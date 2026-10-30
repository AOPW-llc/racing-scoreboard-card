/**
 * Racing Scoreboard Card — live NASCAR Cup Series results, running order and points standings
 * https://github.com/AOPW-llc/racing-scoreboard-card
 *
 * Data: ESPN's public scoreboard, standings and race feeds (CORS-open, no key).
 * One race per screen; the arrows (or a swipe) move through the season's
 * schedule. Times are shown in the browser's time zone.
 */

const VERSION = '1.0.0';
const CARD_TAG = 'racing-scoreboard-card';

const SITE = 'https://site.api.espn.com/apis';
const CORE = 'https://sports.core.api.espn.com/v2/sports/racing/leagues';
const IDLE_REFRESH_S = 300;        // no race on
const STANDINGS_REFRESH_S = 1800;
const LIVE_STATS_MIN_S = 60;       // per-driver laps / led / points are 40 requests: at most once a minute
const FETCH_TIMEOUT_MS = 10000;
const STATS_CONCURRENCY = 10;
const RECENT_RACE_H = 36;          // a race finished this recently is still the one to show
const STANDINGS_BELOW_CUT = 4;     // standings rows shown under the Chase cut line before "Show all"
const CHASE_RACES = 10;            // the Chase is each series' last 10 points races
const DRIVER_REFRESH_S = 600;

// ESPN series slugs: [slug, name, drivers who make the Chase]
const SERIES = [
  ['nascar-premier', 'NASCAR Cup Series', 16],
  ['nascar-secondary', "NASCAR O'Reilly Auto Parts Series", 12],
  ['nascar-truck', 'NASCAR Truck Series', 10],
];
// Non-points races, left out of the race count
const EXHIBITION = /clash|duel|all[\s-]?star|open\b/i;
// Teams ESPN leaves blank in its race entries, by car number (2026). The `teams` option adds to / overrides these.
const TEAM_FALLBACK = {
  'nascar-premier': { 23: '23XI Racing', 35: '23XI Racing', 45: '23XI Racing', 67: '23XI Racing', 41: 'Haas Factory Team' },
};
const NO_TEAM = 'Team not listed';
// Car number colors by manufacturer
const MAKES = { chevrolet: '#c99a1e', ford: '#1d4f91', toyota: '#d71920', ram: '#4a4a4a' };

