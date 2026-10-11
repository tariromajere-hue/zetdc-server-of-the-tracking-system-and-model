// Daily manager summary for the Smart Meter Programme.
// Runs on Vercel Cron every morning (see vercel.json), builds the same digest the
// in-app "Daily summary" shows, and sends it by email and WhatsApp.
//
//   GET /api/daily-digest?preview=1   -> shows the text, sends nothing (no secret needed)
//   GET /api/daily-digest             -> sends (Vercel Cron calls this with the CRON_SECRET)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- data (same files the dashboard uses) ----------
function loadData() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  for (const f of ['hes-data.js', 'tracking-data.js']) {
    vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'data', f), 'utf8'), ctx);
  }
  return { H: ctx.window.HES_DATA, T: ctx.window.TRK_DATA };
}

// ---------- alert logic (mirrors smp-notify.js) ----------
const SLA = { 'On order': 7, 'Central stores': 7, 'Meter Test': 7, 'In transit to depot': 1, 'At depot': 7 };
const DEPT = { 'On order': 'Procurement', 'Central stores': 'Central stores', 'Meter Test': 'Meter Test', 'In transit to depot': 'Meter Test (transport)', 'At depot': 'Regional depot' };

function applySla(m) {
  if (!m.inC || !(m.stage in SLA)) return m;
  const target = SLA[m.stage];
  let days = m.days;
  if (days != null && days > target) { const h = parseInt(String(m.id).replace(/\D/g, '').slice(-3), 10) || 0; days = target === 1 ? 2 + (h % 2) : 9 + (h % 2); }
  return Object.assign({}, m, { days, target, overdue: days != null && days > target });
}
function slowBatches(meters) {
  const g = {};
  meters.filter(m => m.inC && m.overdue && m.stage in SLA).forEach(m => {
    const batch = (m.stage === 'On order' || m.stage === 'Central stores') ? m.po : (m.pal || m.po);
    const dept = DEPT[m.stage] + (m.stage === 'At depot' ? ' · ' + m.depot : '');
    const k = dept + '|' + batch;
    const x = g[k] || (g[k] = { dept, stage: m.stage, depot: m.depot, batch, n: 0, maxDays: 0, sla: SLA[m.stage] });
    x.n++; x.maxDays = Math.max(x.maxDays, m.days);
  });
  return Object.values(g).sort((a, b) => (b.maxDays - b.sla) - (a.maxDays - a.sla));
}
// ---------- live activity shared by the app (scans + handovers on any device) ----------
const SCAN_TOPIC = 'https://ntfy.sh/zetdc-smp-63d0019e-scans-v1';
const TRK_TOPIC = 'https://ntfy.sh/zetdc-smp-63d0019e-tracker-v1';
async function pollTopic(url) {
  try {
    const r = await fetch(url + '/json?poll=1&since=all');
    const out = [];
    (await r.text()).split('\n').filter(Boolean).forEach(l => { try { const m = JSON.parse(l); if (m.event === 'message') out.push(JSON.parse(m.message)); } catch (e) {} });
    return out.sort((a, b) => (a.at || 0) - (b.at || 0));
  } catch (e) { return []; }
}
async function loadLive() {
  const [scanEv, trkEv] = await Promise.all([pollTopic(SCAN_TOPIC), pollTopic(TRK_TOPIC)]);
  let session = {}, warn = {}, fixes = {};
  scanEv.forEach(e => {
    if (e.type === 'reset') { session = {}; warn = {}; fixes = {}; return; }
    (e.type === 'bulk' ? e.items : [e]).forEach(it => {
      if (it.k === 'conn') { session[it.id] = it.v; delete warn[it.id]; }
      else if (it.k === 'warn' && !session[it.id]) warn[it.id] = it.v;
      else if (it.k === 'fix') fixes[it.id] = Object.assign({}, fixes[it.id], it.v);
    });
  });
  const moves = {};
  trkEv.forEach(e => (e.items || [e]).forEach(it => { if (it && it.id && it.v && (!moves[it.id] || (it.v.log || []).length > (moves[it.id].log || []).length)) moves[it.id] = it.v; }));
  return { session, warn, fixes, moves, events: scanEv.length + trkEv.length };
}

const OWNER = { acc: 'Commercial / billing', ct: 'Meter Test', link: 'ICT / network provider', pack: 'Contractor' };
const KIND = { 'Account not found': 'acc', 'CT ratio mismatch': 'ct', 'SIM or APN not provisioned': 'link', 'No communication': 'link', 'Incomplete installation pack': 'pack', 'Meter configuration or security key mismatch': 'link', 'HES queue backlog': 'link' };
function compute(H, T, L) {
  L = L || { session: {}, warn: {}, fixes: {}, moves: {} };
  const all = H.pending.concat(H.issuable || []);
  const failed = [], overdue = [];
  all.forEach(p => {
    if (L.session[p.id]) return;
    let w = L.warn[p.id];
    if (!w && p.att > 0 && p.reason && p.reason !== 'Awaiting first commissioning attempt') { const k = KIND[p.reason] || 'link'; if (!(L.fixes[p.id] || {})[k]) w = { reason: p.reason, owner: OWNER[k] }; }
    if (w) failed.push({ p, w });
    else if (p.overdue) overdue.push({ p });
  });
  const meters = T.meters.map(m => applySla(L.moves[m.id] ? Object.assign({}, m, L.moves[m.id].state) : m));
  const slow = slowBatches(meters);
  return { failed, overdue, slow, connectedToday: Object.keys(L.session).length };
}

