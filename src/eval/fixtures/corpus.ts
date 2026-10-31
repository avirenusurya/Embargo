/**
 * Labelled team-knowledge corpus for "Acme Notes" (a small Indian SaaS team) plus one partner company (Globex).
 * 50 blocks: product, pricing, launch, security, HR, fundraising, support, partner material, and customer-call
 * transcripts with speakers. `visibleTo` is hand-labelled from each block's rules (not computed by the policy engine).
 */
import { ALL_WHO, TEAM, type BlockFixture } from './types.ts';

const md = (s: string) => s.replace(/^\n/, '').replace(/\n\s+$/, '\n');

export const BLOCKS: BlockFixture[] = [
  // ---------------- product & engineering (team, viewable) ----------------
  {
    key: 'product', title: 'Product overview', owner: 'asha', source: 'text', pinned: true, visibleTo: TEAM,
    text: md(`
# Acme Notes

Acme Notes is a shared notebook for small teams that every AI tool can read.

## What it does
Notes sync across devices in real time and work offline on mobile.
Teams organise notes into spaces, and every space has its own permissions.
AI tools read team notes through the Embargo MCP connector instead of copy-paste.

## Who uses it
Our customers are startups and agencies with 2 to 30 people.
Most teams adopt it for sprint planning, meeting notes and product specs.
`),
  },
  {
    key: 'brand', title: 'Brand and voice guidelines', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Brand and voice guidelines

## Colors
Primary brand color is indigo (#4F46E5).
Accent color is amber (#F59E0B) and is used only for calls to action.

## Tone
Tone is plain, warm and direct. Write like a helpful colleague, not a salesperson.
Use sentence case for headings and buttons.

## Words to avoid
Never use "revolutionary", "synergy" or "game-changing" in marketing copy.
Avoid exclamation marks in product UI.
`),
  },
  {
    key: 'design_system', title: 'Design system tokens', owner: 'kabir', source: 'text', visibleTo: TEAM,
    text: md(`
# Design system tokens

## Spacing
Spacing scale is 4, 8, 12, 16, 24, 32 and 48 pixels.
Cards use 16 px padding and 12 px corner radius.

## Typography
Body font is Inter at 15 px with 1.5 line height.
Headings use Inter Semibold and code uses JetBrains Mono.

## Components
Buttons have three variants: primary, secondary and ghost.
The settings screen uses a two-column layout above 960 px.
`),
  },
  {
    key: 'roadmap', title: 'Q4 product roadmap', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Q4 product roadmap

## Themes
Q4 focuses on offline mode, Notion import and enterprise readiness.

## Offline mode
Offline mode ships in version 3.5 on 28 November for iOS and Android.
Edits made offline merge automatically using per-paragraph conflict resolution.

## Enterprise
Okta SSO support ships in version 3.6 in December.
Audit logs become available on the Pro plan in version 3.6.

## Notion import
Notion import supports pages, databases and nested toggles.
`),
  },
  {
    key: 'techstack', title: 'Tech stack', owner: 'rohan', source: 'text', visibleTo: TEAM,
    text: md(`
# Tech stack

## Backend
The backend is TypeScript on Node 22 with Fastify.
The database is Postgres 16 with the pgvector extension.
Background jobs run on a Postgres-backed queue with an outbox table.

## Frontend
The web app is React with Vite, and the mobile apps are React Native.

## Local setup
Run npm install, copy .env.example to .env, then run npm run dev.
Use docker compose up db to start a local Postgres with pgvector.
`),
  },
  {
    key: 'deploy', title: 'Deploy runbook', owner: 'rohan', source: 'text', visibleTo: TEAM,
    text: md(`
# Deploy runbook

## Normal deploys
Deploys run from the main branch via GitHub Actions.
Every deploy runs database migrations before the new containers receive traffic.
Deploys are blocked on Fridays after 4 PM IST unless it is a hotfix.

## Hotfixes
Create a branch from the last release tag, open a PR labelled hotfix, and get one approval.
Hotfix deploys skip the staging soak but still run the smoke test.

## Rollback
To roll back, re-run the previous successful deploy workflow from GitHub Actions.
If a migration must be reverted, run the matching down migration with npm run migrate:down before rolling back the app.
`),
  },
  {
    key: 'oncall', title: 'On-call and incident process', owner: 'rohan', source: 'text', visibleTo: TEAM,
    text: md(`
# On-call and incident process

## Rotation
On-call rotates weekly between the backend engineers using PagerDuty.
The on-call engineer must acknowledge a page within 10 minutes.

## Severity levels
SEV1 means the product is down or data is at risk for many customers.
SEV2 means a major feature is broken with no workaround.
SEV3 means a minor bug or a degraded experience with a workaround.

## Communication
Post updates on the public status page every 30 minutes during a SEV1.
Write a blameless postmortem within 3 working days of any SEV1 or SEV2.
`),
  },
  {
    key: 'api', title: 'Public API reference', owner: 'rohan', source: 'text', visibility: 'public', visibleTo: ALL_WHO,
    text: md(`
# Public API reference

## Authentication
API clients authenticate with a bearer token created in workspace settings.
Tokens are scoped per workspace and can be revoked at any time.

## Pagination
List endpoints use cursor pagination with a next_cursor field.
The default page size is 50 items and the maximum page size is 200 items.

## Limits
Rate limits apply per token, and customers can contact support for higher limits.
Requests larger than 1 MB are rejected with status 413.
`),
  },
  {
    key: 'onboarding_eng', title: 'Engineering onboarding checklist', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Engineering onboarding checklist

## Day one
Get access to GitHub, Linear, Slack and the shared 1Password vault from Priya.
Set up the backend locally using the tech stack guide and run the test suite.

## First week
Pair with Rohan on one small bug fix and ship it to production.
Read the deploy runbook and the on-call process before joining the rotation.
Shadow one on-call shift before taking pages yourself.
`),
  },
  {
    key: 'mobile', title: 'Mobile app release process', owner: 'kabir', source: 'text', visibleTo: TEAM,
    text: md(`
# Mobile app release process

## iOS
iOS builds go to TestFlight for internal testers two days before release.
App Store review usually takes one to two days.

## Android
Android releases use a staged rollout on Google Play starting at 10 percent.
Increase the staged rollout to 50 percent after 24 hours without new crashes, then to 100 percent.

## Release notes
Release notes are written by the feature owner and reviewed by Priya.
`),
  },
  {
    key: 'allhands', title: 'Engineering all-hands notes (October)', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Engineering all-hands notes (October)

Okay so, basically, we kicked off by, you know, going through the wins from last month. Rohan walked through the offline sync work and, um, it is actually looking really good now.
The main decision was that we will freeze new features on 20 November so the team can focus on launch stability.
Kabir showed the new onboarding screens and, I mean, everyone kind of liked the simpler first-run flow.
We agreed that every pull request needs one review and a passing CI run, no exceptions, even for small fixes.
Neha mentioned that support tickets about sync conflicts dropped by about a third since build 3.4.2.
Open question: should we move the weekly demo from Friday to Thursday?
`),
  },

  // ---------------- pricing & launch ----------------
  {
    key: 'pricing', title: 'Pricing decision', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Pricing decision

We decided on a single Pro plan for launch.
Launch price is ₹499/month.
Annual plan gets 2 months free.
Free plan stays available for teams of up to 3 people.
`),
  },
  {
    key: 'pricing_exp', title: 'Pricing experiments', owner: 'asha', source: 'text', allowedConnections: ['dev'], visibleTo: ['dev'],
    text: md(`
# Pricing experiments

## Landing page A/B test
We tested two price points on the pricing page for three weeks in September.
The ₹449 variant converted 3.1 percent of visitors and the ₹499 variant converted 2.9 percent.
Revenue per visitor was higher with the ₹499 variant, so we kept ₹499.

## Next experiment
Next we will test showing annual pricing by default.
`),
    neverTextFor: { founder: ['₹449 variant converted'], cursor: ['₹449 variant converted'], contractor: ['₹449 variant converted'], partner: ['₹449 variant converted'] },
  },
  {
    key: 'launch', title: 'Launch plan', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Launch plan

Launch date is 15 Nov.
We will announce on X and LinkedIn, and email existing beta users the same morning.
The launch campaign runs for one week with daily posts.
Priya owns the launch checklist and Kabir owns the launch visuals.
`),
  },
  {
    key: 'marketing_cal', title: 'Marketing calendar', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Marketing calendar

## November
Launch date is 22 Nov.
Product Hunt launch is scheduled for the launch day at 12:01 AM PT.

## Webinars
The offline mode webinar is on 4 December at 5 PM IST.
The Notion import webinar is on 11 December at 5 PM IST.
`),
  },
  {
    key: 'launch_announce', title: 'Launch announcement draft', owner: 'priya', source: 'text', embargo: 'future', visibleTo: [],
    text: md(`
# Launch announcement draft

Today we are launching Acme Notes 2.0, which brings offline sync to every team.
Acme Notes 2.0 includes Notion import, Okta SSO and audit logs.
Pricing starts at ₹499 per month for the Pro plan.
Quote from Asha Rao: "Teams should never lose a decision in a chat thread again."
`),
    neverText: ['Acme Notes 2.0', 'never lose a decision in a chat thread'],
  },
  {
    key: 'diwali_promo', title: 'Diwali promo codes', owner: 'priya', source: 'text', expires: 'past', visibleTo: [],
    text: md(`
# Diwali promo codes

Promo code DIWALI40 gives 40 percent off the first three months of Pro.
The code is limited to the first 500 redemptions.
`),
    neverText: ['DIWALI40'],
  },
  {
    key: 'beta_feedback', title: 'Beta feedback summary', owner: 'priya', source: 'text', embargo: 'past', visibleTo: TEAM,
    text: md(`
# Beta feedback summary

## Offline mode
Beta users asked most often for reliable offline editing on flights and trains.
Several teams reported duplicate paragraphs after reconnecting, fixed in build 3.4.2.

## Search
Users want search across all spaces and filters by author.

## Plans
Most beta teams said a single Pro plan is easier to understand than tiers.
`),
  },

  // ---------------- sales & customers ----------------
  {
    key: 'icp', title: 'Ideal customer profile', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Ideal customer profile

Our ideal customer is a startup or agency with 5 to 30 people that already uses two or more AI tools.
The buyer is usually the founder or head of engineering.
Strong signals are a messy Notion workspace and repeated copy-paste of project context into ChatGPT or Claude.
Poor fits are enterprises above 500 people and teams that need on-premise hosting.
`),
  },
  {
    key: 'sales_playbook', title: 'Sales playbook', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Sales playbook

## Discovery questions
Which AI tools does your team use every week?
Where does project context live today, and who keeps it up to date?
What happened the last time someone shared the wrong document with a tool?

## Objection: we already use Notion
Acme Notes imports Notion pages and keeps them in sync, so teams do not have to migrate on day one.
Position Acme Notes as the layer that makes Notion content usable by AI tools.

## Next steps
Offer a 14-day trial with a guided onboarding call.
`),
  },
  {
    key: 'standup', title: 'Tuesday standup', owner: 'priya', source: 'transcript', visibleTo: TEAM,
    lines: [
      { speaker: 'Priya Nair', text: 'Quick update, the launch price is ₹599/month now.', expectHeld: false },
      { speaker: 'Rohan Mehta', text: 'Offline sync migration will finish by Friday.', expectHeld: false },
      { speaker: 'Kabir Shah', text: 'The new onboarding screens are ready for design review.', expectHeld: false },
      { speaker: 'Rohan Mehta', text: 'The flaky export test is caused by a timezone bug in the scheduler.', expectHeld: false },
      { speaker: 'Neha Joshi', text: 'I will update the help center articles for offline mode this week.', expectHeld: false },
    ],
  },
  {
    key: 'initech_call', title: 'Customer call: Initech renewal', owner: 'priya', source: 'transcript', visibleTo: TEAM,
    lines: [
      { speaker: 'Priya Nair', text: 'Thanks for joining, this call is about the Initech renewal in January.', expectHeld: false },
      { speaker: 'Sanjay Kapoor', text: 'Our team of 40 people uses Acme Notes every day for sprint planning.', expectHeld: false },
      { speaker: 'Sanjay Kapoor', text: 'We need Okta SSO before we can renew the contract.', expectHeld: false },
      { speaker: 'Rohan Mehta', text: 'Okta SSO support ships in version 3.6 on 10 December.', expectHeld: false },
      { speaker: 'Sanjay Kapoor', text: 'Our renewal budget is capped at 9 lakh for the year.', expectHeld: true, review: 'blocked' },
      { speaker: 'Sanjay Kapoor', text: 'You can reach me directly at sanjay.k@initech.test for the paperwork.', expectHeld: true },
      { speaker: 'Priya Nair', text: 'We will send the completed security questionnaire by Friday.', expectHeld: false },
      { speaker: 'Sanjay Kapoor', text: 'We are also evaluating Notion as an alternative.', expectHeld: false },
    ],
    neverText: ['9 lakh', 'sanjay.k@initech.test'],
  },
  {
    key: 'umbrella_call', title: 'Customer call: Umbrella Health pilot', owner: 'asha', source: 'transcript', visibleTo: TEAM,
    lines: [
      { speaker: 'Kavya Menon', text: 'We want to pilot Acme Notes with our clinical operations team of 25 people.', expectHeld: false },
      { speaker: 'Kavya Menon', text: 'Patient records must never be stored in shared notes.', expectHeld: false },
      { speaker: 'Asha Rao', text: 'We can offer audit logs and a data processing agreement for the pilot.', expectHeld: false },
      { speaker: 'Kavya Menon', text: 'One of our coordinators is in hospital after surgery, so timelines may slip.', expectHeld: true },
      { speaker: 'Kavya Menon', text: 'The pilot starts on 6 January if their compliance team signs off.', expectHeld: false },
      { speaker: 'Asha Rao', text: 'The pilot price for Umbrella is ₹350 per seat per month.', expectHeld: false },
    ],
    neverText: ['in hospital after surgery'],
  },

  // ---------------- HR ----------------
  {
    key: 'hiring_plan', title: 'Hiring plan', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Hiring plan

## Q1 hiring
We are hiring 2 backend engineers and 1 product designer in Q1.
Backend roles require strong TypeScript and Postgres experience.

## Interview loop
The interview loop is a 30-minute intro call, a take-home exercise, a pairing session with Rohan, and a values interview with Asha.
Offers are approved by Asha within 48 hours of the final interview.
`),
  },
  {
    key: 'leave_policy', title: 'Leave policy', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Leave policy

Employees get 24 days of paid leave per year plus 10 public holidays.
Unused leave up to 10 days carries over to the next year.
Request leave in the HR tool at least two weeks ahead for anything longer than three days.
Parental leave is 26 weeks for birthing parents and 6 weeks for other parents.
`),
  },
  {
    key: 'salary_bands', title: 'Salary bands 2026', owner: 'asha', source: 'text', access_mode: 'sealed_use', answer_policy: 'yes_no', visibleTo: [],
    text: md(`
# Salary bands 2026

Senior engineer band is ₹38–46 LPA.
Staff engineer band is ₹52–60 LPA.
Product designer band is ₹22–30 LPA.
Joining bonus is capped at ₹3 lakh for all roles.
`),
    neverText: ['38–46', '52–60', '22–30 LPA'],
  },
  {
    key: 'perf_review', title: 'Performance review notes: Kabir', owner: 'asha', source: 'text', visibility: 'private', visibleTo: ['founder'],
    text: md(`
# Performance review notes: Kabir

Kabir ships polished UI quickly and the onboarding redesign was excellent.
Kabir needs to improve estimation and should flag slipping tasks earlier.
Proposed rating is "exceeds expectations" with a promotion discussion in April.
`),
    neverTextFor: { dev: ['needs to improve estimation'], cursor: ['needs to improve estimation'], contractor: ['needs to improve estimation'], partner: ['needs to improve estimation'] },
  },

  // ---------------- fundraising & board ----------------
  {
    key: 'fundraise', title: 'Fundraising notes', owner: 'asha', source: 'text', visibility: 'private', visibleTo: ['founder'],
    text: md(`
# Fundraising notes

We are raising a seed round at ₹40 crore pre-money valuation.
Peak XV has offered to lead with ₹12 crore, and two angels are joining.
The target close date is 31 January.
Do not mention the round to customers or partners until the term sheet is signed.
`),
    neverTextFor: { dev: ['₹40 crore'], cursor: ['₹40 crore'], contractor: ['₹40 crore'], partner: ['₹40 crore'] },
  },
  {
    key: 'acquisition', title: 'Acquisition talks', owner: 'asha', source: 'text', access_mode: 'sealed_use', answer_policy: 'yes_no', visibleTo: [],
    text: md(`
# Acquisition talks with Zentrix

Zentrix offer is ₹180 crore in cash and stock.
Zentrix deadline is 15 December for an answer.
The board prefers to stay independent unless the offer exceeds ₹250 crore.
`),
    neverText: ['Zentrix', '₹180 crore', '₹250 crore'],
  },
  {
    key: 'investor_update_old', title: 'Investor update (August)', owner: 'asha', source: 'text', status: 'revoked', visibleTo: [],
    text: md(`
# Investor update (August)

Monthly burn was ₹18 lakh in August and runway is 16 months.
We closed 12 new paying teams in August.
`),
    neverText: ['₹18 lakh'],
  },
  {
    key: 'board_deck', title: 'Board meeting notes (October)', owner: 'asha', source: 'text', access_mode: 'agent_only', visibleTo: TEAM,
    text: md(`
# Board meeting notes (October)

## Highlights
Paying teams grew from 120 to 165 in the quarter.
Net revenue retention is 112 percent.

## Decisions
The board approved hiring two backend engineers and one designer in Q1.
We decided to delay the enterprise tier until after the Q4 launch.

## Risks
Main risk is that the offline mode release slips past November.
`),
  },
  {
    key: 'okrs', title: 'Company OKRs Q4', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Company OKRs Q4

## Objective 1: Launch Acme Notes Pro
Key result: 300 paying teams by 31 December.
Key result: Weekly active teams above 70 percent of paying teams.

## Objective 2: Make offline mode reliable
Key result: Sync conflict rate below 0.5 percent of edits.
Key result: Crash-free sessions above 99.5 percent on mobile.
`),
  },

  // ---------------- security ----------------
  {
    key: 'security', title: 'Security internals', owner: 'asha', source: 'text', access_mode: 'sealed_use', answer_policy: 'facts_only', visibleTo: [],
    text: md(`
# Security internals

API rate limit is 100 requests per minute per key.
Admin panel host is admin.internal.acme behind the office VPN.
Incident contact is Ravi this week and Sana next week.
Backup schedule is nightly at 02:00 IST to a separate region.
Key rotation period is 90 days for all data encryption keys.
`),
    neverText: ['100 requests per minute', 'admin.internal.acme', '02:00 IST'],
  },
  {
    key: 'pentest', title: 'Pentest findings 2026', owner: 'asha', source: 'text', access_mode: 'sealed_use', answer_policy: 'summary', visibleTo: [],
    text: md(`
# Pentest findings 2026

The pentest was run by an external firm in September.
Stored XSS in the share dialog was fixed in version 3.2.
Session cookies were missing the SameSite attribute, fixed in version 3.3.
Open finding is verbose error messages on the import endpoint.
`),
    neverText: ['Stored XSS in the share dialog', 'verbose error messages on the import endpoint'],
  },
  {
    key: 'security_overview', title: 'Security overview for customers', owner: 'asha', source: 'text', visibility: 'public', visibleTo: ALL_WHO,
    text: md(`
# Security overview for customers

## Encryption
Customer data is encrypted at rest with AES-256-GCM and in transit with TLS 1.2 or higher.
Each note version is encrypted with its own data key.

## Compliance
We are working towards a SOC 2 Type I report, planned for 2027.
We sign a data processing agreement with every paying customer on request.

## Access
Staff access to production requires SSO and hardware security keys.
`),
  },

  // ---------------- partner material ----------------
  {
    key: 'partner_api', title: 'Globex integration guide', owner: 'asha', source: 'text', visibility: 'partner', partner: true, visibleTo: ALL_WHO,
    text: md(`
# Globex integration guide

## Webhooks
The integration subscribes to note.created and note.updated webhook events.
Webhook payloads are signed with HMAC-SHA256 using the shared secret from the partner dashboard.

## OAuth
The Globex connector requests the notes.read and spaces.read OAuth scopes.
Access tokens expire after one hour and are refreshed with the refresh token.

## Sandbox
Partners get a sandbox workspace with sample notes for testing.
`),
  },
  {
    key: 'integration_faq', title: 'Integration FAQ', owner: 'asha', source: 'text', cardToPartner: true, visibleTo: ALL_WHO,
    text: md(`
# Integration FAQ

## Webhook retries
Failed webhook deliveries are retried 5 times with exponential backoff over 24 hours.
After the last retry the event is marked failed and shown in the partner dashboard.

## Ordering
Webhook events can arrive out of order, so use the updated_at field to discard stale updates.

## Endpoints
Each partner can register up to 10 webhook endpoints.
`),
  },
  {
    key: 'partner_terms', title: 'Partner revenue share terms', owner: 'asha', source: 'text', visibleTo: TEAM,
    text: md(`
# Partner revenue share terms

Globex receives a 20% revenue share on referred accounts for the first 12 months.
Payouts are made quarterly in INR within 30 days of quarter end.
The partner agreement renews automatically every year.
`),
    neverTextFor: { partner: ['20% revenue share'] },
  },
  {
    key: 'globex_sync', title: 'Globex partner sync', owner: 'asha', source: 'transcript', visibility: 'partner', partner: true, visibleTo: ALL_WHO,
    lines: [
      { speaker: 'Dev Malhotra', text: 'The Globex connector for Acme Notes goes live on 5 December.', expectHeld: false },
      { speaker: 'Asha Rao', text: 'We will expose webhooks for note created and note updated events.', expectHeld: false },
      { speaker: 'Dev Malhotra', text: 'Our engineers need sandbox API keys by next Monday.', expectHeld: false },
      { speaker: 'Asha Rao', text: 'Our investors expect this partnership to add 200 paying teams this year.', expectHeld: true, review: 'team_only' },
      { speaker: 'Dev Malhotra', text: 'We will co-market the integration in our January newsletter.', expectHeld: false },
      { speaker: 'Dev Malhotra', text: 'My mobile number is +91 98450 77881 if anything breaks.', expectHeld: true },
    ],
    neverText: ['98450 77881'],
    neverTextFor: { partner: ['200 paying teams'] },
  },

  // ---------------- support ----------------
  {
    key: 'support_macros', title: 'Support macros', owner: 'priya', source: 'text', purposes: ['support'], visibleTo: TEAM,
    text: md(`
# Support macros

## Refund request
Thank the customer, confirm the account email, and process the refund within 2 business days.
Never promise a refund outside the refund policy without approval from Priya.

## Export failed
Ask for the export format and workspace ID, then check the export job log.
Offer a manual Markdown export if the job keeps failing.

## Sign-in problems
Ask the customer to try the magic link sign-in and clear cookies.
`),
  },
  {
    key: 'refund_policy', title: 'Refund policy', owner: 'priya', source: 'text', visibility: 'public', visibleTo: ALL_WHO,
    text: md(`
# Refund policy

Refunds are allowed within 7 days of purchase for monthly plans.
Annual plans can be refunded pro rata in the first 30 days.
Refunds are paid back to the original payment method.
`),
    editTo: md(`
# Refund policy

Refunds are allowed within 30 days of purchase for monthly plans.
Annual plans can be refunded pro rata in the first 60 days.
Refunds are paid back to the original payment method.
`),
    neverText: ['7 days of purchase', 'first 30 days'],
  },
  {
    key: 'support_sla', title: 'Support SLA', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Support SLA

First response time is 4 hours.
Pro customers get support by email and in-app chat on weekdays from 9 AM to 7 PM IST.
SEV1 incidents get a response within 1 hour, every day of the week.
`),
  },
  {
    key: 'support_handbook', title: 'Support handbook', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Support handbook

## Response times
First response time is 8 hours.
Tickets are triaged by Neha every morning and assigned by product area.

## Tone
Reply in plain language, restate the problem, and give one clear next step.

## Escalation
Escalate bugs that affect more than one customer to the on-call engineer.
`),
  },
  {
    key: 'escalations', title: 'Customer escalation contacts', owner: 'priya', source: 'text', access_mode: 'agent_only', visibleTo: TEAM,
    text: md(`
# Customer escalation contacts

Escalate P1 customer issues to Rohan Mehta and the current on-call engineer.
Escalate billing disputes to Priya Nair.
Escalate security reports to Asha Rao and the security alias.
`),
  },
  {
    key: 'help_offline', title: 'Help center: Offline mode', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Help center: Offline mode

## Turning on offline mode
Open Settings, choose Offline, and pick the spaces to keep on the device.
Offline spaces download in the background over Wi-Fi.

## Conflicts
If two people edit the same paragraph offline, both versions are kept and marked for review.
`),
  },
  {
    key: 'help_export', title: 'Help center: Exporting notes', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Help center: Exporting notes

Export any space as Markdown, PDF or HTML from the space menu.
Large exports are emailed as a download link that expires after 7 days.
Exports include attachments up to 100 MB per file.
`),
  },
  {
    key: 'office', title: 'Office and travel', owner: 'priya', source: 'text', visibleTo: TEAM,
    text: md(`
# Office and travel

## Office
The Bengaluru office is on the 4th floor of the Indiranagar co-working space, open 9 AM to 9 PM.
Guests must be registered at the front desk a day in advance.

## Travel
Book flights through the company travel account at least 14 days ahead.
Hotel budget is up to ₹6,000 per night in metro cities.
`),
  },

  // ---------------- lifecycle cases: archived, drafts ----------------
  {
    key: 'archived_roadmap', title: 'Q2 roadmap', owner: 'priya', source: 'text', status: 'archived', visibleTo: [],
    text: md(`
# Q2 roadmap

The Q2 theme was collaboration: comments, mentions and shared spaces.
Comments shipped in version 2.8 and mentions in version 2.9.
`),
    neverText: ['Q2 theme was collaboration'],
  },
  {
    key: 'draft_blog', title: 'Draft blog post: Why we built Acme Notes', owner: 'priya', source: 'text', status: 'draft', visibleTo: [],
    text: md(`
# Draft blog post: Why we built Acme Notes

We started Acme Notes after losing one too many product decisions inside long chat threads.
This draft still needs a customer quote and a final headline.
`),
    neverText: ['losing one too many product decisions'],
  },
  {
    key: 'agent_draft', title: 'Agent notes: export bug', owner: 'rohan', source: 'text', createdVia: 'agent', visibleTo: [],
    text: 'AGENTDRAFT-7731: the export bug reproduces when the space name contains an emoji.\nWorkaround is renaming the space before exporting.',
    neverText: ['AGENTDRAFT-7731'],
  },
];

export const blockByKey = new Map(BLOCKS.map((b) => [b.key, b]));
