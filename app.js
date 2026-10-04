"use strict";

/* ---------- settings ---------- */

const DEFAULTS = {
  skaters: { g: 3, a: 2, ppp: 1, sog: 0.4, hit: 0.4, blk: 0.5, pm: 0.5, pim: 0 },
  goalies: { w: 4, l: 0, otl: 1, sv: 0.2, ga: -2, so: 3 },
};
const LABELS = {
  skaters: { g: "Goal", a: "Assist", ppp: "Power-play point", sog: "Shot on goal", hit: "Hit", blk: "Blocked shot", pm: "Plus/minus", pim: "Penalty minute" },
  goalies: { w: "Win", l: "Loss", otl: "Overtime loss", sv: "Save", ga: "Goal against", so: "Shutout" },
};
const UI_DEFAULTS = {
  skaters: { minGp: 5, hideTop: 120, max: 300, step: 10, heroFloor: 60 },
  goalies: { minGp: 3, hideTop: 20, max: 64, step: 2, heroFloor: 10 },
};
const POS_NAMES = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const PAGE = 50;

const state = {
  mode: "skaters",
  meta: null,
  data: { skaters: [], goalies: [] },
  goaliesMissing: false,
  weights: {
    skaters: { ...DEFAULTS.skaters, ...load("weights", {}) },
    goalies: { ...DEFAULTS.goalies, ...load("gweights", {}) },
  },
  ui: { skaters: { ...UI_DEFAULTS.skaters }, goalies: { ...UI_DEFAULTS.goalies } },
  watch: new Set(load("watch", [])),
  sort: { skaters: { key: "score", dir: -1 }, goalies: { key: "score", dir: -1 } },
  shown: PAGE,
  lastFocus: null,
};

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */

