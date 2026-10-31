/**
 * Labelled evaluation fixtures (Part 21.2). Everything here is hand-labelled ground truth; nothing is derived
 * from the policy engine or compiler under test.
 */

/** Requesters in the eval world. Each maps to one MCP connection (see world.ts). */
export type Who = 'dev' | 'founder' | 'cursor' | 'contractor' | 'partner';
export const ALL_WHO: Who[] = ['dev', 'founder', 'cursor', 'contractor', 'partner'];
/** Members of the Acme workspace (owner, editors, viewer). */
export const TEAM: Who[] = ['dev', 'founder', 'cursor', 'contractor'];

/** People in the eval world. `user` = has an account; `ws` = workspace they belong to. */
export type UserKey = 'asha' | 'priya' | 'rohan' | 'kabir' | 'neha' | 'devm';

export interface TranscriptLine {
  speaker: string;
  text: string;
  /** Expected initial consent status from sensitivity detection (Part 11.8): true = 'held'. */
  expectHeld: boolean;
  /** Speaker review decision applied after ingest via the real review-link flow (Part 12.5). */
  review?: 'allowed' | 'team_only' | 'blocked';
}

export interface BlockFixture {
  key: string;
  title: string;
  owner: UserKey;
  /** 'text' → paste/markdown source; 'transcript' → conversation with speakers. */
  source: 'text' | 'transcript';
  text?: string;
  lines?: TranscriptLine[];
  pinned?: boolean;
  access_mode?: 'viewable' | 'agent_only' | 'sealed_use';
  visibility?: 'private' | 'team' | 'partner' | 'public';
  /** visibility=partner names the partner workspace (Globex). */
  partner?: boolean;
  /** Share to the partner workspace with a card (Part 13 sharing / L1). */
  cardToPartner?: boolean;
  /** allowed_connection_ids, by requester key. */
  allowedConnections?: Who[];
  purposes?: string[];
  embargo?: 'future' | 'past';
  expires?: 'future' | 'past';
  /** Lifecycle applied after ingest. 'draft' = created without auto_publish. */
  status?: 'draft' | 'archived' | 'revoked';
  answer_policy?: 'facts_only' | 'yes_no' | 'summary';
  /** A later edit (new version). The original `text` becomes a superseded version. */
  editTo?: string;
  /** Created by an agent through the MCP `create_block` tool (private draft, Part 11.7) instead of the REST API. */
  createdVia?: 'agent';
  /** Hand-labelled: requesters who may receive this block's text via get_context (MCP). Purpose-gated blocks
   *  additionally need `purposes` to match the request's purpose. */
  visibleTo: Who[];
  /** Strings that must never reach anyone via get_context (held/blocked lines, superseded versions, etc.). */
  neverText?: string[];
  /** Strings that must never reach specific requesters (e.g. team_only statements → partner). */
  neverTextFor?: Partial<Record<Who, string[]>>;
}

export interface QueryFixture {
  id: string;
  who: Who;
  task: string;
  /** Human-labelled required blocks (keys). Empty = nothing the requester may see covers it. */
  relevant: string[];
  purpose?: string;
  max_tokens?: number;
  /** Extra per-query forbidden blocks (on top of the corpus-wide visibility labels). */
  forbid?: string[];
  /** Pair of blocks with seeded conflicting facts; returned items should carry a contradiction warning. */
  contradiction?: [string, string];
  note?: string;
}

export type SealedExpect = 'answer' | 'refuse' | 'either';
export interface SealedFixture {
  id: string;
  who: Who;
  kind: 'factual' | 'yes_no' | 'injection' | 'verbatim' | 'overreach' | 'out_of_scope' | 'cross_tenant' | 'scope';
  question: string;
  expect: SealedExpect;
  /** For expect=answer: regex the correct answer should match (answer accuracy, informational). */
  correct?: string;
  /** Strings that must not appear in any answer (over-disclosure needles). */
  mustNotContain?: string[];
  /** For kind=scope: the call is expected to fail with this error code. */
  expectError?: string;
  note?: string;
}

export type ActionExpect = 'allow' | 'hold' | 'block';
export interface ActionFixture {
  id: string;
  who: 'dev' | 'founder';
  /** Blocks this connection reads (read_block) before acting, so they are in its 24h "received" set (12.7 step 2). */
  received?: string[];
  /** Use the requester's main connection instead of a fresh one (needed when a block is limited to that
   *  connection via allowed_connection_ids; its history only adds restricted content). */
  baseConnection?: boolean;
  action: string;
  target: string;
  payload: Record<string, unknown>;
  expect: ActionExpect;
  why: string;
  /** Labelled per the letter of 12.7 where the spec's restricted set is narrower than intuition. */
  specScope?: boolean;
}

/** viaSocket action flows configured in the eval workspace, with their audience (12.7 step 1). */
export const ACTION_FLOWS: Record<string, 'public' | 'team' | 'external'> = {
  post_x: 'public',
  post_slack: 'team',
  create_page: 'team',
  send_email: 'external',
  post_partner_channel: 'external',
};
