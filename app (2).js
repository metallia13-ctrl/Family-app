'use strict';
/* App Famiglia — logica applicativa. Configurazione in config.js, stile in style.css */

/* ───────── utilità ───────── */
const $ = s => document.querySelector(s),
  esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  rid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36),
  iso = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10),
  fmt = v => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; },
  ago = t => { const m = (Date.now() - t) / 6e4; return !t ? '' : m < 1 ? 'adesso' : m < 60 ? Math.round(m) + ' min fa' : m < 1440 ? Math.round(m / 60) + ' h fa' : Math.round(m / 1440) + ' g fa'; },
  m2 = t => { const p = String(t || '0:0').split(':'); return p[0] * 60 + +p[1]; },
  now = () => Date.now();

const PAL = ['#d6336c', '#1c7ed6', '#2f9e44', '#f08c00', '#7048e8', '#0ca678', '#e8590c', '#495057'],
  UL = ['Normale', 'Importante', 'Urgente'],
  H0 = 7, H1 = 22, T = (H1 - H0) * 60,
  COLLS = ['tasks', 'notes', 'people', 'events', 'contacts', 'shifts', 'feed', 'vitals'],
  hash = u => [...String(u)].reduce((a, c) => a + c.charCodeAt(0), 0);

const emptyS = () => ({ members: {}, tasks: {}, notes: {}, events: {}, people: {}, contacts: {}, shifts: {}, feed: {}, vitals: {} });
let me, D, S = emptyS(), unsubs = [], dataOn = false, pend = false, raf = 0, rf = false, membersLoaded = false, lastErr = '';
let open = new Set(), psel = null, nfil = 'all', tab = 'h', day = iso(new Date());
const lastFeed = {};
let ensuring = false;
const step = m => { (window.__log = window.__log || []).push(new Date().toLocaleTimeString('it-IT') + '  ' + m); },
  withT = (p, ms, msg) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms))]),
  stepsHtml = () => `<details open class="diag"><summary>Passaggi</summary><pre>${esc((window.__log || []).join('\n'))}</pre></details>`;

const role = () => (me && (S.members[me.uid] || {}).role) || '',
  isEd = () => ['editor', 'admin'].includes(role()),
  col = u => (S.members[u] || {}).color || PAL[hash(u) % PAL.length],
  pn = p => (S.people[p] || {}).name || '',
  mname = u => esc((S.members[u] || {}).name || 'Familiare'),
  popt = f => `<option value="">${f}</option>` + Object.entries(S.people).map(([i, p]) => `<option value="${i}">${esc(p.name)}</option>`).join(''),
  urg = (o, a, i, ed) => { const u = o.urg || 0; return ed ? `<button class="ub" data-a="${a}" data-i="${i}">⚑ ${UL[u]}</button>` : u ? `<span class="ub">⚑ ${UL[u]}</span>` : ''; };

function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 3500); }

/* ───────── database (Firestore) ───────── */
function fbDB() {
  if (!firebase.apps.length) firebase.initializeApp(CFG);
  const f = firebase.firestore(), LIM = { feed: 80, vitals: 300 },
    err = c => e => { lastErr = `${c}: ${e.code || e.message}`; toast('Errore ' + lastErr); render(true); },
    deny = e => toast('Non consentito: ' + (e.code || e.message));
  return {
    watch: (c, cb) => (LIM[c] ? f.collection(c).orderBy('ts', 'desc').limit(LIM[c]) : f.collection(c))
      .onSnapshot(q => { const o = {}; q.forEach(d => o[d.id] = d.data()); cb(o); }, err(c)),
    put: (c, i, d, m) => (m ? f.collection(c).doc(i).set(d, { merge: true }) : f.collection(c).doc(i).set(d)).catch(deny),
    del: (c, i) => f.collection(c).doc(i).delete().catch(deny),
    raw: f
  };
}

const fd = (text, pid, k) => me && D.put('feed', rid(), { uid: me.uid, text, pid: pid || '', k: k || '', ts: now() });
const fdOnce = (key, text, pid, k) => { if (now() - (lastFeed[key] || 0) < 3e5) return; lastFeed[key] = now(); fd(text, pid, k); };

/* ───────── avvio e accesso ───────── */
function stop() { unsubs.forEach(u => u && u()); unsubs = []; dataOn = false; membersLoaded = false; lastErr = ''; S = emptyS(); }

function init() {
  D = fbDB();
  const auth = firebase.auth();
  step('accesso: in attesa di Firebase…');
  auth.getRedirectResult().catch(e => e.code && toast('Accesso: ' + e.code));
  auth.onAuthStateChanged(async u => {
    stop();
    if (!u) {
      step('nessun utente collegato: schermata di accesso');
      me = null; $('#who').textContent = ''; $('#out').hidden = true;
      $('#app').innerHTML = '<div class="login"><div class="logo">🏠</div><h2>App Famiglia</h2><p>Accedi per coordinare le cure di Babbo e Mamma.</p><button class="pri" data-a="login">Accedi con Google</button></div>';
      return;
    }
    me = { uid: u.uid, name: u.displayName || u.email, email: (u.email || '').toLowerCase() };
    $('#who').textContent = me.name; $('#out').hidden = false;
    $('#app').innerHTML = '<p class="c">Caricamento…</p>';
    step('utente: ' + me.email);
    unsubs.push(D.watch('members', o => { S.members = o; membersLoaded = true; step('membri ricevuti: ' + Object.keys(o).length + ', mio ruolo: ' + (role() || 'nessuno')); gate(); render(true); }));
    ensuring = true; await ensureMember(); ensuring = false; render(true);
  });
}

async function ensureMember() {
  const ref = D.raw.collection('members').doc(me.uid), base = { name: me.name, email: me.email, color: PAL[hash(me.uid) % PAL.length] },
    boss = (typeof ADMIN_EMAILS !== 'undefined' ? ADMIN_EMAILS : []).map(x => String(x).trim().toLowerCase()).includes(me.email),
    TO = 'Firestore non risponde: database non creato, rete assente o bloccata (adblock/antivirus)';
  try {
    step('profilo: lettura…');
    if ((await withT(ref.get(), 12000, TO)).exists) { step('profilo: trovato'); return; }
    step('profilo: assente, creazione come ' + (boss ? 'admin' : 'in attesa') + (boss ? '' : ' (email non presente in ADMIN_EMAILS)'));
    try { await withT(ref.set({ ...base, role: boss ? 'admin' : 'pending' }), 12000, TO); step('profilo: creato'); }
    catch (e) {
      if (!boss) throw e;
      lastErr = 'creazione come admin rifiutata dalle regole (' + (e.code || e.message) + ')'; step(lastErr);
      await withT(ref.set({ ...base, role: 'pending' }), 12000, TO); step('profilo: creato come in attesa');
    }
  } catch (e) { lastErr = 'profilo non creato: ' + (e.code || e.message); step(lastErr); toast(lastErr); }
}

