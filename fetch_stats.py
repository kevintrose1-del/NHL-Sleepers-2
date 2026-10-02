#!/usr/bin/env python3
"""
Pulls NHL skater stats from the NHL's public web API and writes the JSON
files the website reads:

  data/meta.json            when the data was updated, which season it covers
  data/players.json         one summary row per skater (used by the main table)
  data/players/<id>.json    full career by season + this season's game log

Uses only the Python standard library, so there is nothing to install.
Run it locally with:  python scripts/fetch_stats.py
"""
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

WEB = "https://api-web.nhle.com/v1"
STATS = "https://api.nhle.com/stats/rest/en"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
PLAYER_DIR = os.path.join(DATA, "players")
WORKERS = 6  # keep this modest so we stay polite to the NHL's servers

TEAMS = [
    "ANA", "BOS", "BUF", "CGY", "CAR", "CHI", "COL", "CBJ", "DAL", "DET",
    "EDM", "FLA", "LAK", "MIN", "MTL", "NSH", "NJD", "NYI", "NYR", "OTT",
    "PHI", "PIT", "SJS", "SEA", "STL", "TBL", "TOR", "UTA", "VAN", "VGK",
    "WSH", "WPG",
]

STAT_KEYS = ("gp", "g", "a", "pts", "pm", "pim", "ppg", "ppp", "sog", "toi")


