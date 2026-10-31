/* Calendar — events live in Nerve (Supabase table public.cal_events), so other apps can read and add to them.
   The page opens on the 6-Hour Dial (the next six hours, twistable up to 72 hours ahead). Below it is a regular
   calendar: Day and Week as an hour-by-hour grid, Month, and Year.
   Birthdays are events with kind 'birthday': `day` is the date they were born, and they repeat every year.
   A status (kind 'block', e.g. "Working" 6 AM–12:30 PM) says what you're doing overall, not where or on what; the
   events inside its hours say that. It gets the dial's outer ring and a shaded stretch behind events in the grid. */
(() => {
  'use strict';

  const SB_URL = 'https://dejcovbqwlrvniitbdqv.supabase.co';
  const SB_KEY = 'sb_publishable_VB-KHKnNz_J5EKWvHKW9Ew_7B2sI6Zg';
  const TABLE = 'cal_events';
  const WEEK_START = 0; // 0 = Sunday, 1 = Monday
  const CATS = { work: 'Work', meet: 'Meet', personal: 'Personal', travel: 'Travel' };
  const CAT_KEYS = Object.keys(CATS);
  const REPEATS = { daily: 1, weekdays: 1, weekly: 1, monthly: 1, yearly: 1 }; // how an event or status can repeat

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cal.' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cal.' + k, v); } catch (e) {} },
  };

  /* ---------- a newer published version replaces this one on open ---------- */
  async function checkVersion() {
    if (window.APP_V === 'dev') return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      const { v } = await r.json();
      let tried = null; try { tried = sessionStorage.getItem('cal.tried'); } catch (e) {}
      if (v && v !== window.APP_V && tried !== v) {
        try { sessionStorage.setItem('cal.tried', v); } catch (e) {}
        location.replace(location.pathname + '?v=' + encodeURIComponent(v));
      }
    } catch (e) {}
  }
  checkVersion();

  /* ---------- dates ---------- */
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => { const t = new Date(d.getFullYear(), d.getMonth() + n, 1); return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), dim(t))); };
  const dim = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const weekStart = d => addDays(d, -((d.getDay() - WEEK_START + 7) % 7));
  const leap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const today = () => ymd(new Date());
  const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
  const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toTime = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  const fmt = (d, o) => d.toLocaleDateString(undefined, o);
  function clock(m, short) {
    m = Math.round(m);
    const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM'), h12 = h % 12 || 12;
    return short && !mm ? h12 + ap : `${h12}:${pad(mm)}${ap}`;
  }
  const hourLabel = h => (h % 12 || 12) + (h % 24 < 12 ? ' AM' : ' PM');

  /* ---------- state ---------- */
  const S = {
    user: null, ready: false, loaded: false, needsSetup: false,
    view: store.get('view', 'week'),
    cursor: today(),
    tab: 'dial', // the app always opens on the dial
    dial: 0, // minutes the dial is twisted ahead of now
    span: 360, // how many minutes the dial shows (the Width fader: 1 to 12 hours, 6 by default)
    rows: [], byDay: new Map(), bdays: [], sleep: [], rec: [],
  };
  if (!['day', 'week', 'month', 'year'].includes(S.view)) S.view = 'week';
  let MV = null; // an event lifted off the dial and being moved: { id, s, dur, grab }

  /* ---------- data: Nerve, or an in-memory copy for the local preview ---------- */
  const DEMO = !!window.CAL_DEMO;
  const sb = DEMO ? null : window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'calendar.auth' } });
  const db = DEMO ? window.CAL_DEMO : {
    async list() {
      const { data, error } = await sb.from(TABLE).select('*').order('day').limit(20000);
      if (error) throw error;
      return data;
    },
    async insert(row) { const { data, error } = await sb.from(TABLE).insert(row).select().single(); if (error) throw error; return data; },
    async update(id, patch) { const { error } = await sb.from(TABLE).update(patch).eq('id', id); if (error) throw error; },
    async remove(id) { const { error } = await sb.from(TABLE).delete().eq('id', id); if (error) throw error; },
    subscribe(cb) { return sb.channel('calendar').on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, cb).subscribe(); },
  };

  function index(rows) {
    S.rows = rows; S.byDay = new Map(); S.bdays = []; S.sleep = []; S.rec = [];
    for (const r of rows) {
      if (r.kind === 'birthday') { S.bdays.push(r); continue; }
      if (r.kind === 'sleep') { S.sleep.push(r); continue; }
      if (REPEATS[r.repeat]) { S.rec.push(r); continue; }
      if (!S.byDay.has(r.day)) S.byDay.set(r.day, []);
      S.byDay.get(r.day).push(r);
    }
  }

  let loadT = null, channel = null;
  async function load() {
    try {
      index(await db.list());
      S.loaded = true; S.needsSetup = false;
    } catch (e) {
      const msg = (e && (e.code + ' ' + e.message)) || '';
      if (/42P01|PGRST205|cal_events/.test(msg)) S.needsSetup = true;
      else toast('Could not reach Nerve. Check your connection.');
      S.loaded = true;
    }
    render();
  }
  const scheduleLoad = () => { clearTimeout(loadT); loadT = setTimeout(load, 250); };
  function start() {
    load();
    if (!channel) channel = db.subscribe(scheduleLoad);
  }

  /* Sleep: a schedule, not events. Each sleep row is a bedtime and wake-up for a set of nights ('nightly',
     'weeknights' = nights starting Sun–Thu, 'weekends' = nights starting Fri and Sat). A night that starts on one day
     shows on that day from bedtime to midnight and on the next from midnight to wake-up. */
  // 'once' is a single night, the one starting on the row's day
  const nightOn = (r, d) => r.repeat === 'once' ? r.day === ymd(d) : r.repeat === 'weeknights' ? d.getDay() <= 4 : r.repeat === 'weekends' ? d.getDay() >= 5 : true;
  function sleepOn(dayStr) {
    const out = [], d = parse(dayStr), prev = addDays(d, -1);
    for (const r of S.sleep) {
      const bed = toMin(r.start_time), wake = toMin(r.end_time);
      if (bed == null || wake == null) continue;
      const piece = (s, e) => out.push({ r, s, e, sleep: true, title: 'Sleep', cat: 'sleep' });
      if (wake <= bed) {
        if (nightOn(r, prev) && wake > 0) piece(0, wake);
        if (nightOn(r, d)) piece(bed, 1440);
      } else if (bed < 12 * 60) { if (nightOn(r, prev)) piece(bed, wake); } // a bedtime after midnight belongs to the night before
      else if (nightOn(r, d)) piece(bed, wake);
    }
    return out;
  }

  /* Repeating events and statuses: `day` is the first time it happens, `repeat` how it comes back, and data.until
     (optional) the last day. A monthly one on the 31st falls on the last day of shorter months. */
  function repeatsOn(r, dayStr) {
    if (dayStr < r.day || (r.data && r.data.until && dayStr > r.data.until)) return false;
    if (r.data && Array.isArray(r.data.skip) && r.data.skip.includes(dayStr)) return false; // that one was moved or deleted
    const d = parse(dayStr), f = parse(r.day);
    switch (r.repeat) {
      case 'daily': return true;
      case 'weekdays': return d.getDay() >= 1 && d.getDay() <= 5;
      case 'weekly': return d.getDay() === f.getDay();
      case 'monthly': return d.getDate() === Math.min(f.getDate(), dim(d));
      case 'yearly': return d.getMonth() === f.getMonth() && d.getDate() === Math.min(f.getDate(), dim(d));
    }
    return false;
  }
  // what a shown event points back to: its row, and which day's occurrence it is
  const idAttr = o => `data-id="${o.r.id}" data-occ="${o.day || ''}"`;
  const ordinal = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  // the choices for a given first date, worded for it: "Every week on Sunday", "Every month on the 1st"
  function repeatChoices(dayStr) {
    const d = dayStr ? parse(dayStr) : new Date();
    return [['', "Doesn't repeat"], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'],
      ['weekly', `Every week on ${fmt(d, { weekday: 'long' })}`], ['monthly', `Every month on the ${ordinal(d.getDate())}`],
      ['yearly', `Every year on ${fmt(d, { month: 'long', day: 'numeric' })}`]];
  }

  /* What's on a day: that day's events plus any birthday falling on it, each with start/end minutes
     (and, when asked, sleep). */
  function occs(dayStr, withSleep) {
    const out = withSleep ? sleepOn(dayStr) : [];
    for (const r of (S.byDay.get(dayStr) || []).concat(S.rec.filter(r => repeatsOn(r, dayStr)))) {
      const s = toMin(r.start_time);
      if (s == null) { out.push({ r, allDay: true, title: r.title, cat: r.category }); continue; }
      let e = toMin(r.end_time); if (e == null) e = s + 60; if (e <= s) e = 1440;
      out.push({ r, s, e, title: r.title, cat: r.category, block: r.kind === 'block' });
    }
    for (const o of out) o.day = dayStr; // which occurrence this is, for repeating events
    if (S.bdays.length) {
      const [y, m, d] = dayStr.split('-').map(Number);
      for (const r of S.bdays) {
        const [by, bm, bd] = r.day.split('-').map(Number);
        const hit = (bm === m && bd === d) || (bm === 2 && bd === 29 && m === 2 && d === 28 && !leap(y));
        if (!hit || y < by) continue;
        const age = y - by;
        out.push({ r, allDay: true, bday: true, age, title: age ? `${r.title} turns ${age}` : `${r.title} was born`, cat: 'bday' });
      }
    }
    return out.sort((a, b) => (a.allDay ? -1 : a.s) - (b.allDay ? -1 : b.s));
  }
  const timed = list => list.filter(o => !o.allDay);

  // gives each of a group of overlapping events a column; returns how many columns the group needs
  function lanes(items) {
    const ends = [];
    items.sort((a, b) => a.s - b.s || b.e - a.e);
    for (const it of items) {
      let i = ends.findIndex(e => e <= it.s);
      if (i < 0) { i = ends.length; ends.push(0); }
      ends[i] = it.e; it.lane = i;
    }
    return Math.max(1, ends.length);
  }

  /* ---------- small day rings (month view) ---------- */
  const pt = (c, r, m) => { const a = ((m - 720) / 1440) * 2 * Math.PI - Math.PI / 2; return [(c + r * Math.cos(a)).toFixed(2), (c + r * Math.sin(a)).toFixed(2)]; };
  function arc(c, r, s, e) {
    e = Math.min(e, s + 1439);
    const [x1, y1] = pt(c, r, s), [x2, y2] = pt(c, r, e), large = e - s > 720 ? 1 : 0;
    return `M${x1} ${y1}A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }
  function miniRing(dayStr, size) {
    const c = size / 2, r = c - 3;
    const arcs = timed(occs(dayStr)).map(o => `<path d="${arc(c, r, o.s, Math.max(o.e, o.s + 15))}" style="stroke:var(--${o.cat})"/>`).join('');
    return `<svg class="mini" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" class="mini-track"/>${arcs}</svg>`;
  }

  /* ---------- the 6-Hour Dial ----------
     The next few hours as half a clock face: now at the bottom, the end of the window at the top, running up the left
     side like the 6-to-12 half of a wall clock. One band per category; events are arcs on their band. It always starts
     at now. Twist it (drag around it, or scroll over it) to look ahead, anywhere up to 72 hours out; it stays wherever
     it's let go. The Width fader beside it sets how much time the half face holds, from 1 to 12 hours (6 by default),
     smoothly with no steps. Minutes here are counted from the start of today. */
  const HORIZON = 72 * 60, SPAN_MIN = 60, SPAN_MAX = 720;
  const maxDial = () => HORIZON - S.span;
  const dialStart = () => nowMin() + Math.round(S.dial);
  function dialEvents(w0) {
    let out = [];
    for (let i = -1; i < 4; i++) out.push(...timed(occs(ymd(addDays(parse(today()), i)), true)).map(o => ({ ...o, s: o.s + i * 1440, e: o.e + i * 1440 })));
    // a night split at midnight is one stretch of sleep on the dial
    out.sort((a, b) => a.s - b.s);
    const sleeps = [];
    for (const o of out.filter(o => o.sleep)) { const p = sleeps[sleeps.length - 1]; if (p && p.e >= o.s) p.e = Math.max(p.e, o.e); else sleeps.push({ ...o }); }
    out = out.filter(o => !o.sleep).concat(sleeps);
    if (MV) out = out.map(o => String(o.r.id) === String(MV.id) && !o.sleep ? { ...o, s: MV.s, e: MV.s + MV.dur, lifted: true } : o);
    return out.filter(o => o.e > w0 && o.s < w0 + S.span).sort((a, b) => a.s - b.s);
  }
  const dialTime = (m, short) => (m >= 1440 ? fmt(addDays(parse(today()), Math.floor(m / 1440)), { weekday: 'short' }) + ' ' : '') + clock(m % 1440, short);
  // a length of time: "6 hours", "2h 24m", "45m"
  function spanText(m) {
    m = Math.round(m);
    const h = Math.floor(m / 60), mm = m % 60;
    return !mm ? `${h} hour${h === 1 ? '' : 's'}` : (h ? `${h}h ${mm}m` : `${mm}m`);
  }
  function sixHours(w0, evs) {
    // the thin outer ring holds statuses ("Working"); inside it, one band per category
    const SPAN = S.span, CX = 240, CY = 246, W = 20, SW = 12, R = { status: 231, work: 212, meet: 189, personal: 166, travel: 143, sleep: 120 }, FACE = 104;
    const P = (r, m) => { const a = Math.PI / 2 + ((m - w0) / SPAN) * Math.PI; return [(CX + r * Math.cos(a)).toFixed(2), (CY + r * Math.sin(a)).toFixed(2)]; };
    const half = (r, s, e, rev) => { const [x1, y1] = P(r, s), [x2, y2] = P(r, e); return rev ? `M${x2} ${y2}A${r} ${r} 0 0 0 ${x1} ${y1}` : `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`; };
    let s = `<svg class="clock" viewBox="0 0 244 500" role="img" aria-label="6-Hour Dial, ${dialTime(w0)} to ${dialTime(w0 + SPAN)}. Twist to look further ahead.">`;
    for (const k of Object.keys(R)) s += `<path d="${half(R[k], w0, w0 + SPAN)}" class="band${k === 'sleep' ? ' band-sleep' : k === 'status' ? ' band-status' : ''}" stroke-width="${k === 'status' ? SW : W}"/>`;
    s += `<path d="${half(FACE, w0, w0 + SPAN)}L${CX} ${CY}Z" class="face"/>`;
    // finer ticks and labels when the window is short, sparser when it's long
    const tick = SPAN <= 120 ? 5 : SPAN <= 480 ? 15 : 30, label = SPAN <= 120 ? 15 : SPAN <= 480 ? 60 : 120;
    for (let m = Math.ceil(w0 / tick) * tick; m <= w0 + SPAN; m += tick) {
      const hour = m % 60 === 0, [x1, y1] = P(FACE, m), [x2, y2] = P(FACE - (hour ? 12 : 6), m);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="tick${hour ? ' major' : ''}"/>`;
      if (m % label === 0) {
        const [x, y] = P(FACE - 26, m), h = Math.floor(m / 60) % 24;
        s += hour ? `<text x="${x}" y="${y}" class="hr" dy="7">${h % 12 || 12}</text>` : `<text x="${x}" y="${y}" class="hr min" dy="5">:${pad(m % 60)}</text>`;
      }
    }
    let i = 0, top = '';
    for (const o of evs) {
      const color = o.sleep ? 'sleep' : CATS[o.cat] ? o.cat : 'personal', k = o.block ? 'status' : color;
      const a = Math.max(o.s, w0), b = Math.min(Math.max(o.e, o.s + 10), w0 + SPAN);
      if (b <= a) continue;
      // a lifted event rides just outside its band, drawn last so it sits over everything (a status has no room outside, so it just glows)
      const r = o.lifted && !o.block ? R[k] + 10 : R[k], len = ((b - a) / SPAN) * Math.PI * r, id = `ev${i++}`;
      const tag = o.sleep ? 'data-sleep="1"' : `${idAttr(o)}`, sw = o.block ? SW : o.lifted ? W + 4 : W - 2;
      // events say where they are too: "Running camera 5 · SVL"
      const text = o.block ? o.title.toUpperCase() : o.r && o.r.place && !o.sleep ? `${o.title} · ${o.r.place}` : o.title;
      let piece = `<path d="${half(r, a, b)}" class="ev-arc${o.sleep ? ' sleep' : ''}${o.block ? ' status' : ''}${o.lifted ? ' lifted' : ''}" stroke-width="${sw}" style="stroke:var(--${color})" ${tag}><title>${esc(text)} · ${dialTime(o.s)}–${dialTime(o.e)}</title></path>`;
      if (len > 34) {
        const cw = o.block ? 6.4 : 6.2, max = Math.floor((len - 14) / cw), t = text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text;
        // near the bottom the arc runs right to left, so the label is drawn the other way to stay upright
        piece += `<path id="${id}" d="${half(r, a, b, (a + b) / 2 - w0 < SPAN / 3)}" fill="none"/><text class="ev-lab${o.sleep ? ' sleep' : ''}${o.block ? ' status' : ''}" dy="${o.block ? 3 : 4}"><textPath href="#${id}" startOffset="9">${esc(t)}</textPath></text>`;
      }
      if (o.lifted) top += piece; else s += piece;
    }
    s += top;
    // the start of the window: a mark at the bottom, red while it's now
    s += `<line x1="${CX - 1}" y1="${CY + FACE}" x2="${CX - 1}" y2="${CY + 237}" class="hand"/><text x="${CX - 8}" y="${CY + 250}" class="c-now">${clock(w0 % 1440)}</text>`;
    return s + '</svg>';
  }
  function upNext(w0, evs, live) {
    // the status you're in (or the next one) sits on top; below it, the event you're at and the one after
    const st = evs.filter(o => o.block), ev = evs.filter(o => !o.block);
    const stNow = st.find(o => o.s <= w0 && o.e > w0) || st.find(o => o.s > w0);
    const cur = ev.find(o => o.s <= w0 && o.e > w0), nxt = ev.find(o => o.s > w0);
    const row = (k, o, when) => `<button type="button" class="up${o.block ? ' up-status' : ''}" ${o.sleep ? 'data-sleep="1"' : `${idAttr(o)}`}><i style="background:var(--${o.cat})"></i><small>${k}</small><b>${esc(o.title)}${!o.block && o.r && o.r.place && !o.sleep ? `<span> · ${esc(o.r.place)}</span>` : ''}</b><em>${when}</em></button>`;
    if (!cur && !nxt && !stNow) return `<p class="up-none">Nothing in these ${esc(spanText(S.span).replace(/^1 hour$/, 'hour'))}.</p>`;
    const stRow = stNow ? row('Status', stNow, stNow.s <= w0 ? `until ${dialTime(stNow.e)}` : `from ${dialTime(stNow.s)}`) : '';
    return stRow + (cur ? row(live ? 'Now' : 'On', cur, `until ${dialTime(cur.e)}`) : '') + (nxt ? row('Next', nxt, dialTime(nxt.s)) : '');
  }
  function ahead(m) {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return (h ? `${h}h ` : '') + (mm || !h ? `${mm}m ` : '') + 'ahead';
  }
  // the Width fader: 12 hours at the top, 1 hour at the bottom
  function fader() {
    const f = (S.span - SPAN_MIN) / (SPAN_MAX - SPAN_MIN), h = S.span / 60, v = Number.isInteger(Math.round(h * 10) / 10) ? Math.round(h * 10) / 10 : (Math.round(h * 10) / 10).toFixed(1);
    return `<div class="fader" id="fdSpan" role="slider" tabindex="0" aria-label="Time width" aria-orientation="vertical" aria-valuemin="1" aria-valuemax="12" aria-valuenow="${(S.span / 60).toFixed(1)}" aria-valuetext="${esc(spanText(S.span))}">
      <span class="fd-end">12h</span>
      <span class="fd-track"><span class="fd-fill" style="height:${f * 100}%"></span><span class="fd-thumb" style="bottom:${f * 100}%">${v}h</span></span>
      <span class="fd-end">1h</span>
      <span class="fd-name">Width</span>
    </div>`;
  }
  function dialCard() {
    const w0 = dialStart(), evs = dialEvents(w0), live = Math.round(S.dial) === 0;
    const d = addDays(parse(today()), Math.floor(w0 / 1440));
    return `<div class="hero-top"><h2>6-Hour Dial</h2>
        <div class="hero-act">${live ? '' : '<button type="button" class="pill sm" data-act="dial-now">Now</button>'}
        <button type="button" class="ic" data-act="sleep" aria-label="Sleep schedule"><svg viewBox="0 0 24 24"><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/></svg></button>
        <button type="button" class="ic" data-act="add" aria-label="New event"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
        <button type="button" class="ic" data-act="menu" aria-label="Account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5"/></svg></button></div></div>
      <div class="hero-in">
        <div class="cc-dial">
          <div class="cc-badge"><small>${esc(fmt(d, { weekday: 'long' }))}</small><b>${d.getDate()}</b></div>
          ${fader()}
          <div class="cc-win${MV ? ' moving' : ''}">${MV
            ? `<small>Move to</small><b>${dialTime(MV.s, true)} – ${dialTime(MV.s + MV.dur, true)}</b>`
            : `<small>${live ? 'Next ' + esc(spanText(S.span)) : ahead(S.dial)}</small><b>${dialTime(w0, true)} – ${dialTime(w0 + S.span, true)}</b>`}
            <span class="cc-prog" aria-hidden="true"><i style="width:${(S.dial / maxDial()) * 100}%"></i></span></div>
          ${sixHours(w0, evs)}
        </div>
        <div class="cc-up">${upNext(w0, evs, live)}</div>
        <div class="legend">${CAT_KEYS.map(k => `<span><i style="background:var(--${k})"></i>${CATS[k]}</span>`).join('')}<span><i style="background:var(--sleep)"></i>Sleep</span></div>
        <p class="cc-tip">${MV ? 'Let go to drop it here' : 'Twist the dial to look ahead · hold an event to move it'}</p>
      </div>`;
  }
  function paintDial() {
    const el = $('#dial'); if (!el) return;
    el.classList.toggle('live', Math.round(S.dial) === 0);
    el.innerHTML = dialCard();
  }

  /* ---------- the calendar: day and week as an hour grid ---------- */
  const HOUR = 48;
  function placeEvents(tl, indent) {
    // overlapping events share the column side by side; inside a status they sit indented so its stripe shows
    const items = tl.map(o => ({ ...o })).sort((a, b) => a.s - b.s || b.e - a.e), ind = indent || 0;
    let group = [], end = -1, out = '';
    const flush = () => {
      const n = lanes(group);
      for (const o of group) {
        const h = Math.max(20, ((o.e - o.s) / 60) * HOUR - 2);
        out += `<button type="button" class="tg-ev${h < 36 ? ' short' : ''}" ${idAttr(o)} style="top:${(o.s / 60) * HOUR}px;height:${h}px;left:calc(${(o.lane / n) * 100}% + ${2 + ind}px);width:calc(${100 / n}% - ${4 + ind}px);--c:var(--${o.cat})">
          <b>${esc(o.title)}</b><small>${REPEATS[o.r.repeat] ? '<span class="rep" title="Repeats">↻</span> ' : ''}${clock(o.s, true)} – ${clock(o.e, true)}${o.r.place ? ', ' + esc(o.r.place) : ''}</small></button>`;
      }
      group = [];
    };
    for (const o of items) {
      if (group.length && o.s >= end) { flush(); end = -1; }
      group.push(o); end = Math.max(end, o.e);
    }
    if (group.length) flush();
    return out;
  }
  function timeGrid(days) {
    const keys = days.map(ymd), lists = keys.map(k => occs(k)), t = today(), multi = days.length > 1;
    const chip = o => `<button type="button" class="chip sm" ${idAttr(o)}><i style="background:var(--${o.cat})"></i>${esc(o.title)}</button>`;
    const head = `<div class="tg-row tg-head"><span class="tg-gut"></span>${days.map((d, i) => `
      <button type="button" class="tg-dh${keys[i] === t ? ' today' : ''}" data-go="${keys[i]}"${multi ? ' data-view-to="day"' : ''}><small>${esc(fmt(d, { weekday: 'short' }))}</small><b>${d.getDate()}</b></button>`).join('')}</div>`;
    const anyAll = lists.some(l => l.some(o => o.allDay));
    const all = anyAll ? `<div class="tg-row tg-all"><span class="tg-gut">all day</span>${lists.map(l => `<div class="tg-allc">${l.filter(o => o.allDay).map(chip).join('')}</div>`).join('')}</div>` : '';
    let gutter = '';
    for (let h = 1; h < 24; h++) gutter += `<span style="top:${h * HOUR}px">${hourLabel(h)}</span>`;
    const cols = lists.map((l, i) => {
      const now = keys[i] === t ? `<span class="tg-now" style="top:${(nowMin() / 60) * HOUR}px"></span>` : '';
      // sleep sits behind the events as a shaded stretch
      const zz = sleepOn(keys[i]).map(o => `<button type="button" class="tg-sleep" data-sleep="1" style="top:${(o.s / 60) * HOUR}px;height:${((o.e - o.s) / 60) * HOUR}px"><span>Sleep</span></button>`).join('');
      // a status ("Working") is a shaded stretch with its name, the events inside it on top
      const bl = timed(l).filter(o => o.block), evs = timed(l).filter(o => !o.block);
      const bz = bl.map(o => `<button type="button" class="tg-block" ${idAttr(o)} style="top:${(o.s / 60) * HOUR}px;height:${((o.e - o.s) / 60) * HOUR}px;--c:var(--${CATS[o.cat] ? o.cat : 'personal'})"><span>${esc(o.title)}</span><small>${clock(o.s, true)} – ${clock(o.e, true)}</small></button>`).join('');
      const inner = evs.filter(o => bl.some(b => o.s < b.e && o.e > b.s)), outer = evs.filter(o => !inner.includes(o));
      return `<div class="tg-col${keys[i] === t ? ' today' : ''}" data-day="${keys[i]}">${zz}${bz}${placeEvents(outer)}${placeEvents(inner, multi ? 5 : 10)}${now}</div>`;
    }).join('');
    return `<section class="card tg" style="--n:${days.length}">${head}${all}
      <div class="tg-scroll"><div class="tg-row tg-body" style="height:${24 * HOUR}px"><div class="tg-gut tg-hours">${gutter}</div>${cols}</div></div></section>`;
  }
  const vDay = () => timeGrid([parse(S.cursor)]);
  const vWeek = () => { const w0 = weekStart(parse(S.cursor)); return timeGrid([...Array(7)].map((_, i) => addDays(w0, i))); };

  function weekdayHeads(short) {
    return [...Array(7)].map((_, i) => `<span>${esc(fmt(new Date(2023, 0, 1 + ((i + WEEK_START) % 7)), { weekday: short ? 'narrow' : 'short' }))}</span>`).join('');
  }
  function vMonth() {
    const d = parse(S.cursor), first = new Date(d.getFullYear(), d.getMonth(), 1), g0 = weekStart(first);
    const weeks = Math.ceil(((first.getDay() - WEEK_START + 7) % 7 + dim(d)) / 7);
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const dd = addDays(g0, i), k = ymd(dd), list = occs(k), out = dd.getMonth() !== d.getMonth();
      const shown = list.slice(0, 3).map(o => `<button type="button" class="mc-ev" ${idAttr(o)}><i style="background:var(--${o.cat})"></i>${o.allDay ? '' : `<em>${clock(o.s, true)}</em>`}${esc(o.title)}</button>`).join('');
      cells += `<div class="mc${out ? ' out' : ''}${k === today() ? ' today' : ''}" data-go="${k}" data-view-to="day">
        <div class="mc-top"><span class="mc-n">${dd.getDate()}</span>${timed(list).length ? miniRing(k, 22) : ''}</div>
        <div class="mc-evs">${shown}${list.length > 3 ? `<span class="mc-more">+${list.length - 3} more</span>` : ''}</div>
        ${list.length ? `<span class="mc-dots">${list.slice(0, 4).map(o => `<i style="background:var(--${o.cat})"></i>`).join('')}</span>` : ''}
      </div>`;
    }
    return `<section class="card month"><div class="mh">${weekdayHeads()}</div><div class="mg">${cells}</div></section>`;
  }
  function vYear() {
    const y = parse(S.cursor).getFullYear();
    let out = '';
    for (let m = 0; m < 12; m++) {
      const first = new Date(y, m, 1), lead = (first.getDay() - WEEK_START + 7) % 7;
      let days = '<span></span>'.repeat(lead);
      for (let i = 1; i <= dim(first); i++) {
        const k = ymd(new Date(y, m, i)), list = occs(k), bd = list.some(o => o.bday), ev = list.find(o => !o.bday);
        days += `<button type="button" class="yd${k === today() ? ' today' : ''}${bd ? ' bd' : ''}" data-go="${k}" data-view-to="day"${list.length ? ` title="${esc(list.map(o => o.title).join(', '))}"` : ''}>${i}${ev ? `<i style="background:var(--${ev.cat})"></i>` : ''}</button>`;
      }
      out += `<section class="card ym"><button type="button" class="ym-name" data-go="${ymd(first)}" data-view-to="month">${esc(fmt(first, { month: 'long' }))}</button><div class="yh">${weekdayHeads(true)}</div><div class="yg">${days}</div></section>`;
    }
    return `<div class="year">${out}</div>`;
  }

  function vLogin() {
    return `<div class="login card"><form id="loginForm">
      <div class="logo"><img src="icon.svg" width="56" height="56" alt=""></div>
      <h1>Calendar</h1>
      <p class="muted">Sign in with your Nerve account.</p>
      <label class="f"><span>Email</span><input id="l_email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" required></label>
      <label class="f"><span>Password</span><input id="l_pass" type="password" autocomplete="current-password" required></label>
      <p class="err" id="l_err" hidden></p>
      <button type="submit" class="pill solid big" id="l_go">Sign in</button>
    </form></div>`;
  }
  function vSetup() {
    return `<div class="login card setup"><h1>One-time setup</h1>
      <p class="muted">Nerve doesn't have the calendar's table yet. Open the Nerve project's SQL editor in Supabase, paste in <b>calendar-setup.sql</b>, and press Run. Then reload this page.</p>
      <a class="pill solid big" href="https://supabase.com/dashboard/project/dejcovbqwlrvniitbdqv/sql/new" target="_blank" rel="noopener">Open the SQL editor</a></div>`;
  }

  function title() {
    const d = parse(S.cursor), y = d.getFullYear() !== new Date().getFullYear();
    if (S.view === 'day') return fmt(d, { weekday: 'long', month: 'long', day: 'numeric', ...(y ? { year: 'numeric' } : {}) });
    if (S.view === 'week') {
      const a = weekStart(d), b = addDays(a, 6), same = a.getMonth() === b.getMonth();
      return `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, same ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`;
    }
    if (S.view === 'month') return fmt(d, { month: 'long', year: 'numeric' });
    return String(d.getFullYear());
  }
  function bar() {
    return `<div class="bar" id="bar">
      <div class="bar-l">
        <button type="button" class="ic" data-act="prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button type="button" class="ic" data-act="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        <h1 id="title">${esc(title())}</h1>
      </div>
      <div class="bar-r">
        <button type="button" class="pill" data-act="today">Today</button>
        <div class="seg" role="tablist">${['day', 'week', 'month', 'year'].map(v => `<button type="button" data-view="${v}" aria-selected="${v === S.view}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      </div>
    </div>`;
  }

  // the calendar part only (keeps the dial and the page scroll where they are)
  let gridKey = null;
  function renderCal() {
    const cal = $('#cal'); if (!cal) return;
    const sc = cal.querySelector('.tg-scroll'), keep = sc && gridKey === S.view + S.cursor ? sc.scrollTop : null;
    $('#bar').outerHTML = bar();
    cal.innerHTML = ({ day: vDay, week: vWeek, month: vMonth, year: vYear }[S.view])();
    const sc2 = cal.querySelector('.tg-scroll');
    if (sc2) {
      // opens a little before now when today is showing, otherwise at 7 AM
      const showsToday = S.view === 'day' ? S.cursor === today() : weekStart(parse(S.cursor)) <= new Date() && new Date() < addDays(weekStart(parse(S.cursor)), 7);
      sc2.scrollTop = keep != null ? keep : ((showsToday ? Math.max(0, nowMin() - 90) : 7 * 60) / 60) * HOUR;
    }
    gridKey = S.view + S.cursor;
    document.title = 'Calendar · ' + title();
  }
  /* Two tabs. Dial: a page of its own that never scrolls, so the only things that move are the dial and its fader.
     Calendar: the regular calendar, which scrolls like any page. */
  function tabs() {
    return `<nav class="tabs" aria-label="Tabs">
      <button type="button" data-tab="dial" aria-selected="${S.tab === 'dial'}"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18"/><path d="M12 7a5 5 0 0 0 0 10"/><path d="M12 12h0"/></svg><span>Dial</span></button>
      <button type="button" data-tab="cal" aria-selected="${S.tab === 'cal'}"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg><span>Calendar</span></button>
    </nav>`;
  }
  // refresh: redraw the tab that's showing with new data, keeping its scroll positions
  function setTab(t, refresh) {
    S.tab = t;
    document.documentElement.classList.toggle('tab-dial', t === 'dial');
    $('#dial').hidden = t !== 'dial'; $('#calTab').hidden = t !== 'cal';
    $('#fab').hidden = t !== 'cal';
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    if (!refresh) { window.scrollTo(0, 0); gridKey = null; }
    if (t === 'cal') renderCal(); else paintDial();
  }
  function render() {
    if ($('#sheet') && !$('#sheet').hidden && editing()) return;
    const v = $('#view'), signed = !!S.user;
    $('#fab').hidden = true;
    document.documentElement.classList.remove('tab-dial');
    if (!S.ready) { v.innerHTML = ''; return; }
    if (!signed) { v.innerHTML = vLogin(); document.title = 'Calendar'; return; }
    if (S.needsSetup) { v.innerHTML = vSetup(); return; }
    if (!S.loaded) { v.innerHTML = '<div class="loading"></div>'; return; }
    const fresh = !$('#dial');
    if (fresh) v.innerHTML = `<section class="hero" id="dial"></section><div id="calTab">${bar()}<div id="cal"></div></div>${tabs()}`;
    setTab(S.tab, !fresh);
  }
  setInterval(() => { if (S.user && !tw && !MV && !FD && $('#dial')) { if (S.tab === 'dial') paintDial(); else if (S.view === 'day' || S.view === 'week') renderCal(); } }, 60000);

  function go(dayStr, view) {
    S.cursor = dayStr;
    if (view) { S.view = view; store.set('view', view); }
    renderCal();
  }
  function step(n) {
    const d = parse(S.cursor);
    S.cursor = ymd(S.view === 'day' ? addDays(d, n) : S.view === 'week' ? addDays(d, 7 * n) : S.view === 'month' ? addMonths(d, n) : addMonths(d, 12 * n));
    renderCal();
  }

  /* ---------- the editor ---------- */
  const sheetOpen = () => !$('#sheet').hidden;
  const editing = () => { const a = document.activeElement; return !!(a && a.closest('#sheet') && a.matches('input, textarea')); };
  let ED = null;
  // occ: for a repeating event, the day of the occurrence that was tapped (the form shows that date)
  function openEditor(row, preset, occ) {
    const r = row || {
      kind: 'event', title: '', category: 'personal', day: S.cursor, place: '', notes: '',
      start_time: toTime(preset?.start ?? (S.cursor === today() ? Math.min(23 * 60, Math.ceil((nowMin() + 1) / 60) * 60) : 9 * 60)),
      end_time: null,
    };
    if (!row && !r.end_time) r.end_time = toTime(Math.min(toMin(r.start_time) + 60, 1439));
    ED = { id: row ? row.id : null, kind: r.kind, cat: r.category || 'personal', orig: row, repeat: REPEATS[r.repeat] ? r.repeat : '', occ: row && REPEATS[row.repeat] ? occ || row.day : null };
    $('#sheet').innerHTML = `<form id="edForm" novalidate>
      <div class="sh-head"><h2>${row ? 'Edit' : 'New'}</h2><button type="button" class="ic" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="seg wide" id="edKind"><button type="button" data-kind="event">Event</button><button type="button" data-kind="block">Status</button><button type="button" data-kind="birthday">Birthday</button></div>
      <p class="muted small st-only">What you're doing overall, like Working. Add the events inside it to say where you are and what you're on.</p>
      <label class="f"><span id="edTitleLab">Title</span><input id="ed_title" value="${esc(r.title)}" autocomplete="off" required></label>
      <div class="f ev-only"><span>Type</span><div class="cats" id="edCats">${CAT_KEYS.map(k => `<button type="button" data-cat="${k}" style="--c:var(--${k})">${CATS[k]}</button>`).join('')}</div></div>
      <label class="f"><span id="edDayLab">Date</span><input id="ed_day" type="date" value="${esc(ED.occ || r.day)}" required></label>
      <label class="tog ev-only no-st"><input type="checkbox" id="ed_allday"${!r.start_time && r.kind !== 'block' ? ' checked' : ''}><span>All day</span></label>
      <div class="row2 ev-only times"><label class="f"><span>Starts</span><input id="ed_start" type="time" value="${esc((r.start_time || '09:00').slice(0, 5))}"></label><label class="f"><span>Ends</span><input id="ed_end" type="time" value="${esc((r.end_time || '10:00').slice(0, 5))}"></label></div>
      <label class="f ev-only"><span>Repeats</span><select id="ed_repeat"></select></label>
      <label class="f ev-only" id="edUntil" hidden><span>Until (optional, leave empty to keep repeating)</span><input id="ed_until" type="date" value="${esc((r.data && r.data.until) || '')}"></label>
      <label class="f ev-only no-st"><span>Place</span><input id="ed_place" value="${esc(r.place)}" autocomplete="off"></label>
      <label class="f"><span>Notes</span><textarea id="ed_notes" rows="2">${esc(r.notes)}</textarea></label>
      <p class="hint bd-only" id="edAge"></p>
      <p class="err" id="ed_err" hidden></p>
      <div class="sh-foot">${row ? '<button type="button" class="pill danger" data-act="delete">Delete</button>' : '<span></span>'}<button type="submit" class="pill solid">Save</button></div>
    </form>`;
    syncEditor();
    $('#scrim').hidden = false; $('#sheet').hidden = false;
    requestAnimationFrame(() => { $('#sheet').classList.add('in'); if (!row) $('#ed_title').focus(); });
  }
  function syncEditor() {
    const f = $('#edForm'); if (!f) return;
    const bd = ED.kind === 'birthday', st = ED.kind === 'block';
    f.classList.toggle('is-bd', bd); f.classList.toggle('is-st', st);
    if (st) $('#ed_allday').checked = false;
    f.querySelectorAll('#edKind button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.kind === ED.kind)));
    f.querySelectorAll('#edCats button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === ED.cat)));
    $('#edTitleLab').textContent = bd ? 'Name' : st ? 'Status (like Working)' : 'Title';
    $('#edDayLab').textContent = bd ? 'Born on (with the year)' : 'Date';
    f.querySelector('.times').hidden = bd || $('#ed_allday').checked;
    const day = $('#ed_day').value;
    // the repeat choices are worded for the chosen date ("Every week on Sunday")
    const sel = $('#ed_repeat');
    if (sel.options.length) ED.repeat = sel.value;
    sel.innerHTML = repeatChoices(day).map(([v, t]) => `<option value="${v}"${v === ED.repeat ? ' selected' : ''}>${esc(t)}</option>`).join('');
    $('#edUntil').hidden = bd || !ED.repeat;
    if (bd && day) {
      const b = parse(day), n = new Date(), t = new Date(n.getFullYear(), n.getMonth(), n.getDate());
      let next = new Date(t.getFullYear(), b.getMonth(), b.getDate());
      if (next < t) next = new Date(t.getFullYear() + 1, b.getMonth(), b.getDate());
      const age = next.getFullYear() - b.getFullYear(), days = Math.round((next - t) / 864e5);
      $('#edAge').textContent = age > 0 ? `Turns ${age} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${fmt(next, { month: 'long', day: 'numeric', year: 'numeric' })}`}.` : '';
    } else $('#edAge').textContent = '';
  }
  function closeEditor() {
    $('#sheet').classList.remove('in'); $('#scrim').hidden = true;
    setTimeout(() => { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; render(); }, 180);
    ED = null;
  }
  async function saveEditor() {
    const err = $('#ed_err'), bd = ED.kind === 'birthday', st = ED.kind === 'block', allDay = bd || (!st && $('#ed_allday').checked);
    const row = {
      kind: ED.kind, title: $('#ed_title').value.trim(), category: bd ? 'personal' : ED.cat, day: $('#ed_day').value,
      start_time: allDay ? null : $('#ed_start').value || null, end_time: allDay ? null : $('#ed_end').value || null,
      place: bd || st ? null : $('#ed_place').value.trim() || null, notes: $('#ed_notes').value.trim() || null,
      repeat: bd ? null : $('#ed_repeat').value || null,
    };
    const until = row.repeat ? $('#ed_until').value || null : null, data = { ...((ED.orig && ED.orig.data) || {}) };
    if (until) data.until = until; else delete data.until;
    row.data = data;
    if (until && until < row.day) { err.textContent = 'The repeat needs to end after it starts.'; err.hidden = false; return; }
    const bad = !row.title ? (bd ? 'Add their name.' : st ? 'Name the status, like Working.' : 'Add a title.') : !row.day ? 'Pick a date.'
      : (!allDay && !row.start_time) ? 'Pick a start time.'
      : (st && !row.end_time) ? 'Pick when it ends.'
      : (!allDay && row.end_time && toMin(row.end_time) <= toMin(row.start_time)) ? 'The end time needs to be after the start.' : '';
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    const btn = $('#edForm [type=submit]');
    if (ED.id && isRep(ED.orig)) {
      const scope = await askScope('Change');
      if (!scope) return;
      btn.disabled = true;
      try {
        const undo = await changeSeries(ED.orig, ED.occ, row, scope);
        closeEditor(); await load();
        toast(scope === 'all' ? 'Saved for all of them' : scope === 'one' ? 'Saved for this one' : 'Saved for this one and after', async () => { await undo(); load(); });
      } catch (e) { btn.disabled = false; err.textContent = 'Could not save to Nerve. Try again.'; err.hidden = false; }
      return;
    }
    btn.disabled = true;
    try {
      if (ED.id) await db.update(ED.id, row); else await db.insert(row);
      const wasNew = !ED.id, day = row.day;
      closeEditor();
      if (wasNew && !bd) S.cursor = day;
      await load();
      toast(wasNew ? (bd ? 'Birthday added' : st ? 'Status added' : 'Event added') : 'Saved');
    } catch (e) {
      btn.disabled = false; err.textContent = 'Could not save to Nerve. Try again.'; err.hidden = false;
    }
  }
  async function deleteEditor() {
    const orig = ED.orig; if (!orig) return;
    if (isRep(orig)) {
      const occ = ED.occ, scope = await askScope('Delete');
      if (!scope) return;
      closeEditor();
      try {
        const undo = await deleteSeries(orig, occ, scope); await load();
        toast(scope === 'all' ? `Deleted every “${orig.title}”` : scope === 'one' ? `Deleted “${orig.title}” on ${fmt(parse(occ), { month: 'short', day: 'numeric' })}` : `Deleted “${orig.title}” from ${fmt(parse(occ), { month: 'short', day: 'numeric' })} on`, async () => { await undo(); load(); });
      } catch (e) { toast('Could not delete. Try again.'); load(); }
      return;
    }
    closeEditor();
    try {
      await db.remove(orig.id); await load();
      toast(`Deleted “${orig.title}”`, async () => { await db.insert(fields(orig)); load(); });
    } catch (e) { toast('Could not delete. Try again.'); }
  }

  /* ---------- changing a repeating event ----------
     Changing, moving or deleting one occurrence asks how far it reaches: only that one, that one and every one after
     it, or all of them. Only that one: the series skips that day (data.skip) and, for a change, a one-off copy takes
     its place. That one and after: the series ends the day before (data.until) and, for a change, a new series starts
     there. Each returns an undo. */
  const isRep = r => !!(r && REPEATS[r.repeat]);
  const fields = r => { const { id, user_id, created_at, updated_at, ...f } = r; return f; };
  const dayDiff = (a, b) => Math.round((parse(a) - parse(b)) / 864e5);
  function askScope(what) {
    return new Promise(res => {
      const el = document.createElement('div');
      el.className = 'ask-wrap';
      el.innerHTML = `<div class="ask" role="dialog" aria-modal="true" aria-label="${esc(what)} a repeating event">
        <h3>${esc(what)} a repeating event</h3>
        <button type="button" class="pill big" data-scope="one">Only this one</button>
        <button type="button" class="pill big" data-scope="following">This one and all after it</button>
        <button type="button" class="pill big" data-scope="all">All of them</button>
        <button type="button" class="pill big ghost" data-scope="">Cancel</button></div>`;
      document.body.appendChild(el);
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-scope]');
        if (!b && e.target !== el) return;
        e.stopPropagation(); el.remove(); res(b ? b.dataset.scope || null : null);
      });
    });
  }
  // next: the occurrence's new values (its day is that occurrence's new date)
  async function changeSeries(series, occ, next, scope) {
    const before = fields(series), data = series.data || {}, added = [];
    if (scope === 'following' && occ <= series.day) scope = 'all';
    if (scope === 'all') {
      // moving one occurrence by some days moves the whole series by the same
      const day = next.repeat ? ymd(addDays(parse(series.day), dayDiff(next.day, occ))) : next.day;
      await db.update(series.id, { ...next, day });
    } else if (scope === 'one') {
      await db.update(series.id, { data: { ...data, skip: [...(data.skip || []), occ] } });
      added.push(await db.insert({ ...next, repeat: null, data: {} }));
    } else {
      await db.update(series.id, { data: { ...data, until: ymd(addDays(parse(occ), -1)) } });
      const nd = { ...(next.data || {}) }, skip = (data.skip || []).filter(s => s >= occ);
      if (skip.length) nd.skip = skip; else delete nd.skip;
      added.push(await db.insert({ ...next, data: nd }));
    }
    return async () => { for (const a of added) if (a && a.id) await db.remove(a.id); await db.update(series.id, before); };
  }
  async function deleteSeries(series, occ, scope) {
    const before = fields(series), data = series.data || {};
    if (scope === 'following' && occ <= series.day) scope = 'all';
    if (scope === 'all') { await db.remove(series.id); return async () => { await db.insert(before); }; }
    if (scope === 'one') await db.update(series.id, { data: { ...data, skip: [...(data.skip || []), occ] } });
    else await db.update(series.id, { data: { ...data, until: ymd(addDays(parse(occ), -1)) } });
    return async () => { await db.update(series.id, { data: before.data || {} }); };
  }

  /* ---------- sleep schedule ---------- */
  function openSleep() {
    const sched = S.sleep.filter(r => r.repeat !== 'once'); // single nights aren't part of the schedule
    const every = sched.find(r => r.repeat !== 'weekends') || null, wk = sched.find(r => r.repeat === 'weekends') || null;
    const t = (r, k, d) => esc(((r && r[k]) || d).slice(0, 5));
    ED = null;
    $('#sheet').innerHTML = `<form id="sleepForm" novalidate>
      <div class="sh-head"><h2>Sleep</h2><button type="button" class="ic" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <p class="muted small">Your sleep shows on its own ring on the dial and as shading in the calendar, every night.</p>
      <div class="row2"><label class="f"><span id="slLab1">Bedtime${wk ? ' (Sun–Thu nights)' : ''}</span><input id="sl_bed" type="time" value="${t(every, 'start_time', '23:00')}"></label>
        <label class="f"><span>Wake up</span><input id="sl_wake" type="time" value="${t(every, 'end_time', '07:00')}"></label></div>
      <label class="tog"><input type="checkbox" id="sl_wk"${wk ? ' checked' : ''}><span>Different on weekends (Fri &amp; Sat nights)</span></label>
      <div class="row2" id="slWk"${wk ? '' : ' hidden'}><label class="f"><span>Weekend bedtime</span><input id="sl_bed2" type="time" value="${t(wk, 'start_time', '00:00')}"></label>
        <label class="f"><span>Wake up</span><input id="sl_wake2" type="time" value="${t(wk, 'end_time', '09:00')}"></label></div>
      <p class="err" id="sl_err" hidden></p>
      <div class="sh-foot">${sched.length ? '<button type="button" class="pill danger" data-act="sleep-off">Turn off</button>' : '<span></span>'}<button type="submit" class="pill solid">Save</button></div>
    </form>`;
    $('#scrim').hidden = false; $('#sheet').hidden = false;
    requestAnimationFrame(() => $('#sheet').classList.add('in'));
  }
  async function replaceSleep(rows) {
    for (const r of S.sleep) if (r.repeat !== 'once') await db.remove(r.id);
    for (const r of rows) await db.insert({ kind: 'sleep', title: 'Sleep', category: 'sleep', day: today(), ...r });
  }
  async function saveSleep(off) {
    const err = $('#sl_err'), wk = !off && $('#sl_wk').checked;
    const rows = off ? [] : [{ start_time: $('#sl_bed').value, end_time: $('#sl_wake').value, repeat: wk ? 'weeknights' : 'nightly' }];
    if (wk) rows.push({ start_time: $('#sl_bed2').value, end_time: $('#sl_wake2').value, repeat: 'weekends' });
    if (rows.some(r => !r.start_time || !r.end_time || r.start_time === r.end_time)) { err.textContent = 'Pick a bedtime and a different wake-up time.'; err.hidden = false; return; }
    try {
      await replaceSleep(rows);
      closeEditor(); await load(); toast(off ? 'Sleep turned off' : 'Sleep saved');
    } catch (e) {
      err.textContent = /check|repeat|column/i.test((e && e.message) || '') ? 'Nerve needs a small update first: run calendar-sleep.sql in the Nerve SQL editor.' : 'Could not save to Nerve. Try again.';
      err.hidden = false; load();
    }
  }

  function openAccount() {
    $('#sheet').innerHTML = `<div class="sh-head"><h2>Account</h2><button type="button" class="ic" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <p class="muted">Signed in to Nerve as <b>${esc(S.user.email || '')}</b>.</p>
      <p class="muted small">Your events are stored in Nerve, so your other apps can use them too.</p>
      <div class="sh-foot"><button type="button" class="pill" data-act="sleep">Sleep schedule</button><button type="button" class="pill" data-act="signout">Sign out</button></div>`;
    ED = null;
    $('#scrim').hidden = false; $('#sheet').hidden = false;
    requestAnimationFrame(() => $('#sheet').classList.add('in'));
  }

  /* ---------- toast ---------- */
  let toastT = null;
  function toast(text, undo) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
    el.hidden = false;
    if (undo) el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 2500);
  }

  /* ---------- input ---------- */
  const byId = id => S.rows.find(r => String(r.id) === String(id));

  /* On the dial, one finger does one of three things:
     - drag around the center: twist the dial (turning it the way the hours run brings later hours down to the
       bottom; half a turn is one window's width). It stays wherever it's let go.
     - press and hold an event (half a second) without moving: the event lifts off; drag it around the dial to a new
       time and let go to save it there, same length, to the nearest 5 minutes.
     - drag the Width fader up and down: 1 to 12 hours, smoothly. */
  let tw = null, twisted = false, holdT = null, FD = null;
  const clampDial = m => Math.max(0, Math.min(maxDial(), m));
  const dialGeom = () => { const svg = $('#dial .clock'), r = svg.getBoundingClientRect(); return { cx: r.left + r.width * 240 / 244, cy: r.top + r.height * 246 / 500 }; };
  // the time under a point on the dial (only the left half counts; beyond the ends it sticks to them)
  function minuteAt(x, y) {
    const g = dialGeom();
    let a = Math.atan2(y - g.cy, x - g.cx); if (a < 0) a += 2 * Math.PI;
    const f = Math.max(0, Math.min(1, (a - Math.PI / 2) / Math.PI));
    return dialStart() + f * S.span;
  }
  function setSpan(clientY) {
    const tr = $('#fdSpan .fd-track').getBoundingClientRect();
    const f = Math.max(0, Math.min(1, 1 - (clientY - tr.top) / tr.height));
    S.span = Math.round(SPAN_MIN + f * (SPAN_MAX - SPAN_MIN));
    S.dial = clampDial(S.dial);
    paintDial();
  }
  document.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    if (e.target.closest('#fdSpan')) { FD = true; e.preventDefault(); setSpan(e.clientY); return; }
    const svg = e.target.closest('#dial .clock');
    if (!svg) return;
    const g = dialGeom();
    tw = { ...g, a: Math.atan2(e.clientY - g.cy, e.clientX - g.cx), start: S.dial, turned: 0, x: e.clientX, y: e.clientY, moved: false };
    const arcEl = e.target.closest('.ev-arc[data-id]'), row = arcEl && byId(arcEl.dataset.id);
    if (row && row.start_time) {
      clearTimeout(holdT);
      holdT = setTimeout(() => {
        if (!tw || tw.moved) return;
        // which copy of the event is under the finger (it may repeat across the days on the dial)
        const m = minuteAt(tw.x, tw.y), o = dialEvents(dialStart()).find(o => String(o.r.id) === String(row.id) && o.s <= m + 5 && o.e >= m - 5);
        if (!o) return;
        MV = { id: row.id, row, s: o.s, dur: o.e - o.s, grab: m - o.s, occDay: Math.floor(o.s / 1440) };
        tw = null; paintDial();
      }, 450);
    }
  });
  window.addEventListener('pointermove', e => {
    if (FD) { setSpan(e.clientY); return; }
    if (MV) {
      MV.s = Math.round((minuteAt(e.clientX, e.clientY) - MV.grab) / 5) * 5;
      MV.s = Math.max(nowMin() - 1440, MV.s);
      paintDial(); return;
    }
    if (!tw) return;
    if (!tw.moved && Math.hypot(e.clientX - tw.x, e.clientY - tw.y) < 6) return;
    tw.moved = true; clearTimeout(holdT);
    const a = Math.atan2(e.clientY - tw.cy, e.clientX - tw.cx);
    let d = a - tw.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    tw.a = a; tw.turned += d;
    S.dial = clampDial(tw.start - (tw.turned / Math.PI) * S.span);
    paintDial();
  });
  async function dropMoved() {
    const mv = MV; MV = null;
    const dayN = Math.floor(mv.s / 1440), start = ((mv.s % 1440) + 1440) % 1440, end = Math.min(start + mv.dur, 1439);
    const day = ymd(addDays(parse(today()), dayN)), patch = { day, start_time: toTime(start), end_time: toTime(end) };
    // a repeating event asks whether the move is for only this one, this one and after, or all of them
    if (isRep(mv.row)) {
      const occ = ymd(addDays(parse(today()), mv.occDay));
      paintDial();
      if (occ === day && patch.start_time === (mv.row.start_time || '').slice(0, 5)) return;
      const scope = await askScope('Move');
      if (!scope) return;
      try {
        const undo = await changeSeries(mv.row, occ, { ...fields(mv.row), ...patch }, scope); await load();
        toast(`Moved to ${dialTime(mv.s, true)}${scope === 'all' ? ', all of them' : scope === 'following' ? ', this and after' : ''}`, async () => { await undo(); load(); });
      } catch (e) { toast('Could not move it. Try again.'); load(); }
      return;
    }
    const before = { day: mv.row.day, start_time: mv.row.start_time, end_time: mv.row.end_time };
    if (patch.day === before.day && patch.start_time === (before.start_time || '').slice(0, 5)) { paintDial(); return; }
    Object.assign(mv.row, patch); index(S.rows); paintDial(); // show it in its new place right away
    try {
      await db.update(mv.id, patch); await load();
      toast(`Moved to ${dialTime(mv.s, true)}`, async () => { await db.update(mv.id, before); load(); });
    } catch (e) { toast('Could not move it. Try again.'); load(); }
  }
  const endPointer = () => {
    clearTimeout(holdT);
    if (FD) { FD = null; return; }
    if (MV) { dropMoved(); twisted = true; setTimeout(() => { twisted = false; }, 80); return; }
    if (!tw) return;
    if (tw.moved) { S.dial = Math.round(S.dial); paintDial(); twisted = true; setTimeout(() => { twisted = false; }, 80); }
    tw = null;
  };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  // a scroll wheel or trackpad over the dial turns it smoothly; over the fader it changes the width
  document.addEventListener('wheel', e => {
    if (e.target.closest('#fdSpan')) { e.preventDefault(); S.span = Math.round(Math.max(SPAN_MIN, Math.min(SPAN_MAX, S.span - e.deltaY * 0.5))); S.dial = clampDial(S.dial); paintDial(); return; }
    if (!e.target.closest('#dial .clock')) return;
    e.preventDefault();
    S.dial = Math.round(clampDial(S.dial + e.deltaY * 0.6 * (S.span / 360)));
    paintDial();
  }, { passive: false });
  document.addEventListener('keydown', e => {
    if (!e.target.closest || !e.target.closest('#fdSpan')) return;
    const d = { ArrowUp: 15, ArrowRight: 15, ArrowDown: -15, ArrowLeft: -15 }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    S.span = Math.max(SPAN_MIN, Math.min(SPAN_MAX, S.span + d)); S.dial = clampDial(S.dial); paintDial();
    $('#fdSpan').focus();
  }, true);
  // long-pressing on iPhone would otherwise bring up the text/selection menu
  document.addEventListener('contextmenu', e => { if (e.target.closest('#dial')) e.preventDefault(); });

  // no pinch zoom anywhere in the app (iOS Safari ignores the viewport tag's no-zoom, so stop the gestures;
  // app.css also limits touch to scrolling, which rules out double-tap zoom). On the Dial tab nothing scrolls at all.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1 || (S.tab === 'dial' && $('#dial') && !$('#dial').hidden && !e.target.closest('#sheet'))) e.preventDefault();
  }, { passive: false });

  document.addEventListener('click', e => {
    const t = e.target;
    if (twisted) { e.preventDefault(); return; }
    const tb = t.closest('.tabs [data-tab]');
    if (tb) { setTab(tb.dataset.tab); return; }
    if (t.closest('[data-sleep]') && t.closest('#view')) { openSleep(); return; }
    if (t.closest('#fdSpan')) return;
    const vb = t.closest('.bar [data-view]');
    if (vb) { go(S.cursor, vb.dataset.view); return; }
    const kb = t.closest('#edKind [data-kind]');
    if (kb) { ED.kind = kb.dataset.kind; syncEditor(); return; }
    const cb = t.closest('#edCats [data-cat]');
    if (cb) { ED.cat = cb.dataset.cat; syncEditor(); return; }
    const a = t.closest('[data-act]');
    if (a) {
      const act = a.dataset.act;
      if (act === 'prev') step(-1); else if (act === 'next') step(1);
      else if (act === 'today') go(today());
      else if (act === 'add') openEditor();
      else if (act === 'menu') openAccount();
      else if (act === 'dial-now') { S.dial = 0; paintDial(); }
      else if (act === 'sleep') openSleep();
      else if (act === 'sleep-off') saveSleep(true);
      else if (act === 'close') closeEditor();
      else if (act === 'delete') deleteEditor();
      else if (act === 'signout') { closeEditor(); if (sb) sb.auth.signOut(); }
      return;
    }
    const ev = t.closest('[data-id]');
    if (ev && t.closest('#view')) { const r = byId(ev.dataset.id); if (r) openEditor(r, null, ev.dataset.occ); return; }
    const g = t.closest('[data-go]');
    if (g) { go(g.dataset.go, g.dataset.viewTo || null); return; }
    // clicking an empty spot in the hour grid starts an event at that time
    const col = t.closest('.tg-col');
    if (col) {
      const m = Math.floor(((e.clientY - col.getBoundingClientRect().top) / HOUR) * 2) * 30;
      S.cursor = col.dataset.day;
      openEditor(null, { start: Math.max(0, Math.min(23 * 60, m)) });
    }
  });
  $('#scrim').addEventListener('click', closeEditor);
  document.addEventListener('change', e => {
    if (e.target.closest('#edForm')) syncEditor();
    if (e.target.id === 'sl_wk') { $('#slWk').hidden = !e.target.checked; $('#slLab1').textContent = e.target.checked ? 'Bedtime (Sun–Thu nights)' : 'Bedtime'; }
  });
  document.addEventListener('input', e => { if (e.target.id === 'ed_day') syncEditor(); });
  document.addEventListener('submit', async e => {
    e.preventDefault();
    if (e.target.id === 'edForm') return saveEditor();
    if (e.target.id === 'sleepForm') return saveSleep(false);
    if (e.target.id !== 'loginForm') return;
    const err = $('#l_err'), go_ = $('#l_go');
    go_.disabled = true; err.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#l_email').value.trim(), password: $('#l_pass').value });
    go_.disabled = false;
    if (error) { err.textContent = 'That email and password did not work.'; err.hidden = false; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('.ask-wrap')) { $('.ask-wrap [data-scope=""]').click(); return; }
    if (e.key === 'Escape' && sheetOpen()) { closeEditor(); return; }
    if (sheetOpen() || !S.user || e.metaKey || e.ctrlKey || e.altKey || (e.target.matches && e.target.matches('input, textarea, select'))) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft') step(-1); else if (k === 'arrowright') step(1);
    else if (k === 't') go(today()); else if (k === 'n') openEditor();
    else if ({ d: 'day', w: 'week', m: 'month', y: 'year' }[k]) go(S.cursor, { d: 'day', w: 'week', m: 'month', y: 'year' }[k]);
  });
  // swipe left/right on the calendar to move through days, weeks, months
  let sx0 = null, sy0 = null;
  $('#view').addEventListener('touchstart', e => { if (!e.target.closest('#cal')) { sx0 = null; return; } sx0 = e.touches[0].clientX; sy0 = e.touches[0].clientY; }, { passive: true });
  $('#view').addEventListener('touchend', e => {
    if (sx0 == null || !S.user) return;
    const dx = e.changedTouches[0].clientX - sx0, dy = e.changedTouches[0].clientY - sy0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    sx0 = null;
  }, { passive: true });

  /* ---------- start ---------- */
  if (DEMO) {
    S.user = { id: 'demo', email: 'preview@local' }; S.ready = true; render(); start();
  } else {
    sb.auth.onAuthStateChange((_ev, session) => {
      const u = session ? session.user : null, was = S.user && S.user.id;
      S.user = u; S.ready = true;
      if (u && was !== u.id) start();
      if (!u) $('#view').innerHTML = '';
      render();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) { checkVersion(); load(); } });
  }
})();
