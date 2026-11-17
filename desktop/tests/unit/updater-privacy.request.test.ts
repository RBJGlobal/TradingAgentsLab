/**
 * UPDATE-CHECK-SENDS-INSTALL-ID-1: request-level proof that the REAL electron-updater code, hardened by
 * hardenUpdaterPrivacy, sends no install ID on any request and never creates, reads or changes `.updaterId`.
 *
 * PORTABLE: imports only the function under test, the installed electron-updater, and Node built-ins. No app code.
 *
 * What runs for real: electron-updater's AppUpdater (check, download, executeDownload, differentialDownloadInstaller),
 * GitHubProvider, Provider, DifferentialDownloader, builder-util-runtime's HttpExecutor (request/doApiRequest,
 * download/downloadToBuffer/doDownload, prepareRedirectUrlOptions with its cross-origin header list,
 * configureRequestOptions) and ElectronHttpExecutor's own redirect handler (addRedirectHandlers, abort and re-issue).
 *
 * What is replaced: only ElectronHttpExecutor.createRequest, the one place the library calls
 * `require("electron").net.request`. `net` does not exist under bun, so a subclass of the real ElectronHttpExecutor
 * overrides createRequest with a raw-socket HTTP/1.1 client to 127.0.0.1 (no Node or bun HTTP client, so the
 * transport adds no header of its own except Host). It models Electron's net redirect contract as upstream net.ts
 * documents it: on a 3xx it emits `redirect` (statusCode, method, url, headers) and never hands the 3xx to the
 * response callback; in "manual" mode the redirect is cancelled unless followRedirect() is called synchronously; in
 * "follow" mode it is followed unless aborted. A followed redirect is re-sent by the transport itself with the same
 * headers (that stands in for Chromium following on its own) and does not go back through createRequest. This
 * Electron build ships net.ts only as compiled bytecode, so that contract is taken from upstream, not read here.
 * Hostnames are mapped: github.com to the fake feed host, release-assets.githubusercontent.com to the fake asset
 * host (both 127.0.0.1, ports 41000-49999). Any other host fails the request. Request paths are as in production.
 * The updater subclass (ProofUpdater) copies MacUpdater.doDownloadUpdate's task (update.zip, differential first, full
 * download on fallback) without its arch probing (sysctl, uname) or Squirrel.Mac (the port-0 local proxy).
 *
 * What this test does NOT prove (only a launched Electron run can show these):
 * - headers that Chromium's network stack adds (Accept-Encoding, Accept-Language from the app locale, Connection,
 *   sec-* or others), and the real Host and TLS details;
 * - cookies: whether the "electron-updater" session partition stores or sends any (net.request useSessionCookies);
 * - redirects Chromium follows by itself, beyond the model above (for example which headers Chromium drops on a
 *   cross-origin redirect);
 * - proxy and login behaviour, HTTP/2, and the Squirrel.Mac and Windows installer steps after the download;
 * - the Windows NSIS and Linux AppImage download tasks (their differential paths are read in the drift test, not run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { hardenUpdaterPrivacy } from '../../electron/updater-privacy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppUpdater } = require('electron-updater/out/AppUpdater');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findFile } = require('electron-updater/out/providers/Provider');

const FEED_HOST = 'github.com';
const ASSET_HOST = 'release-assets.githubusercontent.com';
const OWNER = 'acme';
const REPO = 'desktop-app';
const INSTALLED = '1.0.0';
const NEW = '2.0.0';
const BETA = '2.0.0-beta.1';
const CACHE_DIR_NAME = 'proof-updater';
/** A valid v4 UUID whose bytes 12 to 15 are ffffffff: the library's rollout maths puts it at 100%, outside any staged rollout. */
const SEEDED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaffffffff';

// ── Fake servers: raw TCP, so what is recorded is exactly what arrived on the wire ──────────────────────────────

