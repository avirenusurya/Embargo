/** Sorted-pair keccak256 Merkle tree (OpenZeppelin-compatible). */
import { keccak256, concat, type Hex } from 'viem';

const hashPair = (a: Hex, b: Hex) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export function buildTree(leaves: Hex[]): Hex[][] {
  if (!leaves.length) throw new Error('empty tree');
  const layers: Hex[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1]; const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
  }
  return layers;
}
export const root = (layers: Hex[][]) => layers[layers.length - 1][0];
export function proof(layers: Hex[][], index: number): Hex[] {
  const p: Hex[] = [];
  for (let l = 0; l < layers.length - 1; l++) {
    const sib = index ^ 1;
    if (sib < layers[l].length) p.push(layers[l][sib]);
    index >>= 1;
  }
  return p;
}
export const verifyProof = (leaf: Hex, p: Hex[], r: Hex) => p.reduce((h, s) => hashPair(h, s), leaf).toLowerCase() === r.toLowerCase();
