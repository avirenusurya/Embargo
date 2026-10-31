/**
 * EAS on Base (Part 14) using viem. Off-chain attestations follow the EAS EIP-712 "Attest" (version 2) format.
 * Verify contract addresses, EAS version string and off-chain UID format against EAS docs (Part 26 #6).
 */
import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, encodePacked, parseAbi, parseEventLogs, zeroAddress, zeroHash, type Hex, verifyTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, foundry } from 'viem/chains';
import { config } from '../config.ts';

const c = config.chain;
export const SCHEMA = 'bytes32 subjectHash,bytes32 workspaceHash,bytes32 recipientHash,uint8 eventType,uint16 scopeCode,uint64 effectiveAt,bytes32 userSigHash';
export const relayer = privateKeyToAccount(c.relayerPrivateKey);
const chain = c.chainId === 8453 ? base : c.chainId === 84532 ? baseSepolia : { ...foundry, id: c.chainId };
export const chainEnabled = () => !!(c.rpcUrl && c.schemaUid);
export const publicClient = () => createPublicClient({ chain, transport: http(c.rpcUrl) });
const walletClient = () => createWalletClient({ account: relayer, chain, transport: http(c.rpcUrl) });

export const EAS_ABI = parseAbi([
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)',
  'function timestamp(bytes32 data) returns (uint64)',
  'function getTimestamp(bytes32 data) view returns (uint64)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  'event Timestamped(bytes32 indexed data, uint64 indexed timestamp)',
]);
export const REGISTRY_ABI = parseAbi([
  'function register(string schema, address resolver, bool revocable) returns (bytes32)',
  'event Registered(bytes32 indexed uid, address indexed registerer, (bytes32 uid, address resolver, bool revocable, string schema) schema)',
]);

export interface RecordFields { subjectHash: Hex; workspaceHash: Hex; recipientHash: Hex; eventType: number; scopeCode: number; effectiveAt: bigint; userSigHash: Hex }

/** EAS SchemaRegistry UID: keccak256(abi.encodePacked(schema, resolver, revocable)). Records use no resolver, non-revocable. */
export const schemaUidFor = (schema = SCHEMA, resolver: Hex = zeroAddress, revocable = false) =>
  keccak256(encodePacked(['string', 'address', 'bool'], [schema, resolver, revocable]));

export const encodeRecordData = (f: RecordFields) => encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bytes32' }],
  [f.subjectHash, f.workspaceHash, f.recipientHash, f.eventType, f.scopeCode, f.effectiveAt, f.userSigHash]);

const schemaUid = () => (c.schemaUid || zeroHash) as Hex;
const easDomain = () => ({ name: 'EAS Attestation', version: c.easVersion, chainId: c.chainId, verifyingContract: c.easAddress as Hex });
const ATTEST_TYPES = {
  Attest: [
    { name: 'version', type: 'uint16' }, { name: 'schema', type: 'bytes32' }, { name: 'recipient', type: 'address' }, { name: 'time', type: 'uint64' },
    { name: 'expirationTime', type: 'uint64' }, { name: 'revocable', type: 'bool' }, { name: 'refUID', type: 'bytes32' }, { name: 'data', type: 'bytes' }, { name: 'salt', type: 'bytes32' },
  ],
} as const;