interface Received { server: 'feed' | 'asset'; method: string; path: string; head: string; headers: Array<[string, string]> }
interface Reply { status: number; headers?: Record<string, string>; body?: Buffer | string }

const received: Received[] = [];
const servers: net.Server[] = [];

function reason(status: number): string {
  return ({ 200: 'OK', 206: 'Partial Content', 302: 'Found', 404: 'Not Found', 416: 'Range Not Satisfiable' } as Record<number, string>)[status] ?? 'X';
}

function listen(name: Received['server'], handler: (r: Received) => Reply): Promise<number> {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      const [requestLine, ...lines] = head.split('\r\n');
      const [method, p] = requestLine.split(' ');
      const headers = lines.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string]; });
      const r: Received = { server: name, method, path: p, head, headers };
      received.push(r);
      const reply = handler(r);
      const body = reply.body == null ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body);
      const out = [`HTTP/1.1 ${reply.status} ${reason(reply.status)}`];
      for (const [k, v] of Object.entries(reply.headers ?? {})) out.push(`${k}: ${v}`);
      out.push(`Content-Length: ${body.length}`, 'Connection: close', '', '');
      socket.end(Buffer.concat([Buffer.from(out.join('\r\n'), 'latin1'), body]));
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const port = 41000 + crypto.randomInt(0, 9000);
      server.once('error', (e: any) => { if (e?.code === 'EADDRINUSE' && ++tries < 20) attempt(); else reject(e); });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    attempt();
  });
}

// ── Release content ─────────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 4096;
const blockA = Buffer.alloc(BLOCK, 0x61);
const blockB = Buffer.alloc(BLOCK, 0x62);
const blockC = Buffer.alloc(BLOCK, 0x63);
const oldZip = Buffer.concat([blockA, blockB]);
const newZip = Buffer.concat([blockA, blockC]);
const sha512 = (b: Buffer) => crypto.createHash('sha512').update(b).digest('base64');
const blockmap = (sums: string[]) => zlib.gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: sums, sizes: [BLOCK, BLOCK] }] }));
const zipName = (v: string) => `Desktop-App-${v}-mac.zip`;
const yml = (v: string, size: number, digest: string, extra = '') =>
  `version: ${v}\nfiles:\n  - url: ${zipName(v)}\n    sha512: ${digest}\n    size: ${size}\npath: ${zipName(v)}\nsha512: ${digest}\nreleaseDate: '2026-11-01T00:00:00.000Z'\n${extra}`;
const entry = (tag: string) =>
  `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-11-01T00:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/><title>${tag}</title><content type="html">notes ${tag}</content></entry>`;
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US"><id>tag:github.com,2008:/${OWNER}/${REPO}/releases</id>${entry(`v${BETA}`)}${entry(`v${NEW}`)}</feed>`;

/** Asset store, keyed by `<tag>/<file>`. `stagingPercentage` is switched per test. */
let stagingLine = '';
function assets(): Record<string, Buffer> {
  return {
    [`v${NEW}/latest-mac.yml`]: Buffer.from(yml(NEW, newZip.length, sha512(newZip), stagingLine)),
    [`v${BETA}/beta-mac.yml`]: Buffer.from(yml(BETA, newZip.length, sha512(newZip))),
    [`v${NEW}/${zipName(NEW)}`]: newZip,
    [`v${NEW}/${zipName(NEW)}.blockmap`]: blockmap(['sum-a', 'sum-c']),
    [`v${INSTALLED}/${zipName(INSTALLED)}.blockmap`]: blockmap(['sum-a', 'sum-b']),
  };
}

