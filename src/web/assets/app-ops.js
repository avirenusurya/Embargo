// Connections (remote + local stdio setup), sharing, activity, savings (R1), people + exposure, records (+ countersign, verification),
// integrations (Wispr, GitHub, viaSocket), workspace settings (members, invites, profile, auto-apply threshold, plan, delete workspace).
import {
  $, $$, esc, fmt, compact, pad, ago, when, date, iso, api, S, AGENT, icon, toast, wrap, busy, modal, confirmBox, view, enhance, cleanup, head, eye, wsay, empty,
  isAdmin, isOwner, canEdit, go, status, working, shortId, memberName, copy, tw, pbar, initials, errMsg, motion,
} from '/static/assets/app-core.js';
import { evtStamp } from '/static/assets/app-blocks.js';
import { countersign } from '/static/assets/app-wallet.js';

// ================================================================ connections (E1/E2/E3)
const SCOPES = [['write_blocks', 'Write drafts', 'Agent can save new private draft blocks'], ['request_access', 'Request access', 'Agent can ask for blocks it cannot read'], ['ask_sealed', 'Ask sealed', `Answers from sealed blocks via ${AGENT.name}, never the text`], ['perform_action', 'Perform actions', 'Post through your viaSocket flows, checked for leaks']];
function setupSnips(token, setup) {
  const T = token || '<YOUR_CONNECTION_TOKEN>';
  const API = setup?.remote_http?.url ? setup.remote_http.url.replace(/\/mcp$/, '') : location.origin;
  const local = { mcpServers: { embargo: { command: 'npx', args: ['-y', 'embargo-mcp'], env: { EMBARGO_TOKEN: T, EMBARGO_API: API } } } };
  const remote = { mcpServers: { embargo: { url: `${API}/mcp`, headers: { Authorization: `Bearer ${T}` } } } };
  return {
    remote: [
      ['Claude Code', `claude mcp add --transport http embargo ${API}/mcp --header "Authorization: Bearer ${T}"`],
      ['Cursor · .cursor/mcp.json', JSON.stringify(remote, null, 2)],
      ['Any Streamable HTTP client', `URL     ${API}/mcp\nHeader  Authorization: Bearer ${T}`],
    ],
    local: [
      ['Run it (stdio)', `npx -y embargo-mcp --token ${T} --api ${API}`],
      ['Or with environment variables', `export EMBARGO_TOKEN=${T}\nexport EMBARGO_API=${API}\nnpx -y embargo-mcp`],
      ['Claude Desktop · claude_desktop_config.json', JSON.stringify(local, null, 2)],
      ['Claude Code (stdio)', `claude mcp add embargo -e EMBARGO_TOKEN=${T} -e EMBARGO_API=${API} -- npx -y embargo-mcp`],
      ['Sealed blocks on this machine', `npx -y embargo-mcp --token ${T} --api ${API} sealed-init          # new sealed key + recovery key\nnpx -y embargo-mcp --token ${T} --api ${API} sealed-recover <KEY>   # restore from recovery key\nnpx -y embargo-mcp --token ${T} --api ${API} sealed-device-request laptop\nnpx -y embargo-mcp --token ${T} --api ${API} sealed-device-approve <device_id>\nnpx -y embargo-mcp --token ${T} --api ${API} sealed-add "Title" ./notes.md`],
    ],
  };
}
function snipsHtml(list) { return `<div class="stack">${list.map(([l, code], i) => `<div class="snip"><div class="snip-h"><span class="lab">${esc(l)}</span><button class="bt xs" data-snip="${i}">${icon('copy', 11)}Copy</button></div><pre class="code">${esc(code)}</pre></div>`).join('')}</div>`; }
export async function connectionsView(fresh) {
  const list = await api(`/workspaces/${S.ws}/connections`);
  const live = list.filter((c) => !c.revoked_at);
  view(`${head({ n: '05', title: 'Connections', desc: 'One scoped, revocable token per tool and person. Claude Code, Claude Desktop, Cursor and any MCP client read the archive through it. Remote over Streamable HTTP, or local over stdio with sealed blocks merged in.' })}
    <div class="cols"><div>${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Tool</th><th class="hs">Person</th><th>Scopes</th><th class="hm">Last used</th><th class="r"></th></tr></thead><tbody>
      ${list.map((c, i) => `<tr class="${c.revoked_at ? 'off' : ''} ${fresh?.id === c.id ? 'hl' : ''}"><td class="n">${pad(i + 1)}</td><td><b>${esc(c.tool_label)}</b></td><td class="hs">${esc(c.user)}</td>
        <td><div class="chips">${c.scopes.map((s) => `<span class="chip ${s === 'read' ? 'dim' : s === 'perform_action' ? 'restricted' : s === 'ask_sealed' ? 'blocked' : 'ink'} plain">${esc(s.replace('_', ' '))}</span>`).join('')}</div></td><td class="hm nowrap">${ago(c.last_used_at)}</td>
        <td class="act">${c.revoked_at ? '<span class="stp red">Revoked</span>' : `<button class="bt xs red" data-rv="${c.id}" data-cursor="REVOKE">Revoke</button>`}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">No tools connected yet. Create a token on the right.</td></tr>'}
    </tbody></table>`)}</div>
    <aside class="pane"><div class="pane-h"><span>New connection</span><i>${live.length} / ${S.wsInfo?.limits?.connections ?? '∞'}</i></div><div class="pane-b">
      <label class="field"><span>Tool</span><input id="tl" placeholder="Claude Code (laptop)"></label>
      <div class="stack" style="gap:8px">${SCOPES.map(([k, l, d]) => `<label class="check"><input type="checkbox" value="${k}" class="sc"><span><b>${l}</b><br><span class="dim">${esc(d)}</span></span></label>`).join('')}</div>
      <button class="bt sm acid full" id="cc">${icon('key', 12)}Create token</button></div></aside></div>
    <div id="tok">${fresh ? `<div class="pane acid mt2"><div class="pane-h"><span>Token for ${esc(fresh.label)}</span><i>Shown once</i></div><div class="pane-b"><div class="secret"><code id="tokv">${esc(fresh.token)}</code><button class="bt sm acid" id="cpt">${icon('copy', 12)}Copy</button></div><p class="hint">Store it in your tool's config now. Embargo keeps only a hash.</p></div></div>` : ''}</div>
    <div class="sect-h mt2"><h2><span class="n">E1 · E2</span>Setup</h2><span class="lab">${fresh ? 'Filled in with your new token' : 'Create a token to fill these in'}</span></div>
    <div class="pane"><div class="tabs" id="stabs"><button class="on" data-s="remote">Remote · Streamable HTTP</button><button data-s="local">Local · stdio (npx embargo-mcp)</button></div><div class="pane-b" id="sbody"></div></div>`);
  const snips = setupSnips(fresh?.token, fresh?.setup);
  const showS = (k) => { $$('#stabs button').forEach((b) => b.classList.toggle('on', b.dataset.s === k)); const box = $('#sbody'); box.innerHTML = `${k === 'local' ? `<p class="hint">The local package runs on your machine, proxies tools to Embargo and merges in sealed blocks it can decrypt locally (keys in the OS keychain, search index in <span class="code-i">~/.embargo</span>). Flags: <span class="code-i">--token</span>, <span class="code-i">--api</span>; env: <span class="code-i">EMBARGO_TOKEN</span>, <span class="code-i">EMBARGO_API</span>.</p>` : '<p class="hint">Hosted endpoint for remote-MCP clients. Every request is checked against the rules and logged.</p>'}${snipsHtml(snips[k])}`; enhance(box); $$('[data-snip]', box).forEach((b) => (b.onclick = () => copy(snips[k][b.dataset.snip][1], 'Snippet copied'))); };
  $$('#stabs button').forEach((b) => (b.onclick = () => showS(b.dataset.s)));
  showS('remote');
  if ($('#cpt')) $('#cpt').onclick = () => copy(fresh.token, 'Token copied');
  $$('[data-rv]').forEach((b) => (b.onclick = wrap(async () => { if (!(await confirmBox({ title: 'Revoke this token?', body: 'The tool loses access on its next request. This cannot be undone; create a new token to reconnect.', confirm: 'Revoke token', danger: true }))) return; await api(`/connections/${b.dataset.rv}`, { method: 'DELETE' }); toast('Token revoked'); connectionsView(); })));
  $('#cc').onclick = wrap(async () => {
    const label = $('#tl').value.trim() || 'AI tool';
    const r = await api(`/workspaces/${S.ws}/connections`, { body: { tool_label: label, scopes: $$('.sc:checked').map((x) => x.value) } });
    toast(`Token issued for ${label}`); await connectionsView({ id: r.id, token: r.token, setup: r.setup, label });
  });
}

// ================================================================ sharing (L1-L3)
export async function sharingView() {
  const [c, colls] = await Promise.all([api(`/workspaces/${S.ws}/cards`), api(`/workspaces/${S.ws}/collections`).catch(() => [])]);
  const cname = (id) => colls.find((x) => x.id === id)?.name ?? 'collection';
  view(`${head({ n: '06', title: 'Sharing', desc: 'Cards share blocks or collections with partner workspaces, people or links, with scope and expiry. Every cross-company share gets a public record that holds no content.' })}
    <div class="sect-h"><h2><span class="n">01</span>Sent</h2><span class="lab">${c.sent.filter((x) => !x.revoked_at).length} live</span></div>
    ${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Recipient</th><th>Scope</th><th class="hs">Note</th><th class="hm">Expires</th><th>Record</th><th class="r"></th></tr></thead><tbody>
      ${c.sent.map((x, i) => `<tr class="${x.revoked_at ? 'off' : ''}"><td class="n">${pad(i + 1)}</td><td><span class="chip dim">${esc(x.recipient_type)}</span> <span class="small">${esc(x.recipient_workspace ?? (x.recipient_type === 'link' ? 'Anyone with link' : shortId(x.recipient_user_id)))}</span></td>
        <td>${x.collection_id ? `<a class="u" href="#collections/${x.collection_id}">${icon('folder', 11)} ${esc(cname(x.collection_id))}</a>` : (x.block_ids || []).map((id) => `<a class="u" href="#blocks/${id}">${shortId(id).slice(-6)}</a>`).join(', ')}</td>
        <td class="hs small">${esc(x.scope?.note ?? '')}</td><td class="hm nowrap">${x.expires_at ? date(x.expires_at) : '—'}</td>
        <td>${x.share_record_id ? `<a class="bt xs" href="/verify/${x.share_record_id}" target="_blank" rel="noopener">Verify${icon('external', 10)}</a>` : '<span class="faint">direct</span>'}</td>
        <td class="act">${x.revoked_at ? '<span class="stp red">Revoked</span>' : `<button class="bt xs red" data-rc="${x.id}">Revoke</button>`}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="7">Nothing shared yet. Open a block or a collection and issue a card.</td></tr>'}
    </tbody></table>`)}
    <div class="cols mt2"><div><div class="sect-h"><h2><span class="n">02</span>Received</h2></div>${tw(`<table class="ledger"><thead><tr><th>From</th><th>Scope</th><th>State</th></tr></thead><tbody>${c.received.map((x) => `<tr class="${x.revoked_at ? 'off' : ''}"><td><b>${esc(x.source_workspace)}</b></td><td>${x.collection_id ? 'A collection' : `${(x.block_ids || []).length} block(s)`}</td><td>${x.revoked_at ? '<span class="stp red">Revoked</span>' : x.expires_at ? `<span class="chip amber">until ${esc(date(x.expires_at))}</span>` : '<span class="chip acid">Live</span>'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="3">Nothing received.</td></tr>'}</tbody></table>`)}</div>
      <aside class="pane"><div class="pane-h"><span>Accept a card link</span><i>L2</i></div><div class="pane-b"><p class="hint">Bind a card someone sent you to this workspace so your AI tools receive it.</p><input id="ct" placeholder="https://…/c/card_…" aria-label="Card link">
        <button class="bt sm acid full" id="ca" ${isAdmin() ? '' : 'disabled'}>Accept into ${esc(S.wsInfo?.name)}</button><div class="hint">This workspace id: <span class="code-i" id="wsid" role="button" tabindex="0" data-cursor="COPY">${S.ws}</span></div></div></aside></div>`);
  $$('[data-rc]').forEach((b) => (b.onclick = wrap(async () => { if (!(await confirmBox({ title: 'Revoke this card?', body: 'The recipient stops receiving it on their next request. A revoke record is written.', confirm: 'Revoke card', danger: true }))) return; await api(`/cards/${b.dataset.rc}`, { method: 'DELETE' }); toast('Card revoked and recorded'); sharingView(); })));
  $('#ca').onclick = wrap(async () => { const t = $('#ct').value.trim().replace(/^.*\/c\//, ''); if (!t) throw new Error('Paste the card link'); await api(`/cards/accept/${encodeURIComponent(t)}`, { body: { workspace_id: S.ws } }); toast('Card accepted. Your tools receive it now.'); sharingView(); });
  $('#wsid').onclick = () => copy(S.ws, 'Workspace id copied');
}

// ================================================================ activity (O1)
const AF = { channel: '', connection: '' };
export async function activityView() {
  const conns = await api(`/workspaces/${S.ws}/connections`).catch(() => []);
  view(`${head({ n: '07', title: 'Activity', desc: `Every request is logged with what was served, which version, and how much was withheld. ${isAdmin() ? 'Owners see why.' : 'You see your own requests.'}`, actions: '<a class="bt sm" href="#savings">Savings</a><a class="bt sm" href="#people">Exposure</a>' })}
    <div class="stats" style="--n:5" id="aStats"></div>
    <div class="toolbar"><div class="seg" id="aseg">${[['', 'All'], ['mcp', 'Context'], ['sealed', 'Sealed'], ['action', 'Actions'], ['web', 'Web']].map(([v, l]) => `<button data-v="${v}" class="${AF.channel === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="acon" aria-label="Connection"><option value="">All connections</option>${conns.map((c) => `<option value="${c.id}" ${AF.connection === c.id ? 'selected' : ''}>${esc(c.tool_label)}</option>`).join('')}</select></div>
    <div id="aWeek"></div><div id="aList"><div class="ld"></div></div>`);
  $$('#aseg button').forEach((b) => (b.onclick = () => { AF.channel = b.dataset.v; $$('#aseg button').forEach((x) => x.classList.toggle('on', x === b)); renderActivity(); }));
  $('#acon').onchange = (e) => { AF.connection = e.target.value; renderActivity(); };
  await renderActivity();
}
async function renderActivity() {
  const qs = new URLSearchParams({ limit: '200' }); if (AF.channel) qs.set('channel', AF.channel); if (AF.connection) qs.set('connection_id', AF.connection);
  const a = await api(`/workspaces/${S.ws}/activity?${qs}`);
  const E = a.entries;
  const st = $('#aStats'); if (!st) return;
  st.innerHTML = `<div><b>${E.filter((e) => e.channel === 'mcp').length}</b><span>Context requests</span></div><div><b>${compact(E.reduce((s, e) => s + (e.tokens_served || 0), 0))}</b><span>Tokens served</span></div><div><b class="acid">${compact(E.reduce((s, e) => s + (e.tokens_saved || 0), 0))}</b><span>Tokens saved</span></div><div><b class="${E.some((e) => e.withheld_count) ? 'red' : ''}">${E.reduce((s, e) => s + (e.withheld_count || 0), 0)}</b><span>Items withheld</span></div><div><b>${E.filter((e) => e.channel === 'sealed').length}</b><span>Sealed questions</span></div>`;
  const wk = $('#aWeek');
  wk.innerHTML = a.week_summary?.length && !AF.channel && !AF.connection ? `<div class="pane mt"><div class="pane-h"><span>This week</span><i>${esc(AGENT.name)}'s ledger</i></div><div class="pane-b tight">${a.week_summary.slice(0, 6).map((s) => `<div class="small" style="padding:4px 0;border-bottom:1px dashed var(--line-2)">${esc(s)}</div>`).join('')}</div></div>` : '';
  const box = $('#aList'); cleanup(box);
  box.innerHTML = `<div class="mt">${tw(`<table class="ledger"><thead><tr><th>When</th><th>Channel</th><th>Who</th><th>Blocks</th><th class="r">Withheld</th><th class="r hm">Served</th><th class="r hs">Saved</th><th class="r hs">ms</th><th class="r"></th></tr></thead><tbody>
    ${E.map((e) => `<tr><td class="nowrap">${ago(e.at)}</td><td class="nowrap"><span class="chip ${e.channel === 'sealed' ? 'blocked' : e.channel === 'action' ? 'restricted' : e.channel === 'web' ? 'dim' : 'ink'}">${esc(e.tool ?? e.channel)}</span>${e.outcome ? ` <span class="chip plain ${['blocked', 'refused'].includes(e.outcome) ? 'red' : 'acid'}">${esc(e.outcome)}</span>` : ''}${e.override ? ' <span class="chip plain amber">override</span>' : ''}</td>
      <td>${esc(e.connection ?? 'Web')} <span class="dim">${esc(e.user ?? '')}</span></td>
      <td class="small">${e.blocks.slice(0, 3).map((b) => `<a class="u" href="#blocks/${b.id}">${esc(b.title ?? 'revoked')}</a>${b.version ? `<span class="faint"> v${b.version}</span>` : ''}`).join(', ')}${e.blocks.length > 3 ? ` +${e.blocks.length - 3}` : ''}</td>
      <td class="r">${e.withheld_count ? `<span class="chip red plain" title="${esc(Object.entries(e.withheld_reasons || {}).map(([k, v]) => `${v} × ${k.replace(/_/g, ' ')}`).join(', '))}" data-cursor="${esc(Object.keys(e.withheld_reasons || {}).join(' · ').replace(/_/g, ' ').toUpperCase().slice(0, 40) || 'WITHHELD')}">${e.withheld_count}</span>` : '<span class="faint">0</span>'}</td>
      <td class="r hm">${fmt(e.tokens_served)}</td><td class="r hs acid">${e.tokens_saved ? fmt(e.tokens_saved) : '—'}</td><td class="r hs faint">${e.latency_ms ?? '—'}</td>
      <td class="act">${e.tool === 'get_context' ? `<button class="bt xs quiet icon" data-h="${e.id}" data-v="1" title="Helpful" aria-label="Helpful">${icon('thumbsup', 11)}</button><button class="bt xs quiet icon" data-h="${e.id}" data-v="0" title="Not helpful" aria-label="Not helpful">${icon('thumbsdown', 11)}</button>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="9">No activity yet. Connect a tool and ask it something.</td></tr>'}</tbody></table>`)}</div>`;
  enhance(box);
  $$('[data-h]', box).forEach((b) => (b.onclick = wrap(async () => { await api(`/activity/${b.dataset.h}/feedback`, { body: { helpful: b.dataset.v === '1' } }); toast('Feedback filed. The compiler learns from it.', 'info'); })));
}

// ================================================================ savings (R1)
let svDays = 30;
export async function savingsView() {
  const s = await api(`/workspaces/${S.ws}/savings?days=${svDays}`);
  const days = []; const map = new Map(s.per_day.map((d) => [d.day, d]));
  for (let i = svDays - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); const k = d.toISOString().slice(0, 10); days.push(map.get(k) ?? { day: k, tokens_original: 0, tokens_served: 0, saved: 0, requests: 0 }); }
  const max = Math.max(1, ...days.map((d) => Math.max(d.tokens_original, d.tokens_served)));
  const ROWS = 24;
  const cells = (d) => { const sv = Math.round((d.saved / max) * ROWS), se = Math.round((d.tokens_served / max) * ROWS); let h = ''; for (let i = 0; i < ROWS; i++) h += `<i class="${i < se ? 'v' : i < se + sv ? 's' : ''}"></i>`; return h; };
  const ratio = s.tokens_original ? Math.round((1 - s.tokens_served / s.tokens_original) * 100) : 0;
  const maxC = Math.max(1, ...s.per_connection.map((c) => c.saved));
  view(`${head({ n: '08', title: 'Savings', desc: `Tokens your AI tools did not have to read, because ${esc(AGENT.name)} serves compressed, deduplicated context instead of raw notes. Counted per request against the originals.`,
    actions: `<div class="seg" id="dseg">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${svDays === d ? 'on' : ''}">${d} days</button>`).join('')}</div>` })}
    <section class="sv-hero"><div class="sv-big"><span class="lab">All-time tokens saved</span><div class="num" data-count="${s.all_time.total_tokens_saved}">0</div><span class="unit">${fmt(s.all_time.requests)} requests served since the archive opened</span></div>
      <div class="sv-side"><div class="stats" style="--n:2"><div><b class="acid">${compact(s.total_tokens_saved)}</b><span>Saved · last ${s.window_days} days</span></div><div><b>${fmt(s.requests)}</b><span>Requests</span></div><div><b>${compact(s.tokens_served)}</b><span>Tokens served</span></div><div><b>${ratio > 0 ? `−${ratio}%` : `${ratio}%`}</b><span>vs ${compact(s.tokens_original)} original</span></div></div>
        <div><div class="pane-h plain"><span>Per day</span><span class="legend"><span><i style="background:var(--acid)"></i>Saved</span><span><i style="background:var(--bone-4)"></i>Served</span></span></div>
          <div class="chart" role="img" aria-label="Tokens per day">${days.map((d) => `<div class="col" data-cursor="${esc(d.day.slice(5))} · ${compact(d.saved)} SAVED · ${d.requests} REQ" title="${esc(d.day)}: ${fmt(d.saved)} saved, ${fmt(d.tokens_served)} served, ${d.requests} requests">${cells(d)}</div>`).join('')}</div>
          <div class="chart-x"><span>${esc(days[0].day.slice(5))}</span><span>${esc(days[Math.floor(days.length / 2)].day.slice(5))}</span><span>TODAY</span></div></div></div></section>
    <div class="sect-h mt2"><h2><span class="n">R1</span>Per connection</h2><span class="lab">last ${s.window_days} days</span></div>
    ${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Connection</th><th class="r">Requests</th><th class="r">Saved</th><th class="hm"></th></tr></thead><tbody>
      ${s.per_connection.map((c, i) => `<tr><td class="n">${pad(i + 1)}</td><td><b>${esc(c.tool_label ?? 'Unknown')}</b></td><td class="r">${fmt(c.requests)}</td><td class="r acid">${fmt(c.saved)}</td><td class="hm">${pbar(c.saved, maxC, 16)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">No tool requests in this window.</td></tr>'}
    </tbody></table>`)}`);
  $$('#dseg button').forEach((b) => (b.onclick = () => { svDays = Number(b.dataset.d); savingsView(); }));
  if (motion.gsap) motion.gsap.fromTo($$('.chart .col'), { scaleY: 0, transformOrigin: 'bottom' }, { scaleY: 1, duration: .32, ease: 'expo.out', stagger: .006, clearProps: 'transform' });
}

// ================================================================ people + exposure (A6, O2)
export async function peopleView() {
  const [persons, members] = await Promise.all([api(`/workspaces/${S.ws}/persons`), api(`/workspaces/${S.ws}/members`)]);
  S.persons = persons; S.members = members;
  const role = (p) => members.find((m) => m.id === p.user_id)?.role;
  view(`${head({ n: '09', title: 'People', desc: 'Everyone who speaks in your conversations: members and outside guests. Exposure shows which tools, cards and workspaces can currently hear each person.' })}
    <div class="cols"><div>${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Person</th><th>Kind</th><th class="hm">Contact</th><th class="r"></th></tr></thead><tbody>
      ${persons.map((p, i) => `<tr><td class="n">${pad(i + 1)}</td><td><span style="display:inline-flex;gap:10px;align-items:center"><span class="av ${p.is_external ? 'dim' : ''}">${esc(initials(p.display_name))}</span><b>${esc(p.display_name)}</b>${p.user_id === S.me.user.id ? '<span class="chip acid plain">you</span>' : ''}</span></td>
        <td>${p.is_external ? '<span class="chip restricted">Guest · review links</span>' : `<span class="chip ink">${esc((role(p) ?? 'member').replace('_', ' '))}</span>`}</td><td class="hm">${esc(p.contact_channel ?? '—')}</td>
        <td class="act">${isAdmin() || p.user_id === S.me.user.id ? `<a class="bt xs" href="#people/${p.id}" data-cursor="EXPOSURE">Exposure<span class="ar">→</span></a>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">No people yet.</td></tr>'}
    </tbody></table>`)}</div>
    <aside class="pane"><div class="pane-h"><span>Add a guest</span><i>A6</i></div><div class="pane-b"><p class="hint">Speakers who are not users (customers, guests). They act only through single-use review links.</p>
      <label class="field"><span>Name</span><input id="pn" placeholder="Meera (Client)" ${canEdit() ? '' : 'disabled'}></label><label class="field"><span>Email <i>(optional, encrypted)</i></span><input id="pe" type="email" placeholder="meera@client.com" ${canEdit() ? '' : 'disabled'}></label>
      <button class="bt sm acid full" id="pa" ${canEdit() ? '' : 'disabled'}>${icon('plus', 12)}Add person</button></div></aside></div>`);
  $('#pa').onclick = wrap(async () => { const n = $('#pn').value.trim(); if (!n) throw new Error('Enter a name'); await api(`/workspaces/${S.ws}/persons`, { body: { display_name: n, email: $('#pe').value.trim() || undefined } }); toast(`${n} added`); peopleView(); });
}
export async function personView(id) {
  const x = await api(`/persons/${id}/exposure`);
  const crumb = document.getElementById('crumbX'); if (crumb) crumb.textContent = x.person.toUpperCase();
  const mine = x.your_statements;
  view(`<a class="back" href="#people">${icon('arrowleft', 12)}People</a>${head({ n: '09', label: 'Exposure', title: x.person, desc: `${x.statements_total} statement${x.statements_total === 1 ? '' : 's'} in live conversations. This is who can hear them right now.` })}
    <div class="stats" style="--n:4">${[['allowed', 'acid'], ['team_only', ''], ['held', 'amber'], ['blocked', 'red']].map(([k, c]) => `<div><b class="${c}">${x.by_status[k] ?? 0}</b><span>${k.replace('_', ' ')}</span></div>`).join('')}</div>
    <div class="sect-h mt2"><h2><span class="n">O2</span>Audiences</h2></div>
    ${tw(`<table class="ledger"><thead><tr><th>Audience</th><th>Kind</th><th class="r">Lines</th></tr></thead><tbody>${x.audiences.map((a) => `<tr><td><b>${esc(a.audience)}</b></td><td><span class="chip dim">${esc(a.kind)}</span></td><td class="r">${a.statements}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="3">No connection, card or workspace can currently receive their statements.</td></tr>'}</tbody></table>`)}
    ${mine ? `<div class="sect-h mt2"><h2><span class="n">J3</span>Your lines</h2><span class="lab">Change a decision or revoke a line</span></div>
      ${tw(`<table class="ledger"><thead><tr><th>Conversation</th><th>Line</th><th>Status</th><th class="r"></th></tr></thead><tbody>${mine.map((s) => `<tr class="${s.revoked_at ? 'off' : ''}"><td class="nowrap">${esc(s.conversation)}</td><td class="small">${s.text ? esc(s.text) : '<span class="rd">destroyed line</span>'}</td>
        <td><span class="chip ${s.status === 'allowed' ? 'acid' : s.status === 'held' ? 'amber' : s.status === 'team_only' ? 'ink' : 'red'}">${esc(s.status.replace('_', ' '))}</span></td>
        <td class="act">${s.revoked_at ? '' : `<select data-dec="${s.id}" style="width:auto;height:24px;font-size:10.5px;display:inline-block" aria-label="Decision"><option value="">Decide…</option><option value="allowed">Allow</option><option value="team_only">Team only</option><option value="blocked">Block</option></select> <button class="bt xs red" data-srev="${s.id}">Revoke</button>`}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="4">You have no statements here.</td></tr>'}</tbody></table>`)}` : ''}`, { key: `#people/${id}` });
  $$('[data-dec]').forEach((s) => (s.onchange = wrap(async () => { if (!s.value) return; await api(`/statements/${s.dataset.dec}/decision`, { body: { status: s.value } }); toast('Decision recorded'); personView(id); })));
  $$('[data-srev]').forEach((b) => (b.onclick = wrap(async () => { if (!(await confirmBox({ title: 'Revoke your line?', body: 'It stops being served on the next request and is destroyed. A signed record proves when.', confirm: 'Revoke line', danger: true }))) return; await api(`/statements/${b.dataset.srev}/revoke`, { body: {} }); toast('Line revoked'); personView(id); })));
}

// ================================================================ records (M1-M6)
export async function recordsView() {
  const r = await api(`/workspaces/${S.ws}/records`);
  const counter = new Map();
  for (const x of r) { const m = /^Countersigns ([0-9a-f-]{36})/.exec(x.note ?? ''); if (m) counter.set(m[1], (counter.get(m[1]) ?? 0) + 1); }
  view(`${head({ n: '10', title: 'Records', desc: 'Signed attestations for cross-company shares, consent decisions, unlocks and deletions, anchored on Base through EAS. Content and plain ids never go on chain. Countersign with your own wallet to add a user signature.', actions: isAdmin() ? `<button class="bt sm" id="anc">${icon('stamp', 12)}Anchor batch now</button>` : '' })}
    <div class="stats" style="--n:4"><div><b>${r.length}</b><span>Records</span></div><div><b class="acid">${r.filter((x) => ['onchain', 'anchored'].includes(x.state)).length}</b><span>On chain / anchored</span></div><div><b>${r.filter((x) => x.signer_type === 'user').length}</b><span>User-signed</span></div><div><b id="vOk">·</b><span>Verified on this screen</span></div></div>
    <div class="mt">${tw(`<table class="ledger"><thead><tr><th class="n">No</th><th>Event</th><th>Note</th><th class="hm">Signer</th><th class="hs">State</th><th>Verification</th><th class="hm">When</th><th class="r"></th></tr></thead><tbody>
      ${r.map((x, i) => `<tr data-rec="${x.id}"><td class="n">${pad(r.length - i)}</td><td>${evtStamp(x.event)}</td><td class="small">${esc(x.note ?? x.subject_type ?? '')}${counter.get(x.id) ? ` <span class="chip acid plain">countersigned ×${counter.get(x.id)}</span>` : ''}</td>
        <td class="hm">${x.signer_type === 'user' ? '<span class="chip acid plain">User wallet</span>' : '<span class="dim">Embargo relayer</span>'}</td><td class="hs"><span class="chip ${['onchain', 'anchored'].includes(x.state) ? 'acid' : 'dim'}">${esc(x.state)}</span>${x.tx_hash ? ` <span class="faint small">${esc(x.tx_hash.slice(0, 10))}…</span>` : ''}</td>
        <td><span class="vstat" data-v="${x.id}"><span class="statusdot wait"></span><span class="dim">Checking</span></span></td><td class="hm nowrap">${ago(x.created_at)}</td>
        <td class="act"><a class="bt xs" href="/verify/${x.id}" target="_blank" rel="noopener" data-cursor="VERIFY">Verify${icon('external', 10)}</a><button class="bt xs" data-cs="${x.id}" data-cursor="SIGN">${icon('pen', 10)}Countersign</button>${isAdmin() ? `<button class="bt xs quiet" data-pb="${x.id}">Proof</button>` : ''}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="8">No records yet. Share a card, review a meeting, or revoke a block.</td></tr>'}
    </tbody></table>`)}</div>`);
  if ($('#anc')) $('#anc').onclick = wrap(async () => { const x = await working(() => api(`/workspaces/${S.ws}/records/anchor`, { body: {} })); toast(x.tx ? `Anchored root ${String(x.root).slice(0, 12)}…` : x.reason ?? 'Nothing to anchor', x.tx ? 'ok' : 'info'); recordsView(); });
  $$('[data-cs]').forEach((b) => (b.onclick = () => countersign(b.dataset.cs, () => recordsView())));
  $$('[data-pb]').forEach((b) => (b.onclick = wrap(async () => { const p = await api(`/records/${b.dataset.pb}`); modal(`<div class="md-t">Dispute evidence</div><div class="md-d">Keep this private. Recompute <span class="code-i">subjectHash = HMAC-SHA256(workspace_record_key, subject_preimage)</span> and compare it with the attestation.</div><pre class="code" data-lenis-prevent style="max-height:56vh">${esc(JSON.stringify(p, null, 2))}</pre><div class="md-f"><button class="bt sm" id="cpp">${icon('copy', 12)}Copy JSON</button></div>`, (el) => ($('#cpp', el).onclick = () => copy(JSON.stringify(p, null, 2), 'Proof bundle copied')), { kind: 'paper', label: 'Proof bundle', code: shortId(b.dataset.pb), width: 820 }); })));
  verifyRows(r.slice(0, 80).map((x) => x.id));
}
async function verifyRows(ids) {
  let ok = 0, done = 0;
  const one = async (id) => {
    const el = document.querySelector(`[data-v="${id}"]`); if (!el) return;
    try {
      const v = await api(`/verify/${id}`, { quiet: true });
      const c = v.checks || {};
      const parts = [c.relayer_signature?.valid, c.data_matches_attestation, c.user_signature ? c.user_signature.valid && c.user_signature.bound : undefined, c.merkle?.valid, c.onchain ? c.onchain.found && c.onchain.data_matches : undefined].filter((x) => x !== undefined);
      const good = parts.length && parts.every(Boolean);
      if (good) ok++;
      const label = good ? (c.onchain?.found ? 'Verified on chain' : c.merkle?.valid ? 'Verified · anchored' : 'Signature valid') : 'Mismatch';
      el.innerHTML = `<span class="statusdot ${good ? 'ok' : 'bad'}"></span><span class="${good ? 'acid' : 'red'}">${label}</span>`;
      el.title = Object.entries(c).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n');
    } catch (e) { el.innerHTML = `<span class="statusdot warn"></span><span class="amber">${esc(e.status === 404 ? 'Not found' : 'Unavailable')}</span>`; }
    done++; const n = document.getElementById('vOk'); if (n) n.textContent = `${ok}/${done}`;
  };
  const q = [...ids];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await one(q.shift()); }));
}

// ================================================================ integrations (B5, B6, N1, N2)
export async function integrationsView() {
  const list = await api(`/workspaces/${S.ws}/integrations`);
  const st = (p) => list.find((x) => x.provider === p);
  const badge = (p) => { const s = st(p); return s ? `<span class="chip ${s.status === 'active' ? 'acid' : 'amber'}">${esc(s.status.replace('_', ' '))}</span>` : '<span class="chip dim">Not connected</span>'; };
  const vs = st('viasocket')?.meta || {};
  const FLOWS = ['review.requested', 'suggestion.created', 'access_request.created', 'digest.weekly', 'member.notify', 'security.alert'];
  view(`${head({ n: '11', title: 'Integrations', desc: 'Where context comes from, and where notices and agent actions go.' })}
    <div class="cardgrid">
      <section class="pane"><div class="pane-h"><span>Wispr Notetaker</span>${badge('wispr')}</div><div class="pane-b">
        <p class="hint">Import meetings through Wispr's MCP server. Speakers are mapped and sensitive lines go to consent review.</p>${st('wispr')?.meta?.tools ? `<p class="hint">Tools: <span class="code-i">${esc(st('wispr').meta.tools.join(', '))}</span></p>` : ''}
        <div class="btns"><button class="bt sm acid" id="wc">${st('wispr') ? 'Reconnect' : 'Connect Wispr'}</button><button class="bt sm" id="wl" ${st('wispr') ? '' : 'disabled'}>List meetings</button></div><div id="wmeet"></div></div></section>
      <section class="pane"><div class="pane-h"><span>GitHub</span>${badge('github')}</div><div class="pane-b">
        <p class="hint">Turn READMEs, docs and configs into blocks. Pushes flag blocks that no longer match the repo.</p>
        <label class="field"><span>Fine-grained token <i>(read-only contents)</i></span><input id="ght" type="password" placeholder="github_pat_…" autocomplete="off" ${isAdmin() ? '' : 'disabled'}></label>
        <div class="btns"><button class="bt sm acid" id="ghc" ${isAdmin() ? '' : 'disabled'}>Save token</button><button class="bt sm" id="ghi">Import repo</button></div></div></section>
    </div>
    <section class="pane mt"><div class="pane-h"><span>viaSocket</span>${badge('viasocket')}</div><div class="pane-b">
      <p class="hint">Review links and desk notices to Slack, WhatsApp or email, and agent actions through <span class="code-i">perform_action</span>. Payloads carry hints and links only. Leave a field empty to keep it as it is.</p>
      <div class="cols half"><div class="stack" style="gap:8px"><span class="lab">Notice flows · webhook URLs</span>${FLOWS.map((k) => `<label class="field"><span>${k}${vs.flows?.includes(k) ? ' <b class="acid">· configured</b>' : ''}</span><input data-flow="${k}" placeholder="${vs.flows?.includes(k) ? 'configured · enter to replace' : 'https://flow.viasocket.com/…'}"></label>`).join('')}</div>
        <div class="stack" style="gap:8px;align-content:start"><span class="lab">Action flows · audience decides the leak check</span>${['post_message', 'create_page', 'send_email', 'post_tweet'].map((k) => `<div class="fgrid" style="grid-template-columns:minmax(0,1fr) 110px"><label class="field"><span>${k}${vs.actions?.includes(k) ? ' <b class="acid">· configured</b>' : ''}</span><input data-act="${k}" placeholder="${vs.actions?.includes(k) ? 'configured · enter to replace' : 'https://…'}"></label><label class="field"><span>Audience</span><select data-aud="${k}">${['team', 'public', 'external'].map((a) => `<option ${(k === 'send_email' ? 'external' : k === 'post_tweet' ? 'public' : 'team') === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label></div>`).join('')}
          <label class="field"><span>Shared secret <i>(sent as x-embargo-secret)</i></span><input id="vsec" type="password" autocomplete="off"></label></div></div>
      <div class="btns end"><button class="bt sm acid" id="vss" ${isAdmin() ? '' : 'disabled'}>Save flows</button></div></div></section>`);
  $('#wc').onclick = wrap(async () => { const r = await api(`/workspaces/${S.ws}/integrations/wispr/connect`, { body: {} }); if (r.authorize_url) location.href = r.authorize_url; else { toast(`Wispr connected: ${r.tools?.length ?? 0} tools found`); integrationsView(); } });
  $('#wl').onclick = wrap(async () => {
    const box = $('#wmeet'); box.innerHTML = '<div class="ld"></div>';
    const m = await api(`/workspaces/${S.ws}/integrations/wispr/meetings`).catch((e) => { box.innerHTML = `<p class="hint red">${esc(e.message)}</p>`; return null; });
    if (!m) return;
    box.innerHTML = m.length ? `<div class="coll-list" data-lenis-prevent style="max-height:260px">${m.map((x) => `<div class="inrow" style="align-items:center;padding:6px 0;border-bottom:1px dashed var(--line-2)"><span class="grow small"><b>${esc(x.title)}</b><br><span class="dim">${esc(x.date ?? '')} · ${(x.attendees || []).length} attendees</span></span><button class="bt xs" data-imp="${esc(x.id)}" data-t="${esc(x.title)}">Import</button></div>`).join('')}</div>` : '<p class="hint">No meetings found.</p>';
    enhance(box);
    $$('[data-imp]', box).forEach((b) => (b.onclick = wrap(async () => { const r = await api(`/workspaces/${S.ws}/integrations/wispr/import`, { body: { meeting_id: b.dataset.imp, title: b.dataset.t } }); toast('Meeting import queued'); S.processing++; status(); go(`blocks/${r.block_id}`); })));
  });
  const L = () => import('/static/assets/app-blocks.js');
  $('#ghc').onclick = wrap(async () => { const t = $('#ght').value.trim(); if (!t) throw new Error('Paste a GitHub token'); await api(`/workspaces/${S.ws}/integrations/github/connect`, { body: { token: t } }); toast('GitHub connected'); integrationsView(); });
  $('#ghi').onclick = () => L().then((m) => m.composer('github'));
  $('#vss').onclick = wrap(async () => {
    const secret = $('#vsec').value || undefined;
    const flows = Object.fromEntries($$('[data-flow]').filter((i) => i.value.trim()).map((i) => [i.dataset.flow, { url: i.value.trim(), secret }]));
    const actions = Object.fromEntries($$('[data-act]').filter((i) => i.value.trim()).map((i) => [i.dataset.act, { url: i.value.trim(), secret, audience: $(`[data-aud="${i.dataset.act}"]`).value }]));
    if (!Object.keys(flows).length && !Object.keys(actions).length) throw new Error('Enter at least one flow URL');
    await api(`/workspaces/${S.ws}/integrations/viasocket`, { body: { flows, actions } }); toast('viaSocket flows saved'); integrationsView();
  });
}

// ================================================================ workspace settings
const SUGG_TYPES = ['update', 'contradiction', 'stale', 'duplicate', 'gap', 'rule', 'expiry', 'onboarding', 'quality'];
export async function settingsView() {
  const [w, members, billing, invites] = await Promise.all([api(`/workspaces/${S.ws}`), api(`/workspaces/${S.ws}/members`), isAdmin() ? api(`/workspaces/${S.ws}/billing`).catch(() => null) : null, isAdmin() ? api(`/workspaces/${S.ws}/invites`).then((r) => r.invites).catch(() => []) : []]);
  S.wsInfo = { ...S.wsInfo, ...w }; S.members = members;
  const st = w.settings || {};
  const A = isAdmin();
  const dis = A ? '' : 'disabled';
  const thr = Number(st.auto_apply_threshold ?? .85);
  const ub = (v, max) => { const on = max ? Math.round(Math.min(1, v / max) * 20) : 0; return `<div class="ublocks">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? (on >= 18 ? 'hot' : 'on') : ''}"></i>`).join('')}</div>`; };
  view(`${head({ n: '12', label: 'Workspace', title: w.name, desc: `Opened ${esc(date(w.created_at))}. Workspace id <span class="code-i" id="wsid" role="button" tabindex="0" data-cursor="COPY">${w.id}</span>`, meta: `${esc(w.plan)} plan · you are ${esc(w.role.replace('_', ' '))}` })}
    <div class="cols w380"><div class="stack">
      <div class="sect-h"><h2><span class="n">A4</span>Members</h2><span class="lab">${members.length} / ${w.limits.members}</span></div>
      ${tw(`<table class="ledger"><thead><tr><th>Member</th><th>Role</th><th class="r"></th></tr></thead><tbody>${members.map((m) => `<tr><td><span style="display:inline-flex;gap:10px;align-items:center"><span class="av ${m.role === 'owner' ? 'acid' : ''}">${esc(initials(m.display_name))}</span><span><b>${esc(m.display_name)}</b>${m.id === S.me.user.id ? ' <span class="chip acid plain">you</span>' : ''}<br><span class="dim small">${esc(m.email ?? '')}</span></span></span></td>
        <td>${w.role === 'owner' && m.role !== 'owner' ? `<select data-role="${m.id}" style="width:auto;height:28px;font-size:11px" aria-label="Role">${['context_admin', 'editor', 'viewer'].map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r.replace('_', ' ')}</option>`).join('')}</select>` : `<span class="chip ${m.role === 'owner' ? 'acid' : m.role === 'context_admin' ? 'restricted' : 'ink'}">${esc(m.role.replace('_', ' '))}</span>`}</td>
        <td class="act">${A && m.role !== 'owner' && m.id !== S.me.user.id ? `<button class="bt xs red" data-rm="${m.id}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table>`)}
      ${A ? `<div class="sect-h mt2"><h2><span class="n">A5</span>Invites</h2><span class="lab">${invites.length} pending</span></div>
        <div class="pane"><div class="pane-b"><div class="fgrid" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;align-items:end">
          <label class="field"><span>Email <i>(optional: leave empty for a link anyone can use once)</i></span><input id="ie" type="email" placeholder="teammate@company.com"></label>
          <label class="field"><span>Role</span><select id="ir"><option value="editor">Editor</option><option value="context_admin">Context admin (founder's office)</option><option value="viewer">Viewer</option></select></label>
          <button class="bt sm acid" id="ia" style="height:36px">${icon('send', 12)}Create invite</button></div><div id="iout"></div></div></div>
        ${tw(`<table class="ledger"><thead><tr><th>Invite</th><th>Role</th><th class="hm">By</th><th class="hs">Expires</th><th class="r"></th></tr></thead><tbody>${invites.map((v) => `<tr data-inv="${v.id}"><td>${v.email ? `<b>${esc(v.email)}</b>` : '<span class="chip ink plain">Link only</span>'}<br><span class="dim small">created ${esc(ago(v.created_at))}</span></td><td><span class="chip ${v.role === 'context_admin' ? 'restricted' : 'ink'}">${esc(v.role.replace('_', ' '))}</span></td><td class="hm">${esc(v.created_by ?? '—')}</td><td class="hs nowrap">${esc(date(v.expires_at))}</td>
          <td class="act">${v.link ? `<button class="bt xs" data-cpi="${v.id}">${icon('copy', 10)}Copy link</button>` : ''}<button class="bt xs red" data-rvi="${v.id}">Revoke</button></td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">No pending invites.</td></tr>'}</tbody></table>`)}` : ''}
      ${isOwner() ? `<div class="sect-h mt2"><h2><span class="n">K2</span>Danger zone</h2></div>
        <section class="pane danger"><div class="pane-h"><span>Delete workspace</span><i>Owner only</i></div><div class="pane-b">
          <p class="hint">Crypto-shreds every data key of <b>${esc(w.name)}</b>: blocks, statements, originals, facts and backups become permanently unreadable. Signed deletion certificates are written. Members lose access immediately.</p>
          <button class="bt sm red" id="wdel" data-cursor="SHRED">${icon('trash', 12)}Delete ${esc(w.name)}…</button></div></section>` : ''}
    </div>
    <aside class="stack">
      <div class="pane"><div class="pane-h"><span>Profile</span><i>You</i></div><div class="pane-b">
        <label class="field"><span>Display name</span><input id="pdn" value="${esc(S.me.user.display_name)}"></label>
        <div class="kv"><span>Email</span><span>${esc(S.me.user.email ?? '—')}</span><span>Wallet</span><span>${S.me.user.wallet_address ? `<span class="code-i">${esc(S.me.user.wallet_address.slice(0, 8))}…${esc(S.me.user.wallet_address.slice(-6))}</span>` : '<span class="dim">Set when you countersign a record</span>'}</span></div>
        <button class="bt sm full" id="psave">Save profile</button></div></div>
      ${A ? `<div class="pane"><div class="pane-h"><span>Workspace name</span></div><div class="pane-b"><div class="inrow"><input id="wname" value="${esc(w.name)}" aria-label="Workspace name"><button class="bt sm" id="wren">Rename</button></div></div></div>` : ''}
      <div class="pane"><div class="pane-h"><span>Consent defaults</span><i>J1 · J5</i></div><div class="pane-b">
        <label class="field"><span>Review</span><select id="s1" ${dis}><option value="flagged" ${st.review_mode !== 'all' ? 'selected' : ''}>Only flagged lines</option><option value="all" ${st.review_mode === 'all' ? 'selected' : ''}>Every line</option></select></label>
        <label class="field"><span>If nobody answers</span><select id="s2" ${dis}><option value="blocked" ${st.unreviewed_default !== 'held' ? 'selected' : ''}>Block from AI</option><option value="held" ${st.unreviewed_default === 'held' ? 'selected' : ''}>Keep waiting</option></select></label>
        <label class="field"><span>Deadline (hours)</span><input id="s3" type="number" min="1" max="720" value="${st.review_deadline_hours ?? 48}" ${dis}></label></div></div>
      <div class="pane"><div class="pane-h"><span>${esc(AGENT.name)} auto-apply</span><i>F14</i></div><div class="pane-b">
        <p class="hint">Checked suggestion types are applied without review when ${esc(AGENT.name)}'s confidence is at or above the threshold.</p>
        <div class="fgrid c2" style="gap:6px">${SUGG_TYPES.map((k) => `<label class="check"><input type="checkbox" data-auto="${k}" ${st.auto_apply?.[k] ? 'checked' : ''} ${dis}> ${k}</label>`).join('')}</div>
        <label class="field"><span>Confidence threshold</span><div class="thr"><input type="range" class="rng" id="thr" min="0.5" max="1" step="0.01" value="${thr}" ${dis} aria-label="Auto-apply confidence threshold"><b id="thrv">${Math.round(thr * 100)}%</b></div></label>
        <button class="bt sm acid full" id="ss" ${dis}>Save settings</button></div></div>
      ${billing ? `<div class="pane"><div class="pane-h"><span>${esc(billing.plan)} plan</span><i>Q2</i></div><div class="pane-b">
        ${[['Blocks', w.counts.active_blocks, w.limits.blocks], ['Members', w.counts.members, w.limits.members], ['Connections', w.counts.connections, w.limits.connections]].map(([k, v, m]) => `<div class="usage"><div class="row"><span>${k}</span><span>${v} / ${m}</span></div>${ub(v, m)}</div>`).join('')}
        ${w.role === 'owner' && billing.plan !== 'team' ? `<button class="bt sm acid full" id="up">Upgrade to Team<span class="ar">→</span></button><p class="hint">Checkout runs on Dodo Payments.</p>` : `<p class="hint">Status ${esc(billing.status ?? 'active')}${billing.current_period_end ? ` · renews ${esc(date(billing.current_period_end))}` : ''}</p>`}</div></div>` : ''}
    </aside></div>`);
  $('#wsid').onclick = () => copy(w.id, 'Workspace id copied');
  $('#psave').onclick = wrap(async () => { const n = $('#pdn').value.trim(); if (!n) throw new Error('Name cannot be empty'); await api('/me', { method: 'PATCH', body: { display_name: n } }); S.me.user.display_name = n; toast('Profile saved'); S.hooks.reloadWorkspace?.(); });
  if ($('#wren')) $('#wren').onclick = wrap(async () => { const n = $('#wname').value.trim(); if (!n) throw new Error('Name cannot be empty'); await api(`/workspaces/${S.ws}`, { method: 'PATCH', body: { name: n } }); S.me = await api('/me'); toast('Workspace renamed'); S.hooks.reloadWorkspace?.(); });
  $$('[data-role]').forEach((s) => (s.onchange = wrap(async () => { await api(`/workspaces/${S.ws}/members/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }); toast(`Role changed to ${s.value.replace('_', ' ')}`); })));
  $$('[data-rm]').forEach((b) => (b.onclick = wrap(async () => { const m = members.find((x) => x.id === b.dataset.rm); if (!(await confirmBox({ title: `Remove ${m.display_name}?`, body: 'They lose access and their tool connections are revoked.', confirm: 'Remove member', danger: true }))) return; await api(`/workspaces/${S.ws}/members/${b.dataset.rm}`, { method: 'DELETE' }); toast('Member removed'); settingsView(); })));
  const thrEl = $('#thr'); if (thrEl) thrEl.oninput = () => { $('#thrv').textContent = `${Math.round(Number(thrEl.value) * 100)}%`; };
  if ($('#ss')) $('#ss').onclick = wrap(async () => {
    const r = await api(`/workspaces/${S.ws}`, { method: 'PATCH', body: { settings: { review_mode: $('#s1').value, unreviewed_default: $('#s2').value, review_deadline_hours: Number($('#s3').value) || 48, auto_apply: Object.fromEntries($$('[data-auto]').map((c) => [c.dataset.auto, c.checked])), auto_apply_threshold: Number(thrEl.value) } } });
    S.wsInfo.settings = r.settings; toast(`Settings saved · auto-apply at ${Math.round(r.settings.auto_apply_threshold * 100)}%`);
  });
  if ($('#up')) $('#up').onclick = wrap(async () => { const r = await api('/billing/checkout', { body: { workspace_id: S.ws } }); location.href = r.checkout_url; });
  // invites
  if ($('#ia')) $('#ia').onclick = wrap(async () => {
    const email = $('#ie').value.trim();
    const r = await api(`/workspaces/${S.ws}/invites`, { body: { email: email || undefined, role: $('#ir').value } });
    toast(email ? (r.emailed ? `Invite emailed to ${email}` : `Invite created for ${email}. Email delivery is not configured: send the link yourself.`) : 'Invite link created');
    await settingsView();
    const out = $('#iout');
    if (out) { out.innerHTML = `<label class="field mt"><span>Invite link · valid 7 days</span><div class="secret"><code>${esc(r.invite_link)}</code><button class="bt sm acid" id="icp">${icon('copy', 12)}Copy</button></div></label>`; $('#icp').onclick = () => copy(r.invite_link, 'Invite link copied'); $(`[data-inv="${r.id}"]`)?.classList.add('hl'); }
  });
  $$('[data-cpi]').forEach((b) => (b.onclick = () => copy(invites.find((v) => v.id === b.dataset.cpi).link, 'Invite link copied')));
  $$('[data-rvi]').forEach((b) => (b.onclick = wrap(async () => { if (!(await confirmBox({ title: 'Revoke this invite?', body: 'The link stops working immediately.', confirm: 'Revoke invite', danger: true }))) return; await api(`/invites/${b.dataset.rvi}`, { method: 'DELETE' }); toast('Invite revoked'); settingsView(); })));
  // delete workspace
  if ($('#wdel')) $('#wdel').onclick = wrap(async () => {
    const ok = await confirmBox({ title: `Delete ${w.name}?`, danger: true, type: w.name, confirm: 'Shred keys & delete', label: 'Irreversible',
      body: `Every data key of this workspace is destroyed. Blocks, statements, originals and backups become permanently unreadable. ${esc(AGENT.name)} writes a signed deletion certificate for each block.` });
    if (!ok) return;
    const r = await working(() => api(`/workspaces/${S.ws}`, { method: 'DELETE', body: { confirm: w.name } }));
    const gone = S.ws;
    modal(`<div class="shk"><span class="stamp red thunk" style="font-size:24px;border-width:3px">Shredded</span><div class="dot" data-count="${r.shredded_keys}">0</div><span class="lab">Data keys destroyed</span></div>
      <div class="md-d">${esc(w.name)} is gone. ${r.record_ids.length} deletion certificate${r.record_ids.length === 1 ? '' : 's'} were signed:</div>
      <div class="tw"><table class="ledger"><tbody>${r.record_ids.map((id, i) => `<tr><td class="n">${pad(i + 1)}</td><td class="small">${esc(id)}</td><td class="act"><a class="bt xs" href="/verify/${esc(id)}" target="_blank" rel="noopener">Verify${icon('external', 10)}</a></td></tr>`).join('')}</tbody></table></div>
      <div class="md-f"><button class="bt sm acid" data-x>Continue</button></div>`, (el, close) => { $('[data-x]', el).onclick = close; }, {
      kind: 'paper', label: 'Deletion certificate', code: 'K4', width: 620,
      onClose: async () => { S.me = await api('/me'); S.ws = S.me.workspaces.find((x) => x.id !== gone)?.id ?? null; localStorage.ws = S.ws ?? ''; history.replaceState(null, '', '#library'); S.hooks.restart?.(); },
    });
  });
}
