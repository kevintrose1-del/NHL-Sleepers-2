"use strict";

const DEFAULT_WEIGHTS = { g: 3, a: 2, ppp: 1, sog: 0.4, hit: 0.4, blk: 0.5, pm: 0.5, pim: 0 };
const WEIGHT_LABELS = {
  g: "Goal", a: "Assist", ppp: "Power-play point", sog: "Shot on goal",
  hit: "Hit", blk: "Blocked shot", pm: "Plus/minus", pim: "Penalty minute",
};
const POS_NAMES = { C: "C", L: "LW", R: "RW", D: "D" };
const PAGE = 50;

const state = {
  players: [],
  meta: null,
  weights: load("weights", DEFAULT_WEIGHTS),
  watch: new Set(load("watch", [])),
  sort: { key: "score", dir: -1 },
  shown: PAGE,
  lastFocus: null,
};

const $ = (id) => document.getElementById(id);

function load(key, fallback) {
  try {
    const v = localStorage.getItem("utr:" + key);
    return v ? JSON.parse(v) : JSON.parse(JSON.stringify(fallback));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}
function save(key, value) {
  try { localStorage.setItem("utr:" + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(n, d = 0) { return Number.isFinite(n) ? n.toFixed(d) : "–"; }
function signed(n, d = 1) { return Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(d) : "–"; }
function mmss(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "–";
  const m = Math.floor(minutes), s = Math.round((minutes - m) * 60);
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, "0")}`;
}
function seasonLabel(id) {
  const s = String(id);
  return s.length === 8 ? `${s.slice(0, 4)}–${s.slice(6)}` : s;
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---------- scoring ---------- */

function fantasy(s, w) {
  return (s.g || 0) * w.g + (s.a || 0) * w.a + (s.ppp || 0) * w.ppp + (s.sog || 0) * w.sog +
    (s.hit || 0) * w.hit + (s.blk || 0) * w.blk + (s.pm || 0) * w.pm + (s.pim || 0) * w.pim;
}

function derive() {
  const w = state.weights;
  const players = state.players;

  const byPrior = [...players].sort((a, b) => (b.prior.pts || 0) - (a.prior.pts || 0));
  byPrior.forEach((p, i) => { p._priorRank = (p.prior.pts || 0) > 0 ? i + 1 : Infinity; });

  for (const p of players) {
    const s = p.season, l = p.l10, gp = s.gp || 0, lgp = l.gp || 0;
    const hitRate = gp ? (s.hit || 0) / gp : 0;
    const blkRate = gp ? (s.blk || 0) / gp : 0;
    p._fpg = gp ? fantasy(s, w) / gp : 0;
    p._l10fpg = lgp ? (fantasy({ ...l, hit: 0, blk: 0 }, w) + lgp * (hitRate * w.hit + blkRate * w.blk)) / lgp : 0;
    p._trend = lgp ? p._l10fpg - p._fpg : 0;
    p._toi = gp ? s.toi / gp / 60 : 0;
    p._l10toi = lgp ? l.toi / lgp / 60 : 0;
    p._toiDelta = lgp ? p._l10toi - p._toi : 0;
    p._sogG = gp ? s.sog / gp : 0;
    p._l10sog = lgp ? l.sog / lgp : 0;
    p._shotDelta = lgp ? p._l10sog - p._sogG : 0;
    p._shp = s.sog ? s.g / s.sog : null;
    p._careerShp = p.career.sog >= 50 ? p.career.g / p.career.sog : null;
    p._luck = p._shp !== null && p._careerShp !== null && s.sog >= 15
      ? Math.max(-0.08, Math.min(0.08, p._careerShp - p._shp)) : 0;
    p._l10ppp = lgp ? l.ppp / lgp : 0;
  }

  const pool = players.filter((p) => p.season.gp >= 5);
  const features = [["_l10fpg", 1], ["_trend", 0.8], ["_toiDelta", 0.8], ["_l10sog", 0.5], ["_luck", 0.6], ["_l10ppp", 0.4]];
  const norms = features.map(([k]) => {
    const vals = pool.map((p) => p[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 1;
    return [mean, sd];
  });
  for (const p of players) {
    p._raw = features.reduce((acc, [k, wt], i) => acc + wt * ((p[k] - norms[i][0]) / norms[i][1]), 0);
  }
  const sorted = pool.map((p) => p._raw).sort((a, b) => a - b);
  for (const p of players) {
    if (!sorted.length || p.season.gp < 5) { p._score = 0; continue; }
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < p._raw) lo = mid + 1; else hi = mid; }
    p._score = Math.round((100 * lo) / sorted.length);
    p._signals = signalsFor(p);
  }
}

function signalsFor(p) {
  const out = [];
  const enough = p.l10.gp >= 5;
  if (enough && p._trend >= 0.5) out.push(["hot", "Heating up", `${signed(p._trend)} FP/G over his last ${p.l10.gp}`]);
  if (enough && p._toiDelta >= 1.5) out.push(["ice", "More ice time", `${signed(p._toiDelta)} min per night lately`]);
  if (p.l10.ppp >= 3) out.push(["pp", "Power play", `${p.l10.ppp} power-play points in his last ${p.l10.gp}`]);
  if (enough && p._shotDelta >= 0.7) out.push(["shots", "Shooting more", `${fmt(p._l10sog, 1)} shots a game lately vs ${fmt(p._sogG, 1)}`]);
  if (p._luck >= 0.03 && p.season.sog >= 20) {
    out.push(["due", "Due for goals", `shooting ${fmt(p._shp * 100, 1)}% vs ${fmt(p._careerShp * 100, 1)}% career`]);
  }
  return out;
}

/* ---------- filtering & sorting ---------- */

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
  const f = filters();
  return state.players.filter((p) => {
    if (f.watchOnly && !state.watch.has(p.id)) return false;
    if (p.season.gp < f.minGp) return false;
    if (f.hideTop && p._priorRank <= f.hideTop && !state.watch.has(p.id)) return false;
    if (f.pos === "F" && p.pos === "D") return false;
    if (f.pos !== "all" && f.pos !== "F" && p.pos !== f.pos) return false;
    if (f.team !== "all" && p.team !== f.team) return false;
    if (f.q && !(p.name.toLowerCase().includes(f.q) || p.team.toLowerCase().includes(f.q))) return false;
    return true;
  });
}

const SORTERS = {
  name: (p) => p.name.split(" ").slice(-1)[0], pos: (p) => p.pos, team: (p) => p.team,
  gp: (p) => p.season.gp, g: (p) => p.season.g, a: (p) => p.season.a, pts: (p) => p.season.pts,
  ppp: (p) => p.season.ppp, sog: (p) => p.season.sog, hit: (p) => p.season.hit, blk: (p) => p.season.blk,
  toi: (p) => p._toi, fpg: (p) => p._fpg, l10fpg: (p) => p._l10fpg, toiDelta: (p) => p._toiDelta, score: (p) => p._score,
};

function sorted(list) {
  const key = SORTERS[state.sort.key] || SORTERS.score;
  const dir = state.sort.dir;
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x ?? -Infinity) - (y ?? -Infinity)) || b._score - a._score;
  });
}

/* ---------- rendering ---------- */

function sigHTML(sigs) {
  return (sigs || []).map(([cls, label, why]) => `<span class="sig ${cls}" title="${esc(why)}">${esc(label)}</span>`).join("");
}

function renderHero() {
  const f = filters();
  const top = sorted(state.players.filter((p) =>
    p.season.gp >= Math.max(5, f.minGp) && p._priorRank > Math.max(f.hideTop, 60) && (p._signals || []).length
  )).sort((a, b) => b._score - a._score).slice(0, 3);

  $("hero").innerHTML = top.length ? top.map((p) => `
    <li data-id="${p.id}" tabindex="0">
      <div>
        <p class="hero-name">${esc(p.name)}</p>
        <p class="hero-meta">${esc(POS_NAMES[p.pos] || p.pos)}, ${esc(p.team)}${p.age ? `, age ${p.age}` : ""}. ${fmt(p._l10fpg, 1)} fantasy points a game over his last ${p.l10.gp}.</p>
        ${sigHTML(p._signals)}
      </div>
      <div class="hero-score"><b>${p._score}</b><span>sleeper score</span></div>
      <p class="hero-why">${esc(p._signals.map((s) => s[2]).join("; "))}.</p>
    </li>`).join("")
    : `<li class="hero-empty">Not enough games played yet this season to spot risers. Check back after the first week.</li>`;
}

function renderTable() {
  const list = sorted(visible());
  const rows = list.slice(0, state.shown);
  $("rows").innerHTML = rows.map((p) => {
    const s = p.season;
    const starred = state.watch.has(p.id);
    const delta = p.l10.gp ? `<span class="${p._toiDelta >= 0.5 ? "up" : p._toiDelta <= -0.5 ? "down" : ""}">${signed(p._toiDelta)}</span>` : "–";
    const l10cls = p._trend >= 0.3 ? "up" : p._trend <= -0.3 ? "down" : "";
    return `<tr data-id="${p.id}">
      <td><button type="button" class="star" data-star="${p.id}" aria-pressed="${starred}" aria-label="${starred ? "Remove from" : "Add to"} watchlist">${starred ? "★" : "☆"}</button></td>
      <td class="left player">${esc(p.name)}${p.nhlSeasons <= 1 ? "<small>Rookie or sophomore</small>" : ""}</td>
      <td>${esc(POS_NAMES[p.pos] || p.pos)}</td><td>${esc(p.team)}</td>
      <td>${s.gp}</td><td>${s.g}</td><td>${s.a}</td><td>${s.pts}</td><td>${s.ppp}</td><td>${s.sog}</td>
      <td>${s.hit}</td><td>${s.blk}</td><td>${mmss(p._toi)}</td>
      <td>${fmt(p._fpg, 2)}</td><td class="${l10cls}">${p.l10.gp ? fmt(p._l10fpg, 2) : "–"}</td><td>${delta}</td>
      <td><span class="score"><span class="score-bar"><i style="width:${p._score}%"></i></span><b>${p._score}</b></span></td>
      <td class="left">${sigHTML(p._signals)}</td>
    </tr>`;
  }).join("");

  $("count").textContent = list.length
    ? `Showing ${rows.length} of ${list.length} skaters.`
    : "No skaters match these filters. Try lowering the minimum games or hiding fewer top scorers.";
  $("more").hidden = rows.length >= list.length;

  document.querySelectorAll("thead th[data-sort]").forEach((th) => {
    if (th.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir < 0 ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
  });
}

function render() { renderHero(); renderTable(); }

function renderWeights() {
  $("weights").innerHTML = Object.keys(DEFAULT_WEIGHTS).map((k) => `
    <label class="field"><span>${WEIGHT_LABELS[k]}</span>
      <input type="number" step="0.1" data-w="${k}" value="${state.weights[k]}"></label>`).join("");
}

/* ---------- player detail ---------- */

async function openPlayer(id) {
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  state.lastFocus = document.activeElement;
  $("drawerBody").innerHTML = `<p>Loading ${esc(p.name)}…</p>`;
  $("drawer").hidden = false; $("scrim").hidden = false;
  document.body.style.overflow = "hidden";
  $("closeDrawer").focus();

  let detail;
  try { detail = await fetchJSON(`data/players/${id}.json`); }
  catch { $("drawerBody").innerHTML = `<p>Couldn't load details for ${esc(p.name)}. Refresh the page and try again.</p>`; return; }

  const s = p.season;
  const headshot = `https://assets.nhle.com/mugs/nhl/latest/${id}.png`;
  $("drawerBody").innerHTML = `
    <div class="d-head">
      <img src="${headshot}" alt="" onerror="this.style.visibility='hidden'">
      <div><h2 id="d-name">${esc(p.name)}</h2>
      <p>${esc(POS_NAMES[p.pos] || p.pos)}, ${esc(p.team)}${p.age ? `, age ${p.age}` : ""}. ${seasonLabel(state.meta.season)} season.</p></div>
    </div>
    ${sigHTML(p._signals)}
    <div class="d-stats">
      <div><b>${p._score}</b><span>Sleeper score</span></div>
      <div><b>${fmt(p._fpg, 2)}</b><span>FP/G, season</span></div>
      <div><b>${p.l10.gp ? fmt(p._l10fpg, 2) : "–"}</b><span>FP/G, last ${p.l10.gp || 10}</span></div>
      <div><b>${mmss(p._toi)}</b><span>TOI, season</span></div>
      <div><b>${p.l10.gp ? mmss(p._l10toi) : "–"}</b><span>TOI, last ${p.l10.gp || 10}</span></div>
      <div><b>${p._shp === null ? "–" : fmt(p._shp * 100, 1) + "%"}</b><span>Shooting %</span></div>
      <div><b>${p._careerShp === null ? "–" : fmt(p._careerShp * 100, 1) + "%"}</b><span>Career shooting %</span></div>
      <div><b>${s.pts}</b><span>Points in ${s.gp} games</span></div>
    </div>
    <h3>Game by game</h3>
    ${gameChart(detail.games, p)}
    <h3>Last 10 games</h3>
    ${gameTable(detail.games.slice(-10).reverse())}
    <h3>Career by season</h3>
    ${careerTable(detail.career)}`;
}

function closePlayer() {
  $("drawer").hidden = true; $("scrim").hidden = true;
  document.body.style.overflow = "";
  if (state.lastFocus) state.lastFocus.focus();
}

function gameChart(games, p) {
  if (!games.length) return `<p class="fine">No games played yet this season.</p>`;
  const w = state.weights;
  const hitRate = p.season.gp ? p.season.hit / p.season.gp : 0;
  const blkRate = p.season.gp ? p.season.blk / p.season.gp : 0;
  const fp = games.map((g) => fantasy({ ...g, hit: 0, blk: 0 }, w) + hitRate * w.hit + blkRate * w.blk);
  const toi = games.map((g) => g.toi / 60);
  const W = 680, H = 200, pad = 28, n = games.length;
  const maxFp = Math.max(4, ...fp), minFp = Math.min(0, ...fp);
  const maxToi = Math.max(20, ...toi);
  const bw = (W - pad * 2) / n;
  const y = (v) => H - pad - ((v - minFp) / (maxFp - minFp)) * (H - pad * 2);
  const yT = (v) => H - pad - (v / maxToi) * (H - pad * 2);
  const bars = fp.map((v, i) => {
    const top = Math.min(y(v), y(0)), h = Math.abs(y(v) - y(0)) || 1;
    return `<rect x="${pad + i * bw + bw * 0.15}" y="${top}" width="${Math.max(1, bw * 0.7)}" height="${h}" fill="var(--crease)"><title>${esc(games[i].date)} vs ${esc(games[i].opp)}: ${fmt(v, 1)} FP, ${mmss(toi[i])} TOI</title></rect>`;
  }).join("");
  const roll = fp.map((_, i) => { const win = fp.slice(Math.max(0, i - 9), i + 1); return win.reduce((a, b) => a + b, 0) / win.length; });
  const line = (vals, fy) => vals.map((v, i) => `${i ? "L" : "M"}${(pad + i * bw + bw / 2).toFixed(1)},${fy(v).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fantasy points and ice time for each game this season">
      <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--rule)"/>
      ${bars}
      <path d="${line(toi, yT)}" fill="none" stroke="var(--blueline)" stroke-width="1.5" stroke-dasharray="4 3"/>
      <path d="${line(roll, y)}" fill="none" stroke="var(--goal)" stroke-width="2.5"/>
      <text x="${pad}" y="16" font-size="12" fill="var(--muted)">max ${fmt(maxFp, 1)} FP</text>
    </svg>
    <p class="chart-legend">Bars: fantasy points each game. Red line: 10-game average. Dashed blue line: ice time.</p>`;
}

function gameTable(games) {
  if (!games.length) return "";
  return `<div class="table-wrap"><table><thead><tr>
      <th class="left">Date</th><th class="left">Opp</th><th>G</th><th>A</th><th>+/-</th><th>PPP</th><th>SOG</th><th>PIM</th><th>TOI</th>
    </tr></thead><tbody>${games.map((g) => `<tr class="minor">
      <td class="left">${esc(g.date)}</td><td class="left">${g.home ? "" : "@ "}${esc(g.opp)}</td>
      <td>${g.g}</td><td>${g.a}</td><td>${signed(g.pm, 0)}</td><td>${g.ppp}</td><td>${g.sog}</td><td>${g.pim}</td><td>${mmss(g.toi / 60)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function careerTable(rows) {
  if (!rows.length) return `<p class="fine">No career history available.</p>`;
  const sortedRows = [...rows].sort((a, b) => b.season - a.season);
  return `<div class="table-wrap"><table><thead><tr>
      <th class="left">Season</th><th class="left">League</th><th class="left">Team</th>
      <th>GP</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>PPP</th><th>SOG</th><th>TOI</th>
    </tr></thead><tbody>${sortedRows.map((r) => `<tr class="minor">
      <td class="left">${seasonLabel(r.season)}</td><td class="left">${esc(r.league)}</td><td class="left">${esc(r.team)}</td>
      <td>${r.gp}</td><td>${r.g}</td><td>${r.a}</td><td>${r.pts}</td><td>${r.league === "NHL" ? signed(r.pm, 0) : "–"}</td>
      <td>${r.league === "NHL" ? r.ppp : "–"}</td><td>${r.league === "NHL" ? r.sog : "–"}</td><td>${esc(r.toi || "–")}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* ---------- events ---------- */

function wire() {
  ["q", "pos", "team", "minGp", "watchOnly"].forEach((id) =>
    $(id).addEventListener("input", () => { state.shown = PAGE; render(); }));
  $("hideTop").addEventListener("input", () => {
    $("hideTopOut").textContent = $("hideTop").value; state.shown = PAGE; render();
  });
  $("more").addEventListener("click", () => { state.shown += PAGE; renderTable(); });

  document.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.tabIndex = 0;
    const go = () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: ["name", "pos", "team"].includes(k) ? 1 : -1 };
      renderTable();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
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
  $("hero").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]"); if (li) openPlayer(Number(li.dataset.id));
  });
  $("hero").addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPlayer(Number(li.dataset.id)); }
  });

  $("weights").addEventListener("input", (e) => {
    const k = e.target.dataset.w; if (!k) return;
    const v = parseFloat(e.target.value);
    state.weights[k] = Number.isFinite(v) ? v : 0;
    save("weights", state.weights); derive(); render();
  });
  $("resetWeights").addEventListener("click", () => {
    state.weights = { ...DEFAULT_WEIGHTS }; save("weights", state.weights);
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
    const [meta, players] = await Promise.all([fetchJSON("data/meta.json"), fetchJSON("data/players.json")]);
    state.meta = meta; state.players = players;
  } catch {
    $("updated").textContent = "No stats loaded yet.";
    document.querySelector("main").hidden = true;
    $("empty").hidden = false;
    return;
  }

  const when = new Date(state.meta.updatedAt);
  $("updated").textContent = `${seasonLabel(state.meta.season)} season${state.meta.seasonStarted ? "" : " (new season hasn't started)"}. Updated ${when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;

  const teams = [...new Set(state.players.map((p) => p.team))].sort();
  $("team").insertAdjacentHTML("beforeend", teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join(""));

  derive();
  render();
}

init();