const RELEASES = `/${OWNER}/${REPO}/releases`;
function feedHandler(r: Received): Reply {
  if (r.path === `${RELEASES}.atom`) return { status: 200, headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' }, body: ATOM };
  if (r.path === `${RELEASES}/latest`) return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: `v${NEW}` }) };
  const m = new RegExp(`^${RELEASES}/download/([^/]+)/([^/?]+)$`).exec(r.path);
  if (m && assets()[`${m[1]}/${m[2]}`]) {
    // As GitHub does: a 302 to a signed URL on another host.
    return { status: 302, headers: { Location: `https://${ASSET_HOST}/assets/${m[1]}/${m[2]}?sig=s1&exp=1` } };
  }
  return { status: 404, body: 'not found' };
}
function assetHandler(r: Received): Reply {
  const m = /^\/assets\/([^/]+)\/([^/?]+)\?sig=s1&exp=1$/.exec(r.path);
  const body = m ? assets()[`${m[1]}/${m[2]}`] : undefined;
  if (!body) return { status: 404, body: 'not found' };
  const range = r.headers.find(([k]) => k.toLowerCase() === 'range')?.[1];
  if (range) {
    const rm = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!rm) return { status: 416 };
    const a = Number(rm[1]);
    const b = Number(rm[2]);
    return { status: 206, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Type': 'application/octet-stream' }, body: body.subarray(a, b + 1) };
  }
  return { status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' }, body };
}

// ── Transport: the real ElectronHttpExecutor with only createRequest replaced ──────────────────────────────────

const transport = { createRequest: 0, follows: 0 };
let hostPorts: Record<string, number> = {};

class LoopbackNetRequest extends EventEmitter {
  private aborted = false;
  private followCb: (() => void) | null = null;
  private socket: net.Socket | null = null;
  private readonly headers: Array<[string, string]>;
  private readonly method: string;
  private readonly mode: string;
  constructor(private readonly options: any, private readonly callback: (res: any) => void) {
    super();
    // net.request applies options.headers when the request is made.
    this.headers = Object.entries(options.headers ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
    this.method = String(options.method || 'GET').toUpperCase();
    this.mode = options.redirect || 'follow';
  }
  end(data?: Buffer): void {
    if (data && data.length) throw new Error('proof transport: request bodies are not expected');
    const port = this.options.port ? `:${this.options.port}` : '';
    this.send(new URL(`${this.options.protocol || 'https:'}//${this.options.hostname}${port}${this.options.path || '/'}`));
  }
  abort(): void { this.aborted = true; this.socket?.destroy(); }
  followRedirect(): void {
    if (!this.followCb) throw new Error('followRedirect() called outside a redirect event');
    this.followCb();
  }
  private send(url: URL): void {
    const port = hostPorts[url.hostname];
    if (!port || url.port) { queueMicrotask(() => this.emit('error', new Error(`proof transport: unmapped host ${url.host}`))); return; }
    const lines = [`${this.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.hostname}`, ...this.headers.map(([k, v]) => `${k}: ${v}`), '', ''];
    const socket = net.connect({ host: '127.0.0.1', port });
    this.socket = socket;
    let buf = Buffer.alloc(0);
    let body: PassThrough | null = null;
    let left = 0;
    socket.on('error', (e) => { if (!this.aborted) this.emit('error', e); });
    socket.on('data', (chunk) => {
      if (body) { this.push(body, chunk, () => left, (n) => { left = n; }); return; }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [statusLine, ...hl] = buf.subarray(0, end).toString('latin1').split('\r\n');
      const statusCode = Number(statusLine.split(' ')[1]);
      const headers: Record<string, string> = {};
      for (const l of hl) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      const rest = buf.subarray(end + 4);
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        socket.destroy();
        this.redirect(statusCode, new URL(headers.location, url).href, headers);
        return;
      }
      body = new PassThrough();
      Object.assign(body, { statusCode, statusMessage: statusLine.split(' ').slice(2).join(' '), headers });
      left = Number(headers['content-length'] ?? 0);
      this.callback(body);
      if (left === 0) { body.end(); socket.destroy(); return; }
      this.push(body, rest, () => left, (n) => { left = n; });
    });
    socket.write(lines.join('\r\n'), 'latin1');
  }
  private push(body: PassThrough, chunk: Buffer, get: () => number, set: (n: number) => void): void {
    if (!chunk.length) return;
    const n = Math.min(chunk.length, get());
    body.write(chunk.subarray(0, n));
    set(get() - n);
    if (get() === 0) { body.end(); this.socket?.destroy(); }
  }
  private redirect(statusCode: number, location: string, headers: Record<string, string>): void {
    if (this.mode === 'error') { this.emit('error', new Error("Attempted to redirect, but redirect policy was 'error'")); return; }
    let followed = this.mode === 'follow';
    this.followCb = () => { followed = true; };
    try {
      this.emit('redirect', statusCode, this.method, location, headers);
    } finally {
      this.followCb = null;
    }
    if (this.aborted) return;
    if (!followed) { this.emit('error', new Error('Redirect was cancelled')); return; }
    transport.follows++;
    this.send(new URL(location));
  }
}

class LoopbackNetExecutor extends ElectronHttpExecutor {
  constructor() { super(null); }
  createRequest(options: any, callback: (res: any) => void): LoopbackNetRequest {
    transport.createRequest++;
    // As the real createRequest does before net.request (electronHttpExecutor.js:44-49).
    if (options.headers && options.headers.Host) { options.host = options.headers.Host; delete options.headers.Host; }
    return new LoopbackNetRequest(options, callback);
  }
}

// ── The updater: real AppUpdater, MacUpdater's download task ────────────────────────────────────────────────

class ProofUpdater extends AppUpdater {
  quitAndInstall(): void { /* never */ }
  doDownloadUpdate(downloadUpdateOptions: any): Promise<string[]> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider;
    const files = provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info);
    const zipFileInfo = findFile(files, 'zip', ['pkg', 'dmg']);
    const self = this as any;
    return self.executeDownload({
      fileExtension: 'zip',
      fileInfo: zipFileInfo,
      downloadUpdateOptions,
      task: async (destinationFile: string, downloadOptions: any) => {
        const cached = path.join(self.downloadedUpdateHelper.cacheDir, 'update.zip');
        let failed = true;
        if (fs.existsSync(cached) && !downloadUpdateOptions.disableDifferentialDownload) {
          failed = await self.differentialDownloadInstaller(zipFileInfo, downloadUpdateOptions, destinationFile, provider, 'update.zip');
        }
        if (failed) await self.httpExecutor.download(zipFileInfo.url, destinationFile, downloadOptions);
      },
      done: async (event: any) => {
        fs.copyFileSync(event.downloadedFile, path.join(self.downloadedUpdateHelper.cacheDir, 'update.zip'));
        return [];
      },
    });
  }
}

