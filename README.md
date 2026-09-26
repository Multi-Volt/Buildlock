# Buildlock

**Disclaimer:** A large portion of this project was written using AI programming tools. If you do not like that sort of thing feel free to ignore this project, it is not for you!

A Deadlock build planner that runs for free on GitHub Pages. A scheduled GitHub Action refreshes every hero's Tracklock builds every 6 hours.

- Plan builds for any hero, arranged in phases (early, mid, late).
- Set a soul count to see which items are online at that point, your level and boons, your ability points, and your investment bonuses.
- See how every item changes your passive stats. Tap any stat to see where its value comes from.
- Test ability upgrades. Ability values scale with your spirit power, cooldown reduction, duration and range.
- Load Tracklock's **Stats build** (core items, situational items, ability unlock order) or **Pro build** (items top players bought, with pick rates) for the current hero with one tap.
- Builds save on your device and can be shared as a text code. You can install it on your phone like an app.

---

## Set it up on GitHub Pages (about 10 minutes, free)

### 1. Create the repository
1. Sign in at https://github.com (create a free account if you need one).
2. Click **+** (top right) → **New repository**.
3. Name it `buildlock`, set it to **Public** (Pages is free for public repos), and click **Create repository**.

### 2. Upload the files
Unzip `buildlock.zip` on your computer first.

**Option A: in the browser**
1. On the new repo's page, click **uploading an existing file**.
2. Open the unzipped `buildlock` folder and select **everything inside it** (not the folder itself). Drag it all onto the page and click **Commit changes**.
3. Check the upload included the `.github` folder, since some computers hide folders that start with a dot:
   - Look for `.github` in the repo's file list.
   - If it's missing, click **Add file → Create new file** and type `.github/workflows/buildlock.yml` as the name. The slashes create the folders.
   - Paste in the contents of that file from the zip, then click **Commit changes**.

**Option B: GitHub Desktop or git** (includes hidden folders automatically)
```sh
cd buildlock
git init && git add . && git commit -m "Buildlock"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/buildlock.git
git push -u origin main
```

### 3. Turn on Pages and give the Action permission
1. In the repo, open **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
2. Open **Settings → Actions → General**. Under **Workflow permissions**, choose **Read and write permissions** and click **Save**. This lets the Action save the latest Tracklock data back into the repo.

### 4. Run it the first time
1. Open the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
2. Click **Update and deploy Buildlock** → **Run workflow** → **Run workflow**.
3. Wait about 3–5 minutes for both jobs, **build** and **deploy**, to get green ticks.
4. Your site is live at **https://YOUR-USERNAME.github.io/buildlock/**. The link also appears on the finished run and under **Settings → Pages**.

### 5. Put it on your phone
- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open the link in Chrome → menu → **Install app** (or Add to Home screen).

It opens full screen like an app. Your builds stay on each device; move them between devices with **Share code** and **Builds → Import**.

---

## What happens automatically

| When | What the Action does |
|---|---|
| Every 6 hours | Fetches both Tracklock pages for every hero (about 2–3 minutes, with polite delays) and republishes the site |
| Every Monday | Also downloads Deadlock's latest game files, so patches (new items, changed stats, new heroes) show up within a week |
| Whenever you push to `main` | Rebuilds and republishes the site |
| **Run workflow** button | The same thing on demand. Tick "Also re-download Deadlock game data" to pick up a patch immediately |

In the app, the Tracklock window shows how old the data is. If an update fails, for example because Tracklock is down or changed its page layout, the site keeps the last good data and says so.

### Checking on it
- **Actions tab:** each run lists every hero as `updated` or `kept old`, with the reason for any failure. A yellow warning appears if no hero could be refreshed.
- **Bot commits:** a commit named "Update Buildlock data" every few hours is normal. It saves the Tracklock cache and keeps the schedule running.
- **Schedule pauses:** GitHub pauses schedules on repos with no activity for 60 days. The bot's commits usually count as activity. If the schedule ever stops, open the Actions tab and click **Enable workflow**.

### If Tracklock blocks GitHub's servers
Some sites refuse automated requests from cloud servers. If every run shows `kept old` with errors like `HTTP 403`, you have two options:
- Run `node server.js --snapshot` on your own computer now and then, then `python3 tools/build.py --offline`, and push the changes.
- Host `server.js` somewhere else (see below) and point the site at it.

Please keep the 6-hour schedule. It's gentle on Tracklock, and their stats don't change faster than that anyway.

---

## Other ways to run it

- **On your computer:** install Node.js 18+ from https://nodejs.org, then double-click `start.bat` (Windows) or `start.command` (Mac), or run `node server.js`.
  - Open http://localhost:8787. The console also prints an address for phones on the same Wi-Fi.
  - This mode fetches Tracklock data on demand, when you open the window.
- **Docker:** run `docker compose up -d`.
- **Render.com (free tier):** New → Blueprint, then pick your repo. `render.yaml` sets it up.
- **Separate server:** to have the GitHub Pages site use a live server instead of the 6-hourly file, set `window.BUILDLOCK_API = 'https://your-server…'` in `public/config.js`.
- **No setup at all:** open `public/index.html` in any browser. It uses the Tracklock snapshot built into the app.

## Commands

| Command | What it does |
|---|---|
| `node server.js` | Run the local server with on-demand Tracklock fetching |
| `node server.js --export _site` | Fetch every hero into `_site/tracklock.json` (what the Action runs) |
| `node server.js --scrape warden` | Print what the parser gets for one hero, useful when something looks wrong |
| `node server.js --snapshot` | Save the pro builds as the built-in offline snapshot |
| `python3 tools/build.py` | Download the latest game data and rebuild `public/index.html` |
| `python3 tools/build.py --offline` | Rebuild `public/index.html` from the saved data only |
| `node test/parser.test.js` | Parser self-test |

## Project layout

```
.github/workflows/buildlock.yml   the scheduled Action (refresh + deploy)
public/                           the site: index.html (app + game data), PWA files, icons
server.js                         Tracklock scraper, cache, local server, static export
tools/build.py                    game data extractor and page builder (Python 3, standard library only)
src/app.template.html             app source
data/                             lookup tables, Tracklock snapshot and cache
test/                             parser self-test
```

## Credits

- Deadlock game data and images belong to Valve. Data is extracted via SteamDB's GameTracking-Deadlock.
- Builds are from tracklock.gg.
- Buildlock is a fan project, not affiliated with Valve or Tracklock.
