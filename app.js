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

const PAL = ['#d6336c', '#1c7ed6', '#2f9e44', '#f08c00', '#7048e8', '#0ca678', '#e8590c', '#1098ad'],
  UL = ['Normale', 'Importante', 'Urgente'],
  H0 = 7, H1 = 22, T = (H1 - H0) * 60,
  COLLS = ['tasks', 'notes', 'people', 'events', 'contacts', 'shifts', 'feed', 'vitals', 'projects', 'pupdates', 'reminders', 'checks', 'config'],
  hash = u => [...String(u)].reduce((a, c) => a + c.charCodeAt(0), 0);

const emptyS = () => ({ members: {}, tasks: {}, notes: {}, events: {}, people: {}, contacts: {}, shifts: {}, feed: {}, vitals: {}, projects: {}, pupdates: {}, reminders: {}, checks: {}, config: {}, prefs: {}, logins: {} });
let me, D, S = emptyS(), unsubs = [], dataOn = false, pend = false, raf = 0, rf = false, membersLoaded = false, lastErr = '';
let thEdit = null, rxOpen = null, loginsOn = false, pfil = 'open', slotOpen = false, open = new Set(), psel = null, nfil = 'all', tab = 'h', day = iso(new Date());
const lastFeed = {};
let ensuring = false;
const step = m => { (window.__log = window.__log || []).push(new Date().toLocaleTimeString('it-IT') + '  ' + m); },
  withT = (p, ms, msg) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms))]),
  stepsHtml = () => `<details open class="diag"><summary>Passaggi</summary><pre>${esc((window.__log || []).join('\n'))}</pre></details>`;

const plist = () => Object.entries(S.people).sort((a, b) => (a[1].ord ?? 99) - (b[1].ord ?? 99) || String(a[1].name).localeCompare(String(b[1].name))),
  both = () => { const b = ['babbo', 'mamma'].filter(x => S.people[x]); return b.length ? b : plist().map(([i]) => i); },
  bothName = () => both().map(pn).join(' e ') || 'Entrambi',
  covers = (s, pi) => s.pid == pi || ((!s.pid || s.pid == 'both') && both().includes(pi));
const role = () => (me && (S.members[me.uid] || {}).role) || '',
  isEd = () => ['editor', 'admin'].includes(role()),
  col = u => (S.members[u] || {}).color || PAL[hash(u) % PAL.length],
  pn = p => (S.people[p] || {}).name || '',
  mname = u => esc((S.members[u] || {}).name || 'Familiare'),
  popt = f => `<option value="">${f}</option>` + plist().map(([i, p]) => `<option value="${i}">${esc(p.name)}</option>`).join(''),
  urg = (o, a, i, ed) => { const u = o.urg || 0; return ed ? `<button class="ub" data-a="${a}" data-i="${i}">⚑ ${UL[u]}</button>` : u ? `<span class="ub">⚑ ${UL[u]}</span>` : ''; };

function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 3500); }

/* ───────── database (Firestore) ───────── */
function fbDB() {
  if (!firebase.apps.length) firebase.initializeApp(CFG);
  const f = firebase.firestore();
  try { f.settings({ experimentalForceLongPolling: true, merge: true }); } catch (e) { }
  const LIM = { feed: 80, vitals: 300, logins: 500 },
    err = c => e => { lastErr = `${c}: ${e.code || e.message}`; toast('Errore ' + lastErr); render(true); },
    deny = c => e => { step('scrittura negata su ' + c + ': ' + (e.code || e.message)); toast('Non consentito (' + c + '): ' + (e.code || e.message)); };
  return {
    watch: (c, cb) => (LIM[c] ? f.collection(c).orderBy('ts', 'desc').limit(LIM[c]) : f.collection(c))
      .onSnapshot(q => { const o = {}; q.forEach(d => o[d.id] = d.data()); cb(o); }, err(c)),
    put: (c, i, d, m) => (m ? f.collection(c).doc(i).set(d, { merge: true }) : f.collection(c).doc(i).set(d)).catch(deny(c)),
    del: (c, i) => f.collection(c).doc(i).delete().catch(deny(c)),
    raw: f
  };
}

const fd = (text, pid, k) => me && D.put('feed', rid(), { uid: me.uid, text, pid: pid || '', k: k || '', ts: now() });
const fdOnce = (key, text, pid, k) => { if (now() - (lastFeed[key] || 0) < 3e5) return; lastFeed[key] = now(); fd(text, pid, k); };

/* ───────── avvio e accesso ───────── */
function stop() { unsubs.forEach(u => u && u()); unsubs = []; dataOn = false; loginsOn = false; membersLoaded = false; lastErr = ''; S = emptyS(); }

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
      $('#app').innerHTML = '<div class="login"><img class="logo" src="icon.svg" alt=""><h2>App Famiglia</h2><p>Accedi per coordinare le cure di Babbo e Mamma.</p><button class="pri" data-a="login">Accedi con Google</button></div>';
      return;
    }
    me = { uid: u.uid, name: u.displayName || u.email, email: (u.email || '').toLowerCase() };
    $('#who').textContent = me.name; $('#out').hidden = false;
    $('#app').innerHTML = '<p class="c">Caricamento…</p>';
    step('utente: ' + me.email);
    unsubs.push(D.watch('members', o => { S.members = o; membersLoaded = true; step('membri ricevuti: ' + Object.keys(o).length + ', mio ruolo: ' + (role() || 'nessuno')); gate(); watchLogins(); render(true); }));
    ensuring = true; await ensureMember(); ensuring = false; render(true);
  });
}

async function ensureMember() {
  const ref = D.raw.collection('members').doc(me.uid), base = { name: me.name, email: me.email, color: PAL[hash(me.uid) % PAL.length] },
    boss = (typeof ADMIN_EMAILS !== 'undefined' ? ADMIN_EMAILS : []).map(x => String(x).trim().toLowerCase()).includes(me.email),
    TO = 'Firestore non risponde';
  try {
    step('profilo: lettura…');
    if ((await withT(ref.get(), 20000, TO)).exists) { step('profilo: trovato'); return; }
    step('profilo: assente, creazione come ' + (boss ? 'admin' : 'in attesa') + (boss ? '' : ' (email non presente in ADMIN_EMAILS)'));
    try { await withT(ref.set({ ...base, role: boss ? 'admin' : 'pending' }), 20000, TO); step('profilo: creato'); }
    catch (e) {
      if (!boss) throw e;
      lastErr = 'creazione come admin rifiutata dalle regole (' + (e.code || e.message) + ')'; step(lastErr);
      await withT(ref.set({ ...base, role: 'pending' }), 20000, TO); step('profilo: creato come in attesa');
    }
  } catch (e) {
    lastErr = 'profilo non creato: ' + (e.code || e.message); step(lastErr);
    if (e.message == TO || e.code == 'unavailable') lastErr = await probe();
    toast(lastErr);
  }
}

/* Test diretto via REST: capisce se manca il database, se le regole bloccano o se la rete è filtrata. */
async function probe() {
  step('test diretto del database…');
  try {
    const tok = await firebase.auth().currentUser.getIdToken(),
      r = await withT(fetch(`https://firestore.googleapis.com/v1/projects/${CFG.projectId}/databases/(default)/documents/members/${me.uid}`, { headers: { Authorization: 'Bearer ' + tok } }), 15000, 'timeout'),
      t = await r.text();
    step('risposta: HTTP ' + r.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 220));
    if (/does not exist/i.test(t)) return 'Il database Firestore non esiste ancora: Firebase → Build → Firestore Database → Crea database (modalità produzione), poi pubblica le regole.';
    if (/Datastore Mode/i.test(t)) return 'Il database è in modalità Datastore: serve un database Firestore in modalità nativa.';
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(t)) return 'L\'API Cloud Firestore è disattivata nel progetto: aprendo Firestore Database dalla console Firebase si attiva.';
    if (r.status == 403) return 'Le regole Firestore bloccano la lettura: pubblica firestore.rules e premi Riprova.';
    if (r.ok || r.status == 404) return 'Il database risponde, ma il collegamento dell\'app viene bloccato (rete, antivirus o estensione del browser). Ricarica la pagina; se persiste, prova da rete mobile o in navigazione anonima.';
    return 'Risposta inattesa dal database (HTTP ' + r.status + ').';
  } catch (x) {
    step('test diretto fallito: ' + x.message);
    return 'Il browser non riesce a raggiungere firestore.googleapis.com: blocco di rete, antivirus o estensione (adblock). Prova da rete mobile o in navigazione anonima.';
  }
}

