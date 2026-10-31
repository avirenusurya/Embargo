// Sealed vault (H4/H5, Part 13.4-13.5): client-side encrypted blocks. The workspace sealed key (WSK) lives in IndexedDB,
// wrapped by a non-extractable WebCrypto key; the device X25519 private key is a non-extractable CryptoKey. Embargo stores
// ciphertext + wrapped keys only. Search runs over plaintext held in memory in this tab.
import { $, $$, esc, fmt, pad, ago, date, api, S, AGENT, icon, toast, wrap, busy, modal, confirmBox, view, enhance, cleanup, head, eye, eyeInk, wsay, empty, canEdit, go, working, docId, shortId, barcode, copy, tw, errMsg } from '/static/assets/app-core.js';
import * as K from '/static/assets/app-sealcrypto.js';

const RECOVERY_PUB = 'recovery:hkdf-sha256:aes-256-gcm:v1';
// ---------------------------------------------------------------- IndexedDB
const DB = 'embargo-sealed', STORE = 'keys';
function idb() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => { db.close(); res(out?.result); }; t.onerror = () => { db.close(); rej(t.error); }; }); }
const slot = () => `${S.me.user.id}:${S.ws}`;
const getLocal = () => tx('readonly', (s) => s.get(slot()));
const putLocal = (v) => tx('readwrite', (s) => s.put(v, slot()));
const delLocal = () => tx('readwrite', (s) => s.delete(slot()));
async function storeWsk(rec, wsk) { const wrapKey = rec.wrapKey ?? await K.newLocalWrapKey(); const sealed = await K.sealLocal(wrapKey, wsk); await putLocal({ ...rec, wrapKey, wsk: sealed, pending: false, enrolledAt: new Date().toISOString() }); }
async function withWsk(fn) {
  const rec = await getLocal(); if (!rec?.wsk) throw new Error('This browser holds no sealed key');
  const wsk = await K.openLocal(rec.wrapKey, rec.wsk);
  try { return await fn(wsk, rec); } finally { wsk.fill(0); }
}
const browserLabel = () => { const ua = navigator.userAgent; const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; const os = /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : ''; return `${b}${os ? ` on ${os}` : ''}`; };

// ---------------------------------------------------------------- in-memory decrypted index
const plain = new Map(); // block id → { title, text }
let plainWs = null;
const tokens = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
function search(q) {
  const terms = tokens(q); if (!terms.length) return [];
  const out = [];
  for (const [id, d] of plain) {
    const hay = `${d.title}\n${d.text}`.toLowerCase();
    let score = 0, all = true;
    for (const t of terms) { const n = hay.split(t).length - 1; if (!n) { all = false; break; } score += n + (d.title.toLowerCase().includes(t) ? 5 : 0); }
    if (all) out.push({ id, score, ...d });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}
function snippet(text, q) {
  const terms = tokens(q); const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((t) => { const i = low.indexOf(t); return i < 0 ? 1e9 : i; })) - 60);
  let s = esc((at > 0 ? '… ' : '') + text.slice(at, at + 220) + (text.length > at + 220 ? ' …' : ''));
  for (const t of terms) s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return s;
}

// ---------------------------------------------------------------- view
let pollT = 0;
export async function vaultView(id) {
  clearTimeout(pollT);
  if (plainWs !== S.ws) { plain.clear(); plainWs = S.ws; }
  if (!globalThis.crypto?.subtle || !window.indexedDB) return view(`${head({ n: '04', title: 'Sealed vault' })}${wsay('This browser has no WebCrypto or IndexedDB. Sealed blocks need both; use a current browser or the local MCP package.', { state: 'alert', tone: 'red' })}`);
  const [rec, devices, list] = await Promise.all([getLocal().catch(() => null), api(`/workspaces/${S.ws}/devices`), api(`/workspaces/${S.ws}/sealed-blocks`)]);
  const mineServer = rec?.deviceId ? devices.find((d) => d.id === rec.deviceId) : null;
  if (rec?.wsk) return id ? openView(id, rec, devices) : openVault(rec, devices, list);
  if (rec?.pending && mineServer) return pendingView(rec, mineServer, devices);
  return setupView(devices, list);
}

