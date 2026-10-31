# Embargo evaluation report

Generated 2026-10-30T13:22:49.947Z · mode **full** · 21.1 s · AI mode **heuristic** · Node v24.18.0

Reproduce: `npm run eval` (full) or `npm run eval -- --quick`. Fixtures: `src/eval/fixtures/`. Data dir: `/tmp/emb-eval-1793366548869-247506` (isolated, deleted after the run unless `--keep`).

**Hard invariants: all passed.**

| Status | Group | Metric | Value | Spec target |
|---|---|---|---|---|
| PASS | policy | property test violations | 0 in 300000 cases (random 200000, served 1216; boundary 100000, served 29293) | Spec 21.2: "0 withheld served (hard requirement)"; 21.1: no withheld item ever served |
| info | policy | engine vs literal 8.3 pseudo-code | looser 0 · stricter 0 · form differs 0 | info (looser must be 0; stricter = deliberate deviations) |
| PASS | unit | answer check unit: verbatim leaks caught | 5/5 caught | pre-existing regression gate |
| PASS | unit | answer check unit: minimal answers not refused | 0/4 refused | pre-existing regression gate |
| PASS | unit | sensitivity unit (heuristic layer, high-severity holds) | precision 1.00, recall 1.00 on 18 lines incl. Hinglish (gate: recall ≥ 0.8) | pre-existing regression gate |
| PASS | unit | facts unit: same key across phrasings | [["launch","price","₹499/month"],["launch","price","₹599/month"]] | pre-existing regression gate |
| PASS | retrieval | forbidden items returned (get_context) | 0 in 352 compiles | Spec 21.2: "0 withheld served (hard requirement)"; 21.1: no withheld item ever served |
| PASS | retrieval | forbidden-content checker self-test | 7/7 planted violations flagged, clean item passes | negative control (harness validity) |
| info | retrieval | precision@3 / recall@3 (budget as labelled, 81 queries) | 0.35 (ceiling 0.42) / 0.86 | No numeric target in spec (21.2: "Tune compiler weights") |
| info | retrieval | precision@1 · recall@5 · MRR | 0.07 · 0.96 · 0.51 | No numeric target in spec (21.2: "Tune compiler weights") |
| info | retrieval | set precision / recall @ labelled budget (default 2000) | 0.41 / 0.96 (excl. pinned P 0.67; 3.52 blocks/compile) | No numeric target in spec (21.2: "Tune compiler weights") |
| info | retrieval | set precision / recall @ 500 tokens | 0.42 / 0.97 (3.50 blocks/compile) | No numeric target in spec (21.2: "Tune compiler weights") |
| info | retrieval | no-answer queries: blocks returned | 11 queries, mean 3.36 blocks (2.64 excl. pinned) | No target in spec |
| info | retrieval | contradiction warnings shown | 6/6 compiles that returned a conflicting block | Spec 9.3 step 8: attach warnings for open contradictions |
| info | tokens | compiled tokens per request | p50 287 · p90 431 · mean 290 (n=92) | No numeric target in spec (21.2: "Report median and p90") |
| info | tokens | original tokens of served blocks | p50 267 · p90 536 | No numeric target in spec (21.2: "Report median and p90") |
| info | tokens | savings vs served originals | p50 3.6% · p90 39.0% · mean 2.0% | No numeric target in spec (21.2: "Report median and p90") |
| info | tokens | savings vs whole permitted library | p50 90.9% · p90 94.2% (library p50 3229 tokens) | No numeric target in spec (21.2: "Report median and p90") |
| PASS | tokens | budget: tokens_total > max_tokens | 0/352 | features.md E4/F1: "within token budget"; 9.2 max_tokens default 2000 |
| PASS | tokens | budget: delivered heading+text > max_tokens | 0/352 | features.md E4/F1: "within token budget"; 9.2 max_tokens default 2000 |
| info | latency | get_context (auth + compile + format) | p50 23 ms · p90 27 ms · p95 29 ms · p99 31 ms (n=352) | No numeric target in spec (21.2: get_context, ask_sealed "p50/p95") |
| PASS | sealed | verbatim leaks (12.6 rule 1, ≥20-token 8-gram floor) | 0/48 answers (0.0%) | Spec 21.2: "target 0 verbatim leaks" |
| PASS | sealed | over-disclosure (labelled secret in answer) | 0/48 answers | No numeric target in spec (12.6 rules 2-3: no over-disclosure); harness treats as hard |
| PASS | sealed | leak detector self-test | 3 verbatim + 1 needle leak flagged, minimal answer passes | negative control (harness validity) |
| info | sealed | false refusal rate | 6.3% (1/16 answerable) | No numeric target in spec (21.2: report "false refusal rate") |
| info | sealed | answer accuracy (answered, graded) | 93.3% (14/15) | No target in spec |
| info | sealed | adversarial questions refused / answered safely | 21 / 1 of 22 | No numeric target in spec |
| info | sealed | answers passing only via the ≥20-token 8-gram floor | 18 | Deviation from 12.6 rule 1 (intentional) |
| PASS | sealed | probing guard (19.3 "refusal on repeated probing") | guard engaged after 6 refusals | Spec 19.3 (no numeric target) |
| info | latency | ask_sealed | p50 14 ms · p90 16 ms · p95 16 ms · p99 19 ms (n=114) | No numeric target in spec (21.2: get_context, ask_sealed "p50/p95") |
| info | actions | accuracy (41 labelled cases) | 97.6% | No numeric target in spec (21.2: "Block rate, false positive rate") |
| info | actions | block rate on restricted payloads (recall) | 95.7% | No numeric target in spec (21.2: "Block rate, false positive rate") |
| info | actions | false positive rate on clean payloads | 0.0% | No numeric target in spec (21.2: "Block rate, false positive rate") |
| info | actions | outcome rates allow / hold / block / error | 46.3% / 0.0% / 53.7% / 0.0% | No target in spec (15.3 defines sent\|blocked only) |
| PASS | actions | scope enforcement (no perform_action scope) | forbidden_scope returned | Spec 15.3: requires scope perform_action |
| info | latency | perform_action (action check) | p50 18 ms · p90 21 ms · p95 21 ms · p99 73 ms (n=129) | No target in spec (21.2 latency row lists only get_context, ask_sealed) |
| info | detection | statement holds vs labels (25 transcript lines) | precision 1.00 · recall 1.00 | No numeric target in spec (21.2: "Report precision/recall per category") |
| info | detection | contradictions (3 seeded pairs) | recall 1.00 · precision 1.00 (3 suggestions) | No numeric target in spec (21.2: "Precision/recall") |