function gate() {
  if (!['viewer', 'editor', 'admin'].includes(role()) || dataOn) return;
  dataOn = true; step('caricamento dati');
  unsubs.push(D.raw.collection('prefs').doc(me.uid).onSnapshot(d => { S.prefs = d.exists ? d.data() : {}; syncLook(); render(); }, () => { }));
  listenPush();
  logAccess();
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
  if (R == 'pending') { app.innerHTML = `<div class="login"><div class="logo">⏳</div><h2>Richiesta inviata</h2><p>Chiedi all'amministratore di autorizzarti.<br>Questa pagina si aggiorna da sola.</p><p class="due">${esc(me.email)}</p></div>`; return; }
  const adm = R == 'admin',
    keep = fresh ? [] : [...document.querySelectorAll('main [id]')].filter(el => 'value' in el).map(el => [el.id, el.value]),
    tabs = tabList();
  let h = '<nav>' + tabs.map(([v, l]) => { const [ic, ...tx] = l.split(' '); return `<button data-a="tab" data-v="${v}" class="${tab == v ? 'on' : ''}"><span class="ti">${ic}</span><span>${tx.join(' ')}</span></button>`; }).join('') + '</nav><main>';
  if (tab == 'h') h += home();
  else if (tab == 'd') h += schede();
  else if (tab == 'n') h += notesTab();
  else if (tab == 'j') h += projectsTab();
  else if (tab == 'i') h += settings();
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
  h += accessHistory();
  return h;
}

