/**
 * Standalone Embargo record verifier (Part 14.7). Checks a record WITHOUT trusting the Embargo server: everything is
 * recomputed from the attestation itself, the proof bundle's preimages and (optionally) the chain.
 *
 *   npx tsx scripts/verify-record.ts <bundle.json | - | https://host/verify/<id> | https://host/records/<id>> [options]
 *
 *   --rpc <url>          JSON-RPC endpoint (or VERIFY_RPC_URL / RPC_URL env). Enables on-chain checks.
 *   --relayer <0x…>      Expected relayer address (or EMBARGO_RELAYER env). Without it the signer is pinned to the
 *                        on-chain sender when --rpc is given, otherwise only reported.
 *   --eas <0x…>          EAS contract address (default for Base / Base Sepolia: 0x4200…0021).
 *   --chain-id <n>       Expected chain id (default: the RPC's chain id).
 *   --global-key <b64>   Embargo's global record key (auditors only) to check workspaceHash / recipientHash.
 *   --cookie <cookie>    Session cookie for /records/:id (owner/admin proof bundles).
 *   --json               Machine-readable output.
 *
 * Exit code 0 when no check FAILs, 1 otherwise. Depends only on viem and node built-ins (no Embargo code).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  createPublicClient, http, keccak256, encodePacked, decodeAbiParameters, decodeFunctionData, recoverTypedDataAddress, verifyTypedData,
  parseAbi, zeroAddress, zeroHash, concat, isAddress, type Hex,
} from 'viem';

// ---- Protocol constants (must match the published Embargo schema) ----
const SCHEMA = 'bytes32 subjectHash,bytes32 workspaceHash,bytes32 recipientHash,uint8 eventType,uint16 scopeCode,uint64 effectiveAt,bytes32 userSigHash';
const SCHEMA_TYPES = SCHEMA.split(',').map((p) => ({ type: p.trim().split(' ')[0], name: p.trim().split(' ')[1] }));
const EVENT_CODE: Record<string, number> = { share: 1, share_revoke: 2, consent: 3, consent_withdraw: 4, revoke: 5, key_destroyed: 6, unlock: 7 };
const BATCHED = ['consent', 'consent_withdraw', 'unlock'];
const BASE_EAS = '0x4200000000000000000000000000000000000021';
const ATTEST_TYPES = {
  Attest: [
    { name: 'version', type: 'uint16' }, { name: 'schema', type: 'bytes32' }, { name: 'recipient', type: 'address' }, { name: 'time', type: 'uint64' },
    { name: 'expirationTime', type: 'uint64' }, { name: 'revocable', type: 'bool' }, { name: 'refUID', type: 'bytes32' }, { name: 'data', type: 'bytes' }, { name: 'salt', type: 'bytes32' },
  ],
} as const;
const USER_TYPES = {
  EmbargoRecord: [
    { name: 'subjectHash', type: 'bytes32' }, { name: 'workspaceHash', type: 'bytes32' }, { name: 'recipientHash', type: 'bytes32' },
    { name: 'eventType', type: 'uint8' }, { name: 'scopeCode', type: 'uint16' }, { name: 'effectiveAt', type: 'uint64' },
  ],
} as const;
const EAS_ABI = parseAbi([
  'function timestamp(bytes32 data) returns (uint64)',
  'function getTimestamp(bytes32 data) view returns (uint64)',
  'function getSchemaRegistry() view returns (address)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
]);
const REGISTRY_ABI = parseAbi(['function getSchema(bytes32 uid) view returns ((bytes32 uid, address resolver, bool revocable, string schema))']);

// ---- CLI ----
type Opts = { src?: string; rpc?: string; relayer?: string; eas?: string; chainId?: number; globalKey?: string; cookie?: string; json: boolean };
function parseArgs(argv: string[]): Opts {
  const o: Opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    if (a === '--rpc') o.rpc = v(); else if (a === '--relayer') o.relayer = v(); else if (a === '--eas') o.eas = v();
    else if (a === '--chain-id') o.chainId = Number(v()); else if (a === '--global-key') o.globalKey = v(); else if (a === '--cookie') o.cookie = v();
    else if (a === '--json') o.json = true; else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (!o.src) o.src = a; else throw new Error(`Unexpected argument ${a}`);
  }
  o.rpc ??= process.env.VERIFY_RPC_URL || process.env.RPC_URL || undefined;
  o.relayer ??= process.env.EMBARGO_RELAYER || undefined;
  return o;
}
function usage() { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, '')); }

async function loadBundle(src: string, cookie?: string): Promise<any> {
  if (src === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) } });
    if (!res.ok) throw new Error(`GET ${src} → HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}

// ---- Checks ----
type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export interface Check { name: string; status: Status; detail: string }

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const hmac = (key: Buffer, s: string) => ('0x' + crypto.createHmac('sha256', key).update(s).digest('hex')) as Hex;
const hashPair = (a: Hex, b: Hex) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
const keyBytes = (k: string) => (/^0x[0-9a-f]*$/i.test(k) ? Buffer.from(k.slice(2), 'hex') : Buffer.from(k, 'base64'));
export const schemaUid = (schema = SCHEMA) => keccak256(encodePacked(['string', 'address', 'bool'], [schema, zeroAddress, false]));
export function offchainUid(m: any): Hex {
  return keccak256(encodePacked(['uint16', 'bytes', 'address', 'address', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes', 'bytes32', 'uint32'],
    [Number(m.version), m.schema, m.recipient, zeroAddress, BigInt(m.time), BigInt(m.expirationTime), !!m.revocable, m.refUID, m.data, m.salt, 0]));
}

export async function verifyBundle(bundle: any, o: Omit<Opts, 'src' | 'json'> = {}): Promise<{ checks: Check[]; ok: boolean; summary: Record<string, unknown> }> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });
  const rec = bundle?.record ?? {};
  const att = bundle?.offchain_attestation;
  if (!att?.message || !att?.signature) { add('bundle', 'FAIL', 'No offchain_attestation in input (expected /verify/:id or /records/:id JSON)'); return { checks, ok: false, summary: {} }; }
  const m = att.message;
  const client = o.rpc ? createPublicClient({ transport: http(o.rpc) }) : null;
  const rpcChainId = client ? await client.getChainId().catch(() => null) : null;
  if (client && rpcChainId === null) add('rpc', 'FAIL', `Cannot reach RPC ${o.rpc}`);

  // 1. Attestation format, UID and signature (relayer key).
  const domain = att.domain ?? {};
  const fmtOk = domain.name === 'EAS Attestation' && Number(m.version) === 2 && (att.primaryType ?? 'Attest') === 'Attest';
  add('attestation.format', fmtOk ? 'PASS' : 'FAIL', `EAS off-chain v${m.version}, domain "${domain.name}" v${domain.version}, chain ${domain.chainId}`);
  const uid = offchainUid(m);
  add('attestation.uid', uid === att.uid ? 'PASS' : 'FAIL', uid === att.uid ? uid : `recomputed ${uid} ≠ claimed ${att.uid}`);
  const message = { ...m, version: Number(m.version), time: BigInt(m.time), expirationTime: BigInt(m.expirationTime) };
  let signer: string | null = null;
  try { signer = await recoverTypedDataAddress({ domain, types: ATTEST_TYPES, primaryType: 'Attest', message, signature: att.signature }); } catch (e: any) { add('attestation.signature', 'FAIL', `cannot recover signer: ${e.message}`); }
  let onchainSender: string | null = null; // filled by on-chain checks; used to pin the relayer when --relayer is absent

  const expectedChain = o.chainId ?? rpcChainId ?? null;
  if (expectedChain !== null) add('attestation.chain', Number(domain.chainId) === expectedChain ? 'PASS' : 'FAIL', `domain chainId ${domain.chainId}, expected ${expectedChain}`);
  const easAddr = o.eas ?? ([8453, 84532].includes(Number(domain.chainId)) ? BASE_EAS : null);
  if (easAddr) add('attestation.eas_contract', eq(domain.verifyingContract, easAddr) ? 'PASS' : 'FAIL', `verifyingContract ${domain.verifyingContract}, expected ${easAddr}`);
  else add('attestation.eas_contract', 'WARN', `verifyingContract ${domain.verifyingContract} not pinned (pass --eas)`);

  // 2. Schema + data.
  const expectedSchema = schemaUid();
  if (m.schema === zeroHash) add('schema', 'WARN', 'Attestation signed before a schema UID was configured (schema = 0x0); data layout assumed to be the Embargo schema');
  else add('schema', eq(m.schema, expectedSchema) ? 'PASS' : 'FAIL', eq(m.schema, expectedSchema) ? `schema UID ${expectedSchema} = keccak256("${SCHEMA}", no resolver, non-revocable)` : `schema ${m.schema} ≠ expected ${expectedSchema}`);
  let d: any = null;
  try {
    const v = decodeAbiParameters(SCHEMA_TYPES, m.data);
    d = Object.fromEntries(SCHEMA_TYPES.map((t, i) => [t.name, v[i]]));
  } catch (e: any) { add('data.decode', 'FAIL', `attestation data does not decode with the schema: ${e.message}`); }
  if (d) {
    const diffs: string[] = [];
    if (rec.subject_hash && !eq(rec.subject_hash, d.subjectHash)) diffs.push('subject_hash');
    if (rec.workspace_hash && !eq(rec.workspace_hash, d.workspaceHash)) diffs.push('workspace_hash');
    if (rec.recipient_hash !== undefined && !eq(rec.recipient_hash ?? zeroHash, d.recipientHash)) diffs.push('recipient_hash');
    if (rec.event && EVENT_CODE[rec.event] !== Number(d.eventType)) diffs.push('event');
    if (rec.scope_code !== undefined && Number(rec.scope_code) !== Number(d.scopeCode)) diffs.push('scope_code');
    if (rec.effective_at && BigInt(Math.floor(new Date(rec.effective_at).getTime() / 1000)) !== d.effectiveAt) diffs.push('effective_at');
    add('data.matches_record', diffs.length ? 'FAIL' : 'PASS', diffs.length ? `record fields differ from the signed data: ${diffs.join(', ')}` : `event ${Object.keys(EVENT_CODE).find((k) => EVENT_CODE[k] === Number(d.eventType))}, scope ${d.scopeCode}, effective ${new Date(Number(d.effectiveAt) * 1000).toISOString()}`);
  }

  // 3. Keyed hashes from the proof bundle's preimages.
  const p = bundle.proof ?? {};
  if (d && p.subject_preimage && p.workspace_record_key) {
    const h = hmac(keyBytes(p.workspace_record_key), p.subject_preimage);
    add('hash.subject', eq(h, d.subjectHash) ? 'PASS' : 'FAIL', eq(h, d.subjectHash) ? `HMAC(workspace_record_key, "${p.subject_preimage}") = subjectHash` : `recomputed ${h} ≠ ${d.subjectHash}`);
  } else add('hash.subject', 'SKIP', 'No subject preimage/key in input (owners get them from /records/:id)');
  if (d && o.globalKey && p.workspace_preimage) {
    const k = keyBytes(o.globalKey);
    const w = hmac(k, p.workspace_preimage);
    add('hash.workspace', eq(w, d.workspaceHash) ? 'PASS' : 'FAIL', `HMAC(global_key, "${p.workspace_preimage}")`);
    if (p.recipient_preimage) { const r = hmac(k, p.recipient_preimage); add('hash.recipient', eq(r, d.recipientHash) ? 'PASS' : 'FAIL', `HMAC(global_key, "${p.recipient_preimage}")`); }
  } else add('hash.workspace', 'SKIP', p.workspace_preimage ? 'Pass --global-key (auditors) to check workspaceHash/recipientHash' : 'No workspace preimage in input');

  // 4. User signature (passkey smart wallet / EOA), bound through userSigHash.
  if (d && (rec.signer_type === 'user' || d.userSigHash !== zeroHash)) {
    const sig = rec.user_signature as Hex | undefined;
    const addr = rec.signer_address as Hex | undefined;
    if (!sig || !addr) add('user.signature', 'FAIL', 'Record claims a user signature but the signature or address is missing');
    else {
      add('user.bound', eq(keccak256(sig), d.userSigHash) ? 'PASS' : 'FAIL', `keccak256(signature) ${eq(keccak256(sig), d.userSigHash) ? '=' : '≠'} userSigHash`);
      const args = { address: addr, domain: { name: 'Embargo Records', version: '1', chainId: Number(domain.chainId) }, types: USER_TYPES, primaryType: 'EmbargoRecord' as const,
        message: { subjectHash: d.subjectHash, workspaceHash: d.workspaceHash, recipientHash: d.recipientHash, eventType: Number(d.eventType), scopeCode: Number(d.scopeCode), effectiveAt: d.effectiveAt }, signature: sig };
      const ok = await (client && rpcChainId !== null ? client.verifyTypedData(args) : verifyTypedData(args)).catch(() => false);
      add('user.signature', ok ? 'PASS' : 'FAIL', `${addr} ${ok ? 'signed' : 'did NOT sign'} this record${client ? ' (ERC-1271/6492 aware via RPC)' : ' (ECDSA only; pass --rpc for smart wallets)'}`);
    }
  }

  // 5. Merkle inclusion (batched records).
  const root = (bundle.batch?.merkle_root ?? bundle.checks?.merkle?.root) as Hex | undefined;
  const mp = bundle.merkle_proof as Hex[] | null | undefined;
  const leaf = keccak256(uid);
  if (mp && root) {
    const got = mp.reduce((h, s) => hashPair(h, s), leaf);
    add('merkle.inclusion', eq(got, root) ? 'PASS' : 'FAIL', eq(got, root) ? `leaf keccak256(uid) + ${mp.length}-step proof → root ${root}` : `proof yields ${got}, not root ${root}`);
    if (bundle.merkle_leaf && !eq(bundle.merkle_leaf, leaf)) add('merkle.leaf', 'FAIL', `claimed leaf ${bundle.merkle_leaf} ≠ keccak256(uid) ${leaf}`);
  } else if (BATCHED.includes(rec.event)) add('merkle.inclusion', 'WARN', `Not anchored yet (state ${rec.state ?? 'unknown'}); only the off-chain signature can be checked`);

  // 6. On-chain checks.
  if (!client || rpcChainId === null) {
    if (root || rec.onchain_uid) add('chain', 'SKIP', 'Pass --rpc to check the on-chain timestamp/attestation');
  } else {
    const eas = (easAddr ?? domain.verifyingContract) as Hex;
    if (m.schema !== zeroHash) {
      const registry = await client.readContract({ address: eas, abi: EAS_ABI, functionName: 'getSchemaRegistry' }).catch(() => null);
      const s: any = registry ? await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'getSchema', args: [m.schema] }).catch(() => null) : null;
      add('chain.schema', s?.schema === SCHEMA ? 'PASS' : 'FAIL', s ? `registered schema "${s.schema}"` : 'schema not found in the EAS SchemaRegistry');
    }
    if (root && mp) {
      const ts = await client.readContract({ address: eas, abi: EAS_ABI, functionName: 'getTimestamp', args: [root] }).catch(() => 0n);
      add('chain.root_timestamp', ts > 0n ? 'PASS' : 'FAIL', ts > 0n ? `root timestamped on chain at ${new Date(Number(ts) * 1000).toISOString()}` : 'root has no EAS timestamp');
      const txh = (bundle.batch?.tx_hash ?? bundle.checks?.merkle?.tx) as Hex | undefined;
      if (txh) {
        const tx = await client.getTransaction({ hash: txh }).catch(() => null);
        let okTx = false, detail = 'transaction not found';
        if (tx) {
          let callRoot: string | null = null;
          try { const f = decodeFunctionData({ abi: EAS_ABI, data: tx.input }); if (f.functionName === 'timestamp') callRoot = f.args[0] as string; } catch { /* not a timestamp call */ }
          okTx = eq(tx.to, eas) && eq(callRoot, root);
          onchainSender = tx.from;
          detail = okTx ? `tx ${txh} from ${tx.from} called EAS.timestamp(root)` : `tx ${txh} is not EAS.timestamp(${root})`;
        }
        add('chain.root_tx', okTx ? 'PASS' : 'FAIL', detail);
      }
    }
    if (rec.onchain_uid) {
      const a: any = await client.readContract({ address: eas, abi: EAS_ABI, functionName: 'getAttestation', args: [rec.onchain_uid] }).catch(() => null);
      const found = a && eq(a.uid, rec.onchain_uid);
      add('chain.attestation', found && eq(a.data, m.data) && eq(a.schema, m.schema) && a.revocationTime === 0n ? 'PASS' : 'FAIL',
        found ? `on-chain attestation by ${a.attester} at ${new Date(Number(a.time) * 1000).toISOString()}; data ${eq(a.data, m.data) ? 'matches' : 'DIFFERS'}; schema ${eq(a.schema, m.schema) ? 'matches' : 'DIFFERS'}${a.revocationTime ? '; REVOKED' : ''}` : `attestation ${rec.onchain_uid} not found`);
      if (found) onchainSender ??= a.attester;
    }
  }

  // Relayer identity: pinned by --relayer, else by the on-chain sender, else reported only.
  if (signer) {
    if (o.relayer) {
      if (!isAddress(o.relayer)) add('attestation.signature', 'FAIL', `--relayer ${o.relayer} is not an address`);
      else add('attestation.signature', eq(signer, o.relayer) ? 'PASS' : 'FAIL', `signed by ${signer}; expected relayer ${o.relayer}`);
    } else if (onchainSender) add('attestation.signature', eq(signer, onchainSender) ? 'PASS' : 'FAIL', `signed by ${signer}; on-chain relayer ${onchainSender}`);
    else add('attestation.signature', 'WARN', `valid signature by ${signer}${eq(signer, att.signer) ? ' (as claimed)' : ` (claimed ${att.signer})`}; pass --relayer to pin the relayer address`);
    if (o.relayer && onchainSender && !eq(o.relayer, onchainSender)) add('chain.sender', 'FAIL', `on-chain sender ${onchainSender} is not relayer ${o.relayer}`);
  }

  const ok = !checks.some((c) => c.status === 'FAIL');
  return { checks, ok, summary: { record: rec.id ?? null, event: rec.event ?? null, uid, signer, root: root ?? null, onchain_uid: rec.onchain_uid ?? null } };
}

// ---- main ----
const isMain = process.argv[1] && new URL(import.meta.url).pathname === fs.realpathSync(process.argv[1]);
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (!o.src) { usage(); process.exit(1); }
    const bundle = await loadBundle(o.src, o.cookie);
    const r = await verifyBundle(bundle, o);
    if (o.json) console.log(JSON.stringify({ ok: r.ok, ...r.summary, checks: r.checks }, null, 2));
    else {
      console.log(`Embargo record ${r.summary.record ?? '(unknown id)'} — ${r.summary.event ?? 'unknown event'}`);
      for (const c of r.checks) console.log(`  ${c.status.padEnd(4)}  ${c.name.padEnd(24)} ${c.detail}`);
      const n = (s: Status) => r.checks.filter((c) => c.status === s).length;
      console.log(`\nRESULT: ${r.ok ? 'PASS' : 'FAIL'}  (${n('PASS')} passed, ${n('FAIL')} failed, ${n('WARN')} warnings, ${n('SKIP')} skipped)`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e: any) {
    console.error(`verify-record: ${e.message}`);
    process.exit(1);
  }
}