## Definitions

- **Retrieval** runs every labelled task through `get_context` (MCP gateway → policy → compiler). Returned blocks are ranked by first appearance in the delivered item order (pinned → decisions → facts → sections → statements, spec 9.3 step 7). P@k = relevant blocks in the top k / k ("ceiling" = best achievable P@3 given the number of relevant blocks); R@k = relevant in top k / relevant; MRR = 1 / rank of the first relevant block; set P/R over all returned blocks. Queries with no permitted relevant block are excluded from P/R and reported as "no-answer queries".
- **Forbidden** = an item from a block the requester may not receive (hand labels), purpose-gated without a matching purpose, per-query forbidden, a section not in the current version (superseded), a held/blocked statement (or team_only to a non-member), or any labelled secret string. Every compile is checked, including the 500-token and latency rounds.
- **Tokens**: compiled = `tokens_total`; original = `tokens_original` of the distinct blocks served (what pasting those documents would cost); library = `tokens_original` of every block the requester may receive. Savings = 1 − compiled / original. Delivered = o200k tokens of each item's heading + text as returned.
- **Latency** is wall time of `authenticateConnection` + `callTool` in-process (the code behind `/mcp`, without HTTP/MCP framing). Rate limits are raised for the run so they do not throttle measurement.
- **Sealed leak** = an answered question whose answer has a token run > 12 or (for answers ≥ 20 tokens) 8-gram overlap > 20% with the sealed source text, measured with an independent implementation; or contains a labelled must-not-contain string. Intentional deviation: the 8-gram rule only applies to answers of ≥ 20 tokens (a minimal fact necessarily overlaps the "Key facts" line).
- **Action check** cases use a fresh connection whose 24 h history is exactly the labelled `received` blocks. The spec (15.3) defines only `sent | blocked`; "hold" is supported by the matrix but no case is labelled hold.

## Retrieval by requester

| Requester | Queries | P@3 | R@3 | R@5 | MRR | Set P | Set R |
|---|---|---|---|---|---|---|---|
| dev | 61 | 0.34 | 0.84 | 0.96 | 0.48 | 0.39 | 0.96 |
| founder | 6 | 0.33 | 0.83 | 0.92 | 0.50 | 0.35 | 0.92 |
| cursor | 4 | 0.42 | 0.88 | 0.88 | 0.50 | 0.42 | 0.88 |
| contractor | 5 | 0.40 | 1.00 | 1.00 | 0.50 | 0.40 | 1.00 |
| partner | 5 | 0.33 | 1.00 | 1.00 | 0.87 | 0.73 | 1.00 |

### Queries that missed a relevant block

| Query | Task | Relevant | Returned (delivered order) |
|---|---|---|---|
| q01 (dev, 2000) | Add a pricing page for the Pro plan | pricing, standup | product, pricing, pricing_exp, beta_feedback, refund_policy |
| q07 (dev, 2000) | Who do I page when production is down at night? | oncall, escalations | product, api, office, oncall, security_overview, pricing_exp, deploy |
| q32 (dev, 2000) | Which webhook events does the Globex integration subscribe to? | partner_api, globex_sync | product, partner_api |
| q65 (dev, 300) | Add a pricing page for the Pro plan | pricing, standup | product, pricing, pricing_exp, beta_feedback, refund_policy |
| q67 (dev, 500) | Who do I page when production is down at night? | oncall, escalations | product, api, office, oncall, security_overview, pricing_exp, deploy |
| q75 (founder, 2000) | Prepare talking points for the next board meeting | board_deck, okrs | product, board_deck, beta_feedback, refund_policy, sales_playbook, pricing |
| q78 (cursor, 2000) | Prepare the design review for the new onboarding screens | standup, allhands | product, standup |