export function offchainUid(m: { version: number; schema: Hex; recipient: Hex; time: bigint; expirationTime: bigint; revocable: boolean; refUID: Hex; data: Hex; salt: Hex }) {
  return keccak256(encodePacked(['uint16', 'bytes', 'address', 'address', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes', 'bytes32', 'uint32'],
    [m.version, m.schema, m.recipient, zeroAddress, m.time, m.expirationTime, m.revocable, m.refUID, m.data, m.salt, 0]));
}

/** Relayer-signed EAS off-chain attestation. */
export async function signOffchain(f: RecordFields, time: bigint, salt: Hex) {
  const message = { version: 2, schema: schemaUid(), recipient: zeroAddress as Hex, time, expirationTime: 0n, revocable: false, refUID: zeroHash as Hex, data: encodeRecordData(f), salt };
  const signature = await relayer.signTypedData({ domain: easDomain(), types: ATTEST_TYPES, primaryType: 'Attest', message });
  const uid = offchainUid(message);
  return { domain: easDomain(), primaryType: 'Attest', types: ATTEST_TYPES, message: { ...message, time: message.time.toString(), expirationTime: '0' }, signature, uid, signer: relayer.address };
}

/**
 * Recovers the signer of an off-chain attestation. `valid` compares against `expectedSigner` (the relayer by
 * default), never against the signer claimed inside the attestation blob itself.
 */
export async function verifyOffchain(att: any, expectedSigner: string = relayer.address) {
  const message = { ...att.message, time: BigInt(att.message.time), expirationTime: BigInt(att.message.expirationTime) };
  const signer = await recoverTypedDataAddress({ domain: att.domain, types: ATTEST_TYPES, primaryType: 'Attest', message, signature: att.signature });
  return { signer, expected: expectedSigner, valid: signer.toLowerCase() === expectedSigner.toLowerCase(), uidMatches: offchainUid(message) === att.uid };
}

// ---- User-signed records (passkey smart wallet, EIP-712) ----
export const USER_TYPES = {
  EmbargoRecord: [
    { name: 'subjectHash', type: 'bytes32' }, { name: 'workspaceHash', type: 'bytes32' }, { name: 'recipientHash', type: 'bytes32' },
    { name: 'eventType', type: 'uint8' }, { name: 'scopeCode', type: 'uint16' }, { name: 'effectiveAt', type: 'uint64' },
  ],
} as const;
export const userDomain = () => ({ name: 'Embargo Records', version: '1', chainId: c.chainId });
export function userTypedData(f: Omit<RecordFields, 'userSigHash'>) {
  return { domain: userDomain(), types: USER_TYPES, primaryType: 'EmbargoRecord' as const, message: { ...f, effectiveAt: f.effectiveAt.toString() } };
}
/** ERC-1271 / ERC-6492 (smart wallets) via RPC when available; plain ECDSA otherwise. */
export async function verifyUserSignature(address: Hex, f: Omit<RecordFields, 'userSigHash'>, signature: Hex) {
  const args = { address, domain: userDomain(), types: USER_TYPES, primaryType: 'EmbargoRecord' as const, message: f, signature };
  if (c.rpcUrl) return publicClient().verifyTypedData(args);
  return verifyTypedData(args);
}

// ---- On-chain ----
/** `onSent` runs once the tx hash is known (before mining) so callers can persist it and avoid double-sends after a crash. */
export interface SendOpts { onSent?: (hash: Hex) => unknown }
export function attestedUid(receipt: { logs: any[] }): Hex | null {
  const ev = parseEventLogs({ abi: EAS_ABI, logs: receipt.logs, eventName: 'Attested' })[0];
  return ev ? ((ev.args as any).uid as Hex) : null;
}
export async function attestOnchain(f: RecordFields, opts: SendOpts = {}): Promise<{ uid: Hex; tx: Hex }> {
  const hash = await walletClient().writeContract({
    address: c.easAddress as Hex, abi: EAS_ABI, functionName: 'attest',
    args: [{ schema: schemaUid(), data: { recipient: zeroAddress, expirationTime: 0n, revocable: false, refUID: zeroHash, data: encodeRecordData(f), value: 0n } }],
  });
  await opts.onSent?.(hash);
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`attest tx reverted (${hash})`);
  const uid = attestedUid(receipt);
  if (!uid) throw new Error('Attested event not found');
  return { uid, tx: hash };
}
export async function timestampRoot(root: Hex, opts: SendOpts = {}): Promise<{ tx: Hex; block: bigint }> {
  const hash = await walletClient().writeContract({ address: c.easAddress as Hex, abi: EAS_ABI, functionName: 'timestamp', args: [root] });
  await opts.onSent?.(hash);
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`timestamp tx reverted (${hash})`);
  return { tx: hash, block: receipt.blockNumber };
}
export async function getRootTimestamp(root: Hex) { return publicClient().readContract({ address: c.easAddress as Hex, abi: EAS_ABI, functionName: 'getTimestamp', args: [root] }); }
export async function getAttestation(uid: Hex) { return publicClient().readContract({ address: c.easAddress as Hex, abi: EAS_ABI, functionName: 'getAttestation', args: [uid] }); }
export async function relayerBalance() { return chainEnabled() ? publicClient().getBalance({ address: relayer.address }) : null; }
