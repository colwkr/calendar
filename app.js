/* Calendar — events live in Nerve (Supabase table public.cal_events), so other apps can read and add to them.
   Views: Day (ring clock + left-to-right flow), Week (one row per day, hours left to right), Month, Year.
   Birthdays are events with kind 'birthday': `day` is the date they were born, and they repeat every year. */
(() => {
  'use strict';

  const SB_URL = 'https://dejcovbqwlrvniitbdqv.supabase.co';
  const SB_KEY = 'sb_publishable_VB-KHKnNz_J5EKWvHKW9Ew_7B2sI6Zg';
  const TABLE = 'cal_events';
  const WEEK_START = 0; // 0 = Sunday, 1 = Monday
  const CATS = { work: 'Work', meet: 'Meet', personal: 'Personal', travel: 'Travel' };
  const CAT_KEYS = Object.keys(CATS);

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
    const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM'), h12 = h % 12 || 12;
    return short && !mm ? h12 + ap : `${h12}:${pad(mm)}${ap}`;
  }
  const hourLabel = h => (h % 12 || 12) + (h % 24 < 12 ? 'a' : 'p');

  /* ---------- state ---------- */
  const S = {
    user: null, ready: false, loaded: false, needsSetup: false,
    view: store.get('view', 'day'),
    cursor: today(),
    rows: [], byDay: new Map(), bdays: [],
  };
  if (!['day', 'week', 'month', 'year'].includes(S.view)) S.view = 'day';

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
    S.rows = rows; S.byDay = new Map(); S.bdays = [];
    for (const r of rows) {
      if (r.kind === 'birthday') { S.bdays.push(r); continue; }
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

  /* What's on a day: that day's events plus any birthday falling on it, each with start/end minutes. */
  function occs(dayStr) {
    const out = [];
    for (const r of S.byDay.get(dayStr) || []) {
      const s = toMin(r.start_time);
      if (s == null) { out.push({ r, allDay: true, title: r.title, cat: r.category }); continue; }
      let e = toMin(r.end_time); if (e == null) e = s + 60; if (e <= s) e = 1440;
      out.push({ r, s, e, title: r.title, cat: r.category });
    }
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

  // packs overlapping events into rows; returns how many rows it needed
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
  // the hours shown left to right: 6a–10p, widened to fit anything earlier or later
  function span(list) {
    let a = 6 * 60, b = 22 * 60;
    for (const o of list) if (!o.allDay) { a = Math.min(a, Math.floor(o.s / 60) * 60); b = Math.max(b, Math.ceil(o.e / 60) * 60); }
    return [a, b];
  }

  /* ---------- rings ---------- */
  // noon at the top, midnight at the bottom, so the waking day fills the top of the dial
  const pt = (c, r, m) => { const a = ((m - 720) / 1440) * 2 * Math.PI - Math.PI / 2; return [(c + r * Math.cos(a)).toFixed(2), (c + r * Math.sin(a)).toFixed(2)]; };
  function arc(c, r, s, e, reverse) {
    e = Math.min(e, s + 1439);
    const [x1, y1] = pt(c, r, s), [x2, y2] = pt(c, r, e), large = e - s > 720 ? 1 : 0;
    return reverse ? `M${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x1} ${y1}` : `M${x1} ${y1}A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }
  function miniRing(dayStr, size) {
    const c = size / 2, r = c - 3;
    const arcs = timed(occs(dayStr)).map(o => `<path d="${arc(c, r, o.s, Math.max(o.e, o.s + 15))}" style="stroke:var(--${o.cat})"/>`).join('');
    return `<svg class="mini" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" class="mini-track"/>${arcs}</svg>`;
  }

  /* The 6-Hour Dial: the next six hours as half a clock face — now at the bottom, six hours from now at the top,
     running up the left side like the 6-to-12 half of a wall clock. One band per category; events are arcs on their
     band. It always starts at now, whatever day the rest of the page shows. Twist it (drag around the dial, or scroll)
     to look ahead six hours at a time, up to 72 hours out; it settles on the nearest six-hour step when let go.
     Minutes below are counted from the start of today. */
  const SPAN = 360, AHEAD = 72 * 60 - SPAN;
  S.dial = 0; // minutes twisted ahead of now
  const dialStart = () => nowMin() + Math.round(S.dial);
  function dialEvents(w0) {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(...timed(occs(ymd(addDays(parse(today()), i)))).map(o => ({ ...o, s: o.s + i * 1440, e: o.e + i * 1440 })));
    return out.filter(o => o.e > w0 && o.s < w0 + SPAN).sort((a, b) => a.s - b.s);
  }
  function sixHours(w0, evs) {
    const CX = 240, CY = 246, W = 22, R = { work: 222, meet: 196, personal: 170, travel: 144 }, FACE = 128;
    const P = (r, m) => { const a = Math.PI / 2 + ((m - w0) / SPAN) * Math.PI; return [(CX + r * Math.cos(a)).toFixed(2), (CY + r * Math.sin(a)).toFixed(2)]; };
    const half = (r, s, e, rev) => { const [x1, y1] = P(r, s), [x2, y2] = P(r, e); return rev ? `M${x2} ${y2}A${r} ${r} 0 0 0 ${x1} ${y1}` : `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`; };
    let s = `<svg class="clock" viewBox="0 0 244 500" role="img" aria-label="6-Hour Dial, ${clock(w0 % 1440)} to ${clock((w0 + SPAN) % 1440)}. Twist to look further ahead.">`;
    for (const k of CAT_KEYS) s += `<path d="${half(R[k], w0, w0 + SPAN)}" class="band" stroke-width="${W}"/>`;
    s += `<path d="${half(FACE, w0, w0 + SPAN)}L${CX} ${CY}Z" class="face"/>`;
    for (let m = Math.ceil(w0 / 15) * 15; m <= w0 + SPAN; m += 15) {
      const hour = m % 60 === 0, [x1, y1] = P(FACE, m), [x2, y2] = P(FACE - (hour ? 12 : 6), m);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="tick${hour ? ' major' : ''}"/>`;
      if (hour) { const [x, y] = P(FACE - 30, m), h = (m / 60) % 24; s += `<text x="${x}" y="${y}" class="hr" dy="7">${h % 12 || 12}</text>`; }
    }
    let i = 0;
    for (const o of evs) {
      const k = CATS[o.cat] ? o.cat : 'personal', r = R[k], a = Math.max(o.s, w0), b = Math.min(Math.max(o.e, o.s + 10), w0 + SPAN);
      if (b <= a) continue;
      const len = ((b - a) / SPAN) * Math.PI * r, id = `ev${i++}`;
      s += `<path d="${half(r, a, b)}" class="ev-arc" stroke-width="${W - 2}" style="stroke:var(--${k})" data-id="${o.r.id}"><title>${esc(o.title)} · ${clock(o.s % 1440)}–${clock(o.e % 1440)}</title></path>`;
      if (len > 34) {
        const max = Math.floor((len - 14) / 6.2), t = o.title.length > max ? o.title.slice(0, Math.max(1, max - 1)) + '…' : o.title;
        // near the bottom the arc runs right to left, so the label is drawn the other way to stay upright
        s += `<path id="${id}" d="${half(r, a, b, (a + b) / 2 - w0 < 120)}" fill="none"/><text class="ev-lab" dy="4" data-id="${o.r.id}"><textPath href="#${id}" startOffset="9">${esc(t)}</textPath></text>`;
      }
    }
    // now: a red mark at the bottom where the window begins
    s += `<line x1="${CX - 1}" y1="${CY + FACE}" x2="${CX - 1}" y2="${CY + 237}" class="hand"/><text x="${CX - 8}" y="${CY + 250}" class="c-now">${clock(w0 % 1440)}</text>`;
    return s + '</svg>';
  }
  // a time on the dial, with its weekday when it isn't today
  const dialTime = (m, short) => (m >= 1440 ? fmt(addDays(parse(today()), Math.floor(m / 1440)), { weekday: 'short' }) + ' ' : '') + clock(m % 1440, short);
  // under the dial: what's on at the start of the window and what's next in it
  function upNext(w0, evs, live) {
    const cur = evs.find(o => o.s <= w0 && o.e > w0), nxt = evs.find(o => o.s > w0);
    const row = (k, o, when) => `<button type="button" class="up" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i><small>${k}</small><b>${esc(o.title)}</b><em>${when}</em></button>`;
    if (!cur && !nxt) return '<p class="up-none">Nothing in these six hours.</p>';
    return (cur ? row(live ? 'Now' : 'On', cur, `until ${dialTime(cur.e)}`) : '') + (nxt ? row('Next', nxt, dialTime(nxt.s)) : '');
  }
  function dialCard() {
    const w0 = dialStart(), evs = dialEvents(w0), live = S.dial === 0, step = Math.round(S.dial / SPAN);
    const d = addDays(parse(today()), Math.floor(w0 / 1440));
    return `<h2>6-Hour Dial</h2>
      ${live ? '' : '<button type="button" class="pill cc-back" data-act="dial-now">Now</button>'}
      <div class="cc-dial">
        <div class="cc-badge"><small>${esc(fmt(d, { weekday: 'long' }))}</small><b>${d.getDate()}</b></div>
        <div class="cc-win"><small>${live ? 'Next 6 hours' : `${step * 6} hours ahead`}</small><b>${dialTime(w0, true)} – ${dialTime(w0 + SPAN, true)}</b>
          <span class="cc-steps" aria-hidden="true">${[...Array(12)].map((_, i) => `<i${i === step ? ' class="on"' : ''}></i>`).join('')}</span></div>
        ${sixHours(w0, evs)}
      </div>
      <div class="cc-up">${upNext(w0, evs, live)}</div>
      <div class="legend">${CAT_KEYS.map(k => `<span><i style="background:var(--${k})"></i>${CATS[k]}</span>`).join('')}</div>`;
  }
  // redraws just the dial (while it's being twisted, the rest of the page stays put)
  function paintDial() {
    const el = $('#dial'); if (!el) return;
    el.classList.toggle('live', S.dial === 0);
    el.innerHTML = dialCard();
  }

  /* ---------- views ---------- */
  function vDay() {
    const d = parse(S.cursor), list = occs(S.cursor), tl = timed(list), allDay = list.filter(o => o.allDay);
    // seven mini rings, the chosen day in the middle
    let strip = '';
    for (let i = -3; i <= 3; i++) {
      const dd = addDays(d, i), k = ymd(dd);
      strip += `<button type="button" class="dchip${i === 0 ? ' on' : ''}${k === today() ? ' today' : ''}" data-go="${k}">${miniRing(k, 54)}<span class="dchip-t"><small>${esc(fmt(dd, { weekday: 'short' }))}</small><b>${dd.getDate()}</b></span></button>`;
    }
    const agenda = list.length ? list.map(o => `
      <button type="button" class="ag" data-id="${o.r.id}">
        <span class="ag-time">${o.allDay ? (o.bday ? 'Birthday' : 'All day') : `${clock(o.s)}<small>${clock(o.e)}</small>`}</span>
        <span class="ag-bar" style="background:var(--${o.cat})"></span>
        <span class="ag-main"><b>${esc(o.title)}</b>${o.r.place ? `<small>${esc(o.r.place)}</small>` : ''}${o.r.notes && !o.bday ? `<small class="ag-notes">${esc(o.r.notes)}</small>` : ''}</span>
      </button>`).join('') : `<div class="empty"><b>Nothing on ${esc(fmt(d, { weekday: 'long' }))}.</b><span>Tap <em>New</em> to add an event.</span></div>`;
    return `
      <div class="strip">${strip}</div>
      <div class="day">
        <section class="card clock-card${S.dial === 0 ? ' live' : ''}" id="dial">${dialCard()}</section>
        <div class="day-r">
          <section class="card">
            <h2>Flow</h2>
            ${allDay.length ? `<div class="chips">${allDay.map(o => `<button type="button" class="chip" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i>${esc(o.title)}</button>`).join('')}</div>` : ''}
            ${flow(S.cursor, tl)}
          </section>
          <section class="card"><h2>Agenda</h2><div class="agenda">${agenda}</div></section>
        </div>
      </div>`;
  }

  // the day left to right: one bar per event, lines carrying you from each thing to the next
  function flow(dayStr, tl) {
    const [a, b] = span(tl), len = b - a, X = m => ((m - a) / len) * 100;
    const items = tl.map(o => ({ ...o })), n = lanes(items), LH = 58, TOP = 30, H = TOP + n * LH + 8;
    let hours = '';
    for (let m = a; m <= b; m += 60) hours += `<span class="fl-h" style="left:${X(m)}%">${hourLabel(m / 60)}</span>`;
    const yMid = it => TOP + it.lane * LH + (LH - 8) / 2;
    const seq = [...items].sort((p, q) => p.s - q.s);
    let lines = '', defs = '';
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i - 1], q = seq[i];
      if (q.s < p.e) continue;
      const x1 = X(p.e) * 10, x2 = X(q.s) * 10, xm = (x1 + x2) / 2, y1 = yMid(p), y2 = yMid(q), g = `fg${i}`;
      defs += `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${Math.max(x2, x1 + 1)}" y2="0"><stop offset="0" style="stop-color:var(--${p.cat})"/><stop offset="1" style="stop-color:var(--${q.cat})"/></linearGradient>`;
      lines += `<path d="M${x1} ${y1}H${xm}V${y2}H${x2}" stroke="url(#${g})"/>`;
    }
    const bars = items.map(o => `
      <button type="button" class="fl-ev" data-id="${o.r.id}" style="left:${X(o.s)}%;width:calc(${X(o.e) - X(o.s)}% - 3px);top:${TOP + o.lane * LH}px;--c:var(--${o.cat})">
        <b>${esc(o.title)}</b><small>${clock(o.s, true)}–${clock(o.e, true)}${o.r.place ? ' · ' + esc(o.r.place) : ''}</small>
      </button>`).join('');
    const now = dayStr === today() && nowMin() >= a && nowMin() <= b ? `<span class="now" style="left:${X(nowMin())}%"></span>` : '';
    return `<div class="flow-wrap"><div class="flow" style="height:${H}px;min-width:${(len / 60) * 84}px" data-day="${dayStr}" data-a="${a}" data-b="${b}">
      <div class="fl-grid">${hours}</div>
      <svg class="fl-lines" viewBox="0 0 1000 ${H}" preserveAspectRatio="none" aria-hidden="true"><defs>${defs}</defs>${lines}</svg>
      ${bars}${now}
      ${tl.length ? '' : '<span class="fl-empty">No timed events. Click anywhere here to add one.</span>'}
    </div></div>`;
  }

  function vWeek() {
    const w0 = weekStart(parse(S.cursor)), days = [...Array(7)].map((_, i) => addDays(w0, i));
    const all = days.map(d => occs(ymd(d)));
    const [a, b] = span(all.flat()), len = b - a, X = m => ((m - a) / len) * 100;
    let hours = '';
    for (let m = a; m <= b; m += 60) hours += `<span class="fl-h" style="left:${X(m)}%">${hourLabel(m / 60)}</span>`;
    const rows = days.map((d, i) => {
      const k = ymd(d), list = all[i], tl = timed(list).map(o => ({ ...o })), n = lanes(tl), LH = 40;
      const allDay = list.filter(o => o.allDay), top = allDay.length ? 26 : 6, h = Math.max(56, top + n * LH + 6);
      const we = d.getDay() === 0 || d.getDay() === 6;
      const now = k === today() && nowMin() >= a && nowMin() <= b ? `<span class="now" style="left:${X(nowMin())}%"></span>` : '';
      return `<div class="wk-row${we ? ' we' : ''}${k === today() ? ' today' : ''}">
        <button type="button" class="wk-day" data-go="${k}" data-view-to="day"><small>${esc(fmt(d, { weekday: 'short' }))}</small><b>${d.getDate()}</b></button>
        <div class="wk-track flow" style="height:${h}px" data-day="${k}" data-a="${a}" data-b="${b}">
          <div class="fl-grid">${hours.replace(/>[^<]+</g, '><')}</div>
          ${allDay.length ? `<div class="wk-all">${allDay.map(o => `<button type="button" class="chip sm" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i>${esc(o.title)}</button>`).join('')}</div>` : ''}
          ${tl.map(o => `<button type="button" class="fl-ev sm" data-id="${o.r.id}" style="left:${X(o.s)}%;width:calc(${X(o.e) - X(o.s)}% - 3px);top:${top + o.lane * LH}px;--c:var(--${o.cat})"><b>${esc(o.title)}</b><small>${clock(o.s, true)}–${clock(o.e, true)}</small></button>`).join('')}
          ${now}
        </div>
      </div>`;
    }).join('');
    return `<section class="card week"><div class="wk-scroll"><div class="wk-inner">
      <div class="wk-row wk-head"><span class="wk-day"></span><div class="wk-track"><div class="fl-grid">${hours}</div></div></div>
      ${rows}
    </div></div></section>`;
  }

  function weekdayHeads(short) {
    return [...Array(7)].map((_, i) => `<span>${esc(fmt(new Date(2023, 0, 1 + ((i + WEEK_START) % 7)), { weekday: short ? 'narrow' : 'short' }))}</span>`).join('');
  }

  function vMonth() {
    const d = parse(S.cursor), first = new Date(d.getFullYear(), d.getMonth(), 1), g0 = weekStart(first);
    const weeks = Math.ceil(((first.getDay() - WEEK_START + 7) % 7 + dim(d)) / 7);
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const dd = addDays(g0, i), k = ymd(dd), list = occs(k), out = dd.getMonth() !== d.getMonth();
      const shown = list.slice(0, 3).map(o => `<button type="button" class="mc-ev" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i>${o.allDay ? '' : `<em>${clock(o.s, true)}</em>`}${esc(o.title)}</button>`).join('');
      cells += `<div class="mc${out ? ' out' : ''}${k === today() ? ' today' : ''}" data-go="${k}" data-view-to="day">
        <div class="mc-top"><span class="mc-n">${dd.getDate()}</span>${timed(list).length ? miniRing(k, 22) : ''}</div>
        <div class="mc-evs">${shown}${list.length > 3 ? `<span class="mc-more">+${list.length - 3} more</span>` : ''}</div>
        ${list.length ? `<span class="mc-dots">${list.slice(0, 4).map(o => `<i style="background:var(--${o.cat})"></i>`).join('')}</span>` : ''}
      </div>`;
    }
    return `<section class="card month"><div class="mh">${weekdayHeads()}</div><div class="mg" style="--weeks:${weeks}">${cells}</div></section>`;
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
      <div class="logo">${miniRingStatic()}</div>
      <h1>Calendar</h1>
      <p class="muted">Sign in with your Nerve account.</p>
      <label class="f"><span>Email</span><input id="l_email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" required></label>
      <label class="f"><span>Password</span><input id="l_pass" type="password" autocomplete="current-password" required></label>
      <p class="err" id="l_err" hidden></p>
      <button type="submit" class="pill solid big" id="l_go">Sign in</button>
    </form></div>`;
  }
  function miniRingStatic() {
    return `<svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true"><circle cx="24" cy="24" r="19" class="mini-track" style="stroke-width:5"/><path d="${arc(24, 19, 1300, 1700)}" style="stroke:var(--work);stroke-width:5;fill:none;stroke-linecap:round"/><path d="${arc(24, 19, 160, 420)}" style="stroke:var(--meet);stroke-width:5;fill:none;stroke-linecap:round"/><path d="${arc(24, 19, 520, 860)}" style="stroke:var(--personal);stroke-width:5;fill:none;stroke-linecap:round"/></svg>`;
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

  function render() {
    if (sheetOpen() && editing()) return;
    const v = $('#view'), signed = !!S.user;
    $('#top').hidden = !signed || S.needsSetup;
    if (!S.ready) { v.innerHTML = ''; return; }
    if (!signed) { v.innerHTML = vLogin(); document.title = 'Calendar'; return; }
    if (S.needsSetup) { v.innerHTML = vSetup(); return; }
    $('#title').textContent = title();
    document.querySelectorAll('#seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
    const sx = (v.querySelector('.wk-scroll') || {}).scrollLeft || 0;
    const ofw = v.querySelector('.flow-wrap'), prevFlow = ofw ? { day: ofw.firstElementChild.dataset.day, left: ofw.scrollLeft } : null;
    v.className = 'v-' + S.view;
    v.innerHTML = S.loaded ? ({ day: vDay, week: vWeek, month: vMonth, year: vYear }[S.view])() : '<div class="loading"></div>';
    const ws = v.querySelector('.wk-scroll'); if (ws) ws.scrollLeft = sx;
    // the day's flow opens on now (today) or on the first event, a little before it
    const fw = v.querySelector('.flow-wrap'), fl = fw && fw.firstElementChild;
    if (fl) {
      if (prevFlow && prevFlow.day === S.cursor) fw.scrollLeft = prevFlow.left;
      else {
        const a = +fl.dataset.a, b = +fl.dataset.b, first = timed(occs(S.cursor))[0];
        const at = S.cursor === today() ? nowMin() - 90 : first ? first.s - 30 : 8 * 60;
        fw.scrollLeft = Math.max(0, ((at - a) / (b - a)) * fl.offsetWidth);
      }
    }
    document.title = 'Calendar · ' + title();
  }
  setInterval(() => { if (S.user && (S.view === 'day' || S.view === 'week')) render(); }, 60000);

  function go(dayStr, view) {
    S.cursor = dayStr;
    if (view) { S.view = view; store.set('view', view); }
    render();
  }
  function step(n) {
    const d = parse(S.cursor);
    S.cursor = ymd(S.view === 'day' ? addDays(d, n) : S.view === 'week' ? addDays(d, 7 * n) : S.view === 'month' ? addMonths(d, n) : addMonths(d, 12 * n));
    render();
  }

  /* ---------- the editor ---------- */
  const sheetOpen = () => !$('#sheet').hidden;
  const editing = () => { const a = document.activeElement; return !!(a && a.closest('#sheet') && a.matches('input, textarea')); };
  let ED = null;
  function openEditor(row, preset) {
    const r = row || {
      kind: 'event', title: '', category: 'personal', day: S.cursor, place: '', notes: '',
      start_time: toTime(preset?.start ?? (S.cursor === today() ? Math.min(23 * 60, Math.ceil((nowMin() + 1) / 60) * 60) : 9 * 60)),
      end_time: null,
    };
    if (!row && !r.end_time) r.end_time = toTime(Math.min(toMin(r.start_time) + 60, 1439));
    ED = { id: row ? row.id : null, kind: r.kind, cat: r.category || 'personal', allDay: !r.start_time, orig: row };
    $('#sheet').innerHTML = `<form id="edForm" novalidate>
      <div class="sh-head"><h2>${row ? 'Edit' : 'New'}</h2><button type="button" class="ic" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="seg wide" id="edKind"><button type="button" data-kind="event">Event</button><button type="button" data-kind="birthday">Birthday</button></div>
      <label class="f"><span id="edTitleLab">Title</span><input id="ed_title" value="${esc(r.title)}" autocomplete="off" required></label>
      <div class="f ev-only"><span>Type</span><div class="cats" id="edCats">${CAT_KEYS.map(k => `<button type="button" data-cat="${k}" style="--c:var(--${k})">${CATS[k]}</button>`).join('')}</div></div>
      <label class="f"><span id="edDayLab">Date</span><input id="ed_day" type="date" value="${esc(r.day)}" required></label>
      <label class="tog ev-only"><input type="checkbox" id="ed_allday"${!r.start_time ? ' checked' : ''}><span>All day</span></label>
      <div class="row2 ev-only times"><label class="f"><span>Starts</span><input id="ed_start" type="time" value="${esc((r.start_time || '09:00').slice(0, 5))}"></label><label class="f"><span>Ends</span><input id="ed_end" type="time" value="${esc((r.end_time || '10:00').slice(0, 5))}"></label></div>
      <label class="f ev-only"><span>Place</span><input id="ed_place" value="${esc(r.place)}" autocomplete="off"></label>
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
    const bd = ED.kind === 'birthday';
    f.classList.toggle('is-bd', bd);
    f.querySelectorAll('#edKind button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.kind === ED.kind)));
    f.querySelectorAll('#edCats button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === ED.cat)));
    $('#edTitleLab').textContent = bd ? 'Name' : 'Title';
    $('#edDayLab').textContent = bd ? 'Born on (with the year)' : 'Date';
    f.querySelector('.times').hidden = bd || $('#ed_allday').checked;
    const day = $('#ed_day').value;
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
    const err = $('#ed_err'), bd = ED.kind === 'birthday', allDay = bd || $('#ed_allday').checked;
    const row = {
      kind: ED.kind, title: $('#ed_title').value.trim(), category: bd ? 'personal' : ED.cat, day: $('#ed_day').value,
      start_time: allDay ? null : $('#ed_start').value || null, end_time: allDay ? null : $('#ed_end').value || null,
      place: bd ? null : $('#ed_place').value.trim() || null, notes: $('#ed_notes').value.trim() || null,
    };
    const bad = !row.title ? (bd ? 'Add their name.' : 'Add a title.') : !row.day ? 'Pick a date.'
      : (!allDay && !row.start_time) ? 'Pick a start time.'
      : (!allDay && row.end_time && toMin(row.end_time) <= toMin(row.start_time)) ? 'The end time needs to be after the start.' : '';
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    const btn = $('#edForm [type=submit]'); btn.disabled = true;
    try {
      if (ED.id) await db.update(ED.id, row); else await db.insert(row);
      const wasNew = !ED.id, day = row.day;
      closeEditor();
      if (wasNew && !bd) S.cursor = day;
      await load();
      toast(wasNew ? (bd ? 'Birthday added' : 'Event added') : 'Saved');
    } catch (e) {
      btn.disabled = false; err.textContent = 'Could not save to Nerve. Try again.'; err.hidden = false;
    }
  }
  async function deleteEditor() {
    const orig = ED.orig; if (!orig) return;
    closeEditor();
    try {
      await db.remove(orig.id); await load();
      const { id, user_id, created_at, updated_at, ...back } = orig;
      toast(`Deleted “${orig.title}”`, async () => { await db.insert(back); load(); });
    } catch (e) { toast('Could not delete. Try again.'); }
  }

  function openAccount() {
    $('#sheet').innerHTML = `<div class="sh-head"><h2>Account</h2><button type="button" class="ic" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <p class="muted">Signed in to Nerve as <b>${esc(S.user.email || '')}</b>.</p>
      <p class="muted small">Your events are stored in Nerve, so your other apps can use them too.</p>
      <div class="sh-foot"><span></span><button type="button" class="pill" data-act="signout">Sign out</button></div>`;
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

  /* Twisting the 6-Hour Dial: drag around its center. Turning it the way the hours run brings later hours down to
     the bottom; half a turn of the face is six hours. Let go and it settles on the nearest six-hour step. */
  let tw = null, twisted = false;
  const settle = () => { S.dial = Math.max(0, Math.min(AHEAD, Math.round(S.dial / SPAN) * SPAN)); paintDial(); };
  document.addEventListener('pointerdown', e => {
    const svg = e.target.closest('#dial .clock');
    if (!svg || e.button > 0) return;
    const r = svg.getBoundingClientRect(), cx = r.left + r.width * 240 / 244, cy = r.top + r.height * 246 / 500;
    tw = { cx, cy, a: Math.atan2(e.clientY - cy, e.clientX - cx), start: S.dial, turned: 0, x: e.clientX, y: e.clientY, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!tw) return;
    if (!tw.moved && Math.hypot(e.clientX - tw.x, e.clientY - tw.y) < 6) return;
    tw.moved = true;
    const a = Math.atan2(e.clientY - tw.cy, e.clientX - tw.cx);
    let d = a - tw.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    tw.a = a; tw.turned += d;
    S.dial = Math.max(0, Math.min(AHEAD, tw.start - (tw.turned / Math.PI) * SPAN));
    paintDial();
  });
  const endTwist = () => {
    if (!tw) return;
    if (tw.moved) { settle(); twisted = true; setTimeout(() => { twisted = false; }, 80); }
    tw = null;
  };
  window.addEventListener('pointerup', endTwist);
  window.addEventListener('pointercancel', endTwist);
  // a scroll wheel or trackpad over the dial turns it one step at a time
  let wheelT = 0;
  document.addEventListener('wheel', e => {
    if (!e.target.closest('#dial .clock')) return;
    e.preventDefault();
    if (Date.now() - wheelT < 350 || Math.abs(e.deltaY) < 4) return;
    wheelT = Date.now();
    S.dial += e.deltaY > 0 ? SPAN : -SPAN; settle();
  }, { passive: false });

  // no pinch or double-tap zoom anywhere in the app (iOS Safari ignores the viewport tag's no-zoom, so stop the gestures)
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  // (app.css also sets touch-action so only scrolling is allowed, which rules out double-tap zoom too)
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  document.addEventListener('click', e => {
    const t = e.target;
    if (twisted) { e.preventDefault(); return; }
    const vb = t.closest('#seg [data-view]');
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
      else if (act === 'close') closeEditor();
      else if (act === 'delete') deleteEditor();
      else if (act === 'signout') { closeEditor(); if (sb) sb.auth.signOut(); }
      return;
    }
    const ev = t.closest('[data-id]');
    if (ev && t.closest('#view')) { const r = byId(ev.dataset.id); if (r) openEditor(r); return; }
    const g = t.closest('[data-go]');
    if (g) { go(g.dataset.go, g.dataset.viewTo || null); return; }
    // clicking an empty stretch of a flow/week row starts an event at that time
    const fl = t.closest('.flow');
    if (fl && fl.dataset.day && !t.closest('.fl-ev, .chip')) {
      const box = fl.getBoundingClientRect(), a0 = +fl.dataset.a, b0 = +fl.dataset.b;
      const m = Math.round((a0 + ((e.clientX - box.left) / box.width) * (b0 - a0)) / 30) * 30;
      S.cursor = fl.dataset.day;
      openEditor(null, { start: Math.max(0, Math.min(23 * 60, m)) });
    }
  });
  $('#scrim').addEventListener('click', closeEditor);
  document.addEventListener('change', e => { if (e.target.closest('#edForm')) syncEditor(); });
  document.addEventListener('input', e => { if (e.target.id === 'ed_day') syncEditor(); });
  document.addEventListener('submit', async e => {
    e.preventDefault();
    if (e.target.id === 'edForm') return saveEditor();
    if (e.target.id !== 'loginForm') return;
    const err = $('#l_err'), go_ = $('#l_go');
    go_.disabled = true; err.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#l_email').value.trim(), password: $('#l_pass').value });
    go_.disabled = false;
    if (error) { err.textContent = 'That email and password did not work.'; err.hidden = false; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheetOpen()) { closeEditor(); return; }
    if (sheetOpen() || !S.user || e.metaKey || e.ctrlKey || e.altKey || (e.target.matches && e.target.matches('input, textarea, select'))) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft') step(-1); else if (k === 'arrowright') step(1);
    else if (k === 't') go(today()); else if (k === 'n') openEditor();
    else if ({ d: 'day', w: 'week', m: 'month', y: 'year' }[k]) go(S.cursor, { d: 'day', w: 'week', m: 'month', y: 'year' }[k]);
  });
  // swipe left/right to move through days, weeks, months
  let sx0 = null, sy0 = null;
  $('#view').addEventListener('touchstart', e => { if (e.target.closest('.wk-scroll, .clock, .flow-wrap')) { sx0 = null; return; } sx0 = e.touches[0].clientX; sy0 = e.touches[0].clientY; }, { passive: true });
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
      render();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) { checkVersion(); load(); } });
  }
})();