function gate() {
  if (!['viewer', 'editor', 'admin'].includes(role()) || dataOn) return;
  dataOn = true; step('caricamento dati');
  COLLS.forEach(c => unsubs.push(D.watch(c, v => { S[c] = v; render(); })));
}

/* ───────── rendering ───────── */
function render(fresh) {
  if (fresh) rf = true;
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; const f = rf; rf = false; draw(f); });
}

function draw(fresh) {
  if (!me) return;
  const a = document.activeElement;
  if (!fresh && a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.closest('main') && a.type != 'checkbox') { pend = true; return; }
  pend = false;
  const R = role(), app = $('#app');
  if (!R) {
    app.innerHTML = (!membersLoaded || ensuring) && !lastErr ? '<p class="c">Caricamento…</p>' :
      `<div class="login"><div class="logo">🔧</div><h2>Profilo non trovato</h2><p>Non riesco a leggere o creare il tuo profilo.</p>${lastErr ? `<p class="warn"><b>${esc(lastErr)}</b></p>` : ''}
      <p class="due">Account: ${esc(me.email)}<br>ID utente: <b>${esc(me.uid)}</b></p>
      <p class="due">Controlla di aver pubblicato <b>firestore.rules</b> con la stessa email di <b>config.js</b> (tutta minuscola). In alternativa, in Firestore crea il documento <b>members/${esc(me.uid)}</b> con i campi <b>role = admin</b> e <b>name</b>.</p>
      <button class="pri" data-a="retry">Riprova</button>${stepsHtml()}</div>`;
    return;
  }
  if (R == 'pending') { app.innerHTML = '<div class="login"><div class="logo">⏳</div><h2>Richiesta inviata</h2><p>Chiedi all\'amministratore di autorizzarti.<br>Questa pagina si aggiorna da sola.</p><p class="due">${esc(me.email)}</p></div>'; return; }
  const adm = R == 'admin',
    keep = fresh ? [] : [...document.querySelectorAll('main [id]')].filter(el => 'value' in el).map(el => [el.id, el.value]),
    tabs = [['h', '🏠 Home'], ['d', '👴👵 Schede'], ['n', '📝 Note'], ['t', '✅ Impegni'], ['s', '🚪 Turni'], ['c', '📅 Calendario']].concat(adm ? [['p', '🔑 Accessi']] : []);
  let h = '<nav>' + tabs.map(([v, l]) => `<button data-a="tab" data-v="${v}" class="${tab == v ? 'on' : ''}">${l}</button>`).join('') + '</nav><main>';
  if (tab == 'h') h += home();
  else if (tab == 'd') h += schede();
  else if (tab == 'n') h += notesTab();
  else if (tab == 'c') h += cal();
  else if (tab == 's') h += shifts();
  else if (tab == 'p' && adm) h += access();
  else h += tasksTab();
  app.innerHTML = h + '</main>';
  keep.forEach(([id, v]) => { const el = document.getElementById(id); if (el && v !== '') el.value = v; });
}

function access() {
  let h = '<p class="due">Visualizzatore: consulta e segna disponibilità, turni, parametri e aggiornamenti. Editor: modifica anche schede, farmaci, impegni e note. Admin: gestisce gli accessi.</p>';
  for (const [u, m] of Object.entries(S.members))
    h += `<div class="mem"><span><b>${esc(m.name)}</b><br><span class="due">${esc(m.email || '')}</span></span><select data-c="role" data-i="${u}" ${u == me.uid ? 'disabled title="Non puoi cambiare il tuo ruolo"' : ''}>${[['pending', 'In attesa'], ['viewer', 'Visualizzatore'], ['editor', 'Editor'], ['admin', 'Admin']].map(([v, l]) => `<option value="${v}" ${m.role == v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  return h;
}

/* ───────── impegni ───────── */
function tasksTab() {
  let h = '';
  if (isEd()) h += `<div class="add"><input type="text" id="nt" placeholder="Nuovo impegno (es. ritirare farmaci, prenotare analisi…)" aria-label="Nuovo impegno"><select id="nk" aria-label="Tipo"><option value="">Impegno generico</option><option value="med">🩺 Visita / esame medico</option></select><select id="np" aria-label="Per chi">${popt('Per chi: tutti')}</select><label class="lb">Scadenza<input type="date" id="nd"></label><label class="lb">Data e ora visita<input type="datetime-local" id="na"></label><select id="nr" aria-label="Ripetizione"><option value="">Non si ripete</option><option value="d">Ogni giorno</option><option value="w">Ogni settimana</option><option value="m">Ogni mese</option></select><button class="pri" data-a="addt">Aggiungi</button></div>`;
  const ts = Object.entries(S.tasks).sort((x, y) => (x[1].done ? 1 : 0) - (y[1].done ? 1 : 0) || (y[1].urg || 0) - (x[1].urg || 0) || (x[1].due || '9').localeCompare(y[1].due || '9'));
  if (!ts.length) h += `<p class="c">Nessun impegno in lista. ${isEd() ? 'Aggiungine uno qui sopra.' : ''}</p>`;
  return h + ts.map(([i, t]) => task(i, t)).join('');
}

function task(i, t) {
  const sel = t.sel || {}, mine = sel[me.uid] || {}, ed = isEd(),
    ns = Object.entries(S.notes).filter(([, n]) => n.task == i).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0)),
    chips = Object.entries(sel).filter(([u, s]) => s && s.st && S.members[u]).map(([u, s]) => `<span class="chip ${s.st}">${esc(S.members[u].name)} ${s.st == 'yes' ? '✓' + (s.when ? ' · ' + fmt(s.when) : '') : '✗'}</span>`).join('');
  return `<div class="task u${t.urg || 0} ${t.done ? 'done' : ''}"><div class="th"><div class="grow"><b>${esc(t.title)}</b>
    ${t.due ? `<div class="due">Entro ${new Date(t.due).toLocaleDateString('it-IT')}</div>` : ''}
    ${t.kind == 'med' ? `<div class="due">🩺 ${esc(pn(t.pid))} · ${fmt(t.at)}</div>` : t.pid ? `<div class="due">Per: <b>${esc(pn(t.pid))}</b></div>` : ''}
    ${t.rep ? `<div class="due">🔁 ${{ d: 'ogni giorno', w: 'ogni settimana', m: 'ogni mese' }[t.rep]}</div>` : ''}</div>
    ${urg(t, 'urg', i, ed)}${t.at || t.due ? `<button data-a="ics" data-i="${i}" title="Aggiungi al calendario con promemoria">⏰</button>` : ''}
    ${ed ? `<button data-a="done" data-i="${i}" title="Fatto">${t.done ? '↩' : '✔'}</button><button data-a="ren" data-i="${i}" title="Modifica">✏️</button><button data-a="delt" data-i="${i}" title="Elimina">🗑</button>` : ''}</div>
    <div class="row">${chips || '<span class="due">Nessuno si è ancora proposto</span>'}</div>
    <div class="row"><button class="yes ${mine.st == 'yes' ? 'on' : ''}" data-a="yes" data-i="${i}">Lo faccio io</button><button class="no ${mine.st == 'no' ? 'on' : ''}" data-a="no" data-i="${i}">Non posso</button>
    ${mine.st == 'yes' ? `<input type="datetime-local" data-c="when" data-i="${i}" value="${esc(mine.when || '')}" aria-label="Quando lo fai">` : ''}</div>
    <div class="row"><button data-a="tog" data-i="${i}">📝 Note (${ns.length}) ${open.has(i) ? '▲' : '▼'}</button></div>
    ${open.has(i) ? `<div class="notes">${ns.map(([k, n]) => note(k, n, ed)).join('')}${ed ? `<div><button data-a="addn" data-i="${i}">+ Nuova nota</button></div>` : ''}</div>` : ''}</div>`;
}

