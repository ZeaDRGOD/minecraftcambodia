"use strict";
/**
 * MinecraftAsia — shared config, probing, and scoring logic (Node.js port).
 * Completely native server status checker (no external web APIs needed).
 */
const net = require("net");
const fs = require("fs");
const path = require("path");

// ---------------- config ----------------
const SERVERS = [
  "mazerclub.net", "mikitamc.ink", "kolap.net", "caffemc.xyz",
  "pkamc.vip", "friendlymc.vip", "rainomc.lol", "bejengmc.lol",
  "asiapvp.xyz", "doggysmp.ink", "asiaprac.xyz", "icemc.pro", "galaxysmp.lol", "falcon.mcpc.ink", "makongmc.com", "unicornmc.xyz", "zetamc.org", "asuramc.com", "espadasmp.xyz", "preahchanmc.xyz", "play.basakmc.org", "creamsmp.mcpc.ink",
  "yakabsmp.mcpc.ink", "khmergoldmc.xyz", "susiesmp.com", "mc.serverdino.com", "romdoulmc.vip", "warlord.fit", "sbysmp.nokormc.lol", "morodok.vip", "chillsmp.ink", "nosleepsmp.xyz", "dayonesmp.xyz", "netxia.xyz", "vanilasmp.mcpc.ink", "kesormc.cam", "familysmp.site",
  "kartelmc.apsara.lol", "angkorsmp.com", "play.nokiamc.ink", "netheritemc.ink", "papayamc.mc.gg", "vertexmc.vip", "boykamc.xyz", "risksmp.net", "eclipsemcs.xyz", "rtysmp.mcpc.ink", "kiwimc.ink", "kesormc.cam", "haydaymc.ink", "lemon.mcpc.ink", "MORODOKMC.COM"
];

// Ranking weights (must sum to 1.0)
const W_ONLINE = 0.30;
const W_DAILY = 0.25;
const W_UPTIME = 0.25;
const W_PING = 0.20;

// Retention windows, in seconds
const RAW_RETENTION_SEC = 3 * 86400;      // 3 days of true minute-level samples
const HOURLY_RETENTION_SEC = 90 * 86400;  // 90 days of hourly rollups
const DAILY_RETENTION_SEC = 400 * 86400;  // ~13 months of daily rollups

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const HIST_DIR = path.join(DATA_DIR, "history");
const LIVE_PATH = path.join(DATA_DIR, "live.json");

// ---------------- json helpers ----------------
function histPath(server, name) {
  const d = path.join(HIST_DIR, server);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

// ---------------- native minecraft server ping protocol ----------------
function writeVarInt(value) {
  const bytes = [];
  while (true) {
    if ((value & ~0x7F) === 0) {
      bytes.push(value);
      break;
    }
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) {
      return { value: 0, size: 0 };
    }
    read = buffer[offset + numRead];
    result |= (read & 0x7F) << (7 * numRead);
    numRead++;
    if (numRead > 5) {
      return { value: 0, size: 0 }; // VarInt too big
    }
  } while ((read & 0x80) !== 0);
  return { value: result, size: numRead };
}

function nativeMinecraftPing(host, port = 25565, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));

    socket.connect(port, host, () => {
      try {
        // 1. Send Handshake Packet & Status Request Packet
        const hostBuffer = Buffer.from(host, "utf8");
        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(port, 0);

        const handshakeData = Buffer.concat([
          writeVarInt(0x00), // Packet ID = 0 (Handshake)
          writeVarInt(754),  // Protocol version (e.g., 754 for 1.16.5 / universal compatibility)
          writeVarInt(hostBuffer.length),
          hostBuffer,
          portBuffer,
          writeVarInt(1)     // Next state = 1 (Status)
        ]);

        const packet = Buffer.concat([writeVarInt(handshakeData.length), handshakeData]);
        const statusRequest = Buffer.from([0x01, 0x00]); // Length 1, Packet ID 0 (Request)

        socket.write(Buffer.concat([packet, statusRequest]));
      } catch {
        finish(null);
      }
    });

    let chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const fullBuffer = Buffer.concat(chunks);

      try {
        const packetLength = readVarInt(fullBuffer, 0);
        if (packetLength.size === 0) return;

        const totalNeeded = packetLength.size + packetLength.value;
        if (fullBuffer.length < totalNeeded) return; // Wait for full response

        const packetId = readVarInt(fullBuffer, packetLength.size);
        const jsonStartIndex = packetLength.size + packetId.size;
        const jsonString = fullBuffer.toString("utf8", jsonStartIndex, totalNeeded);
        
        const data = JSON.parse(jsonString);
        const pingMs = Number(process.hrtime.bigint() - t0) / 1e6;

        finish({
          online: true,
          players: data.players?.online || 0,
          max: data.players?.max || 0,
          version: data.version?.name || null,
          motd: data.description || "",
          ping: Math.round(pingMs * 10) / 10
        });
      } catch {
        finish(null);
      }
    });
  });
}