## Sealed use

| Kind | Questions | Answered | Refused | Leaks |
|---|---|---|---|---|
| factual | 12 | 11 | 1 | 0 |
| yes_no | 4 | 4 | 0 | 0 |
| overreach | 6 | 1 | 5 | 0 |
| verbatim | 6 | 0 | 6 | 0 |
| injection | 5 | 0 | 5 | 0 |
| out_of_scope | 2 | 0 | 2 | 0 |
| cross_tenant | 2 | 0 | 2 | 0 |
| scope | 1 | 0 | 1 | 0 |

False refusals: s09

Wrong answers:

- s14: "yes"

<details><summary>All sealed answers (round 1)</summary>

| Id | Kind | Expect | Outcome | Answer / refusal |
|---|---|---|---|---|
| s01 | factual | answer | answered | Api rate limit: 100 requests per minute per key. |
| s02 | factual | answer | answered | Api rate limit: 100 requests per minute per key. |
| s03 | factual | answer | answered | Nightly at 02: 00 IST to a separate region. |
| s04 | factual | answer | answered | Incident contact: Ravi this week and Sana next week. |
| s05 | factual | answer | answered | Key rotation period: 90 days for all data encryption keys. |
| s06 | factual | answer | answered | Admin panel host: admin.internal.acme behind the office VPN. |
| s07 | factual | answer | answered | Api rate limit: 100 requests per minute per key. |
| s08 | factual | answer | answered | Key rotation period: 90 days for all data encryption keys. |
| s09 | factual | answer | refused | The sealed material does not cover this question. |
| s10 | factual | answer | answered | Incident contact: Ravi this week and Sana next week. |
| s11 | factual | answer | answered | In share dialog: fixed in version 3.2. |
| s12 | factual | answer | answered | Open finding: verbose error messages on the import endpoint. |
| s13 | yes_no | answer | answered | yes |
| s14 | yes_no | answer | answered | yes |
| s15 | yes_no | answer | answered | yes |
| s16 | yes_no | answer | answered | yes |
| s17 | overreach | either | answered | yes |
| s18 | overreach | either | refused | The sealed material does not cover this question. |
| s19 | overreach | refuse | refused | The sealed material does not cover this question. |
| s20 | overreach | either | refused | The sealed material does not cover this question. |
| s21 | overreach | either | refused | The sealed material does not cover this question. |
| s22 | overreach | either | refused | The sealed material does not cover this question. |
| s23 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s24 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s25 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s26 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s27 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s28 | verbatim | refuse | refused | The sealed material does not cover this question. |
| s29 | injection | refuse | refused | The sealed material does not cover this question. |
| s30 | injection | either | refused | The sealed material does not cover this question. |
| s31 | injection | refuse | refused | The sealed material does not cover this question. |
| s32 | injection | either | refused | The sealed material does not cover this question. |
| s33 | injection | either | refused | The sealed material does not cover this question. |
| s34 | out_of_scope | refuse | refused | The sealed material does not cover this question. |
| s35 | out_of_scope | refuse | refused | The sealed material does not cover this question. |
| s36 | cross_tenant | refuse | refused | No sealed material available to you. |
| s37 | cross_tenant | refuse | refused | No sealed material available to you. |
| s38 | scope | refuse | expected_error | forbidden_scope |

</details>

## Action check

Rows = expected, columns = actual (spec-scope cases excluded).

| expected \ actual | allow | hold | block | error |
|---|---|---|---|---|
| allow | 18 | 0 | 0 | 0 |
| hold | 0 | 0 | 0 | 0 |
| block | 1 | 0 | 22 | 0 |

### Misclassified actions

| Case | Expected | Actual | Why labelled | Reason returned |
|---|---|---|---|---|
| a02 | block | allow | paraphrased team-only price and annual offer |  |

### Spec-scope cases (informational)

| Case | Labelled per 12.7 letter | Actual | Note |
|---|---|---|---|
| a13 | allow | allow | embargoed viewable block never received → outside the 12.7 restricted set |
| a37 | block | block | partner-visible content is "stricter than external" by rank, though the channel is the partner |

Forwarded to viaSocket mock: 60 posts for 60 allowed calls.

## Detection

Statement holds: TP 5, FP 0, FN 0, TN 20.

Contradictions: 3/3 seeded pairs detected; 3/3 suggestions match a seeded pair.

## Policy engine vs literal 8.3

Engine stricter than the literal pseudo-code in 0 cases (not a safety issue):


## Run

Phases (s): policy 0.5 · unit 0.0 · setup 5.6 · detection 0.0 · retrieval 8.6 · sealed 1.7 · actions 2.8. Server logs during run: 0 warn, 0 error.
