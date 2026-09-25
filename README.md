# MinecraftAsia — Node.js edition (Pterodactyl / any Node host)

One continuous Node.js process: serves the site AND runs the poller
in-process every 60 seconds, with true no-gap per-minute data. No GitHub,
no git, no cron needed — everything lives on this one host.

## Deploy on Pterodactyl

1. Upload this whole folder's contents to your server via the panel's file
   manager (or SFTP) — into the root directory of your Node.js app.
2. In the panel's Startup tab, make sure the startup command runs
   `node server.js` (or set the "main file" variable to `server.js` if
   your egg uses a variable for that).
3. Open the panel's Console, run `npm install` once (or use the panel's
   "Install"/"Reinstall" button if it runs npm install for you).
4. Start the server. Console should show:
   `[server] MinecraftAsia listening on http://0.0.0.0:<port>`
   followed by `[poller] sample ok — X/12 servers up` every minute.
5. Visit `http://<your-ip>:<port>/` — the board should populate within
   about a minute (the first sample runs immediately on boot).

**Port**: the server reads `SERVER_PORT` or `PORT` from the environment
(whichever your Pterodactyl egg sets — most Node.js eggs use
`SERVER_PORT`). It always binds `0.0.0.0`, which Pterodactyl requires.

## Getting HTTPS on top of this (Cloudflare — recommended)

Pterodactyl gives you a raw IP:port with no way to bind port 80/443 or get
a certificate directly, so put Cloudflare in front instead — it's free and
gives real HTTPS without touching this app at all:

1. Point your domain's nameservers at Cloudflare (Cloudflare walks you
   through this when you add the site).
2. DNS tab → Add record → Type `A`, Name `rank` (or whatever subdomain you
   want), IPv4 address = your Pterodactyl node's IP, Proxy status =
   **Proxied** (orange cloud).
3. SSL/TLS tab → set encryption mode to **Flexible** (browser↔Cloudflare
   is HTTPS; Cloudflare↔your server stays plain HTTP, which is fine since
   this is a public read-only ranking board with no logins).
4. Rules → Origin Rules → Create rule → When hostname equals
   `rank.yourdomain.com` → then rewrite **Destination Port** to your
   Pterodactyl port (e.g. `25566`). This is the step that lets Cloudflare
   reach your non-standard port while visitors just use `https://` with no
   port in the URL.
5. (Optional but recommended) SSL/TLS → Edge Certificates → turn on
   "Always Use HTTPS" so any stray `http://` links get redirected.
6. Wait a few minutes for DNS, then visit `https://rank.yourdomain.com`.

If you ever want real end-to-end encryption instead of Cloudflare
terminating it (SSL mode "Full/Strict"), that needs a certificate issued
via DNS-01 challenge (since you can't bind port 80 for HTTP-01) — happy to
set that up later if you want it; Flexible is the standard, zero-hassle
choice for a hobby project like this.

## Data ranges / ranking formula / font

Unchanged from the GitHub version — see the code comments in
`lib/common.js` and `css/style.css`. Weights: 30% online, 25% daily peak,
25% uptime, 20% ping.

## Local testing

```bash
npm install
node server.js
# open http://localhost:25566
```
