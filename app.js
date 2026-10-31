/* Calendar — events live in Nerve (Supabase table public.cal_events), so other apps can read and add to them.
   The page opens on the 6-Hour Dial (the next six hours, twistable up to 72 hours ahead). Below it is a regular
   calendar: Day and Week as an hour-by-hour grid, Month, and Year.
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
    dial: 0, // minutes the 6-Hour Dial is twisted ahead of now
    rows: [], byDay: new Map(), bdays: [],
  };
  if (!['day', 'week', 'month', 'year'].includes(S.view)) S.view = 'week';

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
     The next six hours as half a clock face: now at the bottom, six hours later at the top, running up the left side
     like the 6-to-12 half of a wall clock. One band per category; events are arcs on their band. It always starts at
     now. Twist it (drag around it, or scroll over it) to look ahead, anywhere up to 72 hours out; it stays wherever
     it's let go. Minutes here are counted from the start of today. */
  const SPAN = 360, AHEAD = 72 * 60 - SPAN;
  const dialStart = () => nowMin() + Math.round(S.dial);
  function dialEvents(w0) {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(...timed(occs(ymd(addDays(parse(today()), i)))).map(o => ({ ...o, s: o.s + i * 1440, e: o.e + i * 1440 })));
    return out.filter(o => o.e > w0 && o.s < w0 + SPAN).sort((a, b) => a.s - b.s);
  }
  const dialTime = (m, short) => (m >= 1440 ? fmt(addDays(parse(today()), Math.floor(m / 1440)), { weekday: 'short' }) + ' ' : '') + clock(m % 1440, short);
  function sixHours(w0, evs) {
    const CX = 240, CY = 246, W = 22, R = { work: 222, meet: 196, personal: 170, travel: 144 }, FACE = 128;
    const P = (r, m) => { const a = Math.PI / 2 + ((m - w0) / SPAN) * Math.PI; return [(CX + r * Math.cos(a)).toFixed(2), (CY + r * Math.sin(a)).toFixed(2)]; };
    const half = (r, s, e, rev) => { const [x1, y1] = P(r, s), [x2, y2] = P(r, e); return rev ? `M${x2} ${y2}A${r} ${r} 0 0 0 ${x1} ${y1}` : `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`; };
    let s = `<svg class="clock" viewBox="0 0 244 500" role="img" aria-label="6-Hour Dial, ${dialTime(w0)} to ${dialTime(w0 + SPAN)}. Twist to look further ahead.">`;
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
      s += `<path d="${half(r, a, b)}" class="ev-arc" stroke-width="${W - 2}" style="stroke:var(--${k})" data-id="${o.r.id}"><title>${esc(o.title)} · ${dialTime(o.s)}–${dialTime(o.e)}</title></path>`;
      if (len > 34) {
        const max = Math.floor((len - 14) / 6.2), t = o.title.length > max ? o.title.slice(0, Math.max(1, max - 1)) + '…' : o.title;
        // near the bottom the arc runs right to left, so the label is drawn the other way to stay upright
        s += `<path id="${id}" d="${half(r, a, b, (a + b) / 2 - w0 < 120)}" fill="none"/><text class="ev-lab" dy="4" data-id="${o.r.id}"><textPath href="#${id}" startOffset="9">${esc(t)}</textPath></text>`;
      }
    }
    // the start of the window: a mark at the bottom, red while it's now
    s += `<line x1="${CX - 1}" y1="${CY + FACE}" x2="${CX - 1}" y2="${CY + 237}" class="hand"/><text x="${CX - 8}" y="${CY + 250}" class="c-now">${clock(w0 % 1440)}</text>`;
    return s + '</svg>';
  }
  function upNext(w0, evs, live) {
    const cur = evs.find(o => o.s <= w0 && o.e > w0), nxt = evs.find(o => o.s > w0);
    const row = (k, o, when) => `<button type="button" class="up" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i><small>${k}</small><b>${esc(o.title)}</b><em>${when}</em></button>`;
    if (!cur && !nxt) return '<p class="up-none">Nothing in these six hours.</p>';
    return (cur ? row(live ? 'Now' : 'On', cur, `until ${dialTime(cur.e)}`) : '') + (nxt ? row('Next', nxt, dialTime(nxt.s)) : '');
  }
  function ahead(m) {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return (h ? `${h}h ` : '') + (mm || !h ? `${mm}m ` : '') + 'ahead';
  }
  function dialCard() {
    const w0 = dialStart(), evs = dialEvents(w0), live = Math.round(S.dial) === 0;
    const d = addDays(parse(today()), Math.floor(w0 / 1440));
    return `<div class="hero-top"><h2>6-Hour Dial</h2>
        <div class="hero-act">${live ? '' : '<button type="button" class="pill sm" data-act="dial-now">Now</button>'}
        <button type="button" class="ic" data-act="menu" aria-label="Account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5"/></svg></button></div></div>
      <div class="hero-in">
        <div class="cc-dial">
          <div class="cc-badge"><small>${esc(fmt(d, { weekday: 'long' }))}</small><b>${d.getDate()}</b></div>
          <div class="cc-win"><small>${live ? 'Next 6 hours' : ahead(S.dial)}</small><b>${dialTime(w0, true)} – ${dialTime(w0 + SPAN, true)}</b>
            <span class="cc-prog" aria-hidden="true"><i style="width:${(S.dial / AHEAD) * 100}%"></i></span></div>
          ${sixHours(w0, evs)}
        </div>
        <div class="cc-up">${upNext(w0, evs, live)}</div>
        <div class="legend">${CAT_KEYS.map(k => `<span><i style="background:var(--${k})"></i>${CATS[k]}</span>`).join('')}</div>
      </div>
      <button type="button" class="hero-more" data-act="to-cal">Calendar<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>`;
  }
  function paintDial() {
    const el = $('#dial'); if (!el) return;
    el.classList.toggle('live', Math.round(S.dial) === 0);
    el.innerHTML = dialCard();
  }

  /* ---------- the calendar: day and week as an hour grid ---------- */
  const HOUR = 48;
  function placeEvents(tl) {
    // overlapping events share the column side by side
    const items = tl.map(o => ({ ...o })).sort((a, b) => a.s - b.s || b.e - a.e);
    let group = [], end = -1, out = '';
    const flush = () => {
      const n = lanes(group);
      for (const o of group) {
        const h = Math.max(20, ((o.e - o.s) / 60) * HOUR - 2);
        out += `<button type="button" class="tg-ev${h < 36 ? ' short' : ''}" data-id="${o.r.id}" style="top:${(o.s / 60) * HOUR}px;height:${h}px;left:calc(${(o.lane / n) * 100}% + 2px);width:calc(${100 / n}% - 4px);--c:var(--${o.cat})">
          <b>${esc(o.title)}</b><small>${clock(o.s, true)} – ${clock(o.e, true)}${o.r.place ? ', ' + esc(o.r.place) : ''}</small></button>`;
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
    const keys = days.map(ymd), lists = keys.map(occs), t = today(), multi = days.length > 1;
    const chip = o => `<button type="button" class="chip sm" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i>${esc(o.title)}</button>`;
    const head = `<div class="tg-row tg-head"><span class="tg-gut"></span>${days.map((d, i) => `
      <button type="button" class="tg-dh${keys[i] === t ? ' today' : ''}" data-go="${keys[i]}"${multi ? ' data-view-to="day"' : ''}><small>${esc(fmt(d, { weekday: 'short' }))}</small><b>${d.getDate()}</b></button>`).join('')}</div>`;
    const anyAll = lists.some(l => l.some(o => o.allDay));
    const all = anyAll ? `<div class="tg-row tg-all"><span class="tg-gut">all day</span>${lists.map(l => `<div class="tg-allc">${l.filter(o => o.allDay).map(chip).join('')}</div>`).join('')}</div>` : '';
    let gutter = '';
    for (let h = 1; h < 24; h++) gutter += `<span style="top:${h * HOUR}px">${hourLabel(h)}</span>`;
    const cols = lists.map((l, i) => {
      const now = keys[i] === t ? `<span class="tg-now" style="top:${(nowMin() / 60) * HOUR}px"></span>` : '';
      return `<div class="tg-col${keys[i] === t ? ' today' : ''}" data-day="${keys[i]}">${placeEvents(timed(l))}${now}</div>`;
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
      const shown = list.slice(0, 3).map(o => `<button type="button" class="mc-ev" data-id="${o.r.id}"><i style="background:var(--${o.cat})"></i>${o.allDay ? '' : `<em>${clock(o.s, true)}</em>`}${esc(o.title)}</button>`).join('');
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
  function render() {
    if ($('#sheet') && !$('#sheet').hidden && editing()) return;
    const v = $('#view'), signed = !!S.user;
    $('#fab').hidden = !signed || S.needsSetup || !S.loaded;
    if (!S.ready) { v.innerHTML = ''; return; }
    if (!signed) { v.innerHTML = vLogin(); document.title = 'Calendar'; return; }
    if (S.needsSetup) { v.innerHTML = vSetup(); return; }
    if (!S.loaded) { v.innerHTML = '<div class="loading"></div>'; return; }
    if (!$('#dial')) {
      v.innerHTML = `<section class="hero${Math.round(S.dial) === 0 ? ' live' : ''}" id="dial"></section>${bar()}<div id="cal"></div>`;
      gridKey = null;
    }
    paintDial();
    renderCal();
  }
  setInterval(() => { if (S.user && !tw) { paintDial(); if (S.view === 'day' || S.view === 'week') renderCal(); } }, 60000);

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
  function openEditor(row, preset) {
    const r = row || {
      kind: 'event', title: '', category: 'personal', day: S.cursor, place: '', notes: '',
      start_time: toTime(preset?.start ?? (S.cursor === today() ? Math.min(23 * 60, Math.ceil((nowMin() + 1) / 60) * 60) : 9 * 60)),
      end_time: null,
    };
    if (!row && !r.end_time) r.end_time = toTime(Math.min(toMin(r.start_time) + 60, 1439));
    ED = { id: row ? row.id : null, kind: r.kind, cat: r.category || 'personal', orig: row };
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
     the bottom; half a turn of the face is six hours. It stays wherever it's let go. */
  let tw = null, twisted = false;
  const clampDial = m => Math.max(0, Math.min(AHEAD, m));
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
    S.dial = clampDial(tw.start - (tw.turned / Math.PI) * SPAN);
    paintDial();
  });
  const endTwist = () => {
    if (!tw) return;
    if (tw.moved) { S.dial = Math.round(S.dial); paintDial(); twisted = true; setTimeout(() => { twisted = false; }, 80); }
    tw = null;
  };
  window.addEventListener('pointerup', endTwist);
  window.addEventListener('pointercancel', endTwist);
  // a scroll wheel or trackpad over the dial turns it smoothly
  document.addEventListener('wheel', e => {
    if (!e.target.closest('#dial .clock')) return;
    e.preventDefault();
    S.dial = Math.round(clampDial(S.dial + e.deltaY * 0.6));
    paintDial();
  }, { passive: false });

  // no pinch zoom anywhere in the app (iOS Safari ignores the viewport tag's no-zoom, so stop the gestures;
  // app.css also limits touch to scrolling, which rules out double-tap zoom)
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  document.addEventListener('click', e => {
    const t = e.target;
    if (twisted) { e.preventDefault(); return; }
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
      else if (act === 'to-cal') $('#bar').scrollIntoView({ behavior: 'smooth' });
      else if (act === 'close') closeEditor();
      else if (act === 'delete') deleteEditor();
      else if (act === 'signout') { closeEditor(); if (sb) sb.auth.signOut(); }
      return;
    }
    const ev = t.closest('[data-id]');
    if (ev && t.closest('#view')) { const r = byId(ev.dataset.id); if (r) openEditor(r); return; }
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
