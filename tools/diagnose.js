// Run on your machine/Render shell:  node tools/diagnose.js
// Shows, per domain: SRV target, A records, and whether they share an IP.
const dns = require("dns").promises;
const { SERVERS } = require("../lib/common");
(async () => {
  const byIp = {};
  for (const d of SERVERS) {
    let srv = null, ips = [];
    try { const r = await dns.resolveSrv(`_minecraft._tcp.${d}`); srv = `${r[0].name}:${r[0].port}`; } catch {}
    try { ips = await dns.resolve4(srv ? srv.split(":")[0] : d); } catch {}
    const key = `${ips.join(",") || "NO-DNS"}${srv ? ":" + srv.split(":")[1] : ":25565"}`;
    (byIp[key] = byIp[key] || []).push(d);
    console.log(d.padEnd(26), srv ? "SRV " + srv : "no SRV".padEnd(4), ips.join(",") || "NO A RECORD");
  }
  console.log("\n--- domains sharing the same ip:port (they WILL return the same MOTD/players) ---");
  for (const [k, v] of Object.entries(byIp)) if (v.length > 1) console.log(k, "=>", v.join(", "));
})();