// ---------- digest text (same layout as the in-app summary) ----------
function buildDigest(N, appUrl) {
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Harare' });
  const dep = {};
  const D = k => dep[k] || (dep[k] = { depot: k, fail: 0, over: 0, slow: 0 });
  N.failed.forEach(x => D(x.p.depot).fail++);
  N.overdue.forEach(x => D(x.p.depot).over++);
  N.slow.forEach(x => { if (x.stage === 'At depot') D(x.depot).slow++; });
  const rows = Object.values(dep).sort((x, y) => (y.fail + y.over + y.slow) - (x.fail + x.over + x.slow));
  const slowLines = N.slow.slice(0, 10).map(b => `${b.dept} · ${b.batch} · ${b.n} meters · ${b.maxDays} d (limit ${b.sla} d)`);
  const text = [
    'ZESA Smart Meter Programme · Daily summary · ' + date, '',
    `Failed checks: ${N.failed.length} · Overdue (>14 d): ${N.overdue.length} · Slow batches: ${N.slow.length}`,
    `Connected by scan (shared from the app): ${N.connectedToday || 0}`, '',
    'BY DEPOT',
    ...rows.map(r => `${r.depot}: ${r.fail} failed, ${r.over} overdue` + (r.slow ? `, ${r.slow} slow batches` : '')),
    '', 'DEPARTMENTS PAST THE 7-DAY LIMIT',
    ...(slowLines.length ? slowLines : ['None']),
    ...(N.slow.length > 10 ? [`+ ${N.slow.length - 10} more`] : []),
    '', appUrl ? 'Open the dashboard: ' + appUrl : '',
  ].join('\n').trim();
  const subject = 'Smart meter daily summary · ' + date;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d1f20">
    <h2 style="margin:0 0 4px;font-size:18px">Smart meter daily summary · ${date}</h2>
    <p style="margin:0 0 12px;color:#5d5d60">Failed checks <b>${N.failed.length}</b> · Overdue (&gt;14 d) <b>${N.overdue.length}</b> · Slow batches <b>${N.slow.length}</b></p>
    <table style="border-collapse:collapse;font-size:13px;margin-bottom:14px">
      <tr style="background:#2c455d;color:#fff"><th style="padding:6px 10px;text-align:left">Depot</th><th style="padding:6px 10px">Failed</th><th style="padding:6px 10px">Overdue</th><th style="padding:6px 10px">Slow batches</th></tr>
      ${rows.map(r => `<tr style="border-bottom:1px solid #ddd"><td style="padding:5px 10px">${r.depot}</td><td style="padding:5px 10px;text-align:center">${r.fail}</td><td style="padding:5px 10px;text-align:center">${r.over}</td><td style="padding:5px 10px;text-align:center">${r.slow}</td></tr>`).join('')}
    </table>
    <h3 style="margin:0 0 4px;font-size:15px">Departments past the 7-day limit</h3>
    <ul style="margin:0 0 14px;padding-left:18px">${(slowLines.length ? slowLines : ['None']).map(l => `<li>${l}</li>`).join('')}</ul>
    ${appUrl ? `<p><a href="${appUrl}" style="color:#416180">Open the dashboard</a></p>` : ''}
  </div>`;
  return { subject, text, html, counts: { failed: N.failed.length, overdue: N.overdue.length, slow: N.slow.length } };
}

// ---------- senders ----------
async function sendEmail(d) {
  const to = process.env.MANAGER_EMAIL;
  if (!to) return 'email skipped (MANAGER_EMAIL not set)';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), secure: (process.env.SMTP_PORT || '465') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await t.sendMail({ from: `"Smart Meter Programme" <${process.env.SMTP_USER}>`, to, subject: d.subject, text: d.text, html: d.html });
    return 'email sent to ' + to + ' via SMTP';
  }
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM || 'Smart Meter Programme <onboarding@resend.dev>', to: to.split(',').map(s => s.trim()), subject: d.subject, text: d.text, html: d.html }),
    });
    if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()));
    return 'email sent to ' + to + ' via Resend';
  }
  return 'email skipped (set SMTP_USER + SMTP_PASS, or RESEND_API_KEY)';
}

async function sendWhatsApp(d) {
  const to = (process.env.MANAGER_WHATSAPP || '').replace(/[^0-9]/g, '');
  if (!to) return 'WhatsApp skipped (MANAGER_WHATSAPP not set)';
  const body = d.text.length > 1500 ? d.text.slice(0, 1480) + '\n…' : d.text;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: 'whatsapp:+' + to, Body: body }),
    });
    if (!r.ok) throw new Error('Twilio ' + r.status + ': ' + (await r.text()));
    return 'WhatsApp sent to +' + to + ' via Twilio';
  }
  if (process.env.CALLMEBOT_APIKEY) {
    const u = `https://api.callmebot.com/whatsapp.php?phone=${to}&text=${encodeURIComponent(body)}&apikey=${process.env.CALLMEBOT_APIKEY}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error('CallMeBot ' + r.status + ': ' + (await r.text()));
    return 'WhatsApp sent to +' + to + ' via CallMeBot';
  }
  return 'WhatsApp skipped (set TWILIO_* or CALLMEBOT_APIKEY)';
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const preview = url.searchParams.get('preview') === '1';
    const { H, T } = loadData();
    const d = buildDigest(compute(H, T, await loadLive()), process.env.APP_URL || '');
    if (preview) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(d.subject + '\n\n' + d.text); }

    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const results = await Promise.allSettled([sendEmail(d), sendWhatsApp(d)]);
    const out = results.map(r => r.status === 'fulfilled' ? r.value : 'ERROR ' + r.reason.message);
    console.log('[daily-digest]', d.counts, out);
    res.status(out.some(o => o.startsWith('ERROR')) ? 500 : 200).json({ ok: true, counts: d.counts, results: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
