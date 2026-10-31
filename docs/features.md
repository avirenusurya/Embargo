# Embargo — Feature List (backup)

> Companion to `embargo.md`. This file lists every feature, its priority, and its acceptance criteria. If the two files ever disagree, `embargo.md` is authoritative.
>
> **Priority:** **P0** = required for the product to work end to end. **P1** = core differentiator. **P2** = valuable extension.
> **Sponsor tags** show where a sponsor is the first-choice implementation.

---

## A. Accounts and workspaces

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| A1 | Passkey sign-in (WebAuthn) | P0 | User can register and sign in with fingerprint/face; no password stored |
| A2 | Magic-link fallback | P0 | User without passkey support can sign in via emailed one-time link |
| A3 | Workspaces | P0 | User can create a workspace and is its `owner` |
| A4 | Roles | P0 | Roles `owner`, `context_admin` (founder's office), `editor`, `viewer` enforced on every API route |
| A5 | Invites | P0 | Owner/context_admin can invite by link or email; invitee joins with chosen role |
| A6 | External persons | P1 | Speakers who are not users (customers, guests) exist as `persons` and can act via review links only |

## B. Block creation (sources)

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| B1 | Paste text / Markdown | P0 | — | Creates a block from pasted content |
| B2 | Dictate into any text field | P0 | **Wispr Flow** (dictation) | Any text input accepts dictated text; no special code required |
| B3 | Upload documents (`.md`, `.txt`, `.pdf`, `.docx`) | P0 | — | Text extracted and turned into a block |
| B4 | Import public URL | P1 | — | Page text fetched, cleaned, turned into a block |
| B5 | Import repo context (GitHub) | P1 | — | README, `/docs`, and selected files imported; block linked to repo path and commit |
| B6 | **Import meeting from Wispr Notetaker** | P0 | **Wispr Flow** (Notetaker MCP) | User connects Wispr account; Embargo lists meetings; selected meeting becomes a conversation block with speakers and statements |
| B7 | Upload audio/video file (fallback) | P1 | OpenAI Whisper (fallback only) | Uploaded recording transcribed via OpenAI Whisper API; becomes a conversation block |
| B8 | Agent-written blocks | P1 | — | `create_block` MCP tool creates a block marked `agent_written`, default visibility `private` |

## C. AI compression and structure

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| C1 | Structured compression | P0 | **AI Grants India** (model credits) | Raw input becomes `title`, `summary`, `sections[]`, `facts[]`, `decisions[]`, `open_questions[]` |
| C2 | Token counts | P0 | — | Original and compressed token counts stored and shown |
| C3 | Editable result | P0 | — | User can edit any field before or after publishing; edit creates new version |
| C4 | Source link | P0 | — | Encrypted original retained and viewable by authorised users |
| C5 | Statement splitting (conversations) | P0 | — | Transcript split into statements, each linked to a speaker |
| C6 | Atomic fact extraction | P1 | — | Facts extracted as `(entity, attribute, value, source_statement_id)` for contradiction detection |

## D. Library and organisation

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| D1 | Block list and search | P0 | Search by text and tag over blocks the user may see |
| D2 | Tags and collections | P0 | Blocks can be tagged and grouped |
| D3 | Pinned blocks | P0 | Pinned blocks are always considered first by the compiler |
| D4 | Versioning and rollback | P1 | Every edit is a version; diffs viewable; rollback creates new version |

## E. Delivery to AI tools (MCP)

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| E1 | MCP server — local (stdio) | P0 | `npx embargo-mcp` runs locally with a connection token and works in MCP clients |
| E2 | MCP server — remote (Streamable HTTP) | P0 | Hosted endpoint works for remote-MCP clients |
| E3 | Scoped connection tokens | P0 | Each tool/person gets its own revocable, scoped token |
| E4 | `get_context` tool | P0 | Returns compiled context within token budget, plus withheld count |
| E5 | `list_blocks`, `read_block` tools | P0 | Return only allowed content |
| E6 | `create_block` tool | P1 | See B8 |
| E7 | `report_context_use` tool | P1 | Agent can report which items it used/ignored; feeds compiler learning |
| E8 | `request_access` tool | P1 | Creates access request and notifies owner |
| E9 | `ask_sealed` tool | P1 | See H3 |
| E10 | `perform_action` tool | P1 | See I2 |

## F. AI Context Manager

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| F1 | **Context compiler** | P0 | For a task, selects, trims, orders, and dedupes allowed items to fit token budget |
| F2 | Compiler learning | P1 | Usage signals (E7, `read_block` follow-ups, human feedback) adjust future selection per task type |
| F3 | Context inbox | P1 | All AI suggestions go to an inbox reviewed by `context_admin` (founder's office) |
| F4 | Update suggestions | P1 | New meetings/repo changes produce proposed block edits with diff |
| F5 | Contradiction alerts | P1 | Conflicting facts across blocks flagged with both sources |
| F6 | Staleness alerts | P1 | Repo-linked blocks out of sync, or blocks unused/old past threshold, flagged |
| F7 | Duplicate merge | P1 | Highly overlapping blocks proposed for merge |
| F8 | Gap detection | P1 | Repeated agent queries with low-relevance results produce "create block" suggestions |
| F9 | Rule suggestions | P1 | Sensitive content in a block produces a suggested stricter rule |
| F10 | Expiry suggestions | P2 | Time-bound blocks past their relevance produce archive/expiry suggestions |
| F11 | Onboarding packs | P2 | For a new member + role, suggested starter set of blocks |
| F12 | Weekly digest | P2 | Summary of changes, contradictions, revokes, shares sent to context_admin |
| F13 | Block quality score | P2 | Blocks frequently served but ignored are flagged for rewrite |
| F14 | Auto-apply settings | P2 | context_admin can set specific suggestion types to apply automatically |

## G. Rules and control

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| G1 | Visibility | P0 | `private`, `team`, `partner:<id>`, `public` enforced by gateway |
| G2 | Allowed tools | P0 | Block can be limited to specific connections |
| G3 | Expiry | P0 | Not served after `expires_at` |
| G4 | Timed embargo | P0 | Not served before `embargo_until`; unlock event recorded |
| G5 | Purpose tags | P2 | Served only for matching `purpose` in request |
| G6 | Line-level rules | P1 | Statements have own status: `allowed`, `held`, `team_only`, `blocked` |
| G7 | Withheld counts | P0 | Tools told how many items were withheld, never which |

## H. Access modes

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| H1 | Viewable | P0 | Humans and agents can read full text |
| H2 | Agent-only | P1 | UI never receives plaintext; MCP returns text. Documented as soft protection |
| H3 | **Sealed use** | P1 | Text never leaves Embargo; `ask_sealed` returns only an answer that passes the answer check |
| H4 | **Sealed blocks** (zero-access storage) | P2 | Encrypted on the client; server stores ciphertext only; readable only by holders of the sealed key |
| H5 | Client-side search for sealed blocks | P2 | Local MCP package searches decrypted sealed blocks on the user's machine |

## I. Safety checks

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| I1 | Sensitive content detection | P1 | Regex + LLM classifier flag personal data, secrets, prices, deals, HR/health/legal, outsider names, with reasons |
| I2 | **Action check** | P1 | Actions sent through Embargo (`perform_action` → viaSocket) are checked against content not allowed for the action's audience; violating actions blocked with reason |
| I3 | **Answer check** | P1 | Sealed-use answers checked for verbatim/near-verbatim leakage and over-disclosure before returning |
| I4 | Prompt-injection hygiene | P0 | Block content returned as delimited data; content never triggers tool calls server-side |

## J. Consent for conversations

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| J1 | Flag-only review | P1 | — | Unflagged statements allowed by default; flagged ones held |
| J2 | Review links (no account) | P1 | **viaSocket** (delivery) | Each speaker with held statements gets a single-purpose link via Slack/WhatsApp/email |
| J3 | Speaker decisions | P1 | — | Speaker sets each own statement to allowed / team-only / blocked / embargo-until |
| J4 | Full-review setting | P2 | — | Workspace can require review of every statement |
| J5 | Unreviewed default | P1 | — | Held statements past review deadline become `blocked` (configurable) |

## K. Revoke and deletion

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| K1 | Revoke block / card / statement | P0 | Stops serving on next request |
| K2 | Crypto-shredding | P0 | Data keys destroyed; ciphertext unreadable, including backups |
| K3 | Derived data purge | P0 | Embeddings, caches, extracted facts deleted |
| K4 | Deletion certificate | P1 | Signed record with timestamp available to owner and affected persons |

## L. Sharing

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| L1 | Cards | P1 | Share blocks/collections with a person, workspace, or link, with scope and expiry |
| L2 | Cross-workspace access | P1 | Recipient workspace connects its tools to the card only |
| L3 | Card expiry and revoke | P1 | Access stops automatically |

## M. Signed records (blockchain)

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| M1 | **Cross-organisation share records** | P1 | Every card shared with another workspace produces a public attestation on Base |
| M2 | **Proof of consent and revocation** | P1 | Consent decisions, withdrawals, revokes, and key destruction produce attestations (batched where high-volume) |
| M3 | User signatures | P1 | Users sign records with a passkey smart wallet; outsiders via server-signed link records |
| M4 | Relayer and gas | P1 | Relayer submits on-chain records and pays gas; users never handle crypto |
| M5 | Batching | P1 | High-volume records stored off-chain and anchored by Merkle root |
| M6 | Verification | P1 | Anyone with a record can verify it against chain data |

## N. Notifications and actions

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| N1 | Notifications | P1 | **viaSocket** | Review links, access requests, inbox items, digests delivered to Slack/WhatsApp/email |
| N2 | Agent actions | P1 | **viaSocket** | `perform_action` posts to Notion/Slack/etc. after action check |

## O. Activity and audit

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| O1 | Access log | P0 | Every serve/withhold logged with connection, item, version, reason, tokens |
| O2 | Personal exposure view | P1 | Person sees where their statements were used |
| O3 | "Why withheld" explanations | P1 | Owner can see the rule path that withheld an item | 

## P. Graph

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| P1 | Rights & relationship graph | P1 | **TigerGraph** | People, blocks, statements, cards, connections, rules mirrored; `allowed_items`, `why_withheld`, `exposure` queries |
| P2 | Postgres fallback | P0 | — | If graph unavailable, policy evaluated from Postgres; revoke/expiry always checked in Postgres |

## Q. Billing

| ID | Feature | Priority | Sponsor | Acceptance criteria |
|---|---|---|---|---|
| Q1 | Team plan checkout | P1 | **Dodo Payments** | Workspace upgrades via Dodo checkout; webhook updates plan |
| Q2 | Plan limits | P1 | — | Members, blocks, connections, imports enforced per plan |

## R. Measurement

| ID | Feature | Priority | Acceptance criteria |
|---|---|---|---|
| R1 | Token savings counter | P1 | Per request and per workspace |
| R2 | Evaluation harness | P1 | Retrieval precision/recall, policy correctness (0 withheld served), detection precision/recall, latency |
| R3 | Product analytics | P1 | Active teams, connections, calls, retention, reviews, revokes, paid workspaces |

## S. Future extensions (not in scope for this build)

| ID | Feature | Notes |
|---|---|---|
| S1 | Paid context cards | Agents pay per use in USDC (x402); revenue split among contributors |
| S2 | Consent-gated key release | Threshold network releases keys only if valid attestation exists |
| S3 | Trusted execution for sealed use | Run sealed-use inference in hardware enclaves |

## Sponsor summary

| Sponsor | Used for | Status |
|---|---|---|
| Wispr Flow | Dictation (B2), Notetaker meeting import (B6) | First choice for all speech |
| OpenAI Whisper | Uploaded audio/video only (B7) | Fallback where Wispr can't be used |
| viaSocket | Notifications (N1), agent actions (N2), review link delivery (J2) | Core |
| TigerGraph | Rights graph (P1) | Core |
| AI Grants India | LLM and embedding credits (C, F, I) | Enabler |
| Dodo Payments | Billing (Q1) | Used for standard SaaS billing only |
| Edge City | Users and distribution | Non-code |
| Cake Wallet | — | Not used |