function load(key, fallback) {
  try { const v = localStorage.getItem("utr:" + key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("utr:" + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");
const signed = (n, d = 1) => (Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(d) : "–");
function mmss(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "–";
  let m = Math.floor(minutes), s = Math.round((minutes - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, "0")}`;
}
function svp(v) {
  if (!Number.isFinite(v)) return "–";
  if (v >= 1) return "1.000";
  return "." + String(Math.round(v * 1000)).padStart(3, "0");
}
function seasonLabel(id) {
  const s = String(id);
  return s.length === 8 ? `${s.slice(0, 4)}–${s.slice(6)}` : s;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---------- fantasy points ---------- */

function skaterFP(s, w) {
  return (s.g || 0) * w.g + (s.a || 0) * w.a + (s.ppp || 0) * w.ppp + (s.sog || 0) * w.sog +
    (s.hit || 0) * w.hit + (s.blk || 0) * w.blk + (s.pm || 0) * w.pm + (s.pim || 0) * w.pim;
}
function goalieFP(s, w) {
  return (s.w || 0) * w.w + (s.l || 0) * w.l + (s.otl || 0) * w.otl +
    ((s.sa || 0) - (s.ga || 0)) * w.sv + (s.ga || 0) * w.ga + (s.so || 0) * w.so;
}
function gameDecision(g) { return { w: g.dec === "W" ? 1 : 0, l: g.dec === "L" ? 1 : 0, otl: g.dec === "O" ? 1 : 0 }; }

/* ---------- sleeper score ---------- */

function rankPrior(list, key) {
  [...list].sort((a, b) => (b.prior[key] || 0) - (a.prior[key] || 0))
    .forEach((p, i) => { p._priorRank = (p.prior[key] || 0) > 0 ? i + 1 : Infinity; });
}

function scorePool(list, minGp, features) {
  const pool = list.filter((p) => p.season.gp >= minGp);
  const norms = features.map(([k]) => {
    const vals = pool.map((p) => p[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 1;
    return [mean, sd];
  });
  for (const p of list) p._raw = features.reduce((acc, [k, wt], i) => acc + wt * ((p[k] - norms[i][0]) / norms[i][1]), 0);
  const sorted = pool.map((p) => p._raw).sort((a, b) => a - b);
  for (const p of list) {
    if (!sorted.length || p.season.gp < minGp) { p._score = 0; continue; }
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < p._raw) lo = mid + 1; else hi = mid; }
    p._score = Math.round((100 * lo) / sorted.length);
  }
}

function deriveSkaters() {
  const w = state.weights.skaters, list = state.data.skaters;
  rankPrior(list, "pts");
  for (const p of list) {
    const s = p.season, l = p.l10, gp = s.gp || 0, lgp = l.gp || 0;
    const hitRate = gp ? (s.hit || 0) / gp : 0, blkRate = gp ? (s.blk || 0) / gp : 0;
    p._fpg = gp ? skaterFP(s, w) / gp : 0;
    p._l10fpg = lgp ? (skaterFP({ ...l, hit: 0, blk: 0 }, w) + lgp * (hitRate * w.hit + blkRate * w.blk)) / lgp : 0;
    p._trend = lgp ? p._l10fpg - p._fpg : 0;
    p._toi = gp ? s.toi / gp / 60 : 0;
    p._l10toi = lgp ? l.toi / lgp / 60 : 0;
    p._toiDelta = lgp ? p._l10toi - p._toi : 0;
    p._sogG = gp ? s.sog / gp : 0;
    p._l10sog = lgp ? l.sog / lgp : 0;
    p._shotDelta = lgp ? p._l10sog - p._sogG : 0;
    p._shp = s.sog ? s.g / s.sog : null;
    p._careerShp = p.career.sog >= 50 ? p.career.g / p.career.sog : null;
    p._luck = p._shp !== null && p._careerShp !== null && s.sog >= 15 ? clamp(p._careerShp - p._shp, -0.08, 0.08) : 0;
    p._l10ppp = lgp ? l.ppp / lgp : 0;
  }
  scorePool(list, 5, [["_l10fpg", 1], ["_trend", 0.8], ["_toiDelta", 0.8], ["_l10sog", 0.5], ["_luck", 0.6], ["_l10ppp", 0.4]]);
  for (const p of list) {
    const out = [], enough = p.l10.gp >= 5;
    if (enough && p._trend >= 0.5) out.push(["hot", "Heating up", `${signed(p._trend)} FP/G over his last ${p.l10.gp}`]);
    if (enough && p._toiDelta >= 1.5) out.push(["ice", "More ice time", `${signed(p._toiDelta)} min per night lately`]);
    if (p.l10.ppp >= 3) out.push(["pp", "Power play", `${p.l10.ppp} power-play points in his last ${p.l10.gp}`]);
    if (enough && p._shotDelta >= 0.7) out.push(["shots", "Shooting more", `${fmt(p._l10sog, 1)} shots a game lately vs ${fmt(p._sogG, 1)}`]);
    if (p._luck >= 0.03 && p.season.sog >= 20) out.push(["due", "Due for goals", `shooting ${fmt(p._shp * 100, 1)}% vs ${fmt(p._careerShp * 100, 1)}% career`]);
    p._signals = p.season.gp >= 5 ? out : [];
  }
}

function deriveGoalies() {
  const w = state.weights.goalies, list = state.data.goalies;
  rankPrior(list, "w");
  const firsts = list.map((p) => Date.parse(p.firstDate)).filter(Number.isFinite);
  const lasts = list.map((p) => Date.parse(p.lastDate)).filter(Number.isFinite);
  const first = firsts.length ? Math.min(...firsts) : 0, last = lasts.length ? Math.max(...lasts) : 0;
  const days = Math.max(14, (last - first) / 864e5 + 1);
  const cutoff = last - 13 * 864e5;
  for (const p of list) {
    const s = p.season, l = p.l10, gp = s.gp || 0, lgp = l.gp || 0;
    p._fpg = gp ? goalieFP(s, w) / gp : 0;
    p._l10fpg = lgp ? goalieFP(l, w) / lgp : 0;
    p._trend = lgp ? p._l10fpg - p._fpg : 0;
    p._svp = s.sa ? 1 - s.ga / s.sa : null;
    p._l10svp = l.sa ? 1 - l.ga / l.sa : null;
    p._svTrend = p._svp !== null && p._l10svp !== null && l.sa >= 50 ? p._l10svp - p._svp : 0;
    p._gaa = s.toi ? (s.ga * 3600) / s.toi : null;
    p._recent = (p.startDates || []).filter((d) => Date.parse(d) >= cutoff).length;
    p._workDelta = p._recent - (s.gs / days) * 14;
    p._careerSvp = p.career.sa >= 500 ? 1 - p.career.ga / p.career.sa : null;
    p._luck = p._svp !== null && p._careerSvp !== null && s.sa >= 150 ? clamp(p._careerSvp - p._svp, -0.03, 0.03) : 0;
  }
  scorePool(list, 3, [["_l10fpg", 1], ["_svTrend", 0.8], ["_workDelta", 1], ["_luck", 0.5]]);
  for (const p of list) {
    const out = [];
    if (p.l10.gp >= 4 && p._svTrend >= 0.01) out.push(["hot", "Hot streak", `${svp(p._l10svp)} save percentage over his last ${p.l10.gp} vs ${svp(p._svp)} for the season`]);
    if (p._workDelta >= 1.5 && p._recent >= 3) out.push(["ice", "Taking the crease", `${p._recent} starts in the last two weeks`]);
    if (p.l10.w >= 6) out.push(["pp", "Winning lately", `${p.l10.w} wins in his last ${p.l10.gp}`]);
    if (p._luck >= 0.008) out.push(["due", "Due for saves", `${svp(p._svp)} this season vs ${svp(p._careerSvp)} career`]);
    p._signals = p.season.gp >= 3 ? out : [];
  }
}

function derive() { deriveSkaters(); deriveGoalies(); }

/* ---------- columns ---------- */

const scoreCell = (p) => `<span class="score"><span class="score-bar"><i style="width:${p._score}%"></i></span><b>${p._score}</b></span>`;
const trendCls = (v, t) => (v >= t ? "up" : v <= -t ? "down" : "");
const playerCell = (p) => `${esc(p.name)}${p.nhlSeasons <= 1 ? "<small>Rookie or sophomore</small>" : ""}`;

const COLUMNS = {
  skaters: [
    { key: "name", label: "Player", left: true, cls: "player", cell: playerCell, sort: (p) => p.name.split(" ").slice(-1)[0] },
    { key: "pos", label: "Pos", cell: (p) => esc(POS_NAMES[p.pos] || p.pos), sort: (p) => p.pos },
    { key: "team", label: "Team", cell: (p) => esc(p.team), sort: (p) => p.team },
    { key: "gp", label: "GP", cell: (p) => p.season.gp, sort: (p) => p.season.gp },
    { key: "g", label: "G", cell: (p) => p.season.g, sort: (p) => p.season.g },
    { key: "a", label: "A", cell: (p) => p.season.a, sort: (p) => p.season.a },
    { key: "pts", label: "P", cell: (p) => p.season.pts, sort: (p) => p.season.pts },
    { key: "ppp", label: "PPP", title: "Power-play points", cell: (p) => p.season.ppp, sort: (p) => p.season.ppp },
    { key: "sog", label: "SOG", title: "Shots on goal", cell: (p) => p.season.sog, sort: (p) => p.season.sog },
    { key: "hit", label: "HIT", cell: (p) => p.season.hit, sort: (p) => p.season.hit },
    { key: "blk", label: "BLK", cell: (p) => p.season.blk, sort: (p) => p.season.blk },
    { key: "toi", label: "TOI", title: "Average time on ice", cell: (p) => mmss(p._toi), sort: (p) => p._toi },
    { key: "fpg", label: "FP/G", title: "Fantasy points per game, season", cell: (p) => fmt(p._fpg, 2), sort: (p) => p._fpg },
    { key: "l10fpg", label: "Last 10", title: "Fantasy points per game, last 10 games",
      cell: (p) => (p.l10.gp ? `<span class="${trendCls(p._trend, 0.3)}">${fmt(p._l10fpg, 2)}</span>` : "–"), sort: (p) => p._l10fpg },
    { key: "toiDelta", label: "Ice time Δ", title: "Minutes per game, last 10 vs season",
      cell: (p) => (p.l10.gp ? `<span class="${trendCls(p._toiDelta, 0.5)}">${signed(p._toiDelta)}</span>` : "–"), sort: (p) => p._toiDelta },
    { key: "score", label: "Sleeper score", title: "How strongly the signals point up, 0–100", cell: scoreCell, sort: (p) => p._score },
  ],
  goalies: [
    { key: "name", label: "Player", left: true, cls: "player", cell: playerCell, sort: (p) => p.name.split(" ").slice(-1)[0] },
    { key: "team", label: "Team", cell: (p) => esc(p.team), sort: (p) => p.team },
    { key: "gp", label: "GP", cell: (p) => p.season.gp, sort: (p) => p.season.gp },
    { key: "gs", label: "GS", title: "Games started", cell: (p) => p.season.gs, sort: (p) => p.season.gs },
    { key: "w", label: "W", cell: (p) => p.season.w, sort: (p) => p.season.w },
    { key: "l", label: "L", cell: (p) => p.season.l, sort: (p) => p.season.l },
    { key: "otl", label: "OTL", title: "Overtime and shootout losses", cell: (p) => p.season.otl, sort: (p) => p.season.otl },
    { key: "gaa", label: "GAA", title: "Goals against average", cell: (p) => fmt(p._gaa, 2), sort: (p) => (p._gaa === null ? Infinity : -p._gaa) },
    { key: "svp", label: "SV%", title: "Save percentage", cell: (p) => svp(p._svp), sort: (p) => p._svp ?? -1 },
    { key: "so", label: "SO", title: "Shutouts", cell: (p) => p.season.so, sort: (p) => p.season.so },
    { key: "fpg", label: "FP/G", title: "Fantasy points per game, season", cell: (p) => fmt(p._fpg, 2), sort: (p) => p._fpg },
    { key: "l10fpg", label: "Last 10", title: "Fantasy points per game, last 10 appearances",
      cell: (p) => (p.l10.gp ? `<span class="${trendCls(p._trend, 0.5)}">${fmt(p._l10fpg, 2)}</span>` : "–"), sort: (p) => p._l10fpg },
    { key: "l10svp", label: "Last 10 SV%", cell: (p) => (p.l10.sa ? `<span class="${trendCls(p._svTrend, 0.008)}">${svp(p._l10svp)}</span>` : "–"), sort: (p) => p._l10svp ?? -1 },
    { key: "recent", label: "Starts, 2 wks", title: "Starts in the last 14 days", cell: (p) => p._recent, sort: (p) => p._recent },
    { key: "score", label: "Sleeper score", title: "How strongly the signals point up, 0–100", cell: scoreCell, sort: (p) => p._score },
  ],
};

/* ---------- filtering & sorting ---------- */

function current() { return state.data[state.mode]; }

function filters() {
  return {
    q: $("q").value.trim().toLowerCase(),
    pos: $("pos").value,
    team: $("team").value,
    minGp: Number($("minGp").value) || 0,
    hideTop: Number($("hideTop").value) || 0,
    watchOnly: $("watchOnly").checked,
  };
}

function visible() {
  const f = filters(), goalies = state.mode === "goalies";
  return current().filter((p) => {
    if (f.watchOnly && !state.watch.has(p.id)) return false;
    if (p.season.gp < f.minGp) return false;
    if (f.hideTop && p._priorRank <= f.hideTop && !state.watch.has(p.id)) return false;
    if (!goalies) {
      if (f.pos === "F" && p.pos === "D") return false;
      if (f.pos !== "all" && f.pos !== "F" && p.pos !== f.pos) return false;
    }
    if (f.team !== "all" && p.team !== f.team) return false;
    if (f.q && !(p.name.toLowerCase().includes(f.q) || p.team.toLowerCase().includes(f.q))) return false;
    return true;
  });
}

function sorted(list) {
  const { key, dir } = state.sort[state.mode];
  const col = COLUMNS[state.mode].find((c) => c.key === key) || COLUMNS[state.mode].at(-1);
  return [...list].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x ?? -Infinity) - (y ?? -Infinity)) || b._score - a._score;
  });
}

/* ---------- rendering ---------- */

const sigHTML = (sigs) => (sigs || []).map(([cls, label, why]) => `<span class="sig ${cls}" title="${esc(why)}">${esc(label)}</span>`).join("");

function renderHero() {
  const f = filters(), floor = UI_DEFAULTS[state.mode].heroFloor;
  if (state.mode === "goalies" && state.goaliesMissing) {
    $("hero").innerHTML = `<li class="hero-empty">Goalie stats appear after the next daily update. To get them now, open the Actions tab on GitHub and run "Update stats".</li>`;
    return;
  }
  const minGp = Math.max(UI_DEFAULTS[state.mode].minGp, f.minGp);
  const top = current()
    .filter((p) => p.season.gp >= minGp && p._priorRank > Math.max(f.hideTop, floor) && p._signals.length)
    .sort((a, b) => b._score - a._score).slice(0, 3);

  $("hero").innerHTML = top.length ? top.map((p) => {
    const meta = state.mode === "goalies"
      ? `G, ${esc(p.team)}${p.age ? `, age ${p.age}` : ""}. ${svp(p._l10svp)} save percentage and ${fmt(p._l10fpg, 1)} fantasy points a game over his last ${p.l10.gp}.`
      : `${esc(POS_NAMES[p.pos] || p.pos)}, ${esc(p.team)}${p.age ? `, age ${p.age}` : ""}. ${fmt(p._l10fpg, 1)} fantasy points a game over his last ${p.l10.gp}.`;
    return `<li data-id="${p.id}" tabindex="0">
      <div><p class="hero-name">${esc(p.name)}</p><p class="hero-meta">${meta}</p>${sigHTML(p._signals)}</div>
      <div class="hero-score"><b>${p._score}</b><span>sleeper score</span></div>
      <p class="hero-why">${esc(p._signals.map((s) => s[2]).join("; "))}.</p>
    </li>`;
  }).join("") : `<li class="hero-empty">Not enough games played yet this season to spot risers. Check back after the first week.</li>`;
}

function renderHead() {
  const { key, dir } = state.sort[state.mode];
  $("thead").innerHTML = `<tr><th scope="col" class="star-col"><span class="sr">Watchlist</span></th>${
    COLUMNS[state.mode].map((c) => `<th scope="col" tabindex="0" data-sort="${c.key}" class="${c.left ? "left" : ""}"${c.title ? ` title="${esc(c.title)}"` : ""}${
      c.key === key ? ` aria-sort="${dir < 0 ? "descending" : "ascending"}"` : ""}>${esc(c.label)}</th>`).join("")
  }<th scope="col" class="left">Signals</th></tr>`;
}

function renderTable() {
  renderHead();
  const list = sorted(visible());
  const rows = list.slice(0, state.shown);
  const cols = COLUMNS[state.mode];
  $("rows").innerHTML = rows.map((p) => {
    const starred = state.watch.has(p.id);
    return `<tr data-id="${p.id}">
      <td><button type="button" class="star" data-star="${p.id}" aria-pressed="${starred}" aria-label="${starred ? "Remove from" : "Add to"} watchlist">${starred ? "★" : "☆"}</button></td>
      ${cols.map((c) => `<td class="${[c.left ? "left" : "", c.cls || ""].join(" ").trim()}">${c.cell(p)}</td>`).join("")}
      <td class="left">${sigHTML(p._signals)}</td>
    </tr>`;
  }).join("");

  const noun = state.mode === "goalies" ? "goalies" : "skaters";
  $("count").textContent = list.length
    ? `Showing ${rows.length} of ${list.length} ${noun}.`
    : state.mode === "goalies" && state.goaliesMissing
      ? "Goalie stats appear after the next daily update."
      : `No ${noun} match these filters. Try lowering the minimum games or hiding fewer top players.`;
  $("more").hidden = rows.length >= list.length;
}

function render() { renderHero(); renderTable(); }

function renderWeights() {
  for (const [mode, el] of [["skaters", "weights"], ["goalies", "gweights"]]) {
    $(el).innerHTML = Object.keys(DEFAULTS[mode]).map((k) => `
      <label class="field"><span>${LABELS[mode][k]}</span>
        <input type="number" step="0.1" data-mode="${mode}" data-w="${k}" value="${state.weights[mode][k]}"></label>`).join("");
  }
}

function fillTeams() {
  const teams = [...new Set(current().map((p) => p.team))].sort();
  const chosen = $("team").value;
  $("team").innerHTML = `<option value="all">All teams</option>` + teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  $("team").value = teams.includes(chosen) ? chosen : "all";
}

function setMode(mode) {
  state.ui[state.mode].minGp = Number($("minGp").value) || 0;
  state.ui[state.mode].hideTop = Number($("hideTop").value) || 0;
  state.mode = mode;
  save("mode", mode);
  document.querySelectorAll(".tabs [data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  const ui = state.ui[mode];
  $("minGp").value = ui.minGp;
  $("hideTop").max = UI_DEFAULTS[mode].max;
  $("hideTop").step = UI_DEFAULTS[mode].step;
  $("hideTop").value = ui.hideTop;
  $("hideTopLabel").innerHTML = mode === "goalies"
    ? `Hide last season's top <output id="hideTopOut">${ui.hideTop}</output> goalies by wins`
    : `Hide last season's top <output id="hideTopOut">${ui.hideTop}</output> scorers`;
  $("posField").hidden = mode === "goalies";
  state.shown = PAGE;
  fillTeams();
  render();
}

/* ---------- player detail ---------- */

async function openPlayer(id) {
  const p = current().find((x) => x.id === id);
  if (!p) return;
  state.lastFocus = document.activeElement;
  $("drawerBody").innerHTML = `<p>Loading ${esc(p.name)}…</p>`;
  $("drawer").hidden = false; $("scrim").hidden = false;
  document.body.style.overflow = "hidden";
  $("closeDrawer").focus();

  let detail;
  try { detail = await fetchJSON(`data/players/${id}.json`); }
  catch { $("drawerBody").innerHTML = `<p>Couldn't load details for ${esc(p.name)}. Refresh the page and try again.</p>`; return; }

  const head = `<div class="d-head">
      <img src="https://assets.nhle.com/mugs/nhl/latest/${id}.png" alt="" onerror="this.style.visibility='hidden'">
      <div><h2 id="d-name">${esc(p.name)}</h2>
      <p>${esc(POS_NAMES[p.pos] || p.pos)}, ${esc(p.team)}${p.age ? `, age ${p.age}` : ""}. ${seasonLabel(state.meta.season)} season.</p></div>
    </div>${sigHTML(p._signals)}`;
  $("drawerBody").innerHTML = head + (p.kind === "G" ? goalieDetail(p, detail) : skaterDetail(p, detail));
}

function tiles(list) {
  return `<div class="d-stats">${list.map(([v, label]) => `<div><b>${v}</b><span>${label}</span></div>`).join("")}</div>`;
}

function skaterDetail(p, detail) {
  const s = p.season, n = p.l10.gp || 10, w = state.weights.skaters;
  const hitRate = s.gp ? s.hit / s.gp : 0, blkRate = s.gp ? s.blk / s.gp : 0;
  const fp = detail.games.map((g) => skaterFP({ ...g, hit: 0, blk: 0 }, w) + hitRate * w.hit + blkRate * w.blk);
  return tiles([
    [p._score, "Sleeper score"], [fmt(p._fpg, 2), "FP/G, season"], [p.l10.gp ? fmt(p._l10fpg, 2) : "–", `FP/G, last ${n}`],
    [mmss(p._toi), "TOI, season"], [p.l10.gp ? mmss(p._l10toi) : "–", `TOI, last ${n}`],
    [p._shp === null ? "–" : fmt(p._shp * 100, 1) + "%", "Shooting %"],
    [p._careerShp === null ? "–" : fmt(p._careerShp * 100, 1) + "%", "Career shooting %"], [s.pts, `Points in ${s.gp} games`],
  ]) +
  `<h3>Game by game</h3>${chart(detail.games, fp, detail.games.map((g) => g.toi / 60), 20, "Dashed blue line: ice time.", (g, v, i) => `${fmt(v, 1)} FP, ${mmss(g.toi / 60)} TOI`)}
   <h3>Last 10 games</h3>${table(
     ["Date", "Opp", "G", "A", "+/-", "PPP", "SOG", "PIM", "TOI"], 2,
     detail.games.slice(-10).reverse().map((g) => [esc(g.date), `${g.home ? "" : "@ "}${esc(g.opp)}`, g.g, g.a, signed(g.pm, 0), g.ppp, g.sog, g.pim, mmss(g.toi / 60)]))}
   <h3>Career by season</h3>${table(
     ["Season", "League", "Team", "GP", "G", "A", "P", "+/-", "PPP", "SOG", "TOI"], 3,
     [...detail.career].sort((a, b) => b.season - a.season).map((r) => {
       const nhl = r.league === "NHL";
       return [seasonLabel(r.season), esc(r.league), esc(r.team), r.gp, r.g, r.a, r.pts, nhl ? signed(r.pm, 0) : "–", nhl ? r.ppp : "–", nhl ? r.sog : "–", esc(r.toi || "–")];
     }), "No career history available.")}`;
}

function goalieDetail(p, detail) {
  const s = p.season, n = p.l10.gp || 10, w = state.weights.goalies;
  const fp = detail.games.map((g) => goalieFP({ ...g, ...gameDecision(g) }, w));
  const gsv = (g) => (g.sa ? svp(1 - g.ga / g.sa) : "–");
  const decText = { W: "Win", L: "Loss", O: "OT loss" };
  return tiles([
    [p._score, "Sleeper score"], [fmt(p._fpg, 2), "FP/G, season"], [p.l10.gp ? fmt(p._l10fpg, 2) : "–", `FP/G, last ${n}`],
    [svp(p._svp), "SV%, season"], [svp(p._l10svp), `SV%, last ${n}`], [fmt(p._gaa, 2), "GAA"],
    [svp(p._careerSvp), "Career SV%"], [`${s.w}-${s.l}-${s.otl}`, "Record"],
  ]) +
  `<h3>Game by game</h3>${chart(detail.games, fp, detail.games.map((g) => g.sa), 40, "Dashed blue line: shots faced.", (g, v) => `${fmt(v, 1)} FP, ${g.ga} GA on ${g.sa} shots`)}
   <h3>Last 10 appearances</h3>${table(
     ["Date", "Opp", "Started", "Result", "SA", "GA", "SV%", "TOI"], 2,
     detail.games.slice(-10).reverse().map((g) => [esc(g.date), `${g.home ? "" : "@ "}${esc(g.opp)}`, g.gs ? "Yes" : "No", decText[g.dec] || "–", g.sa, g.ga, gsv(g), mmss(g.toi / 60)]))}
   <h3>Career by season</h3>${table(
     ["Season", "League", "Team", "GP", "W", "L", "OTL", "GAA", "SV%", "SO"], 3,
     [...detail.career].sort((a, b) => b.season - a.season).map((r) => [
       seasonLabel(r.season), esc(r.league), esc(r.team), r.gp, r.w, r.l, r.otl,
       Number.isFinite(r.gaa) ? fmt(r.gaa, 2) : "–", Number.isFinite(r.svp) ? svp(r.svp) : "–", r.so]), "No career history available.")}`;
}

function table(headers, leftCount, rows, emptyText = "") {
  if (!rows.length) return emptyText ? `<p class="fine">${emptyText}</p>` : "";
  const cls = (i) => (i < leftCount ? ' class="left"' : "");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="minor">${r.map((v, i) => `<td${cls(i)}>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function chart(games, fp, second, secondFloor, secondLegend, tip) {
  if (!games.length) return `<p class="fine">No games played yet this season.</p>`;
  const W = 680, H = 200, pad = 28, n = games.length;
  const maxFp = Math.max(4, ...fp), minFp = Math.min(0, ...fp);
  const maxSecond = Math.max(secondFloor, ...second);
  const bw = (W - pad * 2) / n;
  const y = (v) => H - pad - ((v - minFp) / (maxFp - minFp)) * (H - pad * 2);
  const y2 = (v) => H - pad - (v / maxSecond) * (H - pad * 2);
  const bars = fp.map((v, i) => {
    const top = Math.min(y(v), y(0)), h = Math.abs(y(v) - y(0)) || 1;
    return `<rect x="${pad + i * bw + bw * 0.15}" y="${top}" width="${Math.max(1, bw * 0.7)}" height="${h}" fill="var(--crease)"><title>${esc(games[i].date)} vs ${esc(games[i].opp)}: ${esc(tip(games[i], v, i))}</title></rect>`;
  }).join("");
  const roll = fp.map((_, i) => { const win = fp.slice(Math.max(0, i - 9), i + 1); return win.reduce((a, b) => a + b, 0) / win.length; });
  const line = (vals, fy) => vals.map((v, i) => `${i ? "L" : "M"}${(pad + i * bw + bw / 2).toFixed(1)},${fy(v).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fantasy points for each game this season">
      <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--rule)"/>
      ${bars}
      <path d="${line(second, y2)}" fill="none" stroke="var(--blueline)" stroke-width="1.5" stroke-dasharray="4 3"/>
      <path d="${line(roll, y)}" fill="none" stroke="var(--goal)" stroke-width="2.5"/>
      <text x="${pad}" y="16" font-size="12" fill="var(--muted)">max ${fmt(maxFp, 1)} FP</text>
    </svg>
    <p class="chart-legend">Bars: fantasy points each game. Red line: 10-game average. ${secondLegend}</p>`;
}

function closePlayer() {
  $("drawer").hidden = true; $("scrim").hidden = true;
  document.body.style.overflow = "";
  if (state.lastFocus) state.lastFocus.focus();
}

/* ---------- events ---------- */

function wire() {
  ["q", "pos", "team", "minGp", "watchOnly"].forEach((id) =>
    $(id).addEventListener("input", () => { state.shown = PAGE; render(); }));
  $("hideTop").addEventListener("input", () => {
    $("hideTopOut").textContent = $("hideTop").value; state.shown = PAGE; render();
  });
  $("more").addEventListener("click", () => { state.shown += PAGE; renderTable(); });

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (b && b.dataset.mode !== state.mode) setMode(b.dataset.mode);
  });

  const sortBy = (th) => {
    const k = th.dataset.sort, cur = state.sort[state.mode];
    state.sort[state.mode] = cur.key === k ? { key: k, dir: -cur.dir } : { key: k, dir: ["name", "pos", "team"].includes(k) ? 1 : -1 };
    renderTable();
  };
  $("thead").addEventListener("click", (e) => { const th = e.target.closest("th[data-sort]"); if (th) sortBy(th); });
  $("thead").addEventListener("keydown", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th); }
  });

  $("rows").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const id = Number(star.dataset.star);
      state.watch.has(id) ? state.watch.delete(id) : state.watch.add(id);
      save("watch", [...state.watch]);
      renderTable();
      return;
    }
    const tr = e.target.closest("tr[data-id]");
    if (tr) openPlayer(Number(tr.dataset.id));
  });
  $("hero").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (li) openPlayer(Number(li.dataset.id)); });
  $("hero").addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPlayer(Number(li.dataset.id)); }
  });

  $("scoring").addEventListener("input", (e) => {
    const k = e.target.dataset.w, mode = e.target.dataset.mode;
    if (!k || !mode) return;
    const v = parseFloat(e.target.value);
    state.weights[mode][k] = Number.isFinite(v) ? v : 0;
    save(mode === "goalies" ? "gweights" : "weights", state.weights[mode]);
    derive(); render();
  });
  $("resetWeights").addEventListener("click", () => {
    state.weights = { skaters: { ...DEFAULTS.skaters }, goalies: { ...DEFAULTS.goalies } };
    save("weights", state.weights.skaters); save("gweights", state.weights.goalies);
    renderWeights(); derive(); render();
  });

  $("closeDrawer").addEventListener("click", closePlayer);
  $("scrim").addEventListener("click", closePlayer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) closePlayer(); });
}

async function init() {
  wire();
  renderWeights();
  try {
    const [meta, skaters] = await Promise.all([fetchJSON("data/meta.json"), fetchJSON("data/players.json")]);
    state.meta = meta; state.data.skaters = skaters;
  } catch {
    $("updated").textContent = "No stats loaded yet.";
    document.querySelector("main").hidden = true;
    $("empty").hidden = false;
    return;
  }
  try { state.data.goalies = await fetchJSON("data/goalies.json"); }
  catch { state.goaliesMissing = true; }

  const when = new Date(state.meta.updatedAt);
  $("updated").textContent = `${seasonLabel(state.meta.season)} season${state.meta.seasonStarted ? "" : " (new season hasn't started)"}. Updated ${when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;

  derive();
  state.mode = load("mode", "skaters") === "goalies" ? "goalies" : "skaters";
  const start = state.mode; state.mode = "skaters";
  setMode(start);
}

init();
