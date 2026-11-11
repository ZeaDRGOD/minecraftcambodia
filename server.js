"use strict";

const express = require("express");
const path = require("path");
const common = require("./lib/common");

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 25566);
const HOST = process.env.HOST || "0.0.0.0";
const SAMPLE_INTERVAL_MS = 60 * 1000;
const AGGREGATE_INTERVAL_MS = 30 * 60 * 1000;
const app = express();

let sampling = false;
let lastAttempt = 0;
let lastSuccess = 0;
let lastError = null;
let lastServerCount = 0;

// Do not let a CDN/browser cache live leaderboard or history JSON.
app.use((req, res, next) => {
  if (req.path === "/data/live.json" || req.path.startsWith("/data/history/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

app.get("/healthz", (req, res) => {
  const live = common.loadJson(common.LIVE_PATH, {});
  const updated = Number(live.updated || 0);
  const now = Math.floor(Date.now() / 1000);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.json({
    ok: true,
    updated,
    ageSeconds: updated ? Math.max(0, now - updated) : null,
    sampling,
    lastAttempt,
    lastSuccess,
    lastError,
    serverCount: lastServerCount,
    livePath: common.LIVE_PATH
  });
});

app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(path.join("data", "live.json")) || filePath.includes(`${path.sep}history${path.sep}`)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    }
  }
}));

async function pollOnce() {
  if (sampling) return;
  sampling = true;
  lastAttempt = Math.floor(Date.now() / 1000);
  try {
    const ranked = await common.sampleOnce();
    lastSuccess = Math.floor(Date.now() / 1000);
    lastError = null;
    lastServerCount = ranked.length;
    const online = ranked.filter(s => s.online_status).length;
    console.log(`[poller] sample saved: ${online}/${ranked.length} online; updated=${lastSuccess}; file=${common.LIVE_PATH}`);
  } catch (error) {
    lastError = error && error.stack ? error.stack : String(error);
    console.error("[poller] sample failed:", lastError);
  } finally {
    sampling = false;
  }
}

function aggregateOnce() {
  try {
    common.aggregateAll();
    console.log("[aggregate] rollup completed");
  } catch (error) {
    console.error("[aggregate] failed:", error && error.stack ? error.stack : error);
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] MinecraftAsia listening on http://${HOST}:${PORT}`);
  console.log(`[server] live data file: ${common.LIVE_PATH}`);
  // Run immediately after the HTTP server is listening, then every minute.
  pollOnce();
  setInterval(pollOnce, SAMPLE_INTERVAL_MS);
  aggregateOnce();
  setInterval(aggregateOnce, AGGREGATE_INTERVAL_MS);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
