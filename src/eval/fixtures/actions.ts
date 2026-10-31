/**
 * Labelled perform_action payloads (Part 12.7). Audiences come from the configured viaSocket flows
 * (ACTION_FLOWS): post_x=public, post_slack/create_page=team, send_email/post_partner_channel=external.
 * Restricted set per 12.7 step 2: content this connection received in the last 24h whose visibility is stricter
 * than the audience, plus ALL sealed_use/agent_only content in the workspace.
 * Ground truth = "does the payload carry restricted content for this audience?" (block) or not (allow).
 * The spec defines only sent|blocked for perform_action (15.3), so no case is labelled 'hold'.
 * specScope cases follow the letter of 12.7 where it is narrower/wider than intuition; they are reported
 * separately and excluded from accuracy.
 */
import type { ActionFixture } from './types.ts';

export const ACTIONS: ActionFixture[] = [
  // ---- public posts (post_x) ----
  { id: 'a01', who: 'dev', received: ['pricing'], action: 'post_x', target: '@acmenotes', payload: { text: 'Launch price is ₹499/month.' }, expect: 'block', why: 'team-only price, verbatim, public audience' },
  { id: 'a02', who: 'dev', received: ['pricing'], action: 'post_x', target: '@acmenotes', payload: { text: 'Big news: Acme Notes Pro costs ₹499 a month at launch, with 2 months free on annual plans.' }, expect: 'block', why: 'paraphrased team-only price and annual offer' },
  { id: 'a03', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'Fun fact: our API rate limit is 100 requests per minute per key.' }, expect: 'block', why: 'sealed_use fact' },
  { id: 'a04', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'We are hiring a product designer in Bengaluru. Apply on our careers page.' }, expect: 'allow', why: 'clean' },
  { id: 'a05', who: 'dev', received: ['api'], action: 'post_x', target: '@acmenotes', payload: { text: 'API clients authenticate with a bearer token created in workspace settings.' }, expect: 'allow', why: 'public block content' },
  { id: 'a06', who: 'dev', received: ['launch'], action: 'post_x', target: '@acmenotes', payload: { text: 'Launch date is 15 Nov. Follow us for updates.' }, expect: 'block', why: 'team-only launch date' },
  { id: 'a07', who: 'dev', received: ['refund_policy'], action: 'post_x', target: '@acmenotes', payload: { text: 'Refunds are allowed within 30 days of purchase for monthly plans.' }, expect: 'allow', why: 'public block content' },
  { id: 'a08', who: 'dev', received: ['security_overview'], action: 'post_x', target: '@acmenotes', payload: { text: 'Customer data is encrypted at rest with AES-256-GCM and in transit with TLS 1.2 or higher.' }, expect: 'allow', why: 'public block content' },
  { id: 'a09', who: 'dev', received: ['board_deck'], action: 'post_x', target: '@acmenotes', payload: { text: 'Paying teams grew from 120 to 165 in the quarter and net revenue retention is 112 percent.' }, expect: 'block', why: 'agent_only board notes' },
  { id: 'a10', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'Paying teams grew from 120 to 165 in the quarter.' }, expect: 'block', why: 'agent_only content is restricted even if not received' },
  { id: 'a11', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'Shipping offline mode soon. Stay tuned!' }, expect: 'allow', why: 'clean, topical overlap only' },
  { id: 'a12', who: 'dev', baseConnection: true, received: ['pricing_exp'], action: 'post_x', target: '@acmenotes', payload: { text: 'Our ₹449 variant converted 3.1 percent of visitors in the September pricing test.' }, expect: 'block', why: 'team-only experiment results' },
  { id: 'a13', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'Today we are launching Acme Notes 2.0, which brings offline sync to every team.' }, expect: 'allow', specScope: true, why: 'embargoed viewable block never received → outside the 12.7 restricted set' },
  { id: 'a14', who: 'dev', received: ['pricing'], action: 'post_x', target: '@acmenotes', payload: { text: 'PRICING UPDATE: LAUNCH PRICE IS ₹499/MONTH. ANNUAL PLAN GETS 2 MONTHS FREE.' }, expect: 'block', why: 'case trick on team-only price' },
  { id: 'a15', who: 'dev', received: ['deploy'], action: 'post_x', target: '@acmenotes', payload: { blocks: [{ type: 'section', text: { body: 'Every deploy runs database migrations before the new containers receive traffic. Deploys are blocked on Fridays after 4 PM IST unless it is a hotfix.' } }] }, expect: 'block', why: 'team-only runbook nested in payload' },
  { id: 'a16', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'Read our new blog post on how small teams share context with AI tools.' }, expect: 'allow', why: 'clean' },
  { id: 'a41', who: 'dev', received: ['pricing'], action: 'post_x', target: '@acmenotes', payload: { text: 'Sign up for the Acme Notes waitlist at acme.test.' }, expect: 'allow', why: 'clean after receiving pricing' },
  { id: 'a43', who: 'dev', action: 'post_x', target: '@acmenotes', payload: { text: 'We take security seriously: data is encrypted and keys are rotated regularly.' }, expect: 'allow', why: 'generic, no sealed specifics' },
  { id: 'a31', who: 'dev', received: ['partner_terms'], action: 'post_x', target: '@acmenotes', payload: { text: 'Globex receives a 20% revenue share on referred accounts for the first 12 months.' }, expect: 'block', why: 'team-only partner terms' },

  // ---- team channel (post_slack) ----
  { id: 'a17', who: 'dev', received: ['pricing'], action: 'post_slack', target: '#launch', payload: { text: 'Reminder: launch price is ₹499/month and the annual plan gets 2 months free.' }, expect: 'allow', why: 'team content to team audience' },
  { id: 'a18', who: 'dev', action: 'post_slack', target: '#eng', payload: { text: 'Heads up: the API rate limit is 100 requests per minute per key.' }, expect: 'block', why: 'sealed_use to team' },
  { id: 'a19', who: 'dev', received: ['escalations'], action: 'post_slack', target: '#support', payload: { text: 'Escalate P1 customer issues to Rohan Mehta and the current on-call engineer.' }, expect: 'block', why: 'agent_only content' },
  { id: 'a20', who: 'dev', received: ['deploy'], action: 'post_slack', target: '#eng', payload: { text: 'Deploys are blocked on Fridays after 4 PM IST unless it is a hotfix.' }, expect: 'allow', why: 'team content to team' },
  { id: 'a21', who: 'founder', received: ['fundraise'], action: 'post_slack', target: '#general', payload: { text: 'Team update: we are raising a seed round at ₹40 crore pre-money valuation.' }, expect: 'block', why: 'private block to team' },
  { id: 'a22', who: 'founder', received: ['perf_review'], action: 'post_slack', target: '#design', payload: { text: 'Kabir needs to improve estimation and should flag slipping tasks earlier.' }, expect: 'block', why: 'private HR notes to team' },
  { id: 'a23', who: 'dev', received: ['globex_sync'], action: 'post_slack', target: '#partnerships', payload: { text: 'Our investors expect this partnership to add 200 paying teams this year.' }, expect: 'allow', why: 'team_only statement to team audience' },
  { id: 'a24', who: 'dev', action: 'post_slack', target: '#hiring', payload: { text: 'Senior engineer band is ₹38–46 LPA.' }, expect: 'block', why: 'sealed_use salary band' },
  { id: 'a25', who: 'dev', action: 'post_slack', target: '#general', payload: { text: 'Standup moved to 10:30 tomorrow.' }, expect: 'allow', why: 'clean' },
  { id: 'a42', who: 'dev', action: 'post_slack', target: '#sales', payload: { text: 'Please review the security questionnaire draft before Friday.' }, expect: 'allow', why: 'clean, topical overlap with sealed security' },

  // ---- team pages (create_page) ----
  { id: 'a26', who: 'dev', received: ['techstack'], action: 'create_page', target: 'Engineering wiki', payload: { title: 'Backend overview', body: 'The backend is TypeScript on Node 22 with Fastify. The database is Postgres 16 with the pgvector extension.' }, expect: 'allow', why: 'team content to team' },
  { id: 'a27', who: 'dev', action: 'create_page', target: 'Engineering wiki', payload: { title: 'Security notes', body: 'Admin panel host is admin.internal.acme behind the office VPN.' }, expect: 'block', why: 'sealed_use fact' },
  { id: 'a28', who: 'dev', received: ['board_deck'], action: 'create_page', target: 'Company wiki', payload: { title: 'Board recap', body: 'We decided to delay the enterprise tier until after the Q4 launch.' }, expect: 'block', why: 'agent_only decision' },

  // ---- external email (send_email) ----
  { id: 'a29', who: 'dev', received: ['integration_faq'], action: 'send_email', target: 'sanjay.k@initech.test', payload: { subject: 'Webhooks', body: 'Failed webhook deliveries are retried 5 times with exponential backoff over 24 hours.' }, expect: 'block', why: 'team content (shared only with Globex) emailed to another company' },
  { id: 'a30', who: 'dev', action: 'send_email', target: 'sanjay.k@initech.test', payload: { subject: 'Follow-up', body: 'Thanks for the call today. We will follow up with the security questionnaire by Friday.' }, expect: 'allow', why: 'clean' },
  { id: 'a32', who: 'dev', received: ['hiring_plan'], action: 'send_email', target: 'hello@talentco.test', payload: { subject: 'Process', body: 'The interview loop is a 30-minute intro call, a take-home exercise, a pairing session with Rohan, and a values interview with Asha.' }, expect: 'block', why: 'team-only hiring process to external' },
  { id: 'a33', who: 'dev', action: 'send_email', target: 'meera@client.test', payload: { subject: 'Docs', body: 'Here is the link to our public API docs: https://acme.test/docs/api' }, expect: 'allow', why: 'clean' },
  { id: 'a34', who: 'dev', action: 'send_email', target: 'candidate@mail.test', payload: { subject: 'Offer', body: 'The staff engineer band is ₹52–60 LPA, so our offer is within range.' }, expect: 'block', why: 'sealed_use salary band' },
  { id: 'a35', who: 'dev', action: 'send_email', target: 'friend@mail.test', payload: { subject: 'Guess what', body: 'Zentrix offer is ₹180 crore in cash and stock.' }, expect: 'block', why: 'sealed_use acquisition fact' },
  { id: 'a36', who: 'dev', received: ['api'], action: 'send_email', target: 'meera@client.test', payload: { subject: 'Pagination', body: 'The default page size is 50 items and the maximum page size is 200 items.' }, expect: 'allow', why: 'public content' },
  { id: 'a40', who: 'dev', received: ['standup'], action: 'send_email', target: 'sanjay.k@initech.test', payload: { subject: 'Pricing', body: 'Quick update, the launch price is ₹599/month now.' }, expect: 'block', why: 'team-only standup statement to external' },

  // ---- partner channel (post_partner_channel, external) ----
  { id: 'a37', who: 'dev', received: ['partner_api'], action: 'post_partner_channel', target: '#globex-shared', payload: { text: 'The Globex connector requests the notes.read and spaces.read OAuth scopes.' }, expect: 'block', specScope: true, why: 'partner-visible content is "stricter than external" by rank, though the channel is the partner' },
  { id: 'a38', who: 'dev', action: 'post_partner_channel', target: '#globex-shared', payload: { text: 'Thanks for the sync today, see you on Monday.' }, expect: 'allow', why: 'clean' },
  { id: 'a39', who: 'dev', received: ['globex_sync'], action: 'post_partner_channel', target: '#globex-shared', payload: { text: 'Our investors expect this partnership to add 200 paying teams this year.' }, expect: 'block', why: 'team_only statement to external audience' },
];
