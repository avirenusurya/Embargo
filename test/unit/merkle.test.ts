/** Merkle builder (Part 14.5): sorted-pair keccak256 tree, OpenZeppelin MerkleProof-compatible. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, concat, toHex, type Hex } from 'viem';
import { buildTree, root, proof, verifyProof } from '../../src/chain/merkle.ts';

const leaf = (i: number) => keccak256(toHex(`leaf-${i}`));
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));

// Independent reference: OpenZeppelin MerkleProof.processProof (commutative keccak of sorted pair).
const ozHash = (a: Hex, b: Hex) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
const ozProcess = (l: Hex, p: Hex[]) => p.reduce((h, s) => ozHash(h, s), l);

test('empty tree is rejected', () => {
  assert.throws(() => buildTree([]), /empty/);
});

test('single leaf: root is the leaf and the proof is empty', () => {
  const l = leaves(1);
  const layers = buildTree(l);
  assert.equal(root(layers), l[0]);
  assert.deepEqual(proof(layers, 0), []);
  assert.ok(verifyProof(l[0], [], root(layers)));
});

test('two leaves: root is the sorted-pair hash', () => {
  const l = leaves(2);
  assert.equal(root(buildTree(l)), ozHash(l[0], l[1]));
  assert.equal(root(buildTree([l[1], l[0]])), ozHash(l[0], l[1]), 'pair hash is commutative');
});

test('every leaf proves inclusion for tree sizes 1..33 (odd sizes promote the last node)', () => {
  for (let n = 1; n <= 33; n++) {
    const l = leaves(n);
    const layers = buildTree(l);
    const r = root(layers);
    for (let i = 0; i < n; i++) {
      const p = proof(layers, i);
      assert.ok(verifyProof(l[i], p, r), `n=${n} i=${i}`);
      assert.equal(ozProcess(l[i], p).toLowerCase(), r.toLowerCase(), `OpenZeppelin-compatible n=${n} i=${i}`);
      assert.ok(p.length <= Math.ceil(Math.log2(n)), 'proof length is logarithmic');
    }
  }
});

test('non-members, tampered proofs and wrong roots fail', () => {
  const l = leaves(9);
  const layers = buildTree(l);
  const r = root(layers);
  const p = proof(layers, 4);
  assert.equal(verifyProof(leaf(99), p, r), false, 'leaf not in tree');
  assert.equal(verifyProof(l[4], proof(layers, 5), r), false, 'proof for another index');
  const bad = p.slice(); bad[0] = leaf(42);
  assert.equal(verifyProof(l[4], bad, r), false, 'tampered sibling');
  assert.equal(verifyProof(l[4], p.slice(1), r), false, 'truncated proof');
  assert.equal(verifyProof(l[4], p, leaf(7)), false, 'wrong root');
});

test('root depends on leaf order and content', () => {
  const l = leaves(5);
  const swapped = [l[0], l[2], l[1], l[3], l[4]];
  assert.notEqual(root(buildTree(l)), root(buildTree(swapped)), 'order matters for >2 leaves, so batch order must be stored');
  const changed = l.slice(); changed[3] = leaf(77);
  assert.notEqual(root(buildTree(l)), root(buildTree(changed)));
});

test('verification is case-insensitive on hex', () => {
  const l = leaves(4);
  const layers = buildTree(l);
  const r = root(layers);
  assert.ok(verifyProof(l[2].toUpperCase().replace('0X', '0x') as Hex, proof(layers, 2), r.toUpperCase().replace('0X', '0x') as Hex));
});
