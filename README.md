# Under the Radar: NHL fantasy sleeper tracker

A free, self-updating website that finds NHL skaters producing more than their reputation. Every morning a scheduled job pulls fresh stats from the NHL's public stats feed, and the site recalculates who's heating up.

What it tracks: season stats, last-10-game form, ice time trends, power-play usage, shot volume, shooting luck, and each player's full career history (NHL plus junior, college, AHL and European seasons) with a game-by-game chart.

## Setup (about 20 minutes, no coding)

1. **Create a free GitHub account** at github.com if you don't have one.
2. **Create a new repository.** Click the **+** in the top right, then **New repository**. Name it something like `nhl-sleepers`, set it to **Public** (free GitHub Pages requires public repos), and click **Create repository**.
3. **Upload the files.** On the new repo's page, click **uploading an existing file**. Unzip this project on your computer, then drag everything inside the folder into the browser window, including the `.github` folder, `data` folder, and `.nojekyll` file. Click **Commit changes**.
   - Hidden files: on a Mac, press Cmd+Shift+. in Finder to show `.github` and `.nojekyll`. On Windows, turn on View > Show > Hidden items. If the drag-and-drop skips the `.github` folder, create the workflow manually: click **Add file > Create new file**, type `.github/workflows/update-stats.yml` as the name, and paste in the contents of that file.
4. **Let the update job save data.** Go to **Settings > Actions > General**, scroll to **Workflow permissions**, choose **Read and write permissions**, and click **Save**.
5. **Turn on the website.** Go to **Settings > Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**, and click **Save**.
6. **Load the stats for the first time.** Go to the **Actions** tab, click **Update stats** on the left, then **Run workflow**. It takes about 5 minutes the first time.
7. **Open your site** at `https://YOUR-USERNAME.github.io/nhl-sleepers/` (Settings > Pages shows the exact link). From now on it updates itself every morning around 6 AM Eastern.

## Using the site

- **Scoring settings:** set the point values to match your league so fantasy points per game line up with what you see on Yahoo, ESPN, Fantrax, etc. Your settings are saved in your browser.
- **Hide last season's top scorers:** the slider removes the players everyone already drafted. Drag it lower to see more players, higher to dig deeper.
- **Watchlist:** click the star next to any player. Starred players always show, even if the slider would hide them.
- **Click any player** for his game-by-game chart, last 10 games, and every season of his career.

## Good to know

- The NHL's stats feed is free and public but not officially documented, so the NHL could change it. If the daily update starts failing, the Actions tab shows a red X and the site keeps showing the last good data.
- GitHub pauses scheduled jobs on repos with no activity for 60 days. The daily data commit counts as activity, so this only matters if updates stop for another reason. If it happens, re-enable it from the Actions tab.
- Fantasy roster percentages aren't publicly available, so "last season's top scorers" stands in for "widely owned."
- Hits and blocks only come as season totals, so last-10 fantasy points use each player's season rate for those two stats.
- Goalies aren't included yet.

## Running it on your own computer (optional)

```
python scripts/fetch_stats.py
python -m http.server 8000
```
Then open http://localhost:8000.