/* ───────── impegni ───────── */
function tasksTab() {
  let h = remHtml();
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
    ${urg(t, 'urg', i, ed)}${t.at || t.due ? `<button data-a="ics" data-i="${i}" title="Scarica promemoria (.ics)">⏰</button><button data-a="gadd" data-k="task" data-i="${i}" title="Aggiungi a Google Calendar">📅</button>` : ''}
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
    label = ctx ? (n.task == 'gen' ? '📌 Bacheca generale' : S.people[n.task] ? '👤 Scheda ' + esc(S.people[n.task].name) : S.projects[n.task] ? '📁 ' + esc(S.projects[n.task].title) : S.tasks[n.task] ? '✅ ' + esc(S.tasks[n.task].title) : '📌 Nota') : '';
  return `<div class="note u${n.urg || 0}" data-n="${k}"><div class="note-hdr"><span>${label ? `<b>${label}</b> · ` : ''}${n.by ? 'di ' + mname(n.by) + ' · ' : ''}${ago(n.ts)}</span>${ed ? '' : urg(n, '', k, false)}</div>
    <textarea data-c="note" ${dis} placeholder="Scrivi una nota, appunti medici, cose da comprare…">${esc(n.text)}</textarea>
    ${(n.items || []).map((x, j) => `<div class="it"><input type="checkbox" data-c="note" ${dis} ${x.d ? 'checked' : ''}><input type="text" data-c="note" ${dis} value="${esc(x.t)}" placeholder="Voce elenco…">${ed ? `<button class="x" data-a="deli" data-i="${k}" data-j="${j}">×</button>` : ''}</div>`).join('')}
    <div class="imgs">${(n.imgs || []).map((s, j) => `<div><img src="${esc(s)}" alt="foto">${ed ? `<button class="x" data-a="deli2" data-i="${k}" data-j="${j}">×</button>` : ''}</div>`).join('')}</div>
    <div class="files">${(n.files || []).map((f, j) => `<a href="${esc(f.data)}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>${ed ? `<button class="x" data-a="delf" data-i="${k}" data-j="${j}">×</button>` : ''}`).join('')}</div>
    ${ed ? `<div class="tools">${urg(n, 'nurg', k, true)}<button data-a="addi" data-i="${k}">☑ Checklist</button><button data-a="pic" data-i="${k}">📷 Foto</button><button data-a="att" data-i="${k}">📎 File</button><button data-a="deln" data-i="${k}">🗑</button></div>` : ''}</div>`;
}

function notesTab() {
  const ed = isEd(), pe = plist();
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
  let h = `<div class="row nav-day"><button data-a="cnav" data-v="-1">◀</button><b class="grow center">${d0.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</b><button data-a="cnav" data-v="1">▶</button><button data-a="today">Oggi</button><button data-a="gsync" title="Sincronizza Google Calendar">🔄</button></div><div class="wk">`;
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
const WD = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'], WORDER = [1, 2, 3, 4, 5, 6, 0],
  sdays = () => ((S.config.slots || {}).days) || {},
  slotsOf = d => sdays()[new Date(d + 'T12:00').getDay()] || [];
function slotEditor() {
  const days = sdays();
  return `<details class="tl" id="slotbox" ${slotOpen ? 'open' : ''}><summary><b>⚙️ Fasce orarie dei turni</b> <span class="due">solo admin</span></summary>
    ${WORDER.map(w => `<div class="tr"><b class="pn">${WD[w].slice(0, 3)}</b><span class="grow">${(days[w] || []).map((x, j) => `<span class="chip">${esc(x.l ? x.l + ' ' : '')}${esc(x.f)}–${esc(x.t)} <button class="ub" data-a="delslot" data-v="${w}" data-j="${j}">×</button></span> `).join('') || '<span class="due">nessuna</span>'}</span></div>`).join('')}
    <div class="add"><select id="zw" aria-label="Giorno">${WORDER.map(w => `<option value="${w}">${WD[w]}</option>`).join('')}<option value="feriali">Lunedì–venerdì</option><option value="all">Tutti i giorni</option></select><input type="text" id="zl" placeholder="Nome (es. Mattina)"><input type="time" id="zf" value="09:00"><input type="time" id="zt" value="12:00"><button class="pri sm" data-a="addslot">Aggiungi fascia</button></div></details>`;
}
function shifts() {
  const pe = plist(), adm = role() == 'admin';
  if (!pe.length) return '<p class="c">Prima crea le schede dei genitori (scheda Schede).</p>';
  const icons = { visita: '🚪', telefonata: '📞' },
    whoOpt = sel => `<option value="both" ${sel == 'both' ? 'selected' : ''}>${esc(bothName())}</option>` + pe.map(([i, p]) => `<option value="${i}" ${sel == i ? 'selected' : ''}>Solo ${esc(p.name)}</option>`).join('');
  let h = adm ? slotEditor() : '';
  if (!Object.values(sdays()).some(x => x && x.length)) return h + `<p class="c">Nessuna fascia oraria definita. ${adm ? 'Aggiungile qui sopra.' : 'Le definisce l\'amministratore.'}</p>`;
  h += `<p class="due">Le visite valgono per ${esc(bothName())}. Se in casa c'è solo uno dei due, cambialo nel tuo turno: verrà segnalato a tutti.</p>`;
  for (let k = 0; k < 14; k++) {
    const d = new Date(); d.setDate(d.getDate() + k); const v = iso(d), sl = slotsOf(v);
    if (!sl.length) continue;
    h += `<div class="tl"><b>${d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'short' })}</b>`;
    for (const x of sl) {
      const key = x.f + '-' + x.t, ss = Object.entries(S.shifts).filter(([, y]) => y.date == v && y.slot == key);
      h += `<div class="slot"><div class="slot-h"><b class="grow">${esc(x.l || '')} <span class="due">${esc(x.f)}–${esc(x.t)}</span></b>${ss.some(([, y]) => y.uid == me.uid) ? '' : `<button class="sm" data-a="book" data-v="${v}|${key}|visita">🚪 Vado io</button><button class="sm" data-a="book" data-v="${v}|${key}|telefonata">📞 Chiamo io</button>`}</div>
        ${ss.length ? ss.map(([si, y]) => `<div class="slot-p"><span class="chip" style="color:${col(y.uid)}">${icons[y.type] || '🚪'} ${mname(y.uid)}</span>${y.uid == me.uid || adm ? `<select data-c="spres" data-i="${si}" aria-label="Chi c'è in casa">${whoOpt(y.pid || 'both')}</select><button class="sm" data-a="gadd" data-k="shift" data-i="${si}" title="Aggiungi a Google Calendar">📅</button><button class="x" data-a="dels" data-i="${si}">×</button>` : `<span class="due">${y.pid && y.pid != 'both' ? '⚠ solo ' + esc(pn(y.pid)) : esc(bothName())}</span>`}</div>`).join('') : '<div class="due warn">scoperta</div>'}</div>`;
    }
    h += '</div>';
  }
  return h;
}

/* ───────── progetti ───────── */
function projectsTab() {
  const ed = isEd(), pe = plist(),
    tname = p => p == 'casa' ? '🏠 Casa' : p == 'both' || !p ? bothName() : pn(p),
    tgt = `<option value="both">${esc(bothName())}</option>` + pe.map(([i, p]) => `<option value="${i}">${esc(p.name)}</option>`).join('') + '<option value="casa">🏠 Casa</option>';
  let h = `<div class="wk"><button data-a="pfil" data-v="open" class="${pfil == 'open' ? 'on' : ''}">In corso</button><button data-a="pfil" data-v="done" class="${pfil == 'done' ? 'on' : ''}">Conclusi</button></div>`;
  if (ed) h += `<div class="add"><input type="text" id="pjt" placeholder="Nuovo progetto (es. scalaggio farmaco, sistemare salotto)"><select id="pjp" aria-label="Riguarda">${tgt}</select><button class="pri" data-a="addpj">+ Crea progetto</button></div>`;
  const ps = Object.entries(S.projects).filter(([, p]) => (p.status || 'open') == pfil).sort((a, b) => (b[1].upd || b[1].ts || 0) - (a[1].upd || a[1].ts || 0));
  if (!ps.length) return h + `<p class="c">Nessun progetto ${pfil == 'open' ? 'in corso' : 'concluso'}.</p>`;
  for (const [i, p] of ps) {
    const ups = Object.entries(S.pupdates).filter(([, u]) => u.proj == i).sort((a, b) => b[1].ts - a[1].ts), all = open.has('pj' + i),
      ns = Object.entries(S.notes).filter(([, n]) => n.task == i);
    h += `<div class="task pj"><div class="th"><b class="grow">📁 ${esc(p.title)}</b><span class="badge">${esc(tname(p.pid))}</span>${ed ? `<button class="sm" data-a="pjst" data-i="${i}">${p.status == 'done' ? '↩ Riapri' : '✔ Concludi'}</button><button class="sm" data-a="pjren" data-i="${i}">✏️</button><button class="sm" data-a="pjdel" data-i="${i}">🗑</button>` : ''}</div>
      <div class="add pj-add"><input type="text" id="pu_${i}" placeholder="Aggiornamento (es. da oggi mezza compressa)"><button class="pri sm" data-a="addpu" data-i="${i}">Aggiungi</button></div>
      <div class="timeline">${(all ? ups : ups.slice(0, 4)).map(([ui, u]) => `<div class="tl-item" style="--c:${col(u.uid)}"><div class="grow"><b style="color:${col(u.uid)}">${mname(u.uid)}</b> <span class="due">${new Date(u.ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><div>${esc(u.text)}</div>${rxHtml('pupdates', ui, u)}</div>${u.uid == me.uid || role() == 'admin' ? `<button class="x" data-a="delpu" data-i="${ui}">×</button>` : ''}</div>`).join('') || '<div class="due">Nessun aggiornamento ancora.</div>'}</div>
      ${ups.length > 4 ? `<button class="sm" data-a="pjall" data-i="${i}">${all ? 'Mostra meno' : 'Mostra tutti (' + ups.length + ')'}</button>` : ''}
      <div class="row"><button data-a="tog" data-i="${i}">📝 Note (${ns.length}) ${open.has(i) ? '▲' : '▼'}</button></div>
      ${open.has(i) ? `<div class="notes">${ns.map(([k, n]) => note(k, n, ed)).join('')}${ed ? `<div><button data-a="addn" data-i="${i}">+ Nuova nota</button></div>` : ''}</div>` : ''}</div>`;
  }
  return h;
}

/* ───────── promemoria e copertura lezioni ───────── */
function remHtml() {
  const ms = Object.entries(S.members).filter(([, m]) => m.role && m.role != 'pending'),
    up = Object.entries(S.reminders).filter(([, r]) => r.atTs > now() - 36e5).sort((a, b) => a[1].atTs - b[1].atTs);
  return `<div class="tl"><b>⏰ Promemoria con notifica</b><div class="add" style="margin:8px 0 4px"><input type="text" id="rt" placeholder="Cosa ricordare (es. ritirare la ricetta)"><select id="ru" aria-label="A chi"><option value="all">A tutti</option>${ms.map(([u, m]) => `<option value="${u}">${u == me.uid ? 'A me' : 'A ' + esc(m.name)}</option>`).join('')}</select><input type="datetime-local" id="ra" aria-label="Quando"><button class="pri sm" data-a="addrem">Imposta</button></div>
    ${up.map(([i, r]) => `<div class="vit-row"><b>${fmt(r.at)}</b><span class="grow">${esc(r.text)} <span class="due">→ ${r.to == 'all' ? 'tutti' : mname(r.to)} · da ${mname(r.by)}</span></span>${r.by == me.uid || role() == 'admin' ? `<button class="x" data-a="delrem" data-i="${i}">×</button>` : ''}</div>`).join('')}</div>`;
}
function coverHtml() {
  const td = iso(new Date()), t0 = now(), by = {};
  for (const e of Object.values(S.events)) if (e.cover && e.date == td && (e.ts1 || 0) > t0 - 2 * 36e5) (by[e.uid] = by[e.uid] || []).push(e);
  const us = Object.keys(by); if (!us.length) return '';
  return `<h3>📚 Chi sente ${esc(bothName())}?</h3>` + us.map(u => {
    const ev = by[u].sort((a, b) => a.from.localeCompare(b.from)), id = td + '_' + u, c = S.checks[id] || {}, mine = u == me.uid;
    const st = c.done ? `✅ Sentiti da <b>${mname(c.by)}</b> ${ago(c.dts)}` : c.by ? `👋 Ci pensa <b>${mname(c.by)}</b>` : mine ? 'In attesa che qualcuno se ne occupi' : '<span class="warn">Nessuno se ne sta occupando</span>';
    const btn = c.done ? '' : c.by == me.uid ? `<button class="pri sm" data-a="cvdone" data-v="${id}">✅ Sentiti: scrivi com'è andata</button>` : !c.by && !mine ? `<button class="pri sm" data-a="cvme" data-v="${id}|${u}">Ci penso io</button>` : '';
    return `<div class="mem cover" style="--c:${col(u)}"><span><b style="color:${col(u)}">${mine ? 'Tu' : mname(u)}</b> oggi non ${mine ? 'sei disponibile' : 'è disponibile'}: ${ev.map(e => esc(e.from) + '–' + esc(e.to) + (e.label && e.label != 'Impegnato' ? ' ' + esc(e.label) : '')).join(' · ')}<br><span class="due">${st}</span></span>${btn}</div>`;
  }).join('');
}

/* ───────── impostazioni: notifiche, Google Calendar, ordine barra ───────── */
const TABS = [['h', '🏠 Home'], ['d', '👴👵 Schede'], ['j', '📁 Progetti'], ['n', '📝 Note'], ['t', '✅ Impegni'], ['s', '🚪 Turni'], ['c', '📅 Calendario'], ['p', '🔑 Accessi'], ['i', '⚙️ Impostazioni']];
const tabList = () => { const o = (S.prefs || {}).tabs || [], ix = v => { const k = o.indexOf(v); return k < 0 ? 50 + TABS.findIndex(t => t[0] == v) : k; }; return TABS.filter(t => t[0] != 'p' || role() == 'admin').sort((a, b) => ix(a[0]) - ix(b[0])); };
function settings() {
  const p = S.prefs || {}, n = p.notif || {}, cals = p.cals || {},
    perm = typeof Notification == 'undefined' ? 'unsupported' : Notification.permission,
    on = perm == 'granted' && Object.keys(p.tokens || {}).length,
    ios = /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !navigator.standalone,
    NK = [['rem', '⏰ Promemoria'], ['med', '🩺 Visite mediche (il giorno prima e un\'ora prima)'], ['gap', '🚪 Turno di domani scoperto (alle 18)'], ['upd', '💬 Aggiornamenti su genitori e progetti'], ['cover', '📚 Richieste di sentire i genitori quando qualcuno è impegnato']];
  let h = lookHtml() + `<div class="tl"><b>🔔 Notifiche su questo dispositivo</b><p class="due">Stato: ${on ? 'attive ✅' : perm == 'denied' ? 'bloccate dal browser (riattivale dalle impostazioni del sito)' : perm == 'unsupported' ? 'non supportate da questo browser' : 'non attive'}${ios ? '<br>Su iPhone funzionano solo dall\'app installata sulla schermata Home.' : ''}</p>
    <div class="row"><button class="pri sm" data-a="pushon">${on ? 'Riattiva' : 'Attiva notifiche'}</button><button class="sm" data-a="pushtest">Prova</button></div>
    ${NK.map(([k, l]) => `<label class="chk"><input type="checkbox" data-c="nk" data-f="${k}" ${n[k] === false ? '' : 'checked'}> ${l}</label>`).join('')}</div>`;
  h += `<div class="tl"><b>📅 Google Calendar</b><p class="due">I tuoi impegni compaiono nel Calendario della famiglia come "Impegnato". Per i calendari segnati con 📚 (es. lezioni) gli altri vedono il titolo e ricevono la richiesta di sentire i genitori mentre sei impegnato/a. Sincronizza quando aggiungi impegni nuovi.</p>
    <div class="row"><button class="pri sm" data-a="gsync">${Object.keys(cals).length ? '🔄 Sincronizza ora' : 'Collega Google Calendar'}</button>${p.gsync ? `<span class="due">Ultima sincronizzazione ${ago(p.gsync)}</span>` : ''}</div>
    ${Object.entries(cals).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name))).map(([id, c]) => `<div class="vit-row"><span class="grow"><b>${esc(c.name)}</b></span><label class="chk"><input type="checkbox" data-c="gcal" data-f="on" data-i="${esc(id)}" ${c.on ? 'checked' : ''}> usa</label><label class="chk"><input type="checkbox" data-c="gcal" data-f="cover" data-i="${esc(id)}" ${c.cover ? 'checked' : ''}> 📚 chiedi di sentire i genitori</label></div>`).join('')}</div>`;
  h += `<div class="tl"><b>↕️ Ordine della barra</b>${tabList().map(([v, l], j, a) => `<div class="vit-row"><span class="grow">${l}</span><button class="sm" data-a="tmv" data-v="${v}" data-j="-1" ${j ? '' : 'disabled'}>↑</button><button class="sm" data-a="tmv" data-v="${v}" data-j="1" ${j == a.length - 1 ? 'disabled' : ''}>↓</button></div>`).join('')}</div>`;
  return h;
}

/* notifiche push (Firebase Cloud Messaging) */
let pushHooked = false;
function listenPush() {
  try { if (pushHooked || !firebase.messaging || typeof Notification == 'undefined' || Notification.permission != 'granted') return; pushHooked = true;
    firebase.messaging().onMessage(p => { const n = p.notification || {}; toast((n.title ? n.title + ': ' : '') + (n.body || '')); });
  } catch (e) { step('notifiche: ' + e.message); }
}
async function pushOn() {
  if (typeof VAPID_KEY == 'undefined' || !VAPID_KEY) return alert('Manca la chiave VAPID_KEY in config.js');
  if (typeof Notification == 'undefined' || !firebase.messaging || !(await firebase.messaging.isSupported())) return alert('Questo browser non supporta le notifiche. Su iPhone installa prima l\'app sulla schermata Home.');
  if (await Notification.requestPermission() != 'granted') return toast('Permesso negato');
  const reg = await navigator.serviceWorker.ready,
    tok = await firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  await D.put('prefs', me.uid, { tokens: { [tok]: now() } }, 1); listenPush(); toast('Notifiche attive ✅');
}

/* Google Calendar */
const GSCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
async function gtoken() {
  try { const c = JSON.parse(sessionStorage.gtok || 'null'); if (c && c.exp > now() + 6e4) return c.t; } catch (e) { }
  const p = new firebase.auth.GoogleAuthProvider(); GSCOPES.forEach(x => p.addScope(x)); p.setCustomParameters({ login_hint: me.email });
  const r = await firebase.auth().currentUser.reauthenticateWithPopup(p), t = r.credential && r.credential.accessToken;
  if (!t) throw new Error('autorizzazione al calendario non ricevuta');
  sessionStorage.gtok = JSON.stringify({ t, exp: now() + 50 * 6e4 }); return t;
}
async function gapi(path, opt = {}) {
  const t = await gtoken(), r = await fetch('https://www.googleapis.com/calendar/v3/' + path, { ...opt, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
  if (r.status == 401) sessionStorage.removeItem('gtok');
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 160));
  return r.status == 204 ? null : r.json();
}
async function gsync() {
  toast('Sincronizzo Google Calendar…');
  const list = await gapi('users/me/calendarList?minAccessRole=reader'), old = (S.prefs || {}).cals || {}, cals = {};
  for (const c of list.items || []) cals[c.id] = { name: c.summaryOverride || c.summary || c.id, on: old[c.id] ? !!old[c.id].on : !!c.primary, cover: old[c.id] ? !!old[c.id].cover : false };
  const t0 = new Date(); t0.setHours(0, 0, 0, 0); const t1 = new Date(t0.getTime() + 31 * 864e5), keep = {}, hm = x => x.toTimeString().slice(0, 5);
  for (const [id, c] of Object.entries(cals)) {
    if (!c.on) continue;
    const r = await gapi(`calendars/${encodeURIComponent(id)}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${t0.toISOString()}&timeMax=${t1.toISOString()}`);
    for (const e of r.items || []) {
      if (!e.start || !e.start.dateTime || e.transparency == 'transparent' || e.status == 'cancelled') continue;
      const a = new Date(e.start.dateTime), b = new Date(e.end.dateTime), k = 'g_' + me.uid + '_' + (id + e.id).replace(/[^A-Za-z0-9]/g, '').slice(-80);
      keep[k] = { uid: me.uid, type: 'busy', src: 'g', date: iso(a), from: hm(a), to: iso(a) == iso(b) ? hm(b) : '23:59', ts0: a.getTime(), ts1: b.getTime(), cover: !!c.cover, label: c.cover ? (e.summary || 'Impegno') : 'Impegnato' };
    }
  }
  const ops = Object.entries(keep).map(([k, v]) => ['set', k, v]).concat(Object.entries(S.events).filter(([k, e]) => e.src == 'g' && e.uid == me.uid && !keep[k]).map(([k]) => ['del', k]));
  for (let x = 0; x < ops.length; x += 450) { const bt = D.raw.batch(); ops.slice(x, x + 450).forEach(([o, k, v]) => o == 'set' ? bt.set(D.raw.collection('events').doc(k), v) : bt.delete(D.raw.collection('events').doc(k))); await bt.commit(); }
  await D.put('prefs', me.uid, { cals, gsync: now() }, 1);
  toast(`Calendario sincronizzato: ${Object.keys(keep).length} impegni`);
}
async function gadd(k, i) {
  let s, e, title;
  if (k == 'task') { const t = S.tasks[i]; s = new Date(t.at || t.due + 'T09:00'); e = new Date(s.getTime() + 36e5); title = t.title + (t.pid ? ' – ' + pn(t.pid) : ''); }
  else { const x = S.shifts[i]; s = new Date(x.date + 'T' + x.time); e = new Date(x.date + 'T' + (x.end || x.time)); if (!(e > s)) e = new Date(s.getTime() + 36e5); title = (x.type == 'telefonata' ? '📞 Chiamare ' : '🚪 Visita a ') + (x.pid && x.pid != 'both' ? pn(x.pid) : bothName()); }
  await gapi('calendars/primary/events', { method: 'POST', body: JSON.stringify({ summary: title, start: { dateTime: s.toISOString() }, end: { dateTime: e.toISOString() }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] } }) });
  toast('Aggiunto a Google Calendar 📅');
}

/* ───────── schede genitori ───────── */
const SECTIONS = [
  { title: '📋 Anagrafica, documenti e burocrazia', fields: [
    ['born', 'Data di nascita', 'date', ''], ['bplace', 'Luogo e provincia di nascita', 'text', 'es. Cagliari (CA)'],
    ['cf', 'Codice fiscale', 'text', '16 caratteri'], 
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
  const ed = isEd(), dis = ed ? '' : 'disabled', pe = plist();
  const cont = `<h3>📇 Rubrica contatti utili</h3>` + Object.entries(S.contacts).sort((a, b) => String(a[1].name).localeCompare(b[1].name)).map(([i, c]) => `<div class="mem"><span><b>${esc(c.name)}</b> · ${esc(c.info)}<br>${c.tel ? `<a href="tel:${esc(String(c.tel).replace(/\s/g, ''))}">📞 ${esc(c.tel)}</a>` : ''}</span>${ed ? `<button data-a="delc" data-i="${i}">🗑</button>` : ''}</div>`).join('')
    + (ed ? `<div class="add"><input type="text" id="cn" placeholder="Nome (es. Guardia medica, Dott. Rossi)"><input type="text" id="ci" placeholder="Ruolo / orari"><input type="tel" id="ct" placeholder="Telefono"><button class="pri" data-a="addc">Aggiungi</button></div>` : '');
  if (!pe.length) return (ed ? '<p class="c">Nessuna scheda.<br><br><button class="pri" data-a="mkp">Crea le schede di Babbo e Mamma</button></p>' : '<p class="c">Nessuna scheda ancora.</p>') + cont;
  if (!S.people[psel]) psel = pe[0][0];
  const p = S.people[psel], vits = vitalsOf(psel);
  let h = `<div class="wk">${pe.map(([i, q]) => `<button data-a="psel" data-v="${i}" class="${i == psel ? 'on' : ''}">👤 ${esc(q.name)}</button>`).join('')}${ed ? '<button data-a="pmv" data-j="-1" class="fit" title="Sposta prima">◀</button><button data-a="pmv" data-j="1" class="fit" title="Sposta dopo">▶</button><button data-a="mkp1" class="fit" title="Nuova scheda">+</button>' : ''}</div>
    <p class="due">Le modifiche si salvano da sole e compaiono nelle novità della Home. Dati sensibili: li vedono tutti i membri autorizzati.</p>
    <div class="task u0"><div class="th"><b class="grow">Scheda di ${esc(p.name)}</b><button class="sm" data-a="cpcf">📋 Copia CF</button><button class="sm pri" data-a="sos">🚑 Riassunto 118/PS</button>${ed ? '<button class="sm" data-a="pren">✏️</button><button class="sm" data-a="pdel">🗑</button>' : ''}</div>`;
  h += therapyHtml(p, ed);
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
  const t0 = now(), td = iso(new Date()), tm = iso(new Date(t0 + 864e5)), pe = plist(), rem = [];
  for (const t of Object.values(S.tasks)) {
    if (t.done) continue;
    const w = t.at ? new Date(t.at).getTime() : 0;
    if (t.kind == 'med' && w > t0 - 36e5 && w < t0 + 7 * 864e5) {
      const ys = Object.keys(t.sel || {}).filter(u => t.sel[u] && t.sel[u].st == 'yes' && S.members[u]);
      rem.push([w, `🩺 <b>${esc(t.title)}</b> · ${esc(pn(t.pid))} · ${fmt(t.at)} — ${ys.length ? 'accompagna ' + ys.map(u => esc(S.members[u].name)).join(', ') : '<b class="warn">nessuno accompagna!</b>'}`]);
    } else if (t.urg == 2) rem.push([w || t0, `⚑ <b class="warn">Urgente:</b> ${esc(t.title)} ${t.pid ? '(' + esc(pn(t.pid)) + ')' : ''}`]);
  }
  for (const r of Object.values(S.reminders)) if ((r.to == 'all' || r.to == me.uid) && r.atTs > t0 - 36e5 && r.atTs < t0 + 864e5) rem.push([r.atTs, `⏰ ${esc(r.text)} · ${fmt(r.at)}`]);
  for (const [d, l] of [[td, 'oggi'], [tm, 'domani']]) {
    const miss = pe.filter(([pi]) => !Object.values(S.shifts).some(s => covers(s, pi) && s.date == d)).map(([, p]) => esc(p.name));
    if (miss.length) rem.push([t0 + (d == tm ? 1 : 0), `⚠️ Nessuna visita o telefonata per <b>${l}</b>: <b>${miss.join(', ')}</b>`]);
  }
  rem.sort((a, b) => a[0] - b[0]);

  let h = rem.length ? `<h3>🚨 Promemoria e avvisi</h3>${rem.map(r => `<div class="mem alert"><span>${r[1]}</span></div>`).join('')}` : '';
  h += coverHtml() + '<h3>👴👵 Situazione genitori</h3>';
  if (!pe.length) h += `<div class="mem"><span>Nessuna scheda presente.</span>${isEd() ? '<button class="pri sm" data-a="mkp">Crea schede Babbo e Mamma</button>' : ''}</div>`;
  else {
    h += '<div class="grid2">';
    for (const [pi, p] of pe) {
      const l = Object.values(S.feed).filter(f => f.k == 'log' && f.pid == pi).sort((a, b) => b.ts - a.ts)[0],
        lv = vitalsOf(pi)[0], ts = Object.values(S.shifts).filter(s => covers(s, pi) && s.date == td).sort((a, b) => String(a.time).localeCompare(String(b.time))),
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
    ic = { proj: '📁', log: '💬', vit: '❤️', th: '💊', sc: '📋', note: '📝' };
  h += `<div class="feed-box"><h3><span>🔔 Ultime info inserite</span><span class="badge">${fe.length}</span></h3><div class="feed-list">${fe.length ? fe.map(([fid, f]) => `<div class="feed-item" style="--c:${col(f.uid)}"><span>${ic[f.k] || '📌'}</span><div class="fi-txt"><b style="color:${col(f.uid)}">${mname(f.uid)}</b> ${f.k == 'log' ? `ha scritto: <b>“${esc(f.text)}”</b>` : esc(f.text)} ${f.pid ? `<span class="badge">${esc(pn(f.pid))}</span>` : ''}${rxHtml('feed', fid, f)}</div><small class="due nowrap">${ago(f.ts)}</small></div>`).join('') : '<p class="due">Ancora nessuna informazione inserita.</p>'}</div>
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

/* ───────── terapia: elenco per momento della giornata ───────── */
const TH_SLOTS = [['m', '🌅 Mattina'], ['p', '🍝 Pranzo'], ['g', '☕ Pomeriggio'], ['s', '🌙 Sera'], ['n', '😴 Notte'], ['b', '🆘 Al bisogno'], ['x', '❔ Orario non indicato']];
function thSlots(t) {
  const s = String(t || ''), w = s.toLowerCase(), out = [], re = /(\d{1,2})\s*[:.]\s*(\d{2})/g; let m;
  while ((m = re.exec(s))) { const h = +m[1] % 24; out.push([h >= 5 && h < 11 ? 'm' : h >= 11 && h < 15 ? 'p' : h >= 15 && h < 18 ? 'g' : h >= 18 && h < 22 ? 's' : 'n', String(h).padStart(2, '0') + ':' + m[2]]); }
  if (!out.length) [[/mattin|colazion|risveglio/, 'm'], [/pranzo/, 'p'], [/pomerigg|merenda/, 'g'], [/sera|cena/, 's'], [/notte|dormir|coricarsi/, 'n']].forEach(([r, k]) => { if (r.test(w)) out.push([k, '']); });
  if (/bisogno|necessit/.test(w)) out.push(['b', '']);
  return out.length ? out : [['x', '']];
}
function therapyHtml(p, ed) {
  const th = p.therapy || [], g = {};
  th.forEach((x, j) => { if (x && x.d) for (const [k, t] of thSlots(x.t)) (g[k] = g[k] || []).push([j, x, t]); });
  let h = '<div class="sec-box"><h4>💊 Terapia farmacologica</h4>';
  if (ed && thEdit !== null) {
    const x = thEdit === 'new' ? {} : th[thEdit] || {};
    h += `<div class="th-form"><b>${thEdit === 'new' ? 'Nuovo farmaco' : 'Modifica farmaco'}</b><div class="form-grid">
      <label class="lb">Farmaco<input type="text" id="thd" value="${esc(x.d)}" placeholder="es. Cardioaspirina 100 mg"></label>
      <label class="lb">Dose<input type="text" id="thq" value="${esc(x.q)}" placeholder="es. 1 compressa"></label>
      <label class="lb">Orari<input type="text" id="tht" value="${esc(x.t)}" placeholder="es. 08:00, 20:00 oppure al bisogno"></label>
      <label class="lb">Note<input type="text" id="thn" value="${esc(x.n)}" placeholder="es. a stomaco pieno"></label>
      <label class="lb full">Scorta / scadenza piano terapeutico<input type="text" id="ths" value="${esc(x.s)}"></label></div>
      <div class="row"><span class="due">Aggiungi orario:</span>${['08:00', '13:00', '17:00', '20:00', '22:00', 'Al bisogno'].map(t => `<button class="sm" data-a="thpre" data-v="${t}">${t}</button>`).join('')}</div>
      <div class="row"><button class="pri sm" data-a="thsave">Salva</button><button class="sm" data-a="thcancel">Annulla</button></div></div>`;
  }
  if (!Object.keys(g).length) h += '<div class="due">Nessun farmaco inserito.</div>';
  for (const [k, l] of TH_SLOTS) {
    const r = g[k]; if (!r) continue;
    r.sort((a, b) => a[2].localeCompare(b[2]) || String(a[1].d).localeCompare(String(b[1].d)));
    h += `<div class="th-grp"><div class="th-h">${l}</div>${r.map(([j, x, t]) => `<div class="med${thEdit === j ? ' editing' : ''}"><div class="grow"><b>${esc(x.d)}</b>${x.q ? ' · ' + esc(x.q) : ''}${t ? ` <span class="badge">${t}</span>` : ''}${x.n ? `<div class="due">${esc(x.n)}</div>` : ''}${x.s ? `<div class="due">📦 ${esc(x.s)}</div>` : ''}</div>${ed ? `<button class="sm" data-a="thed" data-j="${j}" title="Modifica" aria-label="Modifica">✏️</button><button class="sm" data-a="delth" data-j="${j}" title="Elimina" aria-label="Elimina">🗑</button>` : ''}</div>`).join('')}</div>`;
  }
  if (ed && thEdit === null) h += '<div class="row"><button class="pri sm" data-a="thed" data-j="-1">+ Aggiungi farmaco</button></div>';
  return h + '</div>';
}

/* ───────── reazioni stile Facebook ───────── */
const RX = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
function rxHtml(c, i, o) {
  const re = o.re || {}, cnt = {}, key = c + ':' + i;
  for (const [u, e] of Object.entries(re)) (cnt[e] = cnt[e] || []).push(u);
  return `<div class="rx">${Object.entries(cnt).map(([e, us]) => `<button class="rx-c ${us.includes(me.uid) ? 'on' : ''}" data-a="rx" data-v="${c}|${i}|${e}" title="${esc(us.map(u => (S.members[u] || {}).name || '').join(', '))}">${e} ${us.length}</button>`).join('')}<button class="rx-add" data-a="rxo" data-v="${key}" aria-label="Reagisci">${re[me.uid] ? '😊' : '😊 Reagisci'}</button>${rxOpen == key ? `<span class="rx-pick">${RX.map(e => `<button data-a="rx" data-v="${c}|${i}|${e}" aria-label="${e}">${e}</button>`).join('')}</span>` : ''}</div>`;
}

/* ───────── storico accessi (solo admin) ───────── */
function watchLogins() { if (role() != 'admin' || loginsOn) return; loginsOn = true; unsubs.push(D.watch('logins', v => { S.logins = v; render(); })); }
let logErr = '';
function logAccess() {
  try {
    const k = 'fam_lastlog_' + me.uid; if (now() - (+localStorage.getItem(k) || 0) < 30 * 6e4) return;
    const ua = navigator.userAgent || '', dev = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Altro',
      app = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
    D.raw.collection('logins').doc(rid()).set({ uid: me.uid, ts: now(), dev, app })
      .then(() => { logErr = ''; try { localStorage.setItem(k, now()); } catch (e) { } })
      .catch(e => { logErr = e.code || e.message; step('registro accessi: ' + logErr); render(); });
  } catch (e) { }
}
function accessHistory() {
  const L = Object.values(S.logins).sort((a, b) => b.ts - a.ts), days = 14, t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const us = Object.keys(S.members).filter(u => S.members[u].role && S.members[u].role != 'pending'), grid = [];
  for (let k = days - 1; k >= 0; k--) { const d = new Date(t0); d.setDate(t0.getDate() - k); const v = iso(d), c = {}; L.forEach(l => { if (iso(new Date(l.ts)) == v) c[l.uid] = (c[l.uid] || 0) + 1; }); grid.push({ d, c }); }
  const max = Math.max(1, ...grid.map(r => Object.values(r.c).reduce((a, b) => a + b, 0))), W = 640, Hh = 170, px = 26, bw = (W - px) / days, step = Math.max(1, Math.ceil(max / 4));
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${Hh + 30}" role="img" aria-label="Accessi al giorno negli ultimi ${days} giorni">`;
  for (let y = 0; y <= max; y += step) { const yy = Hh - y / max * Hh + 6; svg += `<line x1="${px}" x2="${W}" y1="${yy}" y2="${yy}" class="gl"/><text x="${px - 6}" y="${yy + 4}" text-anchor="end" class="ax">${y}</text>`; }
  grid.forEach((r, k) => {
    let y = Hh + 6; const x = px + k * bw + bw * .18;
    us.forEach(u => { const n = r.c[u] || 0; if (!n) return; const hh = n / max * Hh; y -= hh; svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * .64).toFixed(1)}" height="${hh.toFixed(1)}" rx="3" fill="${col(u)}"><title>${esc((S.members[u] || {}).name)}: ${n}</title></rect>`; });
    if ((days - 1 - k) % 2 == 0) svg += `<text x="${(x + bw * .32).toFixed(1)}" y="${Hh + 24}" text-anchor="middle" class="ax">${r.d.getDate()}/${r.d.getMonth() + 1}</text>`;
  });
  svg += '</svg>';
  const leg = us.map(u => { const mine = L.filter(l => l.uid == u), last = mine[0], n30 = mine.filter(l => l.ts > now() - 30 * 864e5).length;
    return `<div class="vit-row"><span class="dot" style="background:${col(u)}"></span><b class="grow">${mname(u)}</b><span class="due">${last ? 'ultimo ' + ago(last.ts) + ' · ' + esc(last.dev) + (last.app ? ' (app)' : '') : 'nessun accesso'} · ${n30} in 30 gg</span></div>`; }).join('');
  const list = L.slice(0, 30).map(l => `<div class="vit-row"><b style="color:${col(l.uid)}">${mname(l.uid)}</b><span class="grow due">${new Date(l.ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span class="due">${esc(l.dev)}${l.app ? ' · app' : ''}</span></div>`).join('');
  const warn = logErr ? `<div class="mem alert"><span><b>Il registro accessi non riesce a salvare</b> (${esc(logErr)}).<br><span class="due">Le regole pubblicate in Firestore non contengono ancora la riga <b>match /logins</b>: incolla di nuovo tutto il file firestore.rules e premi Pubblica.</span></span></div>` : '';
  return `<h3>📈 Storico accessi</h3>${warn}<p class="due">Lo storico conta gli accessi da quando è attiva questa funzione (uno ogni 30 minuti per dispositivo): quelli precedenti non erano registrati.</p><div class="tl">${L.length ? svg : '<p class="due">Nessun accesso registrato finora: compariranno da adesso.</p>'}${leg}</div>${L.length ? `<details class="tl"><summary><b>Elenco ultimi accessi</b></summary>${list}</details>` : ''}`;
}

/* ───────── aspetto: tema giorno/notte e palette ───────── */
const LOOK_KEY = 'fam_look';
const getLook = () => { try { return JSON.parse(localStorage.getItem(LOOK_KEY) || '{}'); } catch (e) { return {}; } };
function applyLook(l) {
  l = l || {}; const r = document.documentElement; if (!r || !r.setAttribute) return;
  if (l.theme && l.theme != 'auto') r.setAttribute('data-theme', l.theme); else r.removeAttribute('data-theme');
  r.setAttribute('data-pal', l.pal || 'warm');
  const m = document.querySelector('meta[name=theme-color]'); if (m && m.setAttribute) m.setAttribute('content', l.pal == 'cold' ? '#4F8CF7' : '#FF8A6B');
}
function setLook(ch) { const l = { ...getLook(), ...ch }; try { localStorage.setItem(LOOK_KEY, JSON.stringify(l)); } catch (e) { } applyLook(l); if (me) D.put('prefs', me.uid, { look: l }, 1); }
function syncLook() { const l = (S.prefs || {}).look; if (l && JSON.stringify(l) != JSON.stringify(getLook())) { try { localStorage.setItem(LOOK_KEY, JSON.stringify(l)); } catch (e) { } applyLook(l); } }
function lookHtml() {
  const lk = getLook();
  return `<div class="tl"><b>🎨 Aspetto</b><div class="due" style="margin-top:8px">Tema</div><div class="wk">${[['auto', '🌗 Automatico'], ['light', '☀️ Giorno'], ['dark', '🌙 Notte']].map(([v, l]) => `<button data-a="look" data-v="theme|${v}" class="${(lk.theme || 'auto') == v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="due">Colori</div><div class="wk">${[['warm', 'Caldi', '#FF8A6B', '#FFB86E'], ['cold', 'Freddi', '#4F8CF7', '#36C2D9']].map(([v, l, a, b]) => `<button data-a="look" data-v="pal|${v}" class="${(lk.pal || 'warm') == v ? 'on' : ''}"><span class="pal" style="background:linear-gradient(135deg,${a},${b})"></span> ${l}</button>`).join('')}</div></div>`;
}
applyLook(getLook());

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
  if (a == 'psel') { psel = v; thEdit = null; return go(); }
  if (a == 'nfil') { nfil = v; return go(); }
  if (a == 'tog') { open.has(i) ? open.delete(i) : open.add(i); return go(); }
  if (a == 'cday') { day = v; return go(); }
  if (a == 'today') { day = iso(new Date()); return go(); }
  if (a == 'cnav') { const d = new Date(day + 'T12:00'); d.setDate(d.getDate() + +v); day = iso(d); return go(); }

  const gerr = x => alert('Google Calendar: ' + (x.code || x.message));
  if (a == 'gsync') return gsync().catch(gerr);
  if (a == 'gadd') return gadd(b.dataset.k, i).catch(gerr);
  if (a == 'pushon') return pushOn().catch(x => alert('Notifiche: ' + (x.code || x.message)));
  if (a == 'pushtest') return navigator.serviceWorker.ready.then(r => r.showNotification('Famiglia', { body: 'Le notifiche funzionano 🎉', icon: 'icon-192.png' })).catch(x => toast('Notifiche: ' + x.message));
  if (a == 'tmv') { const l = tabList().map(t => t[0]), x = l.indexOf(v), y = x + j; if (y < 0 || y >= l.length) return; [l[x], l[y]] = [l[y], l[x]]; return D.put('prefs', me.uid, { tabs: l }, 1); }
  if (a == 'pmv') { const l = plist().map(t => t[0]), x = l.indexOf(psel), y = x + j; if (x < 0 || y < 0 || y >= l.length) return; [l[x], l[y]] = [l[y], l[x]]; l.forEach((id, k) => D.put('people', id, { ord: k }, 1)); return; }
  if (a == 'addslot') {
    const w = $('#zw').value, f = $('#zf').value, t = $('#zt').value, l = $('#zl').value.trim();
    if (!f || !t || t <= f) return toast('Controlla gli orari della fascia');
    const ws = w == 'all' ? [0, 1, 2, 3, 4, 5, 6] : w == 'feriali' ? [1, 2, 3, 4, 5] : [+w], days = {};
    ws.forEach(x => { days[x] = [...(sdays()[x] || []).filter(z => z.f + '-' + z.t != f + '-' + t), { l, f, t }].sort((p, q) => p.f.localeCompare(q.f)); });
    return D.put('config', 'slots', { days }, 1);
  }
  if (a == 'delslot') { const arr = [...(sdays()[v] || [])]; arr.splice(j, 1); return D.put('config', 'slots', { days: { [v]: arr } }, 1); }
  if (a == 'book') { const [dt, key, ty] = v.split('|'), [f, t] = key.split('-'); D.put('shifts', rid(), { uid: me.uid, pid: 'both', type: ty, date: dt, slot: key, time: f, end: t }); fd(`ha preso il turno (${ty}) del ${dt}, ${f}–${t}`); return; }
  if (a == 'pfil') { pfil = v; return go(); }
  if (a == 'pjall') { open.has('pj' + i) ? open.delete('pj' + i) : open.add('pj' + i); return go(); }
  if (a == 'addpj') { const t = $('#pjt').value.trim(); if (!t) return toast('Scrivi il nome del progetto'); const pid = $('#pjp').value; $('#pjt').value = ''; D.put('projects', rid(), { title: t, pid, status: 'open', ts: now(), upd: now(), by: me.uid }); fd('ha creato il progetto "' + t + '"', S.people[pid] ? pid : '', 'proj'); return; }
  if (a == 'pjst') { const p = S.projects[i]; D.put('projects', i, { status: p.status == 'done' ? 'open' : 'done', upd: now() }, 1); fd((p.status == 'done' ? 'ha riaperto' : 'ha concluso') + ' il progetto "' + p.title + '"', S.people[p.pid] ? p.pid : '', 'proj'); return; }
  if (a == 'pjren') { const t = prompt('Nome del progetto', S.projects[i].title); if (t) D.put('projects', i, { title: t }, 1); return; }
  if (a == 'pjdel') { if (confirm('Eliminare il progetto con aggiornamenti e note?')) { Object.entries(S.pupdates).filter(([, u]) => u.proj == i).forEach(([k]) => D.del('pupdates', k)); Object.entries(S.notes).filter(([, n]) => n.task == i).forEach(([k]) => D.del('notes', k)); D.del('projects', i); } return; }
  if (a == 'addpu') { const el = $('#pu_' + i), t = el ? el.value.trim() : '', p = S.projects[i]; if (!t) return toast('Scrivi l\'aggiornamento'); el.value = ''; D.put('pupdates', rid(), { proj: i, uid: me.uid, text: t, ts: now() }); if (isEd()) D.put('projects', i, { upd: now() }, 1); fd(`📁 ${p.title}: ${t}`, S.people[p.pid] ? p.pid : '', 'proj'); return; }
  if (a == 'delpu') return D.del('pupdates', i);
  if (a == 'addrem') { const t = $('#rt').value.trim(), at = $('#ra').value, to = $('#ru').value; if (!t || !at) return toast('Scrivi il promemoria e quando'); const atTs = new Date(at).getTime(); if (atTs < now()) return toast('Scegli un orario futuro'); $('#rt').value = ''; D.put('reminders', rid(), { text: t, at, atTs, to, by: me.uid, ts: now() }); toast('Promemoria impostato ⏰'); return; }
  if (a == 'delrem') return D.del('reminders', i);
  if (a == 'cvme') { const [id, u] = v.split('|'); D.put('checks', id, { date: id.slice(0, 10), uid: u, by: me.uid, ts: now() }, 1); fd('si occupa di sentire ' + bothName() + ' mentre ' + ((S.members[u] || {}).name || 'un familiare') + ' è impegnato/a'); return; }
  if (a == 'cvdone') { const t = prompt('Com\'è andata? Scrivi un aggiornamento per tutti'); if (t === null) return; if (t.trim()) fd(t.trim(), '', 'log'); D.put('checks', v, { done: true, dts: now(), by: me.uid }, 1); return; }
  if (a == 'look') { const [k, val] = v.split('|'); setLook({ [k]: val }); return go(); }
  if (a == 'thed') { thEdit = j < 0 ? 'new' : j; return go(); }
  if (a == 'thcancel') { thEdit = null; return go(); }
  if (a == 'thpre') { const el = $('#tht'); if (el) el.value = el.value.trim() ? el.value.trim().replace(/,$/, '') + ', ' + v : v; return; }
  if (a == 'thsave') {
    const g = id => ($(id).value || '').trim(), x = { d: g('#thd'), q: g('#thq'), t: g('#tht'), n: g('#thn'), s: g('#ths') };
    if (!x.d) return toast('Scrivi il nome del farmaco');
    const th = [...(S.people[psel].therapy || [])].filter((y, k) => (y && y.d) || k === thEdit), isNew = thEdit === 'new';
    if (isNew) th.push(x); else th[th.indexOf((S.people[psel].therapy || [])[thEdit])] = x;
    D.put('people', psel, { therapy: th.filter(y => y && y.d) }, 1);
    fd((isNew ? 'ha aggiunto ' : 'ha modificato ') + x.d + ' nella terapia di ' + pn(psel), psel, 'th'); thEdit = null; return go();
  }
  if (a == 'rxo') { rxOpen = rxOpen == v ? null : v; return go(); }
  if (a == 'rx') {
    const [c, id, em] = v.split('|'), doc = S[c] && S[c][id]; if (!doc) return;
    const re = { ...(doc.re || {}) };
    if (re[me.uid] == em) { delete re[me.uid]; D.raw.collection(c).doc(id).update(new firebase.firestore.FieldPath('re', me.uid), firebase.firestore.FieldValue.delete()).catch(x => toast('Non consentito: ' + x.code)); }
    else { re[me.uid] = em; D.put(c, id, { re: { [me.uid]: em } }, 1); }
    doc.re = re; rxOpen = null; return go();
  }
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
  if (a == 'delth') { if (!confirm('Eliminare questo farmaco?')) return; if (thEdit !== null) thEdit = null; const th = [...(S.people[psel].therapy || [])]; th.splice(j, 1); D.put('people', psel, { therapy: th }, 1); fd('ha rimosso un farmaco dalla terapia di ' + pn(psel), psel, 'th'); return; }
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

  if (a == 'addn') { open.add(i); D.put('notes', rid(), { task: i, text: '', items: [], imgs: [], files: [], ts: now(), by: me.uid }); fd('ha aggiunto una nota a "' + ((S.tasks[i] || S.projects[i] || {}).title || pn(i)) + '"', S.people[i] ? i : '', 'note'); return; }
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
  if (c == 'nk') return D.put('prefs', me.uid, { notif: { [e.target.dataset.f]: e.target.checked } }, 1);
  if (c == 'gcal') { D.put('prefs', me.uid, { cals: { [e.target.dataset.i]: { [e.target.dataset.f]: e.target.checked } } }, 1).then(() => gsync()).catch(x => alert('Google Calendar: ' + (x.code || x.message))); return; }
  if (c == 'spres') { const x = S.shifts[e.target.dataset.i], val = e.target.value; D.put('shifts', e.target.dataset.i, { pid: val }, 1); fd(val == 'both' ? `al turno del ${x.date} ci sono di nuovo ${bothName()}` : `segnala: al turno del ${x.date} in casa c'è solo ${pn(val)}`, val == 'both' ? '' : val); return; }
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

document.addEventListener('toggle', e => { if (e.target.id == 'slotbox') slotOpen = e.target.open; }, true);
document.addEventListener('focusout', () => setTimeout(() => { if (pend) render(); }, 250));
$('#out').onclick = () => firebase.auth().signOut();
/* ───────── installazione come app ───────── */
let installEv = null;
if (typeof window.addEventListener == 'function') {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent || ''),
    standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; $('#inst').hidden = false; });
  window.addEventListener('appinstalled', () => { $('#inst').hidden = true; toast('App installata 🎉'); });
  if (ios && !standalone) $('#inst').hidden = false;
  $('#inst').onclick = async () => {
    if (installEv) { installEv.prompt(); await installEv.userChoice; installEv = null; $('#inst').hidden = true; }
    else if (ios) alert('Per installare su iPhone:\n1. Apri questa pagina in Safari\n2. Tocca il pulsante Condividi (il quadrato con la freccia)\n3. Scegli «Aggiungi alla schermata Home»');
    else toast('Usa il menu ⋮ del browser → «Installa app»');
  };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(e => step('service worker: ' + e.message));
}

window.__appOK = true;
try { init(); } catch (e) { step('ERRORE avvio: ' + e.message); throw e; }