interface Run { root: string; userData: string; cacheDir: string; updater: any; logs: string[]; spyCalls: () => number }

let spyCount = 0;
const roots: string[] = [];
const originalGetOrCreate = AppUpdater.prototype.getOrCreateStagingUserId;

function makeRun(opts: { harden: boolean; seedId?: string; seedZip?: boolean; beta?: boolean }): Run {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-privacy-proof-'));
  roots.push(root);
  const userData = path.join(root, 'userData');
  const cacheBase = path.join(root, 'cache');
  const cacheDir = path.join(cacheBase, CACHE_DIR_NAME);
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const cfg = path.join(root, 'app-update.yml');
  fs.writeFileSync(cfg, `owner: ${OWNER}\nrepo: ${REPO}\nprovider: github\nreleaseType: release\nupdaterCacheDirName: ${CACHE_DIR_NAME}\n`);
  if (opts.seedId) fs.writeFileSync(path.join(userData, '.updaterId'), opts.seedId);
  if (opts.seedZip) fs.writeFileSync(path.join(cacheDir, 'update.zip'), oldZip);
  const app = {
    version: INSTALLED, name: 'Desktop App', isPackaged: true, appUpdateConfigPath: cfg, userDataPath: userData, baseCachePath: cacheBase,
    whenReady: () => Promise.resolve(), quit() {}, relaunch() {}, onQuit() {},
  };
  const updater: any = new ProofUpdater(null, app);
  const logs: string[] = [];
  const keep = (level: string) => (m: unknown) => { logs.push(`${level} ${String(m)}`); };
  updater.logger = { info: keep('info'), warn: keep('warn'), error: keep('error'), debug: keep('debug') };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater._testOnlyOptions = { platform: 'darwin', isUseDifferentialDownload: true };
  if (opts.beta) { updater.channel = 'beta'; updater.allowPrerelease = true; }
  // As in production the executor exists before the hardening runs (AppUpdater constructor, app == null).
  updater.httpExecutor = new LoopbackNetExecutor();
  if (opts.harden) {
    const r = hardenUpdaterPrivacy(updater);
    if (!r.ok) throw new Error(`hardening refused on the real AppUpdater: ${r.missing.join('; ')}`);
  }
  const before = spyCount;
  return { root, userData, cacheDir, updater, logs, spyCalls: () => spyCount - before };
}

