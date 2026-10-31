/**
 * Registers the Embargo record schema on EAS (once per network). Prints the schema UID for EAS_SCHEMA_UID.
 * Needs RPC_URL, CHAIN_ID (84532 Base Sepolia | 8453 Base) and a funded RELAYER_PRIVATE_KEY.
 */
import { createPublicClient, createWalletClient, http, parseEventLogs, zeroAddress, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { config } from '../src/config.ts';
import { SCHEMA, REGISTRY_ABI, relayer } from '../src/chain/eas.ts';

if (!config.chain.rpcUrl) { console.error('Set RPC_URL (and CHAIN_ID) first.'); process.exit(1); }
const chain = config.chain.chainId === 8453 ? base : baseSepolia;
const pub = createPublicClient({ chain, transport: http(config.chain.rpcUrl) });
const wallet = createWalletClient({ account: relayer, chain, transport: http(config.chain.rpcUrl) });
console.log(`Relayer ${relayer.address} balance: ${await pub.getBalance({ address: relayer.address })} wei on chain ${chain.id}`);
const hash = await wallet.writeContract({ address: config.chain.schemaRegistryAddress as Hex, abi: REGISTRY_ABI, functionName: 'register', args: [SCHEMA, zeroAddress, false] });
const receipt = await pub.waitForTransactionReceipt({ hash });
const ev = parseEventLogs({ abi: REGISTRY_ABI, logs: receipt.logs, eventName: 'Registered' })[0];
console.log(`Schema registered. tx ${hash}\nEAS_SCHEMA_UID=${(ev?.args as any)?.uid}`);
