"use strict";
/**
 * MinecraftAsia — Node.js all-in-one server.
 *
 * Runs on your Pterodactyl (or any Node) host as ONE continuous process:
 *   - serves the static frontend (index.html, css/, js/, data/)
 *   - samples all servers every 60 seconds (true per-minute data, no gaps —
 *     unlike the GitHub Actions burst approach, this never has to stop)
 *   - rolls raw samples into hourly/daily aggregates every 30 minutes
 *
 * No GitHub, no git, no cron needed. Just: `npm install && node server.js`
 * and leave it running (Pterodactyl keeps it alive/restarts it for you).
 */
const express = require("express");
const path = require("path");
const common = require("./lib/common");

const PORT = process.env.SERVER_PORT || process.env.PORT || 25566;
const HOST = "0.0.0.0"; // Pterodactyl requires binding all interfaces, not localhost

const SAMPLE_INTERVAL_MS = 60 * 1000;        // real 1-minute samples
const AGGREGATE_INTERVAL_MS = 30 * 60 * 1000; // rollup every 30 minutes

const app = express();

// Serve the whole project directory (index.html, css/, js/, data/) as static
// files, exactly like the frontend already expects (relative fetches such
// as "data/live.json", "css/style.css" work unchanged).
app.use(express.static(path.join(__dirname)));

app.get("/healthz", (req, res) => res.json({ ok: true, updated: common.loadJson(common.LIVE_PATH, {}).updated || 0 }));

app.listen(PORT, HOST, () => {
  console.log(`[server] MinecraftAsia listening on http://${HOST}:${PORT}`);
});

// ---------------- background loops (in-process, no cron needed) ----------------
let sampling = false;
async function pollLoop() {
  if (sampling) return; // guard against overlap if a probe ever runs long
  sampling = true;
  try {
    const ranked = await common.sampleOnce();
    const up = ranked.filter((s) => s.online_status).length;
    console.log(`[poller] sample ok — ${up}/${ranked.length} servers up`);
  } catch (e) {
    console.error("[poller] error:", e.message);
  } finally {
    sampling = false;
  }
}

function aggregateLoop() {
  try {
    common.aggregateAll();
    console.log("[aggregate] rollup ok");
  } catch (e) {
    console.error("[aggregate] error:", e.message);
  }
}

// Run once immediately on boot so the board isn't empty while waiting for
// the first interval tick, then keep going forever.
pollLoop();
setInterval(pollLoop, SAMPLE_INTERVAL_MS);
setInterval(aggregateLoop, AGGREGATE_INTERVAL_MS);

// A late first aggregate pass shortly after boot, so hourly/daily charts
// aren't empty for the first 30 minutes.
setTimeout(aggregateLoop, 2 * 60 * 1000);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
