/** Sensitivity detection layer 1 (rules/regex) + heuristic layer 2 and the merge/severity logic (Part 11.8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from '../helpers/env.ts';

setupEnv();
const { regexFlags, keywordFlags, mergeFlags, maxSeverity } = await import('../../src/ai/sensitivity.ts');
const { classifySensitivity } = await import('../../src/ai/tasks.ts');

const reasons = (t: string) => regexFlags(t).map((f) => f.reason);
const cats = (t: string) => keywordFlags(t).map((f) => f.category);

test('emails and phone numbers (Indian and international)', () => {
  assert.ok(reasons('reach me at meera@client.test').includes('Contains an email address'));
  assert.ok(reasons('call 98765 43210 tomorrow').includes('Contains a phone number'));
  assert.ok(reasons('call +91-9876543210').includes('Contains a phone number'));
  assert.ok(reasons('office +44 20 7946 0958').includes('Contains a phone number'));
  assert.deepEqual(regexFlags('the meeting is at 10'), []);
});

test('payment cards use the Luhn check', () => {
  assert.ok(reasons('card 4111 1111 1111 1111 exp 12/29').includes('Contains a payment card number'));
  assert.ok(!reasons('order 4111 1111 1111 1112').includes('Contains a payment card number'), 'fails Luhn');
});

test('Aadhaar-like, PAN-like, IFSC-like and IBAN-like identifiers', () => {
  assert.ok(reasons('aadhaar 2345 6789 0123').includes('Contains an Aadhaar-like number'));
  assert.ok(!reasons('number 1234 5678 9012').includes('Contains an Aadhaar-like number'), 'Aadhaar never starts with 0/1');
  assert.ok(reasons('PAN ABCDE1234F').includes('Contains a PAN-like identifier'));
  assert.ok(reasons('IFSC HDFC0001234').includes('Contains an IFSC-like bank code'));
  assert.ok(reasons('IBAN GB82WEST12345698765432').includes('Contains an IBAN-like account number'));
  assert.equal(regexFlags('IFSC HDFC0001234').find((f) => f.reason.includes('IFSC'))?.severity, 'medium');
});

test('API keys and high-entropy secrets', () => {
  for (const k of ['sk-abcdefghijklmnopqrstuv', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-1234567890-abcdefghij'])
    assert.ok(reasons(`key: ${k}`).includes('Contains an API key or secret'), k);
  assert.ok(reasons('token Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LzXcVbNm').includes('Contains a high-entropy secret-like string'));
  assert.ok(!reasons('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').some((r) => r.includes('secret')), 'low entropy');
  assert.equal(regexFlags('sk-abcdefghijklmnopqrstuv')[0].category, 'credentials');
  // A pasted PEM block is still caught through the entropy rule on its base64 body.
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi8vZ1Kq7nX4yR2bW5cE8hLpQ\n-----END RSA PRIVATE KEY-----';
  assert.ok(regexFlags(pem).some((f) => f.category === 'credentials' && f.severity === 'high'));
});

// Regression (src/ai/sensitivity.ts, credentials regex): the alternation used to be wrapped in a leading \b, and "-----BEGIN"
// starts with a non-word char, so the PEM header alone never matched when preceded by a space/newline/start.
test('PEM private-key header is detected on its own', () => {
  for (const t of ['key:\n-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----', 'paste: -----BEGIN OPENSSH PRIVATE KEY-----', 'x-----BEGIN EC PRIVATE KEY-----'])
    assert.ok(reasons(t).includes('Contains an API key or secret'), t);
  assert.equal(regexFlags('-----BEGIN ENCRYPTED PRIVATE KEY-----')[0]?.severity, 'high');
  assert.ok(!reasons('-----BEGIN CERTIFICATE-----').includes('Contains an API key or secret'), 'public certificates are not secrets');
  // Word-prefixed keys still need a word boundary in front.
  assert.ok(!reasons('task-abcdefghijklmnopqrstuv').includes('Contains an API key or secret'), 'sk- inside a word is not a key prefix');
});

test('keyword categories, including Hinglish money words', () => {
  assert.deepEqual(cats('Launch price is ₹499/month'), ['pricing']);
  assert.ok(cats('Our budget for this deal is 5 lakh').includes('deal_or_fundraising'));
  assert.ok(cats('valuation 20 crore in the seed round').includes('deal_or_fundraising'));
  assert.ok(cats('she is in hospital after surgery').includes('health'));
  assert.ok(cats('salary revisions after the performance review').includes('hr'));
  assert.ok(cats('we got a legal notice about the NDA').includes('legal'));
  assert.ok(cats('the password for the firewall').includes('security'));
  assert.deepEqual(cats('We will announce on LinkedIn next week'), []);
});

test('mergeFlags keeps the highest severity per category; maxSeverity summarises', () => {
  const m = mergeFlags([{ category: 'pricing', severity: 'low', reason: 'a' }], [{ category: 'pricing', severity: 'high', reason: 'b' }, { category: 'legal', severity: 'medium', reason: 'c' }]);
  assert.equal(m.length, 2);
  assert.equal(m.find((f) => f.category === 'pricing')!.severity, 'high');
  assert.equal(maxSeverity(m), 'high');
  assert.equal(maxSeverity([{ category: 'legal', severity: 'medium', reason: '' }]), 'medium');
  assert.equal(maxSeverity([{ category: 'legal', severity: 'low', reason: '' }]), 'low');
  assert.equal(maxSeverity([]), null);
});

test('classifySensitivity (heuristic mode) merges regex, keywords and outsider names', async () => {
  const f = await classifySensitivity('Our budget for this deal is 5 lakh, reach me at meera@client.test', { externalSpeaker: true });
  const c = new Set(f.map((x) => x.category));
  assert.ok(c.has('deal_or_fundraising') && c.has('personal_data'));
  assert.equal(maxSeverity(f), 'high');
  const o = await classifySensitivity('I spoke with Meera Guest yesterday', { externalNames: ['Meera Guest'] });
  assert.ok(o.some((x) => x.category === 'outsider_identity' && x.severity === 'medium'));
  assert.deepEqual(await classifySensitivity("I'll write the deploy checklist this week"), []);
  for (const x of f) assert.ok(!x.reason.includes('5 lakh') && !x.reason.includes('meera@'), 'reasons never quote the sensitive value');
});
