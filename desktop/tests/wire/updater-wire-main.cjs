/*
 * Updater wire run (release gate for the update-check ID fix).
 *
 * Launched by tests/wire/run-updater-wire.sh inside this app's own Electron
 * binary, with this app's own installed electron-updater and the app's
 * electron/updater-privacy.ts (bundled to CJS by the script). Nothing here
 * ships in the app: tests/ is outside the electron-builder file set.
 *
 * - Two raw TCP servers on 127.0.0.1 stand in for github.com (the feed) and
 *   GitHub's asset host. Every request's head is recorded byte for byte, so
 *   headers Chromium adds below electron-updater are visible too.
 * - The feed answers the real GitHub provider paths (releases.atom, then a 302
 *   from releases/download/... to the asset host), like production.
 * - Both servers set a cookie; a later request must not send it back.
 * - userData is an isolated temp folder (never the founder's profile), seeded
 *   with a known .updaterId so we can see whether its value is sent.
 * - autoInstallOnAppQuit is false and quitAndInstall is never called, so
 *   Squirrel never installs anything. The run quits after the zip is served.
 * - electron-updater caches downloads in ~/Library/Caches/<WIRE_CACHE_NAME>,
 *   shared by the three modes of one script run (so the later modes also do a
 *   differential download) and removed by the script at the end.
 *
 * WIRE_MODE=hardened applies hardenUpdaterPrivacy first; WIRE_MODE=bite does
 * not (proves this harness can see the header at all); WIRE_MODE=hardened-session
 * also tries a session-level hook that removes Accept-Language.
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const MODE = process.env.WIRE_MODE;
const OUT = process.env.WIRE_OUT;
const APP_DESKTOP = process.env.WIRE_APP_DESKTOP;
const USERDATA = process.env.WIRE_USERDATA;
const PRIVACY_CJS = process.env.WIRE_PRIVACY_CJS;
if (!/^updater-wire-run-[A-Za-z0-9]+$/.test(process.env.WIRE_CACHE_NAME || '')) { console.error('bad WIRE_CACHE_NAME'); process.exit(2); }
const OWNER = 'RBJGlobal';
const REPO = process.env.WIRE_REPO;
const SEEDED_ID = '11111111-2222-4333-8444-555555555555';
const NEW = '9.9.9';
if (!['hardened', 'bite', 'hardened-session'].includes(MODE) || !OUT || !APP_DESKTOP || !USERDATA || !REPO) {
  console.error('missing WIRE_* env');
  process.exit(2);
}

app.setPath('userData', USERDATA);
fs.mkdirSync(USERDATA, { recursive: true });
fs.writeFileSync(path.join(USERDATA, '.updaterId'), SEEDED_ID);

const zip = crypto.randomBytes(64 * 1024);
const sha512 = crypto.createHash('sha512').update(zip).digest('base64');
const ZIP = `Wire-${NEW}-arm64-mac.zip`;
const RELEASES = `/${OWNER}/${REPO}/releases`;
const records = [];

function startServer(name, handler) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const [requestLine, ...headerLines] = head.split('\r\n');
        const [method, reqPath] = requestLine.split(' ');
        records.push({ server: name, method, path: reqPath, headers: headerLines });
        const r = handler(reqPath);
        const lines = [`HTTP/1.1 ${r.status} X`, `Content-Length: ${r.body.length}`, 'Connection: close'];
        for (const [k, v] of Object.entries(r.headers || {})) lines.push(`${k}: ${v}`);
        sock.end(Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'), r.body]));
        buf = Buffer.alloc(0);
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  let assetPort = 0;
  let feedCookieSent = false;
  let assetCookieSent = false;
  const asset = await startServer('asset', (p) => {
    const cookie = assetCookieSent ? {} : { 'Set-Cookie': 'wireasset=1; Path=/' };
    assetCookieSent = true;
    if (p === `/assets/v${NEW}/latest-mac.yml`) {
      const yml = `version: ${NEW}\nfiles:\n  - url: ${ZIP}\n    sha512: ${sha512}\n    size: ${zip.length}\npath: ${ZIP}\nsha512: ${sha512}\nreleaseDate: '2026-11-01T00:00:00.000Z'\n`;
      return { status: 200, headers: { 'Content-Type': 'text/yaml', ...cookie }, body: Buffer.from(yml) };
    }
    if (p === `/assets/v${NEW}/${ZIP}`) {
      setTimeout(finish, 3000);
      return { status: 200, headers: { 'Content-Type': 'application/zip', ...cookie }, body: zip };
    }
    return { status: 404, headers: cookie, body: Buffer.from('no') };
  });
  assetPort = asset.port;
  const feed = await startServer('feed', (p) => {
    const cookie = feedCookieSent ? {} : { 'Set-Cookie': 'wirefeed=1; Path=/' };
    feedCookieSent = true;
    if (p === `${RELEASES}.atom`) {
      const entry = `<entry><id>tag:github.com,2008:Repository/1/v${NEW}</id><updated>2026-11-01T00:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/v${NEW}"/><title>v${NEW}</title><content type="html">wire</content></entry>`;
      const atom = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US"><id>tag:github.com,2008:/${OWNER}/${REPO}/releases</id>${entry}</feed>`;
      return { status: 200, headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', ...cookie }, body: Buffer.from(atom) };
    }
    if (p === `/api/v3/repos/${OWNER}/${REPO}/releases/latest`) {
      // A custom feed host makes the GitHub provider ask the API for the tag.
      return { status: 200, headers: { 'Content-Type': 'application/json', ...cookie }, body: Buffer.from(JSON.stringify({ tag_name: `v${NEW}` })) };
    }
    const dl = `${RELEASES}/download/v${NEW}/`;
    if (p.startsWith(dl)) {
      return { status: 302, headers: { Location: `http://127.0.0.1:${assetPort}/assets/v${NEW}/${p.slice(dl.length)}`, ...cookie }, body: Buffer.alloc(0) };
    }
    return { status: 404, headers: cookie, body: Buffer.from('no') };
  });

  const { autoUpdater } = require(path.join(APP_DESKTOP, 'node_modules', 'electron-updater'));
  let hardening = null;
  if (MODE === 'hardened-session') {
    // Experiment only: can a session-level hook on electron-updater's own
    // partition remove the Accept-Language that Chromium adds?
    const { session } = require('electron');
    session.fromPartition('electron-updater', { cache: false }).webRequest.onBeforeSendHeaders((details, cb) => {
      const h = { ...details.requestHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'accept-language') delete h[k];
      cb({ requestHeaders: h });
    });
  }
  if (MODE === 'hardened' || MODE === 'hardened-session') {
    const { hardenUpdaterPrivacy } = require(PRIVACY_CJS);
    hardening = hardenUpdaterPrivacy(autoUpdater);
    if (!hardening.ok) {
      write({ error: 'hardening refused', hardening });
      return app.exit(3);
    }
  }
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // The download step reads the feed config from dev-app-update.yml in an
  // unpackaged run; write the same loopback config there.
  fs.writeFileSync(path.join(app.getAppPath(), 'dev-app-update.yml'),
    `provider: github\nowner: ${OWNER}\nrepo: ${REPO}\nhost: 127.0.0.1:${feed.port}\nprotocol: http\nupdaterCacheDirName: ${process.env.WIRE_CACHE_NAME}\n`);
  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, host: `127.0.0.1:${feed.port}`, protocol: 'http' });
  autoUpdater.on('error', (e) => { errors.push(String(e && e.message || e).slice(0, 300)); });
  const errors = [];
  global.__wire = { hardening, errors, feedPort: feed.port, assetPort };
  setTimeout(() => { errors.push('timeout'); finish(); }, 30000);
  autoUpdater.checkForUpdates().catch((e) => errors.push(String(e && e.message || e).slice(0, 300)));
}

function write(extra) {
  const idPath = path.join(USERDATA, '.updaterId');
  const idNow = fs.existsSync(idPath) ? fs.readFileSync(idPath, 'utf8') : null;
  const doc = {
    mode: MODE,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    electronUpdater: require(path.join(APP_DESKTOP, 'node_modules', 'electron-updater', 'package.json')).version,
    seededId: SEEDED_ID,
    updaterIdAfter: idNow,
    seededIdSentAnywhere: records.some((r) => r.headers.some((h) => h.includes(SEEDED_ID))),
    stagingHeaderSeen: records.some((r) => r.headers.some((h) => /^x-user-staging-id:/i.test(h))),
    cookieSentBack: records.some((r) => r.headers.some((h) => /^cookie:/i.test(h))),
    records,
    ...(global.__wire || {}),
    ...extra,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  write({});
  app.exit(0);
}

app.whenReady().then(main);
