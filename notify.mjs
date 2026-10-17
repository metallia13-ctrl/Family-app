// Invia le notifiche push dell'App Famiglia. Gira su GitHub Actions ogni 15 minuti.
// Legge Firestore con l'account di servizio (secret FIREBASE_SA) e non invia mai due volte la stessa notifica.
import admin from 'firebase-admin';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore(), NOW = Date.now(), H = 36e5, LINK = process.env.APP_URL || undefined;
const pad = n => String(n).padStart(2, '0'), isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = isoDay(new Date()), tomorrow = isoDay(new Date(NOW + 24 * H)), hour = new Date().getHours();
const all = async q => Object.fromEntries((await q.get()).docs.map(d => [d.id, d.data()]));

const [members, prefs, people, tasks] = await Promise.all(['members', 'prefs', 'people', 'tasks'].map(c => all(db.collection(c))));
const users = Object.keys(members).filter(u => ['viewer', 'editor', 'admin'].includes(members[u].role));
const name = u => (members[u] && members[u].name || 'Un familiare').split(' ')[0];
const pn = p => (people[p] || {}).name || '';
const bothIds = ['babbo', 'mamma'].filter(x => people[x]).length ? ['babbo', 'mamma'].filter(x => people[x]) : Object.keys(people);
const bothName = bothIds.map(pn).join(' e ') || 'i genitori';
const owner = {};
for (const u of users) for (const t of Object.keys((prefs[u] || {}).tokens || {})) owner[t] = u;
let sent = 0;

async function notify(key, uids, kind, title, body) {
  const ref = db.collection('sent').doc(key.replace(/\//g, '_').slice(0, 300));
  if ((await ref.get()).exists) return;
  await ref.set({ ts: NOW });
  const tokens = [...new Set(uids.filter(u => users.includes(u) && ((prefs[u] || {}).notif || {})[kind] !== false)
    .flatMap(u => Object.keys((prefs[u] || {}).tokens || {})))];
  if (!tokens.length) return;
  const r = await admin.messaging().sendEachForMulticast({ tokens, notification: { title, body }, webpush: LINK ? { notification: { icon: new URL('icon-192.png', LINK).href }, fcmOptions: { link: LINK } } : {} });
  sent += r.successCount;
  for (const [i, x] of r.responses.entries()) if (!x.success && /not-registered|invalid-registration|invalid-argument/.test(x.error?.code || '')) {
    const u = owner[tokens[i]]; if (u) await db.collection('prefs').doc(u).update(new admin.firestore.FieldPath('tokens', tokens[i]), admin.firestore.FieldValue.delete()).catch(() => { });
  }
}

// 1. promemoria arrivati all'orario (fino a 6 ore di ritardo)
for (const [id, r] of Object.entries(await all(db.collection('reminders').where('atTs', '<=', NOW).where('atTs', '>', NOW - 6 * H))))
  await notify('rem_' + id, r.to == 'all' ? users : [r.to], 'rem', '⏰ Promemoria', r.text);

// 2. visite mediche: il giorno prima e un'ora prima
for (const [id, t] of Object.entries(tasks)) {
  if (t.done || t.kind != 'med' || !t.at) continue;
  const ts = new Date(t.at).getTime(), when = new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const acc = Object.keys(t.sel || {}).filter(u => t.sel[u] && t.sel[u].st == 'yes').map(name);
  const who = acc.length ? 'accompagna ' + acc.join(', ') : 'nessuno accompagna ancora!';
  const what = `${t.title}${t.pid ? ' (' + pn(t.pid) + ')' : ''}`;
  if (NOW >= ts - 24 * H && NOW < ts - 2 * H) await notify('med1d_' + id + '_' + t.at, users, 'med', '🩺 Domani: ' + what, `Alle ${when} · ${who}`);
  if (NOW >= ts - H && NOW < ts) await notify('med1h_' + id + '_' + t.at, users, 'med', '🩺 Tra poco: ' + what, `Alle ${when} · ${who}`);
}

// 3. dalle 18: turno di domani scoperto
if (hour >= 18) {
  const sh = Object.values(await all(db.collection('shifts').where('date', '==', tomorrow)));
  for (const p of Object.keys(people)) {
    const ok = sh.some(s => s.pid == p || ((!s.pid || s.pid == 'both') && bothIds.includes(p)));
    if (!ok) await notify(`gap_${tomorrow}_${p}`, users, 'gap', '🚪 Domani nessuno va da ' + pn(p), 'Apri i Turni e prenota una fascia.');
  }
}

// 4. nuovi aggiornamenti (diario genitori e progetti) a tutti tranne chi li ha scritti
for (const [id, f] of Object.entries(await all(db.collection('feed').where('ts', '>', NOW - 2 * H))))
  if (f.k == 'log' || f.k == 'proj')
    await notify('upd_' + id, users.filter(u => u != f.uid), 'upd', (f.k == 'log' ? '💬 ' : '📁 ') + name(f.uid) + (f.pid ? ' · ' + pn(f.pid) : ''), f.text);

// 5. qualcuno è a lezione/impegnato (calendari 📚): chiedi agli altri di sentire i genitori
const evs = Object.values(await all(db.collection('events').where('ts1', '>', NOW)));
const checks = await all(db.collection('checks').where('date', '==', today));
for (const e of evs) {
  if (!e.cover || e.date != today || e.ts0 - 15 * 6e4 > NOW) continue;
  const c = checks[today + '_' + e.uid]; if (c && (c.by || c.done)) continue;
  await notify(`cover_${today}_${e.uid}`, users.filter(u => u != e.uid), 'cover', `📚 ${name(e.uid)} è impegnata/o fino alle ${e.to}`, `Qualcuno può sentire ${bothName}? Poi scrivi com'è andata nell'app.`);
}

// pulizia dei registri più vecchi di 30 giorni
const old = await db.collection('sent').where('ts', '<', NOW - 30 * 24 * H).limit(200).get();
if (!old.empty) { const b = db.batch(); old.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
console.log(`Fatto: ${sent} notifiche inviate, ${users.length} utenti.`);