def get(url, retries=4):
    """GET a URL and parse JSON. Returns None on 404 or repeated failure."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "under-the-radar-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (attempt + 1))
        except Exception:
            time.sleep(2 * (attempt + 1))
    print(f"  ! gave up on {url}", file=sys.stderr)
    return None


def season_for(date):
    """NHL season id like 20262027. A new season id starts in August."""
    start = date.year if date.month >= 8 else date.year - 1
    return start * 10000 + start + 1


def prev_season(season):
    start = season // 10000 - 1
    return start * 10000 + start + 1


def toi_seconds(text):
    if not text:
        return 0
    try:
        minutes, seconds = str(text).split(":")
        return int(minutes) * 60 + int(seconds)
    except ValueError:
        return 0


def num(value):
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def realtime_stats(season):
    """Season hits and blocked shots for every skater (not in the game logs)."""
    out = {}
    start = 0
    exp = urllib.parse.quote(f"seasonId={season} and gameTypeId=2")
    while True:
        url = (f"{STATS}/skater/realtime?isAggregate=true&isGame=false"
               f"&start={start}&limit=100&cayenneExp={exp}")
        data = get(url) or {}
        rows = data.get("data", []) or []
        for row in rows:
            pid = row.get("playerId")
            if pid:
                out[pid] = {"hit": num(row.get("hits")), "blk": num(row.get("blockedShots"))}
        if len(rows) < 100:
            break
        start += 100
    return out


def roster_ids():
    ids = set()
    for team in TEAMS:
        data = get(f"{WEB}/roster/{team}/current")
        if not data:
            continue
        for group in ("forwards", "defensemen"):
            for p in data.get(group, []) or []:
                if p.get("id"):
                    ids.add(p["id"])
    return ids


def total(games):
    t = {k: 0 for k in STAT_KEYS}
    t["gp"] = len(games)
    for g in games:
        for k in STAT_KEYS[1:]:
            t[k] += g.get(k, 0)
    return t


def age_on(birth, today):
    try:
        b = datetime.date.fromisoformat(birth)
    except (TypeError, ValueError):
        return None
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


def build_player(pid, active, prior, rt, today):
    land = get(f"{WEB}/player/{pid}/landing")
    if not land or land.get("position") == "G":
        return None

    log = (get(f"{WEB}/player/{pid}/game-log/{active}/2") or {}).get("gameLog", []) or []
    games = []
    for g in log:
        games.append({
            "date": g.get("gameDate"),
            "opp": g.get("opponentAbbrev"),
            "home": g.get("homeRoadFlag") == "H",
            "g": num(g.get("goals")),
            "a": num(g.get("assists")),
            "pts": num(g.get("goals")) + num(g.get("assists")),
            "pm": num(g.get("plusMinus")),
            "pim": num(g.get("pim")),
            "ppg": num(g.get("powerPlayGoals")),
            "ppp": num(g.get("powerPlayPoints")),
            "sog": num(g.get("shots")),
            "toi": toi_seconds(g.get("toi")),
        })
    games.sort(key=lambda x: x["date"] or "")

    season = total(games)
    season.update(rt.get(pid, {"hit": 0, "blk": 0}))
    last10 = total(games[-10:])

    career_rows = []
    for s in land.get("seasonTotals", []) or []:
        if s.get("gameTypeId") != 2:
            continue
        career_rows.append({
            "season": s.get("season"),
            "league": s.get("leagueAbbrev"),
            "team": (s.get("teamName") or {}).get("default"),
            "gp": num(s.get("gamesPlayed")),
            "g": num(s.get("goals")),
            "a": num(s.get("assists")),
            "pts": num(s.get("points")),
            "pm": num(s.get("plusMinus")),
            "pim": num(s.get("pim")),
            "ppg": num(s.get("powerPlayGoals")),
            "ppp": num(s.get("powerPlayPoints")),
            "sog": num(s.get("shots")),
            "toi": s.get("avgToi"),
        })

    nhl = [r for r in career_rows if r["league"] == "NHL"]
    history = [r for r in nhl if r["season"] != active]
    career = {k: sum(r[k] for r in history) for k in ("gp", "g", "a", "pts", "sog")}
    prior_rows = [r for r in nhl if r["season"] == prior]
    prior_tot = {k: sum(r[k] for r in prior_rows) for k in ("gp", "g", "a", "pts")}

    first = (land.get("firstName") or {}).get("default", "")
    last = (land.get("lastName") or {}).get("default", "")
    pos = land.get("position") or ""

    detail = {"id": pid, "name": f"{first} {last}".strip(), "career": career_rows, "games": games}
    with open(os.path.join(PLAYER_DIR, f"{pid}.json"), "w") as f:
        json.dump(detail, f, separators=(",", ":"))

    return {
        "id": pid,
        "name": f"{first} {last}".strip(),
        "team": land.get("currentTeamAbbrev") or "FA",
        "pos": pos,
        "age": age_on(land.get("birthDate"), today),
        "nhlSeasons": len({r["season"] for r in history}),
        "season": season,
        "l10": last10,
        "career": career,
        "prior": prior_tot,
    }


def main():
    os.makedirs(PLAYER_DIR, exist_ok=True)
    today = datetime.date.today()
    current = season_for(today)

    print(f"Checking whether the {current} season has started...")
    rt = realtime_stats(current)
    active = current
    if not rt:
        active = prev_season(current)
        print(f"  no games yet, showing {active} instead")
        rt = realtime_stats(active)
    prior = prev_season(active)

    ids = roster_ids()
    if active == current:
        ids |= set(rt.keys())  # also catch players who played this season but are off a roster today
    print(f"Fetching {len(ids)} skaters...")

    players = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for result in pool.map(lambda pid: build_player(pid, active, prior, rt, today), sorted(ids)):
            if result:
                players.append(result)

    if len(players) < 100:
        print("Too few players came back; leaving yesterday's data in place.", file=sys.stderr)
        sys.exit(1)

    keep = {f"{p['id']}.json" for p in players} | {".gitkeep"}
    for name in os.listdir(PLAYER_DIR):
        if name not in keep:
            os.remove(os.path.join(PLAYER_DIR, name))

    with open(os.path.join(DATA, "players.json"), "w") as f:
        json.dump(players, f, separators=(",", ":"))
    with open(os.path.join(DATA, "meta.json"), "w") as f:
        json.dump({
            "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
            "season": active,
            "priorSeason": prior,
            "seasonStarted": active == current,
            "playerCount": len(players),
        }, f, indent=2)
    print(f"Done: {len(players)} skaters written.")


if __name__ == "__main__":
    main()