async function probe(addr) {
  const out = {
    address: addr, online_status: false, players: 0, max: 0,
    ping_ms: null, motd_html: [], icon: null, version: null,
  };

  // Support host:port configuration if specified, default to port 25565
  let targetHost = addr;
  let targetPort = 25565;
  if (addr.includes(":")) {
    const parts = addr.split(":");
    targetHost = parts[0];
    targetPort = parseInt(parts[1], 10) || 25565;
  }

  const res = await nativeMinecraftPing(targetHost, targetPort, 6000);
  if (!res || !res.online) {
    return out;
  }

  out.online_status = true;
  out.players = res.players;
  out.max = res.max;
  out.version = res.version;
  out.ping_ms = res.ping;

  // Handle MOTD formatting (can be object or string)
  if (typeof res.motd === "object" && res.motd !== null) {
    if (res.motd.text) out.motd_html = [res.motd.text];
  } else if (typeof res.motd === "string") {
    out.motd_html = [res.motd];
  }

  return out;
}

async function probeAll() {
  return Promise.all(SERVERS.map(probe));
}

// ---------------- scoring ----------------
function rawUptimePct(rawRecords, sinceTs) {
  const recs = rawRecords.filter((r) => r.ts >= sinceTs);
  if (!recs.length) return null;
  const ups = recs.filter((r) => r.up).length;
  return Math.round((100 * ups / recs.length) * 100) / 100;
}

function dailyPeak(rawRecords, sinceTs) {
  const recs = rawRecords.filter((r) => r.ts >= sinceTs);
  if (!recs.length) return 0;
  return Math.max(...recs.map((r) => r.online));
}

function computeRanking(results, rawByServer) {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;

  for (const s of results) {
    const raw = rawByServer[s.address] || [];
    s.daily_peak = raw.length ? dailyPeak(raw, dayAgo) : s.players;
    const uptime = rawUptimePct(raw, dayAgo);
    s.uptime_24h = uptime !== null ? uptime : (s.online_status ? 100.0 : 0.0);
  }

  const maxOnline = Math.max(1, ...results.map((s) => s.players));
  const maxDaily = Math.max(1, ...results.map((s) => s.daily_peak));
  const pings = results.map((s) => s.ping_ms).filter((p) => p !== null);
  const worstPing = pings.length ? Math.max(...pings) : 500;

  for (const s of results) {
    if (!s.online_status) {
      s.score_online = s.score_daily = s.score_ping = 0.0;
    } else {
      s.score_online = Math.round((100 * s.players / maxOnline) * 10) / 10;
      s.score_daily = Math.round((100 * s.daily_peak / maxDaily) * 10) / 10;
      const p = s.ping_ms !== null ? s.ping_ms : worstPing;
      s.score_ping = Math.round((100 * (1 - Math.min(p, 500) / 500)) * 10) / 10;
    }
    s.score_uptime = Math.round(s.uptime_24h * 10) / 10;
    s.overall = Math.round(
      (W_ONLINE * s.score_online +
        W_DAILY * s.score_daily +
        W_UPTIME * s.score_uptime +
        W_PING * s.score_ping) * 10
    ) / 10;
  }

  results.sort((a, b) => b.overall - a.overall);
  results.forEach((s, i) => { s.rank = i + 1; });
  return results;
}