function vaultHead(sub, right = '') {
  return `${head({ n: '04', title: 'Sealed vault', desc: `Zero-access storage. Blocks are encrypted in this browser before upload; Embargo stores ciphertext only and cannot compress, search or answer from them. ${esc(AGENT.name)} never sees the key.` })}
    <section class="vault-h"><span class="lockbox">${icon('vault', 24)}</span><div><div class="t">${sub}</div><div class="d">Keys: workspace sealed key (AES-256-GCM) wrapped per device with X25519, plus an offline recovery key. Same formats as the local <span class="code-i">embargo-mcp</span> package.</div></div><div class="btns">${right}</div></section>`;
}

// ---------------- not enrolled
function setupView(devices, list) {
  const exists = devices.some((d) => d.wrapped_wsk);
  const hasRecovery = devices.some((d) => d.label === 'recovery' && d.wrapped_wsk);
  view(`${vaultHead(exists ? 'This browser is not enrolled' : 'No sealed key yet', '')}
    <div class="cols"><div class="stack">
      ${exists ? wsay(`Your sealed key already exists on ${devices.filter((d) => d.wrapped_wsk && d.label !== 'recovery').length} device(s)${hasRecovery ? ' and in your recovery key' : ''}. Bring it here with the recovery key, or ask one of your enrolled devices to approve this browser.`, { state: 'held', tone: 'amber' })
        : wsay(`Create the workspace sealed key on this browser. I'll show a recovery key once: store it offline. Without a device or the recovery key, sealed content cannot be recovered by anyone, including Embargo.`, { state: 'watch' })}
      <div class="cardgrid">
        ${!exists ? `<section class="pane acid"><div class="pane-h"><span>Create sealed key</span><i>First device</i></div><div class="pane-b"><p class="hint">Generates a 256-bit key in this browser, wraps it with a recovery key and enrols this browser as a device.</p><button class="bt sm acid full" id="mk" ${canEdit() ? '' : 'disabled'}>${icon('key', 12)}Create sealed key</button></div></section>` : ''}
        <section class="pane"><div class="pane-h"><span>Recover with recovery key</span><i>${hasRecovery ? 'Available' : 'No recovery wrap'}</i></div><div class="pane-b"><label class="field"><span>Recovery key</span><input id="rk" placeholder="43 characters" autocomplete="off" spellcheck="false" ${hasRecovery ? '' : 'disabled'}></label><button class="bt sm full" id="rkgo" ${hasRecovery ? '' : 'disabled'}>Unwrap key here</button></div></section>
        <section class="pane"><div class="pane-h"><span>Approve from another device</span><i>X25519</i></div><div class="pane-b"><label class="field"><span>Name this device</span><input id="dl" value="${esc(browserLabel())}"></label><button class="bt sm full" id="rq" ${exists ? '' : 'disabled'}>${icon('device', 12)}Request approval</button><p class="hint">An enrolled browser approves it in its Sealed vault, or run <span class="code-i">embargo-mcp sealed-device-approve &lt;id&gt;</span>.</p></div></section>
      </div></div>
      <aside class="stack">${devicesPane(devices, null, false)}<div class="pane"><div class="pane-h"><span>Sealed blocks</span><i>${list.length}</i></div><div class="pane-b"><p class="hint">${list.length ? `${list.length} sealed block(s) exist in this workspace. Enrol this browser to open them.` : 'None yet.'}</p></div></div></aside></div>`);
  if ($('#mk')) $('#mk').onclick = wrap(createKey);
  $('#rkgo').onclick = wrap(async () => {
    const key = $('#rk').value.trim(); if (!key) throw new Error('Paste your recovery key');
    const r = devices.find((d) => d.label === 'recovery' && d.wrapped_wsk);
    let wsk; try { wsk = await K.unwrapWithRecovery(r.wrapped_wsk, key); } catch { throw new Error('That recovery key does not unwrap your sealed key'); }
    try { await enrolWithKey(wsk, browserLabel()); } finally { wsk.fill(0); }
    toast('Sealed key recovered. This browser is enrolled.'); vaultView();
  });
  $('#rq').onclick = wrap(async () => {
    const kp = await K.deviceKeypair();
    const label = $('#dl').value.trim() || browserLabel();
    const d = await api(`/workspaces/${S.ws}/devices`, { body: { label, public_key: kp.publicKey } });
    await putLocal({ deviceId: d.device_id, privateKey: kp.privateKey, publicKey: kp.publicKey, label, pending: true, requestedAt: new Date().toISOString() });
    toast('Approval requested'); vaultView();
  });
}
async function enrolWithKey(wsk, label) {
  const kp = await K.deviceKeypair();
  const d = await api(`/workspaces/${S.ws}/devices`, { body: { label, public_key: kp.publicKey, wrapped_wsk: await K.wrapToDevice(wsk, kp.publicKey) } });
  await storeWsk({ deviceId: d.device_id, privateKey: kp.privateKey, publicKey: kp.publicKey, label }, wsk);
}
async function createKey() {
  const wsk = K.generateWsk();
  const rec = K.generateRecoveryKey();
  modal(`<div class="md-t">Your recovery key</div><div class="md-d">Shown once. Store it offline (password manager, printed copy). It is the only way to restore sealed content on a new device if every enrolled device is lost.</div>
    <div class="reckey"><span class="lab" style="color:#8a5300">Recovery key · ${esc(S.wsInfo?.name ?? '')}</span><code id="rkv">${esc(rec)}</code><div class="btns"><button class="bt sm" id="rkc">${icon('copy', 12)}Copy</button><button class="bt sm" id="rkd">${icon('download', 12)}Download .txt</button></div></div>
    <label class="check"><input type="checkbox" id="rks"> <span><b>I stored the recovery key offline.</b> Embargo cannot show it again.</span></label>
    <div class="md-f"><button class="bt sm" data-x>Cancel</button><button class="bt sm acid" id="rkok" disabled>Seal the vault<span class="ar">→</span></button></div>`, (el, close) => {
    $('#rkc', el).onclick = () => copy(rec, 'Recovery key copied');
    $('#rkd', el).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`EMBARGO SEALED VAULT RECOVERY KEY\nWorkspace: ${S.wsInfo?.name} (${S.ws})\nUser: ${S.me.user.email ?? S.me.user.display_name}\nCreated: ${new Date().toISOString()}\n\n${rec}\n\nRestore: Sealed vault → Recover with recovery key, or embargo-mcp sealed-recover <KEY>\n`], { type: 'text/plain' })); a.download = `embargo-recovery-${S.ws.slice(-6)}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    $('#rks', el).onchange = (e) => ($('#rkok', el).disabled = !e.target.checked);
    $('[data-x]', el).onclick = close;
    $('#rkok', el).onclick = wrap(async () => {
      const restore = busy($('#rkok', el), 'Sealing');
      try {
        await working(async () => {
          await api(`/workspaces/${S.ws}/devices`, { body: { label: 'recovery', public_key: RECOVERY_PUB, wrapped_wsk: await K.wrapWithRecovery(wsk, rec) } });
          await enrolWithKey(wsk, browserLabel());
        });
      } finally { restore(); wsk.fill(0); }
      close(); toast('Vault sealed. This browser holds the key.'); vaultView();
    });
  }, { kind: 'paper', label: 'Recovery key', code: 'SHOWN ONCE', width: 600, onClose: () => wsk.fill(0) });
}

