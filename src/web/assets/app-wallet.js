// Record countersigning (M3): EIP-712 signature from an injected wallet (window.ethereum) or a passkey smart wallet.
// The Coinbase Wallet SDK is fetched from esm.sh only when the user picks the passkey wallet, so the app has no
// network dependency at load time.
import { $, $$, esc, api, AGENT, icon, toast, modal, enhance, shortId, errMsg } from '/static/assets/app-core.js';

const SDK_URL = 'https://esm.sh/@coinbase/wallet-sdk@4.3.0';
const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']];
const domainTypes = (d) => DOMAIN_FIELDS.filter(([k]) => d[k] !== undefined).map(([name, type]) => ({ name, type }));
const hex = (n) => `0x${Number(n).toString(16)}`;

let cbProvider = null;
async function passkeyProvider(chainId) {
  if (cbProvider) return cbProvider;
  let mod;
  try { mod = await import(/* @vite-ignore */ SDK_URL); }
  catch { throw Object.assign(new Error('Could not load the passkey wallet. Check your connection and try again, or use a browser wallet.'), { code: 'sdk_load' }); }
  const opts = { appName: 'Embargo', appChainIds: [Number(chainId)] };
  if (mod.createCoinbaseWalletSDK) cbProvider = mod.createCoinbaseWalletSDK({ ...opts, preference: { options: 'smartWalletOnly' } }).getProvider();
  else { const SDK = mod.CoinbaseWalletSDK ?? mod.default; cbProvider = new SDK(opts).makeWeb3Provider({ options: 'smartWalletOnly' }); }
  return cbProvider;
}

/** Sign the record's typed data with `provider`; returns { address, signature }. */
export async function signRecord(provider, td) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = accounts?.[0];
  if (!address) throw new Error('The wallet returned no account');
  const want = Number(td.domain.chainId);
  try {
    const cur = parseInt(await provider.request({ method: 'eth_chainId' }), 16);
    if (want && cur !== want) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(want) }] });
  } catch { /* wallets that cannot switch still sign; the domain carries the chain id */ }
  const data = { types: { EIP712Domain: domainTypes(td.domain), ...td.types }, domain: td.domain, primaryType: td.primaryType, message: td.message };
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(data)] });
  return { address, signature };
}

function friendly(e) {
  const c = e?.code ?? e?.cause?.code;
  if (c === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')) return 'You declined the signature. Nothing was recorded.';
  if (e?.code === 'bad_signature') return 'The signature did not verify for this record. Smart-wallet signatures need the server to have an RPC endpoint (ERC-1271 / ERC-6492); browser wallets sign with plain ECDSA.';
  if (c === 4100) return 'The wallet has not authorised this site. Unlock it and try again.';
  return errMsg(e);
}

/** Countersign dialog. onDone(newRecordId) runs after the countersign record is written. */
export function countersign(recordId, onDone) {
  const injected = !!window.ethereum;
  modal(`<div class="md-t">Countersign record</div>
    <div class="md-d">Add your own signature to record <b>${esc(shortId(recordId))}</b>. You sign the same EIP-712 fields the relayer attested (subject, workspace and recipient hashes, event, scope, time). No content and no plain ids leave Embargo. A new user-signed record is written that points to this one.</div>
    <div class="wallet-pick" id="wp">
      <button type="button" data-w="injected" ${injected ? '' : 'disabled style="opacity:.5"'}><span class="wi">${icon('wallet', 16)}</span><span><b>Browser wallet</b><span>${injected ? 'Detected (window.ethereum). Signs with eth_signTypedData_v4.' : 'No injected wallet found in this browser.'}</span></span></button>
      <button type="button" data-w="passkey"><span class="wi">${icon('fingerprint', 16)}</span><span><b>Passkey smart wallet</b><span>Coinbase Smart Wallet with your passkey. Loads the wallet SDK when you click.</span></span></button>
    </div>
    <div id="wout"></div>`, (el, close) => {
    const out = $('#wout', el);
    const say = (html) => { out.innerHTML = html; enhance(out); };
    $$('[data-w]', el).forEach((b) => (b.onclick = async () => {
      $$('[data-w]', el).forEach((x) => (x.disabled = true));
      try {
        say(`<div class="loading" style="padding:16px 0"><div class="ld"></div><span>Preparing typed data</span></div>`);
        const td = await api(`/records/${recordId}/typed-data`);
        say(`<div class="loading" style="padding:16px 0"><div class="ld"></div><span>${b.dataset.w === 'passkey' ? 'Opening the passkey wallet' : 'Waiting for your wallet'}</span></div>`);
        const provider = b.dataset.w === 'passkey' ? await passkeyProvider(td.domain.chainId) : window.ethereum;
        const { address, signature } = await signRecord(provider, td);
        say(`<div class="loading" style="padding:16px 0"><div class="ld"></div><span>Filing countersignature</span></div>`);
        const r = await api(`/records/${recordId}/countersign`, { body: { address, signature } });
        let checks = null;
        try { checks = (await api(`/verify/${r.record_id}`, { quiet: true })).checks; } catch { /* verification is shown on the verify page too */ }
        const ok = checks?.user_signature?.valid && checks?.user_signature?.bound;
        say(`<div class="shk"><span class="stamp ${ok ? 'acid' : 'amber'} thunk" style="font-size:18px">${ok ? 'Countersigned' : 'Filed · unverified'}</span>
          <p class="md-d" style="margin-top:12px">Signer <b>${esc(address.slice(0, 6))}…${esc(address.slice(-4))}</b>. New record <b>${esc(shortId(r.record_id))}</b>.${checks ? ` User signature ${checks.user_signature?.valid ? 'verifies' : 'does not verify'}; relayer signature ${checks.relayer_signature?.valid ? 'verifies' : 'does not verify'}.` : ''}</p>
          <a class="bt sm" href="/verify/${esc(r.record_id)}" target="_blank" rel="noopener">Verify record${icon('external', 12)}</a></div>`);
        toast(`Record countersigned by ${address.slice(0, 6)}…${address.slice(-4)}`);
        onDone?.(r.record_id);
      } catch (e) {
        console.warn('countersign', e);
        say(`<div class="wsay red">${'<canvas class="warden eye m" data-warden="alert" data-glow="0"></canvas>'}<div><span class="who">${esc(AGENT.name)}</span><p>${esc(friendly(e))}</p></div></div>`);
        $$('[data-w]', el).forEach((x) => (x.disabled = x.dataset.w === 'injected' && !injected));
      }
    }));
  }, { kind: 'paper', label: 'Countersign', code: 'M3', width: 600 });
}