/* ── helpers ── */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
/** The US Eastern calendar date of an instant, which is how ESPN buckets the scoreboard. */
const etDate = d => { const x = new Date(d.getTime() - 5 * 3600e3); return new Date(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };
const https = url => String(url ?? '').replace(/^http:/, 'https:');
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Run `fn` over `items`, a few at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ── data model ── */

/**
 * The season schedule from a scoreboard response: [{ id, name, short, date, num, total }].
 * `num` counts points races only (the Clash, Duels and All-Star Race have none).
 */
function parseSchedule(league) {
  const name = league?.name ?? '';
  const races = (league?.calendar ?? []).map(c => ({
    id: String(c.event?.$ref ?? '').match(/events\/(\d+)/)?.[1] ?? null,
    name: c.label ?? '',
    // "NASCAR Cup Series at Martinsville" → "Martinsville"
    short: (c.label ?? '').replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+at\\s+`, 'i'), '').replace(/^.*\s+at\s+/i, '') || c.label || '',
    date: new Date(c.startDate),
  })).filter(r => r.id && !isNaN(r.date));
  races.sort((a, b) => a.date - b.date);
  let n = 0;
  races.forEach(r => { r.num = EXHIBITION.test(r.name) ? null : ++n; });
  races.forEach(r => { r.total = n; });
  return races;
}

/** A scoreboard event: status, TV and the field in running / finishing order. */
function parseRace(ev) {
  const comp = ev.competitions?.[ev.competitions.length - 1] ?? {};
  const status = comp.status ?? ev.status ?? {};
  const type = status.type ?? {};
  return {
    id: ev.id,
    name: ev.name ?? '',
    date: new Date(comp.date ?? ev.date),
    state: type.state ?? 'pre',           // pre | in | post
    statusName: type.name ?? '',
    detail: type.shortDetail ?? '',
    lap: Number(status.period) || 0,
    tv: (comp.broadcasts ?? []).flatMap(b => b.names ?? []).join(', '),
    drivers: (comp.competitors ?? []).map(c => ({
      id: c.id,
      name: c.athlete?.displayName ?? '',
      short: c.athlete?.shortName ?? c.athlete?.displayName ?? '',
      flag: c.athlete?.flag?.href ?? '',
      pos: Number(c.order) || null,
      winner: c.winner === true,
    })),
  };
}

/** driverId → { start, number, make, sponsor, team } from the core competition feed. */
function parseEntries(comp) {
  const map = {};
  for (const c of comp?.competitors ?? []) {
    map[c.id] = {
      start: Number(c.startOrder) || null,
      number: c.vehicle?.number ?? '',
      make: c.vehicle?.manufacturer ?? '',
      sponsor: c.vehicle?.sponsor ?? '',
      team: c.vehicle?.team ?? '',
    };
  }
  return map;
}

/** One driver's race numbers from the core statistics feed. */
function parseDriverStats(data) {
  const general = data?.splits?.categories?.find(c => c.name === 'general')?.stats ?? [];
  const n = k => { const v = Number(general.find(s => s.name === k)?.displayValue); return isNaN(v) ? null : v; };
  return { laps: n('lapsCompleted'), led: n('lapsLead'), behind: n('behindLaps'), pts: n('championshipPts'), bonus: n('bonus'), penalty: n('penaltyPts') };
}

/** A driver's bio from the core athlete feed. (Its vehicle list is out of date, so cars come from race entries.) */
function parseBio(a) {
  const dob = a?.dateOfBirth ? new Date(a.dateOfBirth) : null;
  let age = null;
  if (dob && !isNaN(dob)) {
    const now = new Date();
    age = now.getFullYear() - dob.getFullYear() - (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
  }
  return {
    name: a?.displayName ?? '',
    headshot: a?.headshot?.href ?? '',
    age,
    hometown: [a?.birthPlace?.city, a?.birthPlace?.state ?? a?.birthPlace?.country].filter(Boolean).join(', '),
  };
}

/**
 * Season totals from a driver's race-by-race results (points races only):
 * starts, wins, top 5s, top 10s, poles, laps led, average start / finish, lead-lap finishes.
 */
function seasonTotals(results) {
  const pts = results.filter(r => r.num && r.finish);
  const avg = k => { const v = pts.map(r => r[k]).filter(Boolean); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '–'; };
  return {
    starts: pts.length,
    wins: pts.filter(r => r.finish === 1).length,
    top5: pts.filter(r => r.finish <= 5).length,
    top10: pts.filter(r => r.finish <= 10).length,
    poles: pts.filter(r => r.start === 1).length,
    led: pts.reduce((a, r) => a + (r.led || 0), 0),
    avgStart: avg('start'),
    avgFinish: avg('finish'),
    leadLap: pts.filter(r => r.behind === 0).length,
  };
}

/** driverId → season record { wins, top5, top10, led, dnf, starts } from the core standings feed. */
function parseSeasonRecords(data) {
  const map = {};
  for (const e of data?.standings ?? []) {
    const id = String(e.athlete?.$ref ?? '').match(/athletes\/(\d+)/)?.[1];
    const stats = e.records?.find(r => r.type === 'total' || r.name === 'overall')?.stats ?? [];
    const n = k => Number(stats.find(s => s.name === k)?.displayValue) || 0;
    if (id) map[id] = { wins: n('wins'), top5: n('top5'), top10: n('top10'), led: n('lapsLead'), dnf: n('dnf'), starts: n('starts') };
  }
  return map;
}

/** "TRACKHOUSE RACING TEAM" → "Trackhouse Racing Team"; names already in mixed case are kept. */
const tidyTeam = s => (/[a-z]/.test(s) ? s : String(s ?? '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));

/**
 * Unofficial team standings: each driver's season record added up under their
 * current team, ranked by wins, then top 5s, top 10s and laps led.
 * [{ name, drivers: [{ id, name }], wins, top5, top10, led }]
 */
function teamStandings(records, teamOf, names) {
  const teams = new Map();
  for (const [id, r] of Object.entries(records)) {
    const name = teamOf(id) || NO_TEAM;
    const key = name.toLowerCase();
    const t = teams.get(key) ?? { name, drivers: [], wins: 0, top5: 0, top10: 0, led: 0 };
    t.drivers.push({ id, name: names[id] ?? '' });
    t.wins += r.wins; t.top5 += r.top5; t.top10 += r.top10; t.led += r.led;
    teams.set(key, t);
  }
  return [...teams.values()].sort((a, b) => (a.name === NO_TEAM) - (b.name === NO_TEAM)
    || b.wins - a.wins || b.top5 - a.top5 || b.top10 - a.top10 || b.led - a.led);
}

/** Season points: [{ id, name, rank, pts }] in standings order. */
function parseStandings(data) {
  const entries = (data?.children ?? []).flatMap(c => c.standings?.entries ?? []).concat(data?.standings?.entries ?? []);
  return entries.map((e, i) => {
    const stat = n => e.stats?.find(s => s.name === n)?.displayValue;
    return {
      id: e.athlete?.id,
      name: e.athlete?.displayName ?? '',
      rank: Number(stat('rank')) || i + 1,
      pts: Number(stat('championshipPts')) || 0,
    };
  }).sort((a, b) => a.rank - b.rank);
}

/* ═════════════════════════════ Card ═════════════════════════════ */

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .muted { color: var(--secondary-text-color); }

  /* card header */
  .top { display: flex; align-items: center; gap: 8px; padding: 12px 16px 4px; }
  .range { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
  .clock { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .nav { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; padding: 2px 10px;
    font-size: 26px; line-height: 1; border-radius: 8px; font-family: inherit; }
  .nav:disabled { opacity: .3; cursor: default; }
  .nav:hover:not(:disabled), .today:hover { background: var(--secondary-background-color); }
  .today { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 14px; cursor: pointer;
    border: 1px solid var(--primary-color); background: none; color: var(--primary-color); white-space: nowrap; }
  .refresh { background: none; border: none; color: var(--secondary-text-color); cursor: pointer; font-size: 17px; padding: 2px 6px; }
  .wkt { display: flex; flex-direction: column; justify-content: center; min-width: 0; margin-left: 4px; line-height: 1.2; }
  .wkn { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* body: race on the left, points on the right; stacked when narrow */
  .body { container-type: inline-size; padding: 8px 16px 16px; touch-action: pan-y; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 24px; align-items: start; }
  .sec { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  @container (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }

  .rhead { display: flex; flex-direction: column; gap: 3px; padding-bottom: 12px; border-bottom: 1px solid var(--divider-color); }
  .rname { font-size: 20px; font-weight: 700; line-height: 1.2; }
  .rsub { font-size: 13px; color: var(--secondary-text-color); }
  .pill { align-self: flex-start; margin-top: 6px; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 12px;
    background: var(--secondary-background-color); }
  .pill.live { color: #fff; background: var(--error-color, #db4437); }
  .win { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; background: var(--secondary-background-color); }
  .win .flagc { font-size: 26px; line-height: 1; }
  .win .who { font-size: 17px; font-weight: 700; }
  .win .sub { font-size: 12px; color: var(--secondary-text-color); }
  .fav { font-size: 13px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--primary-color); }
  .fav b { font-weight: 700; }
  .empty { text-align: center; padding: 18px 4px; }

  h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color); }
  .fold { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 8px; margin: 0 0 6px; cursor: pointer;
    font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color); }
  .fold .hint { font-weight: 400; letter-spacing: 0; text-transform: none; opacity: .75; }
  .fold.closed { margin: 0; }
  .fold.closed::after { content: ''; flex: 1; border-top: 1px solid var(--divider-color); }
  .fold:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }

  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 4px 4px; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); text-align: right; white-space: nowrap; }
  td { padding: 5px 4px; font-size: 13px; border-top: 1px solid var(--divider-color); text-align: right; white-space: nowrap; }
  th.l, td.l { text-align: left; }
  td.pos { width: 26px; font-weight: 700; }
  td.mv { width: 30px; font-size: 11px; color: var(--secondary-text-color); }
  td.mv.up { color: var(--success-color, #43a047); }
  td.mv.down { color: var(--error-color, #db4437); }
  td.car { width: 34px; text-align: center; }
  .num { display: inline-block; min-width: 26px; padding: 2px 3px; border-radius: 5px; font-size: 12px; font-weight: 800; color: #fff;
    background: var(--mc, var(--secondary-text-color)); font-style: italic; letter-spacing: -.02em; }
  td.drv { white-space: normal; max-width: 0; width: 100%; }
  td.drv .n { font-weight: 600; }
  td.drv .t { display: block; font-size: 11px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.drv img { width: 14px; height: 10px; object-fit: cover; margin-left: 5px; vertical-align: 0; border-radius: 1px; }
  td.pts { font-weight: 700; }
  tr[data-driver] { cursor: pointer; }
  tr[data-driver]:hover td { background: var(--secondary-background-color); }

  /* driver page */
  .back { font: inherit; font-size: 15px; background: none; border: none; color: var(--primary-color); cursor: pointer; padding: 6px 8px; border-radius: 8px; }
  .back:hover { background: var(--secondary-background-color); }
  .dv { display: flex; flex-direction: column; gap: 18px; }
  .dv-head { display: flex; align-items: center; gap: 14px; padding-bottom: 12px; border-bottom: 4px solid var(--mc, var(--divider-color)); }
  .dv-head img { width: 76px; height: 76px; object-fit: cover; object-position: top; border-radius: 50%; background: var(--secondary-background-color); flex: none; }
  .dv-name { font-size: 22px; font-weight: 700; line-height: 1.2; }
  .dv-sub { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
  .dv-sub .num { margin-right: 6px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .tile { padding: 10px 8px; border-radius: 12px; background: var(--secondary-background-color); text-align: center; }
  .tile .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile .k { font-size: 11px; color: var(--secondary-text-color); margin-top: 3px; }
  .tile.hi .v { color: var(--primary-color); }
  .note { font-size: 11px; color: var(--secondary-text-color); }
  tr[data-race] { cursor: pointer; }
  td.fin { font-weight: 700; }
  td.fin.w { color: var(--primary-color); }
  tr.me td { background: var(--secondary-background-color); }
  tr.me td.drv .n { color: var(--primary-color); }
  /* Chase cut line: ----- Next Cutoff: Richmond ----- */
  tr.cut td { padding: 6px 0; border-top: none; }
  .cutline { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; }
  .cutline::before, .cutline::after { content: ''; flex: 1; border-top: 2px solid #f4c430; }
  tr.cut + tr td { border-top: none; }
  .tabs { display: inline-flex; gap: 2px; padding: 2px; margin-bottom: 8px; border-radius: 10px; background: var(--secondary-background-color); }
  .tabs button { all: unset; cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 8px; color: var(--secondary-text-color); }
  .tabs button.on { background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color); box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .tabs button:focus-visible { outline: 2px solid var(--primary-color); }
  td.drv .ds { display: block; font-size: 11px; color: var(--secondary-text-color); white-space: normal; }
  .more { all: unset; cursor: pointer; font-size: 12px; color: var(--primary-color); padding: 6px 0 0; }
  .err { color: var(--error-color, #db4437); font-size: 13px; text-align: center; padding: 0 16px 8px; }
  .foot { font-size: 11px; color: var(--secondary-text-color); padding: 0 16px 12px; }
  @container (max-width: 420px) {
    .body { padding: 8px 12px 12px; }
    td.drv .t { display: none; }
    .hide-narrow { display: none; }
  }
`;

const VIEW_KEY = 'racing-scoreboard-card:view';
const FOLD_KEY = 'racing-scoreboard-card:folded';
const TAB_KEY = 'racing-scoreboard-card:standings';

class RacingScoreboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._schedule = [];                  // the season's races
    this._idx = -1;                       // race on screen
    this._home = -1;                      // the race "Today" goes back to
    this._races = new Map();              // raceId → { race, entries, stats, statsAt, venue }
    this._venues = new Map();             // venue $ref → "Martinsville Speedway · Ridgeway, VA"
    this._standings = null;
    this._standingsAt = 0;
    this._drivers = new Map();            // driverId → { bio, results, at } or { error }
    this._records = null;                 // driverId → season record (core standings)
    this._teamEntries = {};               // driverId → { number, team } from the latest race
    try { this._tab = localStorage.getItem(TAB_KEY) === 'teams' ? 'teams' : 'drivers'; } catch { this._tab = 'drivers'; }
    this._driverView = null;              // driver page open, if any
    this._todayKey = dayKey(new Date());
    this._error = null;
    this._loading = true;
    try { this._folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY)) || []); } catch { this._folded = new Set(); }
    try {
      const v = JSON.parse(sessionStorage.getItem(VIEW_KEY));
      if (v?.day === this._todayKey && v.id) { this._restore = v; this._driverView = v.driver ?? null; }
    } catch { /* start at the current race */ }
  }

  setConfig(config) {
    const series = this._config?.series;
    this._config = { series: 'nascar-premier', refresh_interval: 30, show_standings: true, ...config };
    this._config.driver = String(this._config.driver ?? '').trim().toLowerCase();
    if (series && series !== this._config.series) {
      this._schedule = []; this._idx = -1; this._races.clear(); this._standings = null; this._standingsAt = 0; this._restore = null;
      this._drivers.clear(); this._driverView = null; this._records = null; this._teamEntries = {};
    }
    if (this.isConnected) this._refresh();
    this._render();
  }

  set hass(hass) { this._hass = hass; }

  connectedCallback() {
    this._tickClock();
    this._refresh();
  }

  disconnectedCallback() {
    clearTimeout(this._clockTimer);
    clearTimeout(this._timer);
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 'auto', min_columns: 6 }; }

  static getConfigForm() {
    return {
      schema: [
        { name: 'series', selector: { select: { mode: 'dropdown', options: SERIES.map(([v, l]) => ({ value: v, label: l })) } } },
        { name: 'driver', selector: { text: {} } },
        { name: 'show_standings', selector: { boolean: {} } },
        { name: 'teams', selector: { object: {} } },
        { name: 'refresh_interval', selector: { number: { min: 10, max: 300, step: 5, mode: 'box', unit_of_measurement: 's' } } },
      ],
      computeLabel: s => ({ series: 'Series', driver: 'Favorite driver', show_standings: 'Show standings', teams: 'Team fixes', refresh_interval: 'Refresh during a race' }[s.name]),
      computeHelper: s => ({
        driver: 'Name or car number, e.g. Kyle Larson or 5. Highlighted in results and standings',
        teams: 'Car number → team, for cars ESPN lists without a team, e.g. "44": NY Racing Team',
      }[s.name]),
    };
  }

  static getStubConfig() { return { series: 'nascar-premier' }; }

  get _series() { return encodeURIComponent(this._config?.series || 'nascar-premier'); }
  get _seriesName() { return SERIES.find(([v]) => v === this._config?.series)?.[1] ?? this._leagueName ?? ''; }
  get _chaseSize() { return SERIES.find(([v]) => v === this._config?.series)?.[2] ?? 0; }

  /** The race that sets the Chase field: the last regular-season points race. */
  get _cutoffRace() {
    const total = this._schedule.find(r => r.num)?.total ?? 0;
    return total > CHASE_RACES ? this._schedule.find(r => r.num === total - CHASE_RACES) ?? null : null;
  }

  _tickClock() {
    clearTimeout(this._clockTimer);
    const now = new Date();
    const el = this.shadowRoot.getElementById('clock');
    if (el) el.textContent = fmtTime(now);
    this._todayKey = dayKey(now);
    this._clockTimer = setTimeout(() => this._tickClock(), 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  /* ── data ── */

  /** The race to open on: one that's on or just finished, else the next one, else the last. */
  _pickHome() {
    const now = Date.now();
    const s = this._schedule;
    const last = [...s].reverse().findIndex(r => r.date <= now);
    const lastIdx = last < 0 ? -1 : s.length - 1 - last;
    if (lastIdx >= 0 && now - s[lastIdx].date < RECENT_RACE_H * 3600e3) return lastIdx;
    const next = s.findIndex(r => r.date > now);
    return next >= 0 ? next : s.length - 1;
  }

  async _refresh() {
    clearTimeout(this._timer);
    const series = this._config?.series;
    if (!series) return;
    try {
      if (!this._schedule.length) {
        const j = await getJSON(`${SITE}/site/v2/sports/racing/${this._series}/scoreboard`);
        if (series !== this._config.series) return;
        this._leagueName = j.leagues?.[0]?.name ?? '';
        this._schedule = parseSchedule(j.leagues?.[0]);
        this._home = this._pickHome();
        const saved = this._restore && this._restore.series === series ? this._schedule.findIndex(r => r.id === this._restore.id) : -1;
        this._restore = null;
        this._idx = saved >= 0 ? saved : this._home;
      }
      const r = this._schedule[this._idx];
      const standingsDue = this._config.show_standings && Date.now() - this._standingsAt > STANDINGS_REFRESH_S * 1000;
      await Promise.all([
        r ? this._loadRace(r) : null,
        standingsDue ? getJSON(`${SITE}/v2/sports/racing/${this._series}/standings`).then(d => {
          if (series === this._config.series) { this._standings = parseStandings(d); this._standingsAt = Date.now(); }
        }).catch(() => {}) : null,
        standingsDue ? this._loadTeams().catch(() => {}) : null,
      ]);
      if (this._driverView && !this._drivers.has(this._driverView)) this._loadDriver(this._driverView); // restored page
      this._error = null;
      this._updated = new Date();
    } catch (e) {
      this._error = `Couldn't load the race (${e.message}). Retrying…`;
    }
    if (series !== this._config.series) return;
    this._loading = false;
    this._render();
    this._scheduleNext();
  }

  /** Everything about one race: scoreboard (status, order, names), entries (cars), venue and, once it's started, each driver's numbers. */
  async _loadRace(r) {
    const have = this._races.get(r.id);
    if (have?.race?.state === 'post' && have.statsDone) return; // a finished race doesn't change
    // ESPN buckets the scoreboard by Eastern date; a night race can land on the day before
    const day = etDate(r.date);
    let race = null;
    for (const d of [day, new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1), new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)]) {
      const j = await getJSON(`${SITE}/site/v2/sports/racing/${this._series}/scoreboard?dates=${ymd(d)}`);
      const ev = (j.events ?? []).find(e => e.id === r.id);
      if (ev) { race = parseRace(ev); break; }
    }
    if (!race) throw new Error('race not found');
    const base = `${CORE}/${this._series}/events/${r.id}`;
    const [comp, event] = await Promise.all([
      getJSON(`${base}/competitions/${r.id}`).catch(() => null),
      have?.venue != null ? null : getJSON(base).catch(() => null),
    ]);
    const entry = { ...(have ?? {}), race, entries: comp ? parseEntries(comp) : have?.entries ?? {} };
    if (event) {
      const ref = https(event.venues?.[0]?.$ref);
      if (ref && !this._venues.has(ref)) {
        try {
          const v = await getJSON(ref);
          const where = [v.address?.city, v.address?.state].filter(Boolean).join(', ');
          this._venues.set(ref, [v.fullName, where].filter(Boolean).join(' · '));
        } catch { this._venues.set(ref, ''); }
      }
      entry.venue = this._venues.get(ref) ?? '';
    }
    // Laps, laps led and points: one request per driver, so at most once a minute during the race
    const statsDue = race.state !== 'pre' && race.drivers.length
      && (!have?.statsAt || Date.now() - have.statsAt > Math.max(LIVE_STATS_MIN_S, Number(this._config.refresh_interval) || 30) * 1000 || (race.state === 'post' && !have.statsDone));
    if (statsDue) {
      const list = await pool(race.drivers, STATS_CONCURRENCY, d =>
        getJSON(`${base}/competitions/${r.id}/competitors/${d.id}/statistics`).then(parseDriverStats).catch(() => null));
      entry.stats = Object.fromEntries(race.drivers.map((d, i) => [d.id, list[i]]));
      entry.statsAt = Date.now();
      entry.statsDone = race.state === 'post' && list.every(Boolean);
    }
    this._races.set(r.id, entry);
  }

  /** Season records for every driver, and each driver's car and team from the latest finished race. */
  async _loadTeams() {
    const series = this._config.series;
    const year = (this._schedule[this._idx]?.date ?? new Date()).getFullYear();
    const last = [...this._schedule].reverse().find(r => r.date < Date.now() - 6 * 3600e3);
    const [st, comp] = await Promise.all([
      getJSON(`${CORE}/${this._series}/seasons/${year}/types/2/standings/0`),
      last ? getJSON(`${CORE}/${this._series}/events/${last.id}/competitions/${last.id}`).catch(() => null) : null,
    ]);
    if (series !== this._config.series) return;
    const records = parseSeasonRecords(st);
    const entries = comp ? parseEntries(comp) : {};
    // Part-timers who weren't in that race: their car and team from the last race they ran (two requests each)
    const missing = Object.keys(records).filter(id => !entries[id]);
    await pool(missing, STATS_CONCURRENCY, async id => {
      try {
        const log = await getJSON(`${CORE}/${this._series}/seasons/${year}/athletes/${id}/eventlog?limit=100`);
        const ran = (log.events?.items ?? []).filter(x => x.played);
        const ev = ran[ran.length - 1]?.eventId;
        if (!ev) return;
        const c = await getJSON(`${CORE}/${this._series}/events/${ev}/competitions/${ev}/competitors/${id}`);
        if (c?.vehicle) entries[id] = { number: c.vehicle.number ?? '', make: c.vehicle.manufacturer ?? '', team: c.vehicle.team ?? '', sponsor: c.vehicle.sponsor ?? '' };
      } catch { /* stays unlisted */ }
    });
    if (series !== this._config.series) return;
    this._records = records;
    this._teamEntries = entries;
  }

  /** A driver's team: ESPN's latest entry, then the built-in / configured fixes by car number, then any race on screen. */
  _teamOf(id) {
    const en = this._teamEntries[id] ?? this._carOf(id);
    const num = en?.number;
    const fix = num != null ? (this._config.teams?.[num] ?? TEAM_FALLBACK[this._config.series]?.[num]) : null;
    return tidyTeam(fix || en?.team || this._carOf(id)?.team || '');
  }

  /** A driver's bio and this season's race-by-race results (one request per race they ran). */
  async _openDriver(id) {
    this._driverView = id;
    this._render();
    this.shadowRoot.querySelector('ha-card')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    await this._loadDriver(id);
  }

  async _loadDriver(id) {
    const have = this._drivers.get(id);
    if (have && !have.error && Date.now() - have.at < DRIVER_REFRESH_S * 1000) return;
    const series = this._config.series;
    try {
      const year = (this._schedule[this._idx]?.date ?? new Date()).getFullYear();
      const lg = `${CORE}/${this._series}`;
      const [athlete, log] = await Promise.all([
        getJSON(`${CORE.replace(/\/leagues$/, '')}/athletes/${encodeURIComponent(id)}`).catch(() => null),
        getJSON(`${lg}/seasons/${year}/athletes/${encodeURIComponent(id)}/eventlog?limit=100`),
      ]);
      const races = new Map(this._schedule.map(r => [r.id, r]));
      const played = (log.events?.items ?? []).filter(x => x.played && races.has(String(x.eventId)));
      const results = await pool(played, STATS_CONCURRENCY, async x => {
        const r = races.get(String(x.eventId));
        const st = await getJSON(https(x.statistics?.$ref)).catch(() => null);
        const general = st?.splits?.categories?.find(c => c.name === 'general')?.stats ?? [];
        const n = k => { const v = Number(general.find(s => s.name === k)?.displayValue); return isNaN(v) ? null : v; };
        return { id: r.id, short: r.short, num: r.num, date: r.date, start: n('pole'), finish: n('place'), led: n('lapsLead'), behind: n('behindLaps'), pts: n('championshipPts') };
      });
      const done = results.filter(x => x.finish).sort((a, b) => b.date - a.date);
      // Car, make and team from their latest race
      let car = null;
      if (done[0]) {
        const c = await getJSON(`${lg}/events/${done[0].id}/competitions/${done[0].id}/competitors/${encodeURIComponent(id)}`).catch(() => null);
        if (c?.vehicle) car = { number: c.vehicle.number ?? '', make: c.vehicle.manufacturer ?? '', team: c.vehicle.team ?? '', sponsor: c.vehicle.sponsor ?? '', date: done[0].date };
      }
      if (series !== this._config.series) return;
      this._drivers.set(id, { bio: parseBio(athlete), results: done, car, at: Date.now() });
    } catch (e) {
      this._drivers.set(id, { error: `Couldn't load this driver (${e.message}).`, at: Date.now() });
    }
    if (this._driverView === id) this._render();
  }

  _scheduleNext() {
    const r = this._schedule[this._idx];
    const e = r && this._races.get(r.id);
    const soon = r && r.date - Date.now() < 15 * 60000 && Date.now() - r.date < 6 * 3600e3;
    const live = e?.race?.state === 'in' || (e?.race?.state === 'pre' && soon);
    const s = this._error ? 30 : live ? Math.max(10, Number(this._config.refresh_interval) || 30) : IDLE_REFRESH_S;
    this._timer = setTimeout(() => this._refresh(), s * 1000);
  }

  _go(i, dir) {
    if (i < 0 || i >= this._schedule.length || i === this._idx) return;
    this._idx = i;
    this._loading = !this._races.has(this._schedule[i].id);
    this._showAll = false;
    this._slideDir = dir;
    this._render();
    this._refresh();
  }

  /* ── render ── */

  _isFav(d, entry) {
    const f = this._config?.driver;
    if (!f) return false;
    return [d.name, d.short].some(x => String(x ?? '').toLowerCase() === f) || (entry?.number && entry.number.toLowerCase() === f.replace(/^#/, ''));
  }

  _render() {
    if (!this._config) return;
    const r = this._schedule[this._idx];
    const e = r && this._races.get(r.id);
    const title = r ? r.short : this._seriesName;
    const sub = r ? [r.num ? `Race ${r.num} of ${r.total}` : 'Non-points race', this._seriesName].filter(Boolean).join(' · ') : '';
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>
      <div class="top">
        <div class="range">${this._driverView ? '<button class="back" id="back">‹ Back</button>' : `
          <button class="nav" id="left" aria-label="Previous race" title="Previous race"${this._idx <= 0 ? ' disabled' : ''}>‹</button>
          <button class="nav" id="right" aria-label="Next race" title="Next race"${this._idx < 0 || this._idx >= this._schedule.length - 1 ? ' disabled' : ''}>›</button>
          <div class="wkt"><span class="wkn">${esc(title)}</span><span class="wk">${esc(sub)}</span></div>
          ${this._home >= 0 && this._idx !== this._home ? '<button class="today" id="today">Current race</button>' : ''}`}
        </div>
        <div class="clock" id="clock">${fmtTime(new Date())}</div>
        <button class="refresh" id="refresh" title="Refresh now">↻</button>
      </div>
      ${this._error ? `<div class="err">${esc(this._error)}</div>` : ''}
      <div class="body">${this._driverView ? this._driverHTML(this._driverView) : `<div class="grid">
        <div class="sec">${r ? this._raceHTML(r, e) : `<div class="empty muted">${this._loading ? 'Loading schedule…' : 'No races found.'}</div>`}</div>
        ${this._config.show_standings ? `<div class="sec">${this._standingsHTML(e)}</div>` : ''}
      </div>`}</div>
      ${this._updated ? `<div class="foot">Updated ${fmtTime(this._updated)}</div>` : ''}
    </ha-card>`;
    this._bind();
    this._animate();
    this._saveView();
  }

  _saveView() {
    const r = this._schedule[this._idx];
    if (!r) return;
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ day: this._todayKey, series: this._config.series, id: r.id, driver: this._driverView })); } catch { /* not remembered */ }
  }

  /** Slide the new race in from the side it came from. */
  _animate() {
    const dir = this._slideDir;
    this._slideDir = 0;
    const el = this.shadowRoot.querySelector('.grid');
    if (!dir || !el?.animate || reduceMotion()) return;
    el.animate([{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'ease-out' });
  }

  _raceHTML(r, e) {
    const race = e?.race;
    const date = race?.date ?? r.date;
    let pill = '';
    if (race?.state === 'in') pill = `<span class="pill live">LIVE${race.lap ? ` · Lap ${race.lap}` : ''}</span>`;
    else if (race?.state === 'post') pill = `<span class="pill">${esc(race.detail || 'Final')}${race.lap ? ` · ${race.lap} laps` : ''}</span>`;
    else if (race && /postponed|delayed|canceled|cancelled/i.test(race.statusName)) pill = `<span class="pill">${esc(race.detail)}</span>`;
    let html = `<div class="rhead">
      <div class="rname">${esc(race?.name || r.name)}</div>
      ${e?.venue ? `<div class="rsub">${esc(e.venue)}</div>` : ''}
      <div class="rsub">${esc(fmtDay(date))} · ${esc(fmtTime(date))}${race?.tv ? ` · ${esc(race.tv)}` : ''}</div>
      ${pill}
    </div>`;
    if (!e) return html + `<div class="empty muted">${this._loading ? 'Loading race…' : ''}</div>`;

    const ent = e.entries ?? {};
    const stats = e.stats ?? {};
    const started = race.state !== 'pre';
    // Before the green flag: the starting lineup (by start position), once it's out
    const rows = race.drivers.map(d => ({ d, en: ent[d.id] ?? {}, st: stats[d.id] ?? null }))
      .sort((a, b) => (started ? (a.d.pos ?? 99) - (b.d.pos ?? 99) : (a.en.start ?? 99) - (b.en.start ?? 99)));

    const win = race.state === 'post' && rows.find(x => x.d.winner);
    if (win) {
      html += `<div class="win"><span class="flagc">🏁</span><div><div class="who">${esc(win.d.name)}</div>
        <div class="sub">${[win.en.number && `#${win.en.number}`, win.en.team, win.en.make].filter(Boolean).map(esc).join(' · ')}${win.st?.led ? ` · led ${win.st.led} laps` : ''}</div></div></div>`;
    }
    const fav = rows.find(x => this._isFav(x.d, x.en));
    if (fav) {
      const parts = started
        ? [`${race.state === 'post' ? 'finished' : 'running'} <b>${fav.d.pos ? ordinal(fav.d.pos) : '–'}</b>`, fav.en.start && `started ${ordinal(fav.en.start)}`,
          fav.st?.led && `led ${fav.st.led}`, fav.st?.pts != null && race.state === 'post' && `${fav.st.pts} pts`]
        : [fav.en.start ? `starts <b>${ordinal(fav.en.start)}</b>` : 'entered'];
      html += `<div class="fav">★ <b>${esc(fav.d.name)}</b> ${parts.filter(Boolean).join(' · ')}</div>`;
    }

    if (!rows.length) return html + `<div class="empty muted">The entry list and starting lineup aren't out yet.</div>`;
    const lineup = !started;
    const hasStats = started && Object.values(stats).some(Boolean);
    const body = rows.map(({ d, en, st }) => {
      const pos = lineup ? en.start : d.pos;
      const moved = !lineup && en.start && d.pos ? en.start - d.pos : 0;
      const mv = lineup || !en.start ? '<td class="mv"></td>' : `<td class="mv${moved > 0 ? ' up' : moved < 0 ? ' down' : ''}" title="Started ${ordinal(en.start)}">${moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '–'}</td>`;
      const color = MAKES[String(en.make).toLowerCase()] ?? '';
      const team = [en.team, en.sponsor].filter(Boolean).join(' · ');
      const behind = st?.behind > 0 ? `-${st.behind} ${st.behind === 1 ? 'lap' : 'laps'}` : '';
      return `<tr class="${this._isFav(d, en) ? 'me' : ''}" data-driver="${esc(d.id)}" title="${esc(d.name)}: season stats">
        <td class="pos">${pos ?? ''}</td>${mv}
        <td class="car">${en.number ? `<span class="num" style="--mc:${esc(color)}" title="${esc(en.make)}">${esc(en.number)}</span>` : ''}</td>
        <td class="l drv"><span class="n">${esc(d.name)}</span>${d.flag && !/usa\.png$/.test(d.flag) ? `<img src="${esc(d.flag)}" alt="" loading="lazy">` : ''}${team ? `<span class="t">${esc(team)}</span>` : ''}</td>
        ${hasStats ? `<td class="hide-narrow">${st?.laps ?? ''}${behind ? `<span class="muted"> (${behind})</span>` : ''}</td><td>${st?.led || ''}</td><td class="pts">${race.state === 'post' ? st?.pts ?? '' : ''}</td>` : ''}
      </tr>`;
    }).join('');
    const head = `<tr><th class="l">${lineup ? 'Start' : 'Pos'}</th><th></th><th></th><th class="l">Driver</th>${hasStats ? `<th class="hide-narrow">Laps</th><th>Led</th><th>${race.state === 'post' ? 'Pts' : ''}</th>` : ''}</tr>`;
    const label = lineup ? 'Starting lineup' : race.state === 'in' ? 'Running order' : 'Results';
    return html + this._foldHTML('results', label, `<table>${head}${body}</table>`);
  }

  _standingsHTML(e) {
    if (!this._standings?.length) return `<div class="empty muted">${this._loading || this._config.show_standings && !this._standingsAt ? 'Loading standings…' : 'No standings yet.'}</div>`;
    const lead = this._standings[0].pts;
    const ent = e?.entries ?? {};
    const raceDrivers = new Map((e?.race?.drivers ?? []).map(d => [d.id, d]));
    // The Chase cut line sits under the last driver in. Before the cutoff race it's "Next Cutoff: <race>";
    // once the field is set (no eliminations in the Chase), it marks the Chase field.
    const cut = this._chaseSize;
    const cutRace = this._cutoffRace;
    const shown = (cut || 16) + STANDINGS_BELOW_CUT;
    const cutLabel = !cutRace ? 'Chase cut line'
      : cutRace.date > Date.now() - 6 * 3600e3 ? `Next Cutoff: ${cutRace.short}` : `Chase field · set at ${cutRace.short}`;
    const list = this._showAll ? this._standings : this._standings.filter((s, i) => i < shown || this._isFav(s, ent[s.id]));
    const rows = list.map((s, i) => {
      const d = raceDrivers.get(s.id) ?? s;
      const line = cut && s.rank > cut && (i === 0 || list[i - 1].rank <= cut)
        ? `<tr class="cut"><td colspan="4"><div class="cutline">${esc(cutLabel)}</div></td></tr>` : '';
      return `${line}<tr class="${this._isFav(d, ent[s.id]) ? 'me' : ''}" data-driver="${esc(s.id)}" title="${esc(s.name)}: season stats"><td class="pos">${s.rank}</td>
        <td class="l drv"><span class="n">${esc(s.name)}</span></td><td class="pts">${s.pts}</td><td class="mv">${s.pts === lead ? '' : `−${lead - s.pts}`}</td></tr>`;
    }).join('');
    const more = this._standings.length > shown
      ? `<button class="more" id="more">${this._showAll ? 'Show fewer' : `Show all ${this._standings.length}`}</button>` : '';
    const tabs = `<div class="tabs" role="tablist"><button role="tab" data-tab="drivers" class="${this._tab === 'drivers' ? 'on' : ''}" aria-selected="${this._tab === 'drivers'}">Drivers</button><button role="tab" data-tab="teams" class="${this._tab === 'teams' ? 'on' : ''}" aria-selected="${this._tab === 'teams'}">Teams</button></div>`;
    const body = this._tab === 'teams' ? this._teamsHTML(ent)
      : `<table><tr><th class="l"></th><th class="l">Driver</th><th>Pts</th><th>Gap</th></tr>${rows}</table>${more}`;
    return this._foldHTML('standings', 'Standings', tabs + body);
  }

  _teamsHTML(ent) {
    if (!this._records) return '<div class="empty muted">Loading teams…</div>';
    const names = Object.fromEntries((this._standings ?? []).map(s => [s.id, s.name]));
    const teams = teamStandings(this._records, id => this._teamOf(id), names);
    let place = 0;
    const rows = teams.map(t => {
      const listed = t.name !== NO_TEAM;
      if (listed) place++;
      const fav = t.drivers.some(d => this._isFav(d, this._teamEntries[d.id]));
      const drivers = t.drivers.map(d => d.name.replace(/^(\S)\S*\s+/, '$1. ')).filter(Boolean).join(', ');
      return `<tr class="${fav ? 'me' : ''}"><td class="pos">${listed ? place : ''}</td>
        <td class="l drv"><span class="n">${esc(t.name)}</span><span class="ds">${esc(drivers)}</span></td>
        <td class="pts">${t.wins}</td><td>${t.top5}</td><td>${t.top10}</td><td class="hide-narrow">${t.led}</td></tr>`;
    }).join('');
    return `<table><tr><th class="l"></th><th class="l">Team</th><th>Wins</th><th>Top 5</th><th>Top 10</th><th class="hide-narrow">Led</th></tr>${rows}</table>
      <div class="note" style="margin-top:6px">Unofficial: drivers' season results added up by their current team, ranked by wins, then top 5s, top 10s and laps led. ESPN doesn't publish owner points.</div>`;
  }

  /** The latest car, make and team a driver has raced with, from the races loaded so far. */
  _carOf(id) {
    let best = null;
    for (const { race, entries } of this._races.values()) {
      const en = entries?.[id];
      if (en?.number && (!best || race.date > best.date)) best = { ...en, date: race.date };
    }
    return best;
  }

  _driverHTML(id) {
    const dv = this._drivers.get(id);
    const st = this._standings?.find(s => s.id === id);
    const raceName = [...this._races.values()].flatMap(x => x.race?.drivers ?? []).find(d => d.id === id)?.name;
    const name = dv?.bio?.name || st?.name || raceName || '';
    const known = this._carOf(id);
    const car0 = !dv?.car || (known && known.date > dv.car.date) ? known ?? dv?.car : dv.car;
    const car = car0 && { ...car0, team: this._teamOf(id) || car0.team };
    const color = MAKES[String(car?.make).toLowerCase()] ?? '';
    const cut = this._chaseSize;
    const sub = [
      car && [car.team, car.make].filter(Boolean).join(' · '),
      dv?.bio?.age != null && `Age ${dv.bio.age}`,
      dv?.bio?.hometown,
    ].filter(Boolean).map(esc).join(' · ');
    const standing = st ? `${ordinal(st.rank)} in points · ${st.pts} pts${cut ? (st.rank <= cut ? ' · in the Chase' : ' · outside the Chase') : ''}` : '';
    let html = `<div class="dv"><div class="dv-head" style="--mc:${esc(color)}">
      ${dv?.bio?.headshot ? `<img src="${esc(dv.bio.headshot)}" alt="">` : ''}
      <div><div class="dv-name">${esc(name)}</div>
        <div class="dv-sub">${car?.number ? `<span class="num" style="--mc:${esc(color)}">${esc(car.number)}</span>` : ''}${sub}</div>
        ${standing ? `<div class="dv-sub">${esc(standing)}</div>` : ''}</div>
    </div>`;
    if (!dv || (!dv.results && !dv.error)) return html + '<div class="empty muted">Loading season stats…</div></div>';
    if (dv.error) return html + `<div class="err">${esc(dv.error)}</div></div>`;

    const year = (this._schedule[this._idx]?.date ?? new Date()).getFullYear();
    const t = seasonTotals(dv.results);
    const tile = (v, k, hi) => `<div class="tile${hi ? ' hi' : ''}"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
    html += `<div><h4>${year} season · points races</h4><div class="tiles">
      ${tile(t.wins, t.wins === 1 ? 'Win' : 'Wins', t.wins > 0)}${tile(t.top5, 'Top 5')}${tile(t.top10, 'Top 10')}${tile(t.poles, t.poles === 1 ? 'Pole' : 'Poles')}
      ${tile(t.led, 'Laps led')}${tile(t.avgStart, 'Avg start')}${tile(t.avgFinish, 'Avg finish')}${tile(t.leadLap, 'Lead-lap finishes')}
      ${tile(t.starts, 'Starts')}${this._records?.[id] ? tile(this._records[id].dnf, this._records[id].dnf === 1 ? 'DNF' : 'DNFs') : ''}${st ? tile(st.pts, 'Points') : ''}
    </div></div>`;
    const rows = dv.results.map(x => `<tr data-race="${esc(x.id)}" title="Open this race">
      <td class="l">${esc(x.short)}${x.num ? '' : ' <span class="muted">(non-points)</span>'}</td>
      <td>${x.start ?? ''}</td><td class="fin${x.finish === 1 ? ' w' : ''}">${x.finish ?? ''}</td><td>${x.led || ''}</td><td class="pts">${x.num && x.pts != null ? x.pts : ''}</td></tr>`).join('');
    html += this._foldHTML('driver-results', 'Race results',
      `<table><tr><th class="l">Race</th><th>Start</th><th>Finish</th><th>Led</th><th>Pts</th></tr>${rows}</table>`);
    html += '<div class="note">Career totals and prize money aren\'t available from ESPN.</div>';
    return html + '</div>';
  }

  /** A section whose heading hides / shows it; remembered on this device. */
  _foldHTML(key, title, body) {
    const closed = this._folded.has(key);
    return `<div><button class="fold${closed ? ' closed' : ''}" data-fold="${key}" aria-expanded="${!closed}">
      ${esc(title)} <span class="hint">(tap to ${closed ? 'expand' : 'hide'})</span></button>${closed ? '' : body}</div>`;
  }

  _bind() {
    const $ = id => this.shadowRoot.getElementById(id);
    $('left')?.addEventListener('click', () => this._go(this._idx - 1, -1));
    $('right')?.addEventListener('click', () => this._go(this._idx + 1, 1));
    $('today')?.addEventListener('click', () => this._go(this._home, this._home > this._idx ? 1 : -1));
    $('refresh')?.addEventListener('click', () => {
      if (this._driverView) this._drivers.delete(this._driverView);
      const r = this._schedule[this._idx];
      const e = r && this._races.get(r.id);
      if (e) { e.statsAt = 0; e.statsDone = false; } // reload this race in full
      this._standingsAt = 0;
      this._refresh();
    });
    $('more')?.addEventListener('click', () => { this._showAll = !this._showAll; this._render(); });
    this.shadowRoot.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => {
      this._tab = el.dataset.tab;
      try { localStorage.setItem(TAB_KEY, this._tab); } catch { /* not remembered */ }
      this._render();
    }));
    $('back')?.addEventListener('click', () => { this._driverView = null; this._render(); });
    this.shadowRoot.querySelectorAll('tr[data-driver]').forEach(el => el.addEventListener('click', () => this._openDriver(el.dataset.driver)));
    this.shadowRoot.querySelectorAll('tr[data-race]').forEach(el => el.addEventListener('click', () => {
      const i = this._schedule.findIndex(r => r.id === el.dataset.race);
      this._driverView = null;
      if (i >= 0 && i !== this._idx) this._go(i, i > this._idx ? 1 : -1); else this._render();
    }));
    this.shadowRoot.querySelectorAll('[data-fold]').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.fold;
      if (!this._folded.delete(k)) this._folded.add(k);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...this._folded])); } catch { /* not remembered */ }
      this._render();
    }));
    // Swipe left / right to change race
    const body = this.shadowRoot.querySelector('.body');
    let x0 = null, y0 = null;
    body?.addEventListener('touchstart', ev => { x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; }, { passive: true });
    body?.addEventListener('touchend', ev => {
      if (x0 == null) return;
      const dx = ev.changedTouches[0].clientX - x0, dy = ev.changedTouches[0].clientY - y0;
      x0 = null;
      if (!this._driverView && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) this._go(this._idx + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }, { passive: true });
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, RacingScoreboardCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: 'Racing Scoreboard Card',
  description: 'NASCAR Cup Series results, running order and points standings, one race at a time.',
  preview: true,
  documentationURL: 'https://github.com/AOPW-llc/racing-scoreboard-card',
});

console.info(`%c RACING-SCOREBOARD-CARD %c v${VERSION} `,
  'color:#fff;background:#e4002b;font-weight:bold', 'color:#e4002b;background:#fff');