// ---------------- waiting for approval
function pendingView(rec, mine, devices) {
  view(`${vaultHead('Waiting for approval', `<button class="bt sm" id="fg">Cancel request</button>`)}
    <div class="cols"><div class="stack">${wsay(`This browser asked to join as <b>${esc(rec.label)}</b>. On an enrolled device open the Sealed vault and approve it, or run:<br><span class="code-i">npx -y embargo-mcp --token &lt;T&gt; --api ${esc(location.origin)} sealed-device-approve ${esc(mine.id)}</span><br>I check every few seconds.`, { state: 'think' })}
      <div class="pane"><div class="pane-h"><span>Device request</span><i>${esc(shortId(mine.id))}</i></div><div class="pane-b"><div class="kv"><span>Device id</span><span class="code-i">${esc(mine.id)}</span><span>Public key</span><span class="small" style="word-break:break-all">${esc(rec.publicKey.slice(0, 64))}…</span><span>Requested</span><span>${esc(ago(mine.created_at))}</span></div>
        <div class="btns"><button class="bt sm acid" id="fin">${icon('refresh', 12)}Check now</button><button class="bt sm" id="cpid">${icon('copy', 12)}Copy device id</button></div></div></div></div>
      <aside>${devicesPane(devices, rec.deviceId, false)}</aside></div>`);
  const finish = async (manual) => {
    const ds = await api(`/workspaces/${S.ws}/devices`, { quiet: true });
    const me = ds.find((d) => d.id === rec.deviceId);
    if (!me?.wrapped_wsk) { if (manual) toast('Not approved yet', 'info'); return false; }
    const wsk = await K.unwrapOnDevice(me.wrapped_wsk, rec.privateKey);
    try { await storeWsk(rec, wsk); } finally { wsk.fill(0); }
    toast('Approved. This browser now holds the sealed key.'); vaultView(); return true;
  };
  $('#fin').onclick = wrap(() => finish(true));
  $('#cpid').onclick = () => copy(mine.id, 'Device id copied');
  $('#fg').onclick = wrap(async () => { await delLocal(); toast('Request cancelled on this browser', 'info'); vaultView(); });
  const tick = async () => { if (!location.hash.startsWith('#sealed') && !location.hash.startsWith('#vault')) return; try { if (await finish(false)) return; } catch (e) { console.warn(e); } pollT = setTimeout(tick, 4000); };
  pollT = setTimeout(tick, 4000);
}