function reset(): void { received.length = 0; transport.createRequest = 0; transport.follows = 0; }
/** Header names as received, in order, Host included. */
const names = (r: Received) => r.headers.map(([k]) => k);
const hasStagingHeader = (r: Received) => r.headers.some(([k]) => k.toLowerCase() === 'x-user-staging-id');
const view = (r: Received) => ({ server: r.server, path: r.path, headers: r.headers });

beforeAll(async () => {
  AppUpdater.prototype.getOrCreateStagingUserId = function (this: unknown) { spyCount++; return originalGetOrCreate.call(this); };
  const feedPort = await listen('feed', feedHandler);
  const assetPort = await listen('asset', assetHandler);
  hostPorts = { [FEED_HOST]: feedPort, [ASSET_HOST]: assetPort };
});
afterAll(() => {
  AppUpdater.prototype.getOrCreateStagingUserId = originalGetOrCreate;
  for (const s of servers) s.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// The exact requests, headers (names and values, in arrival order) of a hardened stable check.
const CHECK_HARDENED = [
  { server: 'feed', path: `${RELEASES}.atom`, headers: [['Host', FEED_HOST], ['accept', 'application/xml, application/atom+xml, text/xml, */*'], ['User-Agent', 'electron-builder'], ['Cache-Control', 'no-cache']] },
  { server: 'feed', path: `${RELEASES}/latest`, headers: [['Host', FEED_HOST], ['Accept', 'application/json'], ['User-Agent', 'electron-builder'], ['Cache-Control', 'no-cache']] },
  { server: 'feed', path: `${RELEASES}/download/v${NEW}/latest-mac.yml`, headers: [['Host', FEED_HOST], ['User-Agent', 'electron-builder'], ['Cache-Control', 'no-cache']] },
  { server: 'asset', path: `/assets/v${NEW}/latest-mac.yml?sig=s1&exp=1`, headers: [['Host', ASSET_HOST], ['User-Agent', 'electron-builder'], ['Cache-Control', 'no-cache']] },
];
const DL = [['accept', '*/*'], ['User-Agent', 'electron-builder'], ['Cache-Control', 'no-cache']];
const FULL_DOWNLOAD = [
  { server: 'feed', path: `${RELEASES}/download/v${NEW}/${zipName(NEW)}`, headers: [['Host', FEED_HOST], ...DL] },
  { server: 'asset', path: `/assets/v${NEW}/${zipName(NEW)}?sig=s1&exp=1`, headers: [['Host', ASSET_HOST], ...DL] },
];
const DIFF_DOWNLOAD = [
  { server: 'feed', path: `${RELEASES}/download/v${NEW}/${zipName(NEW)}.blockmap`, headers: [['Host', FEED_HOST], ...DL] },
  { server: 'asset', path: `/assets/v${NEW}/${zipName(NEW)}.blockmap?sig=s1&exp=1`, headers: [['Host', ASSET_HOST], ...DL] },
  // The OLD blockmap: its path names the installed version, in the tag folder and in the file name.
  { server: 'feed', path: `${RELEASES}/download/v${INSTALLED}/${zipName(INSTALLED)}.blockmap`, headers: [['Host', FEED_HOST], ...DL] },
  { server: 'asset', path: `/assets/v${INSTALLED}/${zipName(INSTALLED)}.blockmap?sig=s1&exp=1`, headers: [['Host', ASSET_HOST], ...DL] },
  // The range request: GitHub's provider turns off multi-range, so DifferentialDownloader's single-range path runs;
  // it answers the redirect with followRedirect(), so the transport (standing in for Chromium) follows it with the same headers.
  { server: 'feed', path: `${RELEASES}/download/v${NEW}/${zipName(NEW)}`, headers: [['Host', FEED_HOST], ...DL, ['range', `bytes=${BLOCK}-${2 * BLOCK - 1}`]] },
  { server: 'asset', path: `/assets/v${NEW}/${zipName(NEW)}?sig=s1&exp=1`, headers: [['Host', ASSET_HOST], ...DL, ['range', `bytes=${BLOCK}-${2 * BLOCK - 1}`]] },
];

describe('updater privacy, request level (real electron-updater 6.8.9 code)', () => {
  test('hardened, fresh install: check then full download; exact requests and headers; no ID anywhere; no .updaterId', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: true });
    const result = await run.updater.checkForUpdates();
    expect(result.isUpdateAvailable).toBe(true);
    expect(received.map(view)).toEqual(CHECK_HARDENED as any);
    reset();
    await run.updater.downloadUpdate();
    expect(received.map(view)).toEqual(FULL_DOWNLOAD as any);
    expect(fs.readFileSync(path.join(run.cacheDir, 'update.zip'))).toEqual(newZip);
    expect(fs.existsSync(path.join(run.userData, '.updaterId'))).toBe(false);
    expect(fs.readdirSync(run.userData)).toEqual([]);
    expect(run.spyCalls()).toBe(0);
    expect(run.logs.some((l) => /user id|staging user id/i.test(l))).toBe(false);
  }, 30_000);

  test('hardened, differential download: blockmaps and the range request carry no ID; the old blockmap path names the installed version', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: true, seedZip: true });
    await run.updater.checkForUpdates();
    reset();
    await run.updater.downloadUpdate();
    expect(received.map(view)).toEqual(DIFF_DOWNLOAD as any);
    // The differential path really ran (no silent fallback to a full download): the result is the new file, and
    // the full-file GET without a range never happened.
    expect(received.filter((r) => /\.zip(\?|$)/.test(r.path) && !r.headers.some(([k]) => k.toLowerCase() === 'range'))).toEqual([]);
    expect(fs.readFileSync(path.join(run.cacheDir, 'update.zip'))).toEqual(newZip);
    expect(received.some(hasStagingHeader)).toBe(false);
    expect(fs.existsSync(path.join(run.userData, '.updaterId'))).toBe(false);
    expect(run.spyCalls()).toBe(0);
    // One createRequest per request the library issued; one transport follow per range redirect.
    expect(transport.follows).toBe(1);
  }, 30_000);

  test('hardened, an existing .updaterId: its value is on no request and in no log, the file is byte for byte unchanged', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: true, seedId: SEEDED_ID, seedZip: true });
    const file = path.join(run.userData, '.updaterId');
    const bytesBefore = fs.readFileSync(file);
    const statBefore = fs.statSync(file);
    await run.updater.checkForUpdates();
    await run.updater.downloadUpdate();
    const all = received.map((r) => r.head).join('\n');
    expect(all.includes(SEEDED_ID)).toBe(false);
    expect(all.toLowerCase().includes('x-user-staging-id')).toBe(false);
    expect(all.includes('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(run.logs.some((l) => l.includes(SEEDED_ID))).toBe(false);
    expect(fs.readFileSync(file)).toEqual(bytesBefore);
    const statAfter = fs.statSync(file);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(run.spyCalls()).toBe(0);
  }, 30_000);

  test('hardened, a staged-rollout feed: the update is still offered, and the ID is never read', async () => {
    reset();
    stagingLine = 'stagingPercentage: 1\n';
    const run = makeRun({ harden: true, seedId: SEEDED_ID });
    const result = await run.updater.checkForUpdates();
    stagingLine = '';
    expect(result.isUpdateAvailable).toBe(true);
    expect(run.spyCalls()).toBe(0);
    expect(run.logs.some((l) => /staging percentage|user id/i.test(l))).toBe(false);
    expect(received.some(hasStagingHeader)).toBe(false);
  }, 30_000);

  test('hardened, beta channel: the atom feed and beta-mac.yml only, no ID', async () => {
    reset();
    const run = makeRun({ harden: true, beta: true });
    const result = await run.updater.checkForUpdates();
    expect(result.updateInfo.version).toBe(BETA);
    expect(received.map((r) => `${r.server} ${r.path}`)).toEqual([
      `feed ${RELEASES}.atom`,
      `feed ${RELEASES}/download/v${BETA}/beta-mac.yml`,
      `asset /assets/v${BETA}/beta-mac.yml?sig=s1&exp=1`,
    ]);
    expect(received.some(hasStagingHeader)).toBe(false);
    expect(fs.existsSync(path.join(run.userData, '.updaterId'))).toBe(false);
  }, 30_000);

  test('the servers saw exactly the requests the transport sent (no hidden retries or follows)', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: true, seedZip: true });
    await run.updater.checkForUpdates();
    await run.updater.downloadUpdate();
    expect(received.length).toBe(transport.createRequest + transport.follows);
  }, 30_000);

  // ── Bite: the same harness WITHOUT the function shows the defect, so the cases above can fail ──────────────────

  test('BITE (no hardening): every check request carries x-user-staging-id, including after the cross-origin redirect, and .updaterId is created', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: false });
    await run.updater.checkForUpdates();
    const file = path.join(run.userData, '.updaterId');
    expect(fs.existsSync(file)).toBe(true);
    const id = fs.readFileSync(file, 'utf8');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(received.map((r) => `${r.server} ${r.path}`)).toEqual(CHECK_HARDENED.map((r) => `${r.server} ${r.path}`));
    for (const r of received) {
      expect(r.headers.find(([k]) => k === 'x-user-staging-id')?.[1]).toBe(id);
    }
    expect(names(received[3])).toEqual(['Host', 'x-user-staging-id', 'User-Agent', 'Cache-Control']);
    expect(run.spyCalls()).toBe(1);
    // Downloads never carried the ID in 6.8.9 (computeRequestHeaders gives {accept:"*/*"}): the download header
    // lists above are a regression pin, not a bite.
    reset();
    await run.updater.downloadUpdate();
    expect(received.map(view)).toEqual(FULL_DOWNLOAD as any);
  }, 30_000);

  test('BITE (no hardening): an existing .updaterId value is sent as the header', async () => {
    reset();
    stagingLine = '';
    const run = makeRun({ harden: false, seedId: SEEDED_ID });
    await run.updater.checkForUpdates();
    expect(received.length).toBe(4);
    for (const r of received) expect(r.headers.find(([k]) => k === 'x-user-staging-id')?.[1]).toBe(SEEDED_ID);
  }, 30_000);

  test('BITE (no hardening): a staged-rollout feed withholds the update from this ID', async () => {
    reset();
    stagingLine = 'stagingPercentage: 1\n';
    const run = makeRun({ harden: false, seedId: SEEDED_ID });
    const result = await run.updater.checkForUpdates();
    stagingLine = '';
    expect(result.isUpdateAvailable).toBe(false);
    expect(run.logs.some((l) => l.includes(`user id: ${SEEDED_ID}`))).toBe(true);
  }, 30_000);
});
