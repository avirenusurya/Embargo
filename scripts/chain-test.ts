/**
 * Chain test (Part 21.1 "Chain"): runs the relayer against a local Anvil node with real EAS contracts.
 *
 *   npm run test:chain            (or: npx tsx scripts/chain-test.ts)
 *
 * Needs:
 *   - anvil: $ANVIL_BIN, ./.tools/foundry/anvil, or on PATH. Install without touching shell rc files:
 *       mkdir -p .tools/foundry && curl -sSL https://github.com/foundry-rs/foundry/releases/latest/download/foundry_stable_linux_amd64.tar.gz | tar xz -C .tools/foundry
 *   - EAS artifacts: $EAS_ARTIFACTS_DIR or /tmp/eas-artifacts (installed on demand with
 *       npm i --prefix /tmp/eas-artifacts @ethereum-attestation-service/eas-contracts   — never into the project)
 *   - forge (optional, same place as anvil) to compile a tiny ERC-1271 wallet for the smart-wallet signature check.
 * If anvil or the artifacts cannot be obtained the script prints why and exits 0 (skipped).
 *
 * Covers: SchemaRegistry + EAS deploy, schema registration, createRecord → anchorBatch (size and interval triggers)
 * → on-chain root timestamp → verifyRecord / proofBundle / standalone verifier, deterministic leaf order, relayer lease,
 * individual on-chain attestations (share), crash recovery without double-send, EIP-712 user countersign (EOA and
 * ERC-1271 wallet), low-balance pause + automatic resume, and chain outage (records stay signed and verifiable).
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEventLogs, zeroAddress, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { foundry } from 'viem/chains';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // anvil dev account #0 (public test key)
let failures = 0, passes = 0;
const check = (name: string, cond: any, detail?: unknown) => {
  if (cond) passes++; else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1500) : ''}`);
};
const skip = (why: string): never => { console.log(`SKIP  chain test: ${why}`); process.exit(0); };

// ---------- locate tools ----------
function findBin(name: string) {
  const cands = [process.env[`${name.toUpperCase()}_BIN`], path.join(ROOT, '.tools', 'foundry', name)].filter(Boolean) as string[];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const w = spawnSync('which', [name], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}
const anvilBin = findBin('anvil') ?? skip('anvil not found (see header for a no-rc-file Foundry install into .tools/foundry)');
function artifactsDir() {
  const dirs = [process.env.EAS_ARTIFACTS_DIR, '/tmp/eas-artifacts/node_modules/@ethereum-attestation-service/eas-contracts/artifacts'].filter(Boolean) as string[];
  for (const d of dirs) if (fs.existsSync(path.join(d, 'contracts', 'EAS.sol', 'EAS.json'))) return d;
  console.log('…installing EAS artifacts into /tmp/eas-artifacts (not into the project)');
  const r = spawnSync('npm', ['i', '--prefix', '/tmp/eas-artifacts', '@ethereum-attestation-service/eas-contracts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  return r.status === 0 && fs.existsSync(path.join(dirs[dirs.length - 1], 'contracts', 'EAS.sol', 'EAS.json')) ? dirs[dirs.length - 1] : null;
}
const ART = artifactsDir() ?? skip('EAS contract artifacts unavailable (offline?)');
const easArt = JSON.parse(fs.readFileSync(path.join(ART, 'contracts', 'EAS.sol', 'EAS.json'), 'utf8'));
const regArt = JSON.parse(fs.readFileSync(path.join(ART, 'contracts', 'SchemaRegistry.sol', 'SchemaRegistry.json'), 'utf8'));

// ---------- start anvil ----------
const port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const RPC = `http://127.0.0.1:${port}`;
let anvil: ChildProcess | null = spawn(anvilBin, ['--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
const stopAnvil = () => { anvil?.kill('SIGTERM'); anvil = null; };
process.on('exit', stopAnvil);
const chain = { ...foundry, id: 31337 };
const pub = createPublicClient({ chain, transport: http(RPC) });
for (let i = 0; ; i++) { try { await pub.getChainId(); break; } catch { if (i > 100) skip('anvil did not start'); await new Promise((r) => setTimeout(r, 100)); } }
const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain, transport: http(RPC) });
const rpc = (method: string, params: any[]) => pub.request({ method: method as any, params: params as any });
console.log(`anvil ${anvilBin} on ${RPC}`);

// ---------- deploy EAS ----------
async function deploy(abi: any, bytecode: Hex, args: any[] = []) {
  const hash = await deployer.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress as Hex;
}
const registry = await deploy(regArt.abi, regArt.bytecode);
const easAddress = await deploy(easArt.abi, easArt.bytecode, [registry]);
const easVersion = await pub.readContract({ address: easAddress, abi: easArt.abi, functionName: 'version' }) as string;
check('SchemaRegistry + EAS deployed', !!registry && !!easAddress, { registry, easAddress, easVersion });

const relayerKey = generatePrivateKey();
const relayerAddr = privateKeyToAccount(relayerKey).address;
await rpc('anvil_setBalance', [relayerAddr, toHex(10n ** 19n)]);

// ---------- configure Embargo for this chain, then import it ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-chain-'));
Object.assign(process.env, {
  DATA_DIR: dataDir, NODE_ENV: 'test', AI_MODE: 'heuristic', LLM_API_KEY: '', DATABASE_URL: '', TIGERGRAPH_HOST: '', WISPR_MCP_URL: '',
  RPC_URL: RPC, CHAIN_ID: '31337', EAS_CONTRACT_ADDRESS: easAddress, EAS_SCHEMA_REGISTRY_ADDRESS: registry, EAS_VERSION: easVersion,
  RELAYER_PRIVATE_KEY: relayerKey, BATCH_SIZE: '4', BATCH_INTERVAL_SECONDS: '600',
});
const eas = await import('../src/chain/eas.ts');
// Register the schema with the relayer key (as scripts/register-schema.ts does), then expose the UID to the config.
const relayerWallet = createWalletClient({ account: privateKeyToAccount(relayerKey), chain, transport: http(RPC) });
const regTx = await relayerWallet.writeContract({ address: registry, abi: eas.REGISTRY_ABI, functionName: 'register', args: [eas.SCHEMA, zeroAddress, false] });
const regEv = parseEventLogs({ abi: eas.REGISTRY_ABI, logs: (await pub.waitForTransactionReceipt({ hash: regTx })).logs, eventName: 'Registered' })[0];
const schemaUid = (regEv?.args as any)?.uid as Hex;
check('schema registered; UID = keccak256(schema, resolver, revocable)', schemaUid === eas.schemaUidFor(), { schemaUid, expected: eas.schemaUidFor() });
const { config } = await import('../src/config.ts');
(config.chain as any).schemaUid = schemaUid; // config was read at import; set the registered UID the same way EAS_SCHEMA_UID would
process.env.EAS_SCHEMA_UID = schemaUid;

const rec = await import('../src/chain/records.ts');
await import('../src/jobs/index.ts');
const { drain } = await import('../src/jobs/queue.ts');
const { getDb } = await import('../src/db/index.ts');
const { uuidv7 } = await import('../src/util.ts');
const { verifyBundle } = await import('./verify-record.ts');
const db = await getDb();
check('chain enabled with relayer from env', eas.chainEnabled() && eas.relayer.address === relayerAddr);
const WS = uuidv7();
const consent = (q = db as any) => rec.createRecord(q, { workspace_id: WS, event: 'consent', subject: { type: 'statement', id: uuidv7(), version: 1, content_hash: 'h' }, scope: { statement_status: 'allowed' } });
const nonce = () => pub.getTransactionCount({ address: relayerAddr });

try {
  // ---------- size trigger ----------
  const first: string[] = [];
  for (let i = 0; i < 3; i++) first.push(await db.tx((q) => consent(q)));
  check('3 pending < BATCH_SIZE and interval not elapsed → not anchored yet', (await rec.anchorBatch(false)) === null);
  first.push(await db.tx((q) => consent(q)));
  const b1: any = await rec.anchorBatch(false);
  check('4th record hits BATCH_SIZE → anchored (size trigger)', b1?.anchored && b1.trigger === 'size' && b1.leaves === 4, b1);
  const ts1 = await eas.getRootTimestamp(b1.root);
  check('Merkle root has an on-chain EAS timestamp', ts1 > 0n, ts1);
  const tx1 = await pub.getTransaction({ hash: b1.tx });
  check('anchor tx sent by the relayer to EAS.timestamp', tx1.from.toLowerCase() === relayerAddr.toLowerCase() && tx1.to?.toLowerCase() === easAddress.toLowerCase());
  const rows = await db.query('SELECT state, batch_index FROM records WHERE id = ANY($1::uuid[]) ORDER BY batch_index', [first]);
  check('records anchored with stable leaf positions', rows.every((r, i) => r.state === 'anchored' && r.batch_index === i), rows);
  for (const id of first) {
    const v: any = await rec.verifyRecord(db, id);
    check(`verifyRecord ${id.slice(-6)}: signature, Merkle proof, on-chain timestamp`, v.checks.relayer_signature.valid && v.checks.merkle.valid && v.checks.merkle.onchain_timestamp > 0, v.checks);
  }

  // ---------- standalone verifier (no trust in the server) ----------
  const bundle = JSON.parse(JSON.stringify(await rec.proofBundle(db, first[2])));
  const vb = await verifyBundle(bundle, { rpc: RPC, relayer: relayerAddr, eas: easAddress, chainId: 31337 });
  check('verify-record: proof bundle passes all checks', vb.ok && vb.checks.some((c) => c.name === 'chain.root_timestamp' && c.status === 'PASS') && vb.checks.some((c) => c.name === 'hash.subject' && c.status === 'PASS'), vb.checks);
  const pinnedByChain = await verifyBundle(bundle, { rpc: RPC, eas: easAddress });
  check('verify-record: relayer pinned by the on-chain sender when --relayer is omitted', pinnedByChain.ok && pinnedByChain.checks.find((c) => c.name === 'attestation.signature')?.status === 'PASS', pinnedByChain.checks);
  const offline = await verifyBundle(bundle, { relayer: relayerAddr, eas: easAddress });
  check('verify-record: works offline (chain checks skipped)', offline.ok && offline.checks.some((c) => c.status === 'SKIP'));
  const tampered = (f: (b: any) => void) => { const b = JSON.parse(JSON.stringify(bundle)); f(b); return verifyBundle(b, { rpc: RPC, relayer: relayerAddr, eas: easAddress }); };
  check('verify-record: tampered Merkle proof fails', !(await tampered((b) => { b.merkle_proof[0] = keccak256('0x01'); })).ok);
  check('verify-record: tampered record field fails', !(await tampered((b) => { b.record.scope_code += 1; })).ok);
  check('verify-record: tampered attestation data fails', !(await tampered((b) => { const d = b.offchain_attestation.message.data as string; b.offchain_attestation.message.data = d.slice(0, 10) + (d[10] === 'a' ? 'b' : 'a') + d.slice(11); })).ok);
  check('verify-record: wrong subject preimage fails', !(await tampered((b) => { b.proof.subject_preimage += 'x'; })).ok);
  check('verify-record: wrong relayer fails', !(await verifyBundle(bundle, { rpc: RPC, relayer: privateKeyToAccount(generatePrivateKey()).address })).ok);
  const file = path.join(dataDir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  const cli = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'scripts', 'verify-record.ts'), file, '--rpc', RPC, '--relayer', relayerAddr, '--eas', easAddress], { encoding: 'utf8' });
  check('verify-record CLI: exit 0 and RESULT: PASS', cli.status === 0 && /RESULT: PASS/.test(cli.stdout), cli.stdout + cli.stderr);
  fs.writeFileSync(file, JSON.stringify({ ...bundle, merkle_proof: [keccak256('0x02')] }));
  const cliBad = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'scripts', 'verify-record.ts'), file, '--rpc', RPC], { encoding: 'utf8' });
  check('verify-record CLI: exit 1 and RESULT: FAIL on a bad proof', cliBad.status === 1 && /RESULT: FAIL/.test(cliBad.stdout), cliBad.stdout);

  // ---------- leaf order is stable even when records share created_at (same transaction) ----------
  const same = await db.tx(async (q) => { const ids = []; for (let i = 0; i < 4; i++) ids.push(await consent(q)); return ids; });
  const b2: any = await rec.anchorBatch(false);
  check('same-transaction records anchored as one batch', b2?.anchored && b2.leaves === 4, b2);
  let allOk = true;
  for (const id of same) { const v: any = await rec.verifyRecord(db, id); allOk &&= v.checks.merkle.valid; }
  check('all proofs valid for records with identical created_at', allOk);

  // ---------- interval trigger ----------
  const lone = await db.tx((q) => consent(q));
  check('1 pending right after a batch → waits for the interval', (await rec.anchorBatch(false)) === null);
  await db.query(`UPDATE record_batches SET anchored_at = anchored_at - interval '11 minutes' WHERE state='anchored'`);
  const b3: any = await rec.anchorBatch(false);
  check('BATCH_INTERVAL_SECONDS since the last batch → anchored (interval trigger)', b3?.anchored && b3.trigger === 'interval' && b3.leaves === 1, b3);
  check('lone record verifies (single-leaf tree)', (await rec.verifyRecord(db, lone) as any).checks.merkle.valid);

  // ---------- leader lease ----------
  await db.tx((q) => consent(q));
  const batchesBefore = Number((await db.query(`SELECT COUNT(*)::int AS n FROM record_batches WHERE state='anchored'`))[0].n);
  const both: any[] = await Promise.all([rec.anchorBatch(true), rec.anchorBatch(true)]);
  const batchesAfter = Number((await db.query(`SELECT COUNT(*)::int AS n FROM record_batches WHERE state='anchored'`))[0].n);
  check('two concurrent anchor runs: exactly one holds the lease and anchors', both.filter((x) => x?.anchored).length === 1 && batchesAfter === batchesBefore + 1 && both.some((x) => x?.anchored === false && /anchoring right now/.test(x.reason)), both);

  // ---------- individual on-chain attestation (high-value event) ----------
  const shareId = await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'share', subject: { type: 'card', id: uuidv7(), version: 2, content_hash: 'b1,b2' }, recipient: { kind: 'workspace', id: uuidv7() }, scope: { visibility: 'partner', expiry: true } }));
  await drain();
  const sv: any = await rec.verifyRecord(db, shareId);
  check('share record attested on chain by the relayer (records.submit job)', sv.record.state === 'onchain' && sv.checks.onchain?.found && sv.checks.onchain.data_matches && sv.checks.onchain.attester_is_relayer, sv);
  const a: any = await eas.getAttestation(sv.record.onchain_uid);
  check('on-chain attestation uses the registered schema and is non-revocable', a.schema === schemaUid && a.revocable === false && a.attester.toLowerCase() === relayerAddr.toLowerCase());
  const sb = await verifyBundle(JSON.parse(JSON.stringify(await rec.proofBundle(db, shareId))), { rpc: RPC, relayer: relayerAddr, eas: easAddress });
  check('verify-record: on-chain share record passes', sb.ok && sb.checks.some((c) => c.name === 'chain.attestation' && c.status === 'PASS'), sb.checks);

  // ---------- crash recovery: tx already mined, DB not updated → no second transaction ----------
  await db.query(`UPDATE records SET state='signed', onchain_uid=NULL WHERE id=$1`, [shareId]);
  const n0 = await nonce();
  await rec.anchorBatch(true);
  const again = (await db.query('SELECT state, onchain_uid FROM records WHERE id=$1', [shareId]))[0];
  check('sweep recovers the mined attestation from its tx hash without resending', again.state === 'onchain' && again.onchain_uid === sv.record.onchain_uid && (await nonce()) === n0, { again, n0, n1: await nonce() });

  // ---------- user EIP-712 countersign: EOA and ERC-1271 smart wallet ----------
  const user = privateKeyToAccount(generatePrivateKey());
  const input = { workspace_id: WS, event: 'consent' as const, subject: { type: 'statement', id: uuidv7(), version: 1, content_hash: 'c' }, scope: { statement_status: 'team_only' }, effective_at: new Date() };
  const base = rec.recordFields(input);
  const td = eas.userTypedData(base);
  const sig = await user.signTypedData({ ...td, message: { ...td.message, effectiveAt: base.effectiveAt } } as any);
  const uid = await db.tx((q) => rec.createRecord(q, { ...input, user: { address: user.address, signature: sig } }));
  const uv: any = await rec.verifyRecord(db, uid);
  check('EOA countersign verified (RPC path) and bound via userSigHash', uv.checks.user_signature?.valid && uv.checks.user_signature?.bound, uv.checks);
  const ub = await verifyBundle(JSON.parse(JSON.stringify(await rec.proofBundle(db, uid))), { rpc: RPC, relayer: relayerAddr, eas: easAddress });
  check('verify-record: user signature checks pass', ub.ok && ub.checks.some((c) => c.name === 'user.signature' && c.status === 'PASS'), ub.checks);

  const forge = findBin('forge');
  let wallet: Hex | null = null;
  if (forge) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-1271-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'foundry.toml'), '[profile.default]\nsrc="src"\nout="out"\n');
    fs.writeFileSync(path.join(dir, 'src', 'Wallet1271.sol'), `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/// Minimal ERC-1271 wallet: valid when the signature is the owner's ECDSA signature over the hash.
contract Wallet1271 {
    address public immutable owner;
    constructor(address o) { owner = o; }
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
`);
    const b = spawnSync(forge, ['build', '--root', dir], { encoding: 'utf8' });
    const out = path.join(dir, 'out', 'Wallet1271.sol', 'Wallet1271.json');
    if (b.status === 0 && fs.existsSync(out)) {
      const j = JSON.parse(fs.readFileSync(out, 'utf8'));
      wallet = await deploy(j.abi, j.bytecode.object, [user.address]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (wallet) {
    const in2 = { ...input, subject: { type: 'statement', id: uuidv7() } };
    const b2f = rec.recordFields(in2);
    const td2 = eas.userTypedData(b2f);
    const s2 = await user.signTypedData({ ...td2, message: { ...td2.message, effectiveAt: b2f.effectiveAt } } as any);
    const wid = await db.tx((q) => rec.createRecord(q, { ...in2, user: { address: wallet!, signature: s2 } }));
    const wv: any = await rec.verifyRecord(db, wid);
    check('ERC-1271 smart-wallet countersign verified on chain', wv.record.signer_address === wallet && wv.checks.user_signature?.valid && wv.checks.user_signature?.bound, wv.checks);
    const other = privateKeyToAccount(generatePrivateKey());
    const s3 = await other.signTypedData({ ...td2, message: { ...td2.message, effectiveAt: b2f.effectiveAt } } as any);
    const rej = await db.tx((q) => rec.createRecord(q, { ...in2, user: { address: wallet!, signature: s3 } })).then(() => null, (e: any) => e);
    check('ERC-1271 wallet rejects a signature by a non-owner (400 bad_signature)', rej?.status === 400 && rej?.code === 'bad_signature', rej?.message);
  } else console.log('SKIP  ERC-1271 wallet check (forge unavailable or compile failed)');

  // ---------- low balance: pause, keep signing off-chain, resume when funded ----------
  await rec.anchorBatch(true); // flush anything pending
  await rpc('anvil_setBalance', [relayerAddr, '0x0']);
  const direct = await eas.timestampRoot(keccak256('0xbeef')).then(() => null, (e: any) => e);
  check('a real insufficient-funds send error is recognised', direct && rec.isInsufficientFunds(direct), String(direct?.shortMessage ?? direct?.message));
  const p1 = await db.tx((q) => consent(q));
  const paused: any = await rec.anchorBatch(true);
  const st1 = await rec.relayerStatus(db);
  check('underfunded relayer pauses anchoring and records why', paused?.paused === true && st1.paused && st1.reason === 'low_balance' && st1.last_balance_wei === '0', { paused, st1 });
  const p2 = await db.tx((q) => rec.createRecord(q, { workspace_id: WS, event: 'revoke', subject: { type: 'block', id: uuidv7() } }));
  await drain();
  const pr = await db.query('SELECT id, state FROM records WHERE id = ANY($1::uuid[])', [[p1, p2]]);
  check('while paused, records are still created and signed off-chain', pr.length === 2 && pr.every((r) => r.state === 'signed'));
  check('while paused, off-chain verification still works', (await rec.verifyRecord(db, p1) as any).checks.relayer_signature.valid);
  await rpc('anvil_setBalance', [relayerAddr, toHex(10n ** 19n)]);
  const resumed: any = await rec.anchorBatch(true);
  const st2 = await rec.relayerStatus(db);
  const after = await db.query('SELECT id, state FROM records WHERE id = ANY($1::uuid[])', [[p1, p2]]);
  check('funded again → resumes automatically, anchors the backlog and sweeps the on-chain event', !st2.paused && st2.resumed_at && resumed?.anchored && after.find((r) => r.id === p1)?.state === 'anchored' && after.find((r) => r.id === p2)?.state === 'onchain', { resumed, st2, after });
  const evs = (await db.query('SELECT kind FROM relayer_events ORDER BY created_at, id')).map((e) => e.kind);
  check('pause and resume recorded once each', JSON.stringify(evs) === '["paused","resumed"]', evs);

  // ---------- chain outage ----------
  stopAnvil();
  await new Promise((r) => setTimeout(r, 300));
  const down = await db.tx((q) => consent(q));
  const outage = await rec.anchorBatch(true).then((x) => ({ ok: x }), (e: any) => ({ err: e }));
  const dv: any = await rec.verifyRecord(db, down);
  check('chain down: anchoring fails with chain_unavailable, record stays signed and verifiable', (outage as any).err?.code === 'chain_unavailable' && dv.record.state === 'signed' && dv.checks.relayer_signature.valid, outage);
  check('chain down: the failed batch is recorded and the next run backs off', (await rec.anchorBatch(false)) === null && Number((await db.query(`SELECT COUNT(*)::int AS n FROM record_batches WHERE state='failed'`))[0].n) >= 1);
} catch (e: any) {
  check('chain test crashed', false, e?.stack ?? String(e));
} finally {
  stopAnvil();
  await db.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All chain checks passed'} (${passes} passed)`);
process.exit(failures ? 1 : 0);