// ---------------- devices pane
function devicesPane(devices, thisId, canApprove) {
  const rows = devices.map((d) => {
    const rec = d.label === 'recovery';
    const pending = !d.wrapped_wsk;
    return `<tr class="${d.id === thisId ? 'hl' : ''}"><td>${rec ? `${icon('key', 11)} <b>Recovery key wrap</b>` : `${icon('device', 11)} <b>${esc(d.label)}</b>${d.id === thisId ? ' <span class="chip acid plain">this browser</span>' : ''}`}<br><span class="dim small">${esc(ago(d.created_at))}</span></td>
      <td>${pending ? '<span class="chip amber">Pending</span>' : '<span class="chip acid">Approved</span>'}</td><td class="act">${pending && canApprove ? `<button class="bt xs acid" data-appr="${d.id}" data-cursor="APPROVE">Approve</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="pane"><div class="pane-h"><span>Your devices</span><i>${devices.length}</i></div>${tw(`<table class="ledger"><tbody>${rows || '<tr class="empty-row"><td colspan="3">No devices yet.</td></tr>'}</tbody></table>`, 'bare')}</div>`;
}

// ---------------- vault open
async function decryptAll(list) {
  const todo = list.filter((b) => !plain.has(b.id) || plain.get(b.id).at !== b.updated_at);
  if (!todo.length) return;
  await withWsk(async (wsk) => {
    const q = [...todo];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (q.length) {
        const b = q.shift();
        try { const s = await api(`/sealed-blocks/${b.id}`, { quiet: true }); plain.set(b.id, { title: s.title, text: await K.decryptSealed(wsk, s), at: b.updated_at }); }
        catch (e) { plain.set(b.id, { title: b.title, text: null, at: b.updated_at, err: e.name === 'OperationError' ? 'Sealed with another key' : errMsg(e) }); }
      }
    }));
  });
}
async function openVault(rec, devices, list) {
  const pend = devices.filter((d) => !d.wrapped_wsk && d.label !== 'recovery');
  view(`${vaultHead(`Unsealed in this browser · ${esc(rec.label)}`, `<button class="bt sm acid" id="nsb" ${canEdit() ? '' : 'disabled'}>${icon('plus', 12)}New sealed block</button>`)}
    <div class="cols"><div class="stack">
      <div class="toolbar" style="margin:0"><label class="search">${icon('search', 13)}<input type="search" id="sq" placeholder="Search decrypted sealed blocks · runs in this browser only" aria-label="Search sealed blocks"></label><span class="lab" id="sidx">Decrypting…</span></div>
      <div id="shits"></div>
      <div id="slist">${tw('<table class="ledger"><tbody><tr class="empty-row"><td><div class="ld"></div></td></tr></tbody></table>')}</div>
    </div><aside class="stack">
      ${pend.length ? `<div class="pane amber"><div class="pane-h"><span>Approval needed</span><i>${pend.length}</i></div><div class="pane-b"><p class="hint">Approving encrypts the sealed key to that device's public key (X25519). Only approve devices you just set up yourself.</p></div></div>` : ''}
      ${devicesPane(devices, rec.deviceId, true)}
      <div class="pane"><div class="pane-h"><span>This browser</span><i>${esc(shortId(rec.deviceId))}</i></div><div class="pane-b"><div class="kv"><span>Enrolled</span><span>${esc(ago(rec.enrolledAt))}</span><span>Key storage</span><span>IndexedDB, wrapped by a non-extractable key</span></div>
        <button class="bt sm red full" id="forget">Forget key on this browser</button></div></div>
    </aside></div>`);
  $('#nsb').onclick = () => newSealed();
  $$('[data-appr]').forEach((b) => (b.onclick = wrap(async () => {
    const d = devices.find((x) => x.id === b.dataset.appr);
    if (!(await confirmBox({ title: `Approve “${d.label}”?`, body: `It will be able to open every sealed block you can open. Device id <span class="code-i">${esc(d.id)}</span>, requested ${esc(ago(d.created_at))}.`, confirm: 'Approve device' }))) return;
    await withWsk(async (wsk) => api(`/workspaces/${S.ws}/devices/${d.id}/approve`, { body: { wrapped_wsk: await K.wrapToDevice(wsk, d.public_key) } }));
    toast(`${d.label} approved`); vaultView();
  })));
  $('#forget').onclick = wrap(async () => { if (!(await confirmBox({ title: 'Forget the key here?', body: 'This browser stops being able to open sealed blocks. Your other devices and the recovery key are unaffected.', confirm: 'Forget key', danger: true }))) return; await delLocal(); plain.clear(); toast('Key removed from this browser', 'info'); vaultView(); });
  await decryptAll(list);
  renderSealedList(list);
  const sq = $('#sq');
  let t; sq.oninput = () => { clearTimeout(t); t = setTimeout(() => renderHits(sq.value), 120); };
}
function renderSealedList(list) {
  const box = $('#slist'); if (!box) return;
  const okN = list.filter((b) => plain.get(b.id)?.text != null).length;
  $('#sidx').textContent = `${okN} of ${list.length} decrypted · in memory`;
  cleanup(box);
  box.innerHTML = list.length ? tw(`<table class="ledger"><thead><tr><th class="n">No</th><th class="hs">File</th><th>Title</th><th class="hm">Size</th><th class="hm">Updated</th><th class="r"></th></tr></thead><tbody>
    ${list.map((b, i) => { const p = plain.get(b.id); return `<tr><td class="n">${pad(i + 1)}</td><td class="hs"><span class="fid sealed">${docId({ ...b, storage_mode: 'sealed_block' })}</span></td>
      <td>${p?.text != null ? `<a class="rowlink" href="#sealed/${b.id}" data-cursor="UNSEAL">${esc(b.title)}</a>` : `<b>${esc(b.title)}</b> <span class="chip red plain">${esc(p?.err ?? 'Locked')}</span>`}</td>
      <td class="hm">${p?.text != null ? `${fmt(p.text.length)} chars` : '—'}</td><td class="hm nowrap">${ago(b.updated_at)}</td>
      <td class="act">${p?.text != null ? `<a class="bt xs" href="#sealed/${b.id}">Open</a>` : ''}${canEdit() ? `<button class="bt xs red" data-sdel="${b.id}">Delete</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`)
    : empty('Vault empty', 'Create a sealed block: it is encrypted here before it leaves this browser.');
  enhance(box);
  $$('[data-sdel]', box).forEach((b) => (b.onclick = wrap(() => deleteSealed(b.dataset.sdel, list.find((x) => x.id === b.dataset.sdel)?.title))));
}
function renderHits(q) {
  const box = $('#shits'); if (!box) return;
  if (!q.trim()) { box.innerHTML = ''; return; }
  const hits = search(q);
  box.innerHTML = `<div class="pane"><div class="pane-h"><span>Local search</span><i>${hits.length} hit${hits.length === 1 ? '' : 's'} · never sent to Embargo</i></div><div class="pane-b">${hits.map((h) => `<a class="hit sbox" href="#sealed/${h.id}"><b>${esc(h.title)}</b><div class="hsn">${snippet(h.text, q)}</div></a>`).join('') || '<p class="hint">No decrypted sealed block matches.</p>'}</div></div>`;
}
async function deleteSealed(id, title) {
  if (!(await confirmBox({ title: `Delete “${title ?? 'sealed block'}”?`, body: 'Embargo deletes the ciphertext and wrapped key and writes a deletion record. Devices drop local copies on their next sync.', confirm: 'Delete & shred', danger: true }))) return false;
  await api(`/sealed-blocks/${id}`, { method: 'DELETE' }); plain.delete(id); toast('Sealed block deleted'); go('sealed'); return true;
}
function newSealed() {
  modal(`<div class="md-t">New sealed block</div><div class="md-d">Encrypted in this browser with a fresh key, wrapped by your sealed key. Embargo receives ciphertext only.</div>
    <label class="field"><span>Title <i>(visible to Embargo: use a placeholder if the title itself is sensitive)</i></span><input id="stt" placeholder="Sealed block" maxlength="200"></label>
    <label class="field"><span>Content</span><textarea id="stx" style="min-height:220px" placeholder="Board notes, credentials policy, M&amp;A memo…"></textarea></label>
    <div class="inrow"><label class="bt sm" for="sfile" style="cursor:pointer">${icon('upload', 12)}Load a text file</label><input type="file" id="sfile" accept=".txt,.md,.csv,.json,text/*" hidden><span class="hint" id="sfn"></span></div>
    <div class="md-f"><button class="bt sm" data-x>Cancel</button><button class="bt sm acid" id="sgo" data-cursor="SEAL">${icon('lock', 12)}Encrypt &amp; upload</button></div>`, (el, close) => {
    $('[data-x]', el).onclick = close;
    $('#sfile', el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $('#stx', el).value = await f.text(); $('#sfn', el).textContent = f.name; if (!$('#stt', el).value) $('#stt', el).value = f.name.replace(/\.[^.]+$/, ''); };
    $('#sgo', el).onclick = wrap(async () => {
      const text = $('#stx', el).value; if (!text.trim()) throw new Error('Nothing to seal');
      const title = $('#stt', el).value.trim() || 'Sealed block';
      const restore = busy($('#sgo', el), 'Encrypting');
      try {
        const bundle = await withWsk((wsk) => K.encryptSealed(wsk, text));
        const r = await api(`/workspaces/${S.ws}/sealed-blocks`, { body: { ...bundle, title } });
        plain.set(r.block_id, { title, text, at: null });
        close(); toast('Sealed. Embargo holds ciphertext only.'); go(`sealed/${r.block_id}`);
      } finally { restore(); }
    });
  }, { label: 'New sealed block', code: 'H4', width: 720 });
}

// ---------------- one sealed block
async function openView(id, rec, devices) {
  let s;
  try { s = await api(`/sealed-blocks/${id}`); } catch (e) { if (e.status === 404) return view(empty('Not in the vault', 'This sealed block was deleted or never existed.', '<a class="bt sm" href="#sealed">Back to the vault</a>')); throw e; }
  let text = null, err = null;
  try { text = await withWsk((wsk) => K.decryptSealed(wsk, s)); plain.set(id, { title: s.title, text, at: s.updated_at }); } catch (e) { err = e.name === 'OperationError' ? 'Sealed with another key. This browser cannot open it.' : errMsg(e); }
  const crumb = document.getElementById('crumbX'); if (crumb) crumb.textContent = docId({ id, storage_mode: 'sealed_block' });
  view(`<a class="back" href="#sealed">${icon('arrowleft', 12)}Sealed vault</a>
    <div class="bd"><div class="bd-main"><article class="paper doc"><span class="pin"></span>
      <header class="doc-top"><div class="ph2">Embargo archive · sealed block<small>Encrypted on your devices · Embargo holds ciphertext only</small></div><span class="did">${docId({ id, storage_mode: 'sealed_block' })}</span></header>
      <h1 class="doc-t">${esc(s.title)}</h1>
      <div class="doc-meta"><span>Updated <b>${esc(ago(s.updated_at))}</b></span><span>Ciphertext <b>${fmt(Math.round(s.ciphertext.length * 0.75))}</b> bytes</span>${text != null ? `<span>Plaintext <b>${fmt(text.length)}</b> chars</span>` : ''}</div>
      <div class="doc-stamps"><span class="stamp red thunk">Sealed block</span>${text != null ? '<span class="stamp acid thunk">Decrypted on this device</span>' : '<span class="stamp red thunk">Locked</span>'}</div>
      <span class="doc-note">Embargo can't read this. Only your devices can.</span>
      <div class="doc-body"><div class="dsec"><div class="h"><span class="no">§01</span>Content</div><div class="body">${text != null ? esc(text) : `<div class="bars">${'<i style="width:92%"></i><i style="width:71%"></i><i style="width:84%"></i>'}</div><span class="rlab">${esc(err)}</span>`}</div></div></div>
      <footer class="doc-foot"><span class="by">${eyeInk('watch')}${esc(AGENT.name)} cannot open this file</span><span>${shortId(id)}</span>${barcode(id)}</footer></article></div>
    <aside class="bd-side"><div class="pane"><div class="pane-h"><span>File actions</span><i>H4</i></div><div class="pane-b">
      ${text != null ? `<button class="bt sm full" id="cpx">${icon('copy', 12)}Copy plaintext</button>` : ''}
      <button class="bt sm red full" id="sdel" ${canEdit() ? '' : 'disabled'}>${icon('trash', 12)}Delete &amp; shred</button></div></div>
      <div class="pane"><div class="pane-h"><span>What Embargo stores</span></div><div class="pane-b"><div class="kv"><span>Ciphertext</span><span class="small" style="word-break:break-all">${esc(s.ciphertext.slice(0, 48))}…</span><span>Wrapped DEK</span><span class="small" style="word-break:break-all">${esc(s.wrapped_dek.slice(0, 32))}…</span><span>Nonce</span><span class="small">${esc(s.nonce)}</span></div></div></div></aside></div>`, { key: `#sealed/${id}` });
  if ($('#cpx')) $('#cpx').onclick = () => copy(text, 'Plaintext copied');
  $('#sdel').onclick = wrap(() => deleteSealed(id, s.title));
}