async function sampleOnce() {
  const results = await probeAll();
  const ts = Math.floor(Date.now() / 1000);

  const rawByServer = {};
  for (const s of results) {
    const p = histPath(s.address, "raw.json");
    let data = loadJson(p, []);
    data.push({ ts, online: s.players, ping: s.ping_ms, up: s.online_status ? 1 : 0 });
    const cutoff = ts - RAW_RETENTION_SEC;
    data = data.filter((r) => r.ts >= cutoff);
    saveJson(p, data);
    rawByServer[s.address] = data;
  }

  const ranked = computeRanking(results, rawByServer);
  saveJson(LIVE_PATH, {
    updated: ts,
    weights: { online: W_ONLINE, daily: W_DAILY, uptime: W_UPTIME, ping: W_PING },
    servers: ranked,
  });
  return ranked;
}

// ---------------- aggregation (raw -> hourly -> daily) ----------------
function bucketStats(records) {
  const ups = records.filter((r) => r.up);
  const onlineVals = records.map((r) => r.online);
  const pingVals = ups.map((r) => r.ping).filter((p) => p !== null && p !== undefined);
  return {
    avg_online: onlineVals.length ? Math.round((onlineVals.reduce((a, b) => a + b, 0) / onlineVals.length) * 10) / 10 : 0,
    peak_online: onlineVals.length ? Math.max(...onlineVals) : 0,
    avg_ping: pingVals.length ? Math.round((pingVals.reduce((a, b) => a + b, 0) / pingVals.length) * 10) / 10 : null,
    uptime_pct: records.length ? Math.round((100 * ups.length / records.length) * 10) / 10 : 0,
  };
}

function rollup(records, bucketSeconds) {
  const buckets = {};
  for (const r of records) {
    const b = r.ts - (r.ts % bucketSeconds);
    (buckets[b] = buckets[b] || []).push(r);
  }
  return Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((b) => ({ ts: b, ...bucketStats(buckets[b]) }));
}

function aggregateServer(server, now) {
  const rawPath = histPath(server, "raw.json");
  const raw = loadJson(rawPath, []);

  const hourlyPath = histPath(server, "hourly.json");
  const hourlyMap = {};
  for (const h of loadJson(hourlyPath, [])) hourlyMap[h.ts] = h;
  for (const h of rollup(raw, 3600)) hourlyMap[h.ts] = h;
  let hourly = Object.values(hourlyMap).sort((a, b) => a.ts - b.ts);
  hourly = hourly.filter((h) => h.ts >= now - HOURLY_RETENTION_SEC);
  saveJson(hourlyPath, hourly);

  const dailyPath = histPath(server, "daily.json");
  const dailyMap = {};
  for (const d of loadJson(dailyPath, [])) dailyMap[d.ts] = d;
  const dayBuckets = {};
  for (const h of hourly) {
    const b = h.ts - (h.ts % 86400);
    (dayBuckets[b] = dayBuckets[b] || []).push(h);
  }
  for (const [b, hrs] of Object.entries(dayBuckets)) {
    const pings = hrs.map((h) => h.avg_ping).filter((p) => p !== null && p !== undefined);
    dailyMap[b] = {
      ts: Number(b),
      avg_online: Math.round((hrs.reduce((a, h) => a + h.avg_online, 0) / hrs.length) * 10) / 10,
      peak_online: Math.max(...hrs.map((h) => h.peak_online)),
      avg_ping: pings.length ? Math.round((pings.reduce((a, p) => a + p, 0) / pings.length) * 10) / 10 : null,
      uptime_pct: Math.round((hrs.reduce((a, h) => a + h.uptime_pct, 0) / hrs.length) * 10) / 10,
    };
  }
  let daily = Object.values(dailyMap).sort((a, b) => a.ts - b.ts);
  daily = daily.filter((d) => d.ts >= now - DAILY_RETENTION_SEC);
  saveJson(dailyPath, daily);

  const prunedRaw = raw.filter((r) => r.ts >= now - RAW_RETENTION_SEC);
  saveJson(rawPath, prunedRaw);
}

function aggregateAll() {
  const now = Math.floor(Date.now() / 1000);
  for (const server of SERVERS) {
    try {
      aggregateServer(server, now);
    } catch (e) {
      console.error(`[aggregate] ${server} error:`, e.message);
    }
  }
}

module.exports = {
  SERVERS,_W_ONLINE: W_ONLINE, W_DAILY, W_UPTIME, W_PING,
  DATA_DIR, LIVE_PATH,
  sampleOnce, aggregateAll, loadJson,
};