/* ───────── note stile Keep ───────── */
function note(k, n, ed, ctx) {
  const dis = ed ? '' : 'disabled',
    label = ctx ? (n.task == 'gen' ? '📌 Bacheca generale' : S.people[n.task] ? '👤 Scheda ' + esc(S.people[n.task].name) : S.tasks[n.task] ? '✅ ' + esc(S.tasks[n.task].title) : '📌 Nota') : '';
  return `<div class="note u${n.urg || 0}" data-n="${k}"><div class="note-hdr"><span>${label ? `<b>${label}</b> · ` : ''}${n.by ? 'di ' + mname(n.by) + ' · ' : ''}${ago(n.ts)}</span>${ed ? '' : urg(n, '', k, false)}</div>
    <textarea data-c="note" ${dis} placeholder="Scrivi una nota, appunti medici, cose da comprare…">${esc(n.text)}</textarea>
    ${(n.items || []).map((x, j) => `<div class="it"><input type="checkbox" data-c="note" ${dis} ${x.d ? 'checked' : ''}><input type="text" data-c="note" ${dis} value="${esc(x.t)}" placeholder="Voce elenco…">${ed ? `<button class="x" data-a="deli" data-i="${k}" data-j="${j}">×</button>` : ''}</div>`).join('')}
    <div class="imgs">${(n.imgs || []).map((s, j) => `<div><img src="${esc(s)}" alt="foto">${ed ? `<button class="x" data-a="deli2" data-i="${k}" data-j="${j}">×</button>` : ''}</div>`).join('')}</div>
    <div class="files">${(n.files || []).map((f, j) => `<a href="${esc(f.data)}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>${ed ? `<button class="x" data-a="delf" data-i="${k}" data-j="${j}">×</button>` : ''}`).join('')}</div>
    ${ed ? `<div class="tools">${urg(n, 'nurg', k, true)}<button data-a="addi" data-i="${k}">☑ Checklist</button><button data-a="pic" data-i="${k}">📷 Foto</button><button data-a="att" data-i="${k}">📎 File</button><button data-a="deln" data-i="${k}">🗑</button></div>` : ''}</div>`;
}

function notesTab() {
  const ed = isEd(), pe = Object.entries(S.people);
  let h = `<div class="wk"><button data-a="nfil" data-v="all" class="${nfil == 'all' ? 'on' : ''}">Tutte</button><button data-a="nfil" data-v="gen" class="${nfil == 'gen' ? 'on' : ''}">📌 Bacheca</button>${pe.map(([pi, p]) => `<button data-a="nfil" data-v="${pi}" class="${nfil == pi ? 'on' : ''}">👤 ${esc(p.name)}</button>`).join('')}</div>`;
  if (ed) h += `<div class="add"><select id="n_target" aria-label="Associa a"><option value="gen" ${nfil == 'gen' ? 'selected' : ''}>📌 Bacheca generale</option>${pe.map(([pi, p]) => `<option value="${pi}" ${nfil == pi ? 'selected' : ''}>👤 Scheda di ${esc(p.name)}</option>`).join('')}</select><input type="text" id="n_quick" placeholder="Testo rapido della nuova nota…"><button class="pri" data-a="addng">+ Crea nota</button></div>`;
  const all = Object.entries(S.notes).filter(([, n]) => nfil == 'all' || n.task == nfil).sort((a, b) => (b[1].urg || 0) - (a[1].urg || 0) || (b[1].ts || 0) - (a[1].ts || 0));
  return h + (all.length ? `<div class="notes">${all.map(([k, n]) => note(k, n, ed, true)).join('')}</div>` : `<p class="c">Nessuna nota in questa vista. ${ed ? 'Creane una qui sopra: puoi aggiungere checklist, foto e allegati.' : ''}</p>`);
}

/* ───────── calendario disponibilità ───────── */
function cal() {
  const act = Object.entries(S.members).filter(([, m]) => m.role && m.role != 'pending'), d0 = new Date(day + 'T12:00'), mon = new Date(d0);
  mon.setDate(d0.getDate() - (d0.getDay() + 6) % 7);
  const pos = (a, b) => { a = Math.max(a, H0 * 60); b = Math.min(b, H1 * 60); return b > a ? `left:${(a - H0 * 60) / T * 100}%;width:${(b - a) / T * 100}%` : ''; };
  let h = `<div class="row nav-day"><button data-a="cnav" data-v="-1">◀</button><b class="grow center">${d0.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</b><button data-a="cnav" data-v="1">▶</button><button data-a="today">Oggi</button></div><div class="wk">`;
  for (let k = 0; k < 7; k++) { const x = new Date(mon); x.setDate(mon.getDate() + k); const v = iso(x); h += `<button data-a="cday" data-v="${v}" class="${v == day ? 'on' : ''}">${x.toLocaleDateString('it-IT', { weekday: 'short' })}<br>${x.getDate()}</button>`; }
  h += '</div>';
  let rows = ''; const cnt = Array(30).fill(0);
  for (const [u, m] of act) {
    const c = col(u), bl = [];
    for (const e of Object.values(S.events)) if (e.uid == u && e.date == day) bl.push({ a: m2(e.from), b: m2(e.to), t: e.type });
    for (const t of Object.values(S.tasks)) { const s = (t.sel || {})[u]; if (s && s.st == 'yes' && !t.done && (s.when || '').slice(0, 10) == day) { const a = m2(s.when.slice(11, 16)); bl.push({ a, b: a + 60, t: 'tsk' }); } }
    const fr = bl.filter(x => x.t == 'free'), bz = bl.filter(x => x.t != 'free');
    for (let i = 0; i < 30; i++) { const s = H0 * 60 + 30 * i, e = s + 30; if (fr.some(x => x.a <= s && x.b >= e) && !bz.some(x => x.a < e && x.b > s)) cnt[i]++; }
    rows += `<div class="tr"><b style="color:${c}">${esc(String(m.name || '?').split(' ')[0])}</b><div class="trk">${bl.map(x => { const p = pos(x.a, x.b); return p ? `<div class="bar ${x.t == 'free' ? '' : x.t == 'tsk' ? 'tsk' : 'busy'}" style="${p};--c:${c}"></div>` : ''; }).join('')}</div></div>`;
  }
  const n = act.length || 1;
  rows += `<div class="tr"><b>Insieme</b><div class="hz">${cnt.map(v => `<i style="background:color-mix(in srgb,var(--ac) ${Math.round(v / n * 100)}%,transparent)">${v || ''}</i>`).join('')}</div></div>`;
  h += `<div class="tl"><div class="ax"><span>7</span><span>10</span><span>13</span><span>16</span><span>19</span><span>22</span></div>${rows}</div>
    <div class="lg"><span><i class="sw f"></i> Disponibile</span><span><i class="sw b"></i> Impegnato</span><span><i class="sw t"></i> Impegno assunto</span><span>Insieme = quante persone sono libere</span></div>
    <div class="add"><select id="et" aria-label="Tipo"><option value="free">Disponibile</option><option value="busy">Impegnato</option></select><input type="date" id="ed" value="${day}"><input type="time" id="ef" value="09:00"><input type="time" id="eto" value="12:00"><input type="text" id="el" placeholder="Nota (es. lavoro, turno…)"><button class="pri" data-a="addev">Aggiungi per me</button></div>`;
  const ev = Object.entries(S.events).filter(([, e]) => e.date == day).sort((a, b) => String(a[1].from).localeCompare(b[1].from));
  for (const [i, e] of ev) h += `<div class="mem"><span><b style="color:${col(e.uid)}">${mname(e.uid)}</b> ${esc(e.from)}–${esc(e.to)} · ${e.type == 'free' ? 'Disponibile' : 'Impegnato'} ${esc(e.label)}</span>${e.uid == me.uid || role() == 'admin' ? `<button data-a="delev" data-i="${i}">🗑</button>` : ''}</div>`;
  return h;
}

/* ───────── turni di visita ───────── */
function shifts() {
  const pe = Object.entries(S.people);
  if (!pe.length) return '<p class="c">Prima crea le schede dei genitori (scheda Schede).</p>';
  const icons = { visita: '🚪', telefonata: '📞', notte: '🌙', pasto: '🍲' };
  let h = `<div class="add"><select id="sp" aria-label="Per chi">${pe.map(([i, p]) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select><select id="sy"><option value="visita">🚪 Visita</option><option value="telefonata">📞 Telefonata</option><option value="notte">🌙 Notte</option><option value="pasto">🍲 Aiuto pasto</option></select><input type="date" id="sd" value="${iso(new Date())}"><input type="time" id="st" value="17:00"><button class="pri" data-a="adds">Mi prendo il turno</button></div>`;
  for (let k = 0; k < 14; k++) {
    const d = new Date(); d.setDate(d.getDate() + k); const v = iso(d);
    h += `<div class="tl"><b>${d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'short' })}</b>`;
    for (const [pi, p] of pe) {
      const ss = Object.entries(S.shifts).filter(([, x]) => x.pid == pi && x.date == v).sort((a, b) => String(a[1].time).localeCompare(b[1].time)),
        dup = ['visita', 'telefonata'].some(t => ss.filter(([, x]) => x.type == t).length > 1);
      h += `<div class="tr"><b class="pn">${esc(p.name)}</b><span class="grow">${ss.length ? ss.map(([si, x]) => `<span class="chip" style="color:${col(x.uid)}">${icons[x.type] || '🚪'} ${mname(x.uid)} ${esc(x.time)}${x.uid == me.uid || role() == 'admin' ? ` <button class="ub" data-a="dels" data-i="${si}">×</button>` : ''}</span> `).join('') : '<span class="due warn">scoperta</span>'}${dup ? ' <span class="due">⚠ doppio</span>' : ''}</span></div>`;
    }
    h += '</div>';
  }
  return h;
}

/* ───────── schede genitori ───────── */
const SECTIONS = [
  { title: '📋 Anagrafica, documenti e burocrazia', fields: [
    ['born', 'Data di nascita', 'date', ''], ['bplace', 'Luogo e provincia di nascita', 'text', 'es. Cagliari (CA)'],
    ['cf', 'Codice fiscale', 'text', '16 caratteri'], ['tess_num', 'N° tessera sanitaria (TEAM)', 'text', ''],
    ['tess', 'Scadenza tessera sanitaria', 'date', ''], ['cid', 'Carta d\'identità: numero e scadenza', 'text', 'es. CA12345AA – scad. 10/2029'],
    ['exempt', 'Esenzioni ticket (codici)', 'text', 'es. E01, C01, 031…'], ['inval', 'Invalidità civile / L.104 / accompagnamento', 'text', 'es. 100% con accompagno'],
    ['where', 'Dove sono chiavi, documenti, SPID/PIN e referti', 'area', 'es. cartellina blu nello studio…', 'full'] ] },
  { title: '🩺 Profilo clinico', fields: [
    ['blood', 'Gruppo sanguigno e Rh', 'text', 'es. 0 Rh+'], ['base_vit', 'Valori abituali (PA, FC, peso, SpO2)', 'text', 'es. PA 130/75, FC 68, 72 kg'],
    ['allergies_med', '⚠️ Allergie a farmaci', 'area', 'Scrivi «Nessuna nota» se assenti', 'full'],
    ['allergies', 'Allergie ambientali e intolleranze alimentari', 'area', 'es. lattosio, nichel, pollini…', 'full'],
    ['conditions', 'Patologie croniche e diagnosi attive', 'area', 'es. ipertensione, diabete tipo 2…', 'full'],
    ['surgeries', 'Interventi chirurgici e ricoveri', 'area', 'es. cataratta OD (2021)…', 'full'],
    ['vaccines', 'Vaccinazioni', 'text', 'es. antinfluenzale ott 2025', 'full'] ] },
  { title: '🏥 Medici e rete curante', fields: [
    ['doctor', 'Medico di base e telefono', 'text', 'es. Dott. Bianchi – 333 1234567'], ['doc_hours', 'Orari ambulatorio e modalità ricette', 'area', 'es. lun-mer-ven 9–12…', 'full'],
    ['spec', 'Specialisti, ospedale e centri di riferimento', 'area', 'es. Cardiologia Osp. Civile…', 'full'], ['pharmacy', 'Farmacia di fiducia (nome, tel, orari)', 'text', ''],
    ['caregiver', 'Assistenza domiciliare (ADI, badante, fisio)', 'text', ''], ['emerg', 'Contatti di emergenza (chi chiamare per primo)', 'text', '', 'full'] ] },
  { title: '🕰️ Orari, routine e vita quotidiana', fields: [
    ['schedule', 'Orari e routine (sveglia, pasti, riposo, sonno)', 'area', 'es. sveglia 7:30, pranzo 12:30, letto 22:00', 'full'],
    ['mobility', 'Mobilità, autonomia e rischio cadute', 'area', '', 'full'], ['aids', 'Ausili (occhiali, apparecchi acustici, dentiera, deambulatore)', 'area', '', 'full'],
    ['diet', 'Dieta, idratazione e alimenti da evitare', 'area', '', 'full'], ['cognitive', 'Umore, sonno, orientamento e abitudini', 'area', '', 'full'],
    ['safety', 'Sicurezza in casa (gas, chiavi, vicini di fiducia)', 'area', '', 'full'] ] }
];
const FL = SECTIONS.flatMap(s => s.fields);

const vitalsOf = pid => [
  ...((S.people[pid] || {}).vitals || []).map(v => ({ ...v, leg: 1 })),
  ...Object.entries(S.vitals).filter(([, v]) => v.pid == pid).map(([id, v]) => ({ ...v, id }))
].sort((a, b) => b.ts - a.ts);

function schede() {
  const ed = isEd(), dis = ed ? '' : 'disabled', pe = Object.entries(S.people);
  const cont = `<h3>📇 Rubrica contatti utili</h3>` + Object.entries(S.contacts).sort((a, b) => String(a[1].name).localeCompare(b[1].name)).map(([i, c]) => `<div class="mem"><span><b>${esc(c.name)}</b> · ${esc(c.info)}<br>${c.tel ? `<a href="tel:${esc(String(c.tel).replace(/\s/g, ''))}">📞 ${esc(c.tel)}</a>` : ''}</span>${ed ? `<button data-a="delc" data-i="${i}">🗑</button>` : ''}</div>`).join('')
    + (ed ? `<div class="add"><input type="text" id="cn" placeholder="Nome (es. Guardia medica, Dott. Rossi)"><input type="text" id="ci" placeholder="Ruolo / orari"><input type="tel" id="ct" placeholder="Telefono"><button class="pri" data-a="addc">Aggiungi</button></div>` : '');
  if (!pe.length) return (ed ? '<p class="c">Nessuna scheda.<br><br><button class="pri" data-a="mkp">Crea le schede di Babbo e Mamma</button></p>' : '<p class="c">Nessuna scheda ancora.</p>') + cont;
  if (!S.people[psel]) psel = pe[0][0];
  const p = S.people[psel], vits = vitalsOf(psel);
  let h = `<div class="wk">${pe.map(([i, q]) => `<button data-a="psel" data-v="${i}" class="${i == psel ? 'on' : ''}">👤 ${esc(q.name)}</button>`).join('')}${ed ? '<button data-a="mkp1" class="fit" title="Nuova scheda">+</button>' : ''}</div>
    <p class="due">Le modifiche si salvano da sole e compaiono nelle novità della Home. Dati sensibili: li vedono tutti i membri autorizzati.</p>
    <div class="task u0"><div class="th"><b class="grow">Scheda di ${esc(p.name)}</b><button class="sm" data-a="cpcf">📋 Copia CF</button><button class="sm pri" data-a="sos">🚑 Riassunto 118/PS</button>${ed ? '<button class="sm" data-a="pren">✏️</button><button class="sm" data-a="pdel">🗑</button>' : ''}</div>`;
  h += `<div class="sec-box"><h4>💊 Terapia farmacologica</h4><div class="due">Farmaco, dose, orari, note (es. a stomaco pieno) e scorta o scadenza del piano terapeutico.</div>${(p.therapy || []).map((x, j) => `<div class="tp"><input type="text" data-c="th" placeholder="Farmaco" value="${esc(x.d)}" ${dis}><input type="text" data-c="th" placeholder="Dose" value="${esc(x.q)}" ${dis}><input type="text" data-c="th" placeholder="Orari" value="${esc(x.t)}" ${dis}><input type="text" data-c="th" placeholder="Note" value="${esc(x.n)}" ${dis}><input type="text" data-c="th" placeholder="Scorta / scadenza" value="${esc(x.s)}" ${dis}>${ed ? `<button class="x sm" data-a="delth" data-j="${j}" title="Rimuovi">×</button>` : ''}</div>`).join('')}
    ${ed ? '<div class="row"><button class="pri sm" data-a="addth" data-t="">+ Farmaco</button><button class="sm" data-a="addth" data-t="08:00">+ Mattina</button><button class="sm" data-a="addth" data-t="13:00">+ Pranzo</button><button class="sm" data-a="addth" data-t="20:00">+ Sera</button><button class="sm" data-a="addth" data-t="Al bisogno">+ Al bisogno</button></div>' : ''}</div>`;
  h += `<div class="sec-box"><h4>❤️ Parametri vitali</h4><div class="add"><input type="text" id="vpa" placeholder="Pressione 125/80"><input type="text" id="vfc" placeholder="FC bpm"><input type="text" id="vsp" placeholder="SpO2 %"><input type="text" id="vgl" placeholder="Glicemia / Temp"><input type="text" id="vw" placeholder="Peso kg"><input type="text" id="vnt" placeholder="Note (a digiuno, capogiro…)"><button class="pri sm" data-a="addvit">Registra</button></div>
    ${vits.length ? vits.slice(0, 8).map(v => `<div class="vit-row"><b>${new Date(v.ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>${v.pa ? `<span class="badge">PA ${esc(v.pa)}</span>` : ''}${v.fc ? `<span class="badge">FC ${esc(v.fc)}</span>` : ''}${v.spo2 ? `<span class="badge">SpO2 ${esc(v.spo2)}%</span>` : ''}${v.gl ? `<span class="badge">${esc(v.gl)}</span>` : ''}${v.w ? `<span class="badge">${esc(v.w)} kg</span>` : ''}<span class="grow due">${esc(v.note || '')} · <i>${mname(v.uid)}</i></span>${!v.leg && (v.uid == me.uid || role() == 'admin') ? `<button class="x sm" data-a="delvit" data-i="${v.id}">×</button>` : ''}</div>`).join('') : '<div class="due">Nessuna rilevazione registrata.</div>'}</div>`;
  for (const sec of SECTIONS) {
    h += `<div class="sec-box"><h4>${sec.title}</h4><div class="form-grid">`;
    for (const [f, l, ty, ph, cls] of sec.fields) {
      const v = esc(p[f] || '');
      h += `<label class="lb ${cls || ''}">${l}${ty == 'area' ? `<textarea data-c="sc" data-f="${f}" placeholder="${esc(ph)}" ${dis}>${v}</textarea>` : `<input type="${ty}" data-c="sc" data-f="${f}" placeholder="${esc(ph)}" value="${v}" ${dis}>`}</label>`;
    }
    h += '</div></div>';
  }
  const ns = Object.entries(S.notes).filter(([, n]) => n.task == psel).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  return h + `<div class="sec-box"><h4>📝 Note, referti e checklist di ${esc(p.name)}</h4><div class="notes">${ns.map(([k, n]) => note(k, n, ed)).join('')}${ed ? `<div><button class="pri sm" data-a="addn" data-i="${psel}">+ Nuova nota</button></div>` : ''}</div></div></div>` + cont;
}

/* ───────── home ───────── */
function home() {
  const t0 = now(), td = iso(new Date()), tm = iso(new Date(t0 + 864e5)), pe = Object.entries(S.people), rem = [];
  for (const t of Object.values(S.tasks)) {
    if (t.done) continue;
    const w = t.at ? new Date(t.at).getTime() : 0;
    if (t.kind == 'med' && w > t0 - 36e5 && w < t0 + 7 * 864e5) {
      const ys = Object.keys(t.sel || {}).filter(u => t.sel[u] && t.sel[u].st == 'yes' && S.members[u]);
      rem.push([w, `🩺 <b>${esc(t.title)}</b> · ${esc(pn(t.pid))} · ${fmt(t.at)} — ${ys.length ? 'accompagna ' + ys.map(u => esc(S.members[u].name)).join(', ') : '<b class="warn">nessuno accompagna!</b>'}`]);
    } else if (t.urg == 2) rem.push([w || t0, `⚑ <b class="warn">Urgente:</b> ${esc(t.title)} ${t.pid ? '(' + esc(pn(t.pid)) + ')' : ''}`]);
  }
  for (const [pi, p] of pe) for (const [d, l] of [[td, 'oggi'], [tm, 'domani']])
    if (!Object.values(S.shifts).some(s => s.pid == pi && s.date == d)) rem.push([t0 + (d == tm ? 1 : 0), `⚠️ Nessuna visita o telefonata segnata per <b>${l}</b> a <b>${esc(p.name)}</b>`]);
  rem.sort((a, b) => a[0] - b[0]);

  let h = rem.length ? `<h3>🚨 Promemoria e avvisi</h3>${rem.map(r => `<div class="mem alert"><span>${r[1]}</span></div>`).join('')}` : '';
  h += '<h3>👴👵 Situazione genitori</h3>';
  if (!pe.length) h += `<div class="mem"><span>Nessuna scheda presente.</span>${isEd() ? '<button class="pri sm" data-a="mkp">Crea schede Babbo e Mamma</button>' : ''}</div>`;
  else {
    h += '<div class="grid2">';
    for (const [pi, p] of pe) {
      const l = Object.values(S.feed).filter(f => f.k == 'log' && f.pid == pi).sort((a, b) => b.ts - a.ts)[0],
        lv = vitalsOf(pi)[0], ts = Object.values(S.shifts).filter(s => s.pid == pi && s.date == td).sort((a, b) => String(a.time).localeCompare(String(b.time))),
        nth = (p.therapy || []).filter(x => x.d).length;
      h += `<div class="pcard"><div class="pcard-top"><b>👤 ${esc(p.name)}</b><button class="sm pri" data-a="gosc" data-v="${pi}">Apri scheda →</button></div>
        <div class="due">💊 Farmaci in terapia: <b>${nth}</b></div>${p.allergies_med ? `<div class="due warn">⚠️ Allergie: <b>${esc(p.allergies_med)}</b></div>` : ''}
        <div class="diary"><b>Ultimo diario:</b> ${l ? `“${esc(l.text)}” <span class="due">(${mname(l.uid)} · ${ago(l.ts)})</span>` : '<span class="due">nessun aggiornamento recente</span>'}</div>
        ${lv ? `<div class="due">❤️ <b>Ultimi parametri (${ago(lv.ts)}):</b> ${lv.pa ? 'PA ' + esc(lv.pa) + ' ' : ''}${lv.fc ? 'FC ' + esc(lv.fc) + ' ' : ''}${lv.spo2 ? 'SpO2 ' + esc(lv.spo2) + '% ' : ''}${lv.gl ? esc(lv.gl) + ' ' : ''}${lv.w ? esc(lv.w) + 'kg' : ''}</div>` : ''}
        <div class="due">🚪 <b>Oggi:</b> ${ts.length ? ts.map(s => `${s.type == 'visita' ? 'Visita' : s.type == 'telefonata' ? 'Tel.' : esc(s.type)} ${esc(s.time)} (${mname(s.uid)})`).join(', ') : '<span class="warn">nessun turno coperto</span>'}</div></div>`;
    }
    h += '</div>';
  }
  h += `<div class="add card-form"><select id="lp" aria-label="Genitore">${popt('Generale')}</select><input type="text" id="lt" placeholder="Com'è andata oggi? Ha mangiato? Umore?…"><button class="pri" data-a="log">Pubblica</button></div>`;
  const fe = Object.entries(S.feed).sort((a, b) => b[1].ts - a[1].ts).slice(0, 25),
    rn = Object.entries(S.notes).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 3),
    ic = { log: '💬', vit: '❤️', th: '💊', sc: '📋', note: '📝' };
  h += `<div class="feed-box"><h3><span>🔔 Ultime info inserite</span><span class="badge">${fe.length}</span></h3><div class="feed-list">${fe.length ? fe.map(([, f]) => `<div class="feed-item" style="--c:${col(f.uid)}"><span>${ic[f.k] || '📌'}</span><div class="fi-txt"><b style="color:${col(f.uid)}">${mname(f.uid)}</b> ${f.k == 'log' ? `ha scritto: <b>“${esc(f.text)}”</b>` : esc(f.text)} ${f.pid ? `<span class="badge">${esc(pn(f.pid))}</span>` : ''}</div><small class="due nowrap">${ago(f.ts)}</small></div>`).join('') : '<p class="due">Ancora nessuna informazione inserita.</p>'}</div>
    ${rn.length ? `<div class="recent"><b>📝 Ultime note:</b> ${rn.map(([, n]) => `<span class="chip">${esc((n.text || 'Nota con elenco/foto').slice(0, 38))}${(n.text || '').length > 38 ? '…' : ''}</span>`).join(' ')} <button class="sm" data-a="tab" data-v="n">Vedi tutte →</button></div>` : ''}</div>`;
  return h;
}

/* ───────── salvataggio note e allegati ───────── */
const upd = (k, f) => { const n = S.notes[k]; if (!n) return; const c = { ...n, items: [...(n.items || [])], imgs: [...(n.imgs || [])], files: [...(n.files || [])] }; f(c); saveNote(k, c); };
function saveNote(k, n) {
  if (JSON.stringify(n).length > 900000) return toast('Nota troppo grande (max ~900 KB): rimuovi qualcosa');
  S.notes[k] = n; D.put('notes', k, n); render(true);
}
function readNote(el) {
  const k = el.dataset.n, n = S.notes[k]; if (!n) return;
  const text = el.querySelector('textarea').value;
  saveNote(k, { ...n, text, ts: now(), by: me.uid, items: [...el.querySelectorAll('.it')].map(r => ({ d: r.children[0].checked, t: r.children[1].value })) });
  fdOnce('n' + k, 'ha aggiornato una nota' + (text ? ': "' + text.slice(0, 35) + (text.length > 35 ? '…' : '') + '"' : ''), S.people[n.task] ? n.task : '', 'note');
}
const pick = (accept, cb) => { const f = document.createElement('input'); f.type = 'file'; f.accept = accept; f.onchange = () => f.files[0] && cb(f.files[0]); f.click(); };
const rd = f => new Promise((r, j) => { const x = new FileReader; x.onload = () => r(x.result); x.onerror = j; x.readAsDataURL(f); });
async function shrink(f) {
  const im = new Image; im.src = await rd(f); await im.decode();
  const s = Math.min(1, 900 / Math.max(im.width, im.height)), c = document.createElement('canvas');
  c.width = im.width * s; c.height = im.height * s; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .7);
}
const notePid = k => (S.notes[k] && S.people[S.notes[k].task]) ? S.notes[k].task : '';

/* ───────── eventi ───────── */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, i = b.dataset.i, j = +b.dataset.j, v = b.dataset.v;
  if (a == 'login') {
    const p = new firebase.auth.GoogleAuthProvider();
    return firebase.auth().signInWithPopup(p).catch(x => ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(x.code) ? firebase.auth().signInWithRedirect(p) : toast('Accesso non riuscito: ' + x.code));
  }
  if (!me) return;
  if (document.activeElement && document.activeElement !== b) document.activeElement.blur?.(); // salva eventuali modifiche in corso
  const go = () => render(true);
  if (a == 'retry') { lastErr = ''; await ensureMember(); return go(); }

  if (a == 'tab') { tab = v; return go(); }
  if (a == 'gosc') { psel = v; tab = 'd'; return go(); }
  if (a == 'psel') { psel = v; return go(); }
  if (a == 'nfil') { nfil = v; return go(); }
  if (a == 'tog') { open.has(i) ? open.delete(i) : open.add(i); return go(); }
  if (a == 'cday') { day = v; return go(); }
  if (a == 'today') { day = iso(new Date()); return go(); }
  if (a == 'cnav') { const d = new Date(day + 'T12:00'); d.setDate(d.getDate() + +v); day = iso(d); return go(); }

  if (a == 'addev') {
    const f = $('#ef').value, t = $('#eto').value, dt = $('#ed').value, ty = $('#et').value;
    if (!dt || !f || !t || t <= f) return toast('Controlla data e orari');
    D.put('events', rid(), { uid: me.uid, type: ty, date: dt, from: f, to: t, label: $('#el').value.trim() });
    fd((ty == 'free' ? 'ha indicato disponibilità il ' : 'ha indicato un impegno il ') + dt); day = dt; return go();
  }
  if (a == 'delev') return D.del('events', i);

  if (a == 'urg') return D.put('tasks', i, { urg: ((S.tasks[i].urg || 0) + 1) % 3 }, 1);
  if (a == 'nurg') return upd(i, n => { n.urg = ((n.urg || 0) + 1) % 3; });
  if (a == 'yes' || a == 'no') {
    const t = S.tasks[i]; if (!t) return; const o = (t.sel || {})[me.uid] || {};
    D.put('tasks', i, { sel: { [me.uid]: { st: a, when: o.when || '' } } }, 1);
    if (a == 'yes' && o.st != 'yes') fd('si è proposto per "' + t.title + '"', t.pid); return;
  }
  if (a == 'addt') {
    const t = $('#nt').value.trim(), k = $('#nk').value, at = $('#na').value;
    if (!t) return toast('Scrivi il titolo');
    if (k == 'med' && !at) return toast('Indica data e ora della visita');
    const o = { title: t, due: $('#nd').value || at.slice(0, 10), done: false, sel: {}, ts: now(), urg: 0, kind: k, pid: $('#np').value, at, rep: $('#nr').value };
    $('#nt').value = ''; D.put('tasks', rid(), o); fd('ha aggiunto impegno: ' + t, o.pid); return;
  }
  if (a == 'done') {
    const t = S.tasks[i]; if (!t) return;
    if (t.rep && !t.done) {
      const d = new Date((t.at || t.due || iso(new Date())).slice(0, 10) + 'T12:00');
      if (t.rep == 'd') d.setDate(d.getDate() + 1); else if (t.rep == 'w') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1);
      const nx = iso(d);
      D.put('tasks', i, { ...t, due: nx, at: t.at ? nx + t.at.slice(10) : '', sel: {} }); fd('ha completato "' + t.title + '", prossima: ' + nx, t.pid); return;
    }
    D.put('tasks', i, { done: !t.done }, 1); return;
  }
  if (a == 'ren') { const t = prompt('Titolo', S.tasks[i].title); if (t) D.put('tasks', i, { title: t }, 1); return; }
  if (a == 'delt') { if (confirm('Eliminare impegno e relative note?')) { Object.entries(S.notes).filter(([, n]) => n.task == i).forEach(([k]) => D.del('notes', k)); D.del('tasks', i); } return; }
  if (a == 'ics') {
    const t = S.tasks[i], d = new Date(t.at || t.due + 'T09:00'), en = new Date(d.getTime() + 36e5),
      f = x => iso(x).replace(/-/g, '') + 'T' + x.toTimeString().slice(0, 5).replace(':', '') + '00',
      txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Famiglia//IT', 'BEGIN:VEVENT', 'UID:' + i + '@famiglia', 'DTSTAMP:' + f(new Date()), 'DTSTART:' + f(d), 'DTEND:' + f(en), 'SUMMARY:' + t.title.replace(/[,;\n]/g, ' '),
        'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Domani', 'END:VALARM', 'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Tra un\'ora', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
      l = document.createElement('a');
    l.href = URL.createObjectURL(new Blob([txt], { type: 'text/calendar' })); l.download = 'impegno.ics'; l.click(); return;
  }

  if (a == 'mkp') { D.put('people', 'babbo', { name: 'Babbo', therapy: [] }); D.put('people', 'mamma', { name: 'Mamma', therapy: [] }); fd('ha creato le schede di Babbo e Mamma'); return; }
  if (a == 'mkp1') { const n = prompt('Nome della nuova scheda'); if (n) { const k = rid(); psel = k; D.put('people', k, { name: n, therapy: [] }); fd('ha creato la scheda di ' + n, k); } return; }
  if (a == 'pren') { const n = prompt('Nome', S.people[psel].name); if (n) D.put('people', psel, { name: n }, 1); return; }
  if (a == 'pdel') { if (confirm('Eliminare la scheda, i parametri e le sue note?')) { Object.entries(S.notes).filter(([, n]) => n.task == psel).forEach(([k]) => D.del('notes', k)); Object.entries(S.vitals).filter(([, x]) => x.pid == psel).forEach(([k]) => D.del('vitals', k)); D.del('people', psel); } return; }
  if (a == 'cpcf') { const cf = (S.people[psel] || {}).cf; if (!cf) return toast('Nessun codice fiscale nella scheda'); navigator.clipboard?.writeText(cf.toUpperCase()); return toast('Codice fiscale copiato'); }
  if (a == 'sos') {
    const p = S.people[psel] || {}, lv = vitalsOf(psel)[0],
      th = (p.therapy || []).filter(x => x.d).map(x => `- ${x.d} (${x.q || ''}) ore ${x.t || ''} ${x.n ? '[' + x.n + ']' : ''}`).join('\n') || 'Nessuna registrata',
      txt = `🚑 RIASSUNTO CLINICO: ${p.name}\nNascita: ${p.born || '—'} (${p.bplace || '—'}) · CF: ${p.cf || '—'}\nGruppo sanguigno: ${p.blood || '—'} · Valori abituali: ${p.base_vit || '—'}\n⚠️ ALLERGIE FARMACI: ${p.allergies_med || 'Nessuna nota'}\nAltre allergie: ${p.allergies || '—'}\nPATOLOGIE: ${p.conditions || '—'}\nINTERVENTI: ${p.surgeries || '—'}\nTERAPIA IN CORSO:\n${th}\n${lv ? `ULTIMI PARAMETRI (${new Date(lv.ts).toLocaleDateString('it-IT')}): PA ${lv.pa || '-'}, FC ${lv.fc || '-'}, SpO2 ${lv.spo2 || '-'}%\n` : ''}Medico: ${p.doctor || '—'} · Emergenza: ${p.emerg || '—'}`;
    navigator.clipboard?.writeText(txt); alert(txt + '\n\n(Copiato negli appunti)'); return;
  }
  if (a == 'addth') { D.put('people', psel, { therapy: [...(S.people[psel].therapy || []), { d: '', q: '', t: b.dataset.t || '', n: '', s: '' }] }, 1); return; }
  if (a == 'delth') { const th = [...(S.people[psel].therapy || [])]; th.splice(j, 1); D.put('people', psel, { therapy: th }, 1); fd('ha rimosso un farmaco dalla terapia di ' + pn(psel), psel, 'th'); return; }
  if (a == 'addvit') {
    const g = id => $(id).value.trim(), e2 = { pid: psel, uid: me.uid, ts: now(), pa: g('#vpa'), fc: g('#vfc'), spo2: g('#vsp'), gl: g('#vgl'), w: g('#vw'), note: g('#vnt') };
    if (!e2.pa && !e2.fc && !e2.spo2 && !e2.gl && !e2.w) return toast('Inserisci almeno un parametro');
    D.put('vitals', rid(), e2);
    fd('ha registrato parametri (' + [e2.pa && 'PA ' + e2.pa, e2.fc && 'FC ' + e2.fc, e2.spo2 && 'SpO2 ' + e2.spo2 + '%', e2.gl, e2.w && e2.w + 'kg'].filter(Boolean).join(', ') + ')' + (e2.note ? ' — ' + e2.note : ''), psel, 'vit');
    ['#vpa', '#vfc', '#vsp', '#vgl', '#vw', '#vnt'].forEach(s => { const el = $(s); if (el) el.value = ''; }); return;
  }
  if (a == 'delvit') return D.del('vitals', i);
  if (a == 'addc') { const n = $('#cn').value.trim(); if (!n) return toast('Scrivi il nome'); D.put('contacts', rid(), { name: n, info: $('#ci').value, tel: $('#ct').value }); fd('ha aggiunto ai contatti: ' + n); return; }
  if (a == 'delc') return D.del('contacts', i);
  if (a == 'adds') {
    const pid = $('#sp').value, ty = $('#sy').value, dt = $('#sd').value, tm = $('#st').value;
    if (!dt) return toast('Indica la data');
    D.put('shifts', rid(), { uid: me.uid, pid, type: ty, date: dt, time: tm }); fd(`ha preso turno (${ty}) del ${dt} alle ${tm}`, pid); return;
  }
  if (a == 'dels') return D.del('shifts', i);
  if (a == 'log') { const t = $('#lt').value.trim(), pid = $('#lp').value; if (!t) return toast('Scrivi una riga'); $('#lt').value = ''; fd(t, pid, 'log'); return; }

  if (a == 'addn') { open.add(i); D.put('notes', rid(), { task: i, text: '', items: [], imgs: [], files: [], ts: now(), by: me.uid }); fd('ha aggiunto una nota a "' + ((S.tasks[i] || {}).title || pn(i)) + '"', S.people[i] ? i : '', 'note'); return; }
  if (a == 'addng') { const tgt = $('#n_target').value || 'gen', txt = $('#n_quick').value.trim(); D.put('notes', rid(), { task: tgt, text: txt, items: [], imgs: [], files: [], ts: now(), by: me.uid }); fd('ha aggiunto una nota' + (txt ? ': "' + txt.slice(0, 40) + '"' : ''), S.people[tgt] ? tgt : '', 'note'); return; }
  if (a == 'deln') { if (confirm('Eliminare la nota?')) D.del('notes', i); return; }
  if (a == 'addi') return upd(i, n => n.items.push({ t: '', d: false }));
  if (a == 'deli') return upd(i, n => n.items.splice(j, 1));
  if (a == 'deli2') return upd(i, n => n.imgs.splice(j, 1));
  if (a == 'delf') return upd(i, n => n.files.splice(j, 1));
  if (a == 'pic') return pick('image/*', async f => { try { const s = await shrink(f); upd(i, n => n.imgs.push(s)); fd('ha allegato una foto a una nota', notePid(i), 'note'); } catch (x) { toast('Formato foto non supportato dal browser'); } });
  if (a == 'att') return pick('*/*', async f => { if (f.size > 600000) return toast('File troppo grande (max 600 KB)'); const d = await rd(f); upd(i, n => n.files.push({ name: f.name, data: d })); fd('ha allegato il file ' + f.name, notePid(i), 'note'); });
});

document.addEventListener('change', e => {
  const c = e.target.dataset.c; if (!c || !me) return;
  if (c == 'when') return D.put('tasks', e.target.dataset.i, { sel: { [me.uid]: { st: 'yes', when: e.target.value } } }, 1);
  if (c == 'role') return D.put('members', e.target.dataset.i, { role: e.target.value }, 1);
  if (c == 'sc') {
    const f = e.target.dataset.f; D.put('people', psel, { [f]: e.target.value }, 1);
    fdOnce('sc' + psel + f, `ha aggiornato "${(FL.find(x => x[0] == f) || [, 'un campo'])[1].split(' (')[0]}" nella scheda di ${pn(psel)}`, psel, 'sc'); return;
  }
  if (c == 'th') {
    const th = [...document.querySelectorAll('.tp')].map(r => { const q = r.querySelectorAll('input'); return { d: q[0].value, q: q[1].value, t: q[2].value, n: q[3].value, s: q[4].value }; });
    D.put('people', psel, { therapy: th }, 1); fdOnce('th' + psel, 'ha aggiornato la terapia di ' + pn(psel), psel, 'th'); return;
  }
  if (c == 'note') readNote(e.target.closest('.note'));
});

document.addEventListener('focusout', () => setTimeout(() => { if (pend) render(); }, 250));
$('#out').onclick = () => firebase.auth().signOut();
window.__appOK = true;
try { init(); } catch (e) { step('ERRORE avvio: ' + e.message); throw e; }
