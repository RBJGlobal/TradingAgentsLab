/**
 * UPDATE-CHECK-SENDS-INSTALL-ID-1: drift test on the installed electron-updater SOURCE. Strict: it never skips; a
 * missing library is a failure. Every fact hardenUpdaterPrivacy and the request-level proof depend on is asserted
 * here, so a library update fails this test instead of silently changing what is sent.
 *
 * PORTABLE: resolves the library through require.resolve, reads only library files, imports no app code.
 * To port to another electron-updater version: set EXPECTED_* below to that version, run this file, and re-read
 * every failing fact in the named file before changing anything (docs/updater-privacy-PORTING.md).
 */
import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The one version this fix was proven on. Change only after re-proving (drift test + request-level test). */
const EXPECTED_ELECTRON_UPDATER = '6.8.9';
const EXPECTED_BUILDER_UTIL_RUNTIME = '9.7.0';

const EU = path.dirname(require.resolve('electron-updater/package.json'));
const BUR = path.dirname(require.resolve('builder-util-runtime/package.json', { paths: [EU] }));
const LAZY = path.dirname(require.resolve('lazy-val/package.json', { paths: [EU] }));

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}
const files = [...jsFiles(path.join(EU, 'out')), ...jsFiles(path.join(BUR, 'out'))];
const src = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const rel = (f: string) => (f.startsWith(EU) ? `electron-updater/${path.relative(EU, f)}` : `builder-util-runtime/${path.relative(BUR, f)}`);
const read = (pkgDir: string, p: string) => {
  const f = path.join(pkgDir, p);
  if (!src.has(f)) throw new Error(`missing library file ${f}: re-check UPDATE-CHECK-SENDS-INSTALL-ID-1 (was the library moved or upgraded?)`);
  return src.get(f)!;
};
const count = (s: string, needle: string | RegExp) => (typeof needle === 'string' ? s.split(needle).length - 1 : (s.match(new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : needle.flags + 'g')) ?? []).length);
/** Where `needle` occurs across both packages: { "electron-updater/out/X.js": n }. */
function where(needle: string | RegExp): Record<string, number> {
  const r: Record<string, number> = {};
  for (const [f, s] of src) { const n = count(s, needle); if (n) r[rel(f)] = n; }
  return r;
}
function must(ok: boolean, fact: string, file: string): void {
  if (!ok) {
    throw new Error(`electron-updater drift: ${fact} no longer holds in ${file}. Re-check UPDATE-CHECK-SENDS-INSTALL-ID-1: re-read that file, decide whether hardenUpdaterPrivacy still covers it, then re-run tests/unit/updater-privacy.request.test.ts. Do not just update this pin.`);
  }
}
const canon = (v: unknown): string => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v);
function mustEqual(actual: unknown, expected: unknown, fact: string, file: string): void {
  must(canon(actual) === canon(expected),`${fact} (expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)})`, file);
}

const APP_UPDATER = read(EU, 'out/AppUpdater.js');
const EXECUTOR = read(EU, 'out/electronHttpExecutor.js');
const PROVIDER = read(EU, 'out/providers/Provider.js');
const HTTP = read(BUR, 'out/httpExecutor.js');
const DIFF = read(EU, 'out/differentialDownloader/DifferentialDownloader.js');
const MAIN = read(EU, 'out/main.js');

describe('electron-updater drift pins (UPDATE-CHECK-SENDS-INSTALL-ID-1)', () => {
  test('versions are the proven ones', () => {
    const eu = JSON.parse(fs.readFileSync(path.join(EU, 'package.json'), 'utf8'));
    const bur = JSON.parse(fs.readFileSync(path.join(BUR, 'package.json'), 'utf8'));
    mustEqual(eu.version, EXPECTED_ELECTRON_UPDATER, 'installed electron-updater version', 'electron-updater/package.json');
    mustEqual(bur.version, EXPECTED_BUILDER_UTIL_RUNTIME, 'installed builder-util-runtime version', 'builder-util-runtime/package.json');
    mustEqual(eu.dependencies?.['builder-util-runtime'], EXPECTED_BUILDER_UTIL_RUNTIME, 'electron-updater pins builder-util-runtime exactly', 'electron-updater/package.json');
    expect(true).toBe(true);
  });

  test("the app's package.json pins electron-updater exactly to the proven version (no ^ or ~)", () => {
    // The app root: the nearest package.json above this test that lists electron-updater.
    let dir = __dirname;
    let found: string | null = null;
    while (dir !== path.dirname(dir)) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        const spec = pkg.dependencies?.['electron-updater'] ?? pkg.devDependencies?.['electron-updater'];
        if (spec !== undefined) { found = spec; break; }
      }
      dir = path.dirname(dir);
    }
    mustEqual(found, EXPECTED_ELECTRON_UPDATER, "the app's electron-updater specifier is the exact proven version", 'package.json');
    expect(true).toBe(true);
  });

  test('(a) the ID comes from one own-property Lazy, created in the constructor, read in two places, filled from .updaterId', () => {
    const F = 'electron-updater/out/AppUpdater.js';
    mustEqual(where('this.stagingUserIdPromise = new lazy_val_1.Lazy(() => this.getOrCreateStagingUserId());'), { [F]: 1 }, 'the constructor sets stagingUserIdPromise as a Lazy over getOrCreateStagingUserId', F);
    mustEqual(where('stagingUserIdPromise'), { [F]: 3 }, 'stagingUserIdPromise is set once and read twice (isStagingMatch, getUpdateInfoAndProvider)', F);
    mustEqual(where('await this.stagingUserIdPromise.value;'), { [F]: 2 }, 'both reads go through .value', F);
    mustEqual(where('getOrCreateStagingUserId'), { [F]: 2 }, 'getOrCreateStagingUserId is defined once and called only from the Lazy', F);
    mustEqual(where('.updaterId'), { [F]: 1 }, '.updaterId is named once', F);
    mustEqual(where('updaterId'), { [F]: 1 }, 'no other updaterId reference', F);
    const body = APP_UPDATER.slice(APP_UPDATER.indexOf('async getOrCreateStagingUserId() {'), APP_UPDATER.indexOf('/** @internal */\n    get isAddNoCacheQuery'));
    must(body.includes('const file = path.join(this.app.userDataPath, ".updaterId");'), '.updaterId lives in userDataPath and is named only inside getOrCreateStagingUserId', F);
    must(body.includes('(0, fs_extra_1.readFile)(file, "utf-8")') && body.includes('(0, fs_extra_1.outputFile)(file, id)'), 'getOrCreateStagingUserId is the only reader and writer of the file', F);
    mustEqual(count(APP_UPDATER, /\(0, fs_extra_1\.outputFile\)\(/g), 2, 'outputFile is used only for the ID file and current.blockmap', F);
    const lazy = fs.readFileSync(path.join(LAZY, 'out/main.js'), 'utf8');
    must(lazy.includes('get hasValue() {\n        return this.creator == null;\n    }'), 'lazy-val Lazy.hasValue is false until .value is first read', 'lazy-val/out/main.js');
    expect(true).toBe(true);
  });

  test('(a) the header is set in exactly one place, on the provider, for every check; the library never sets Accept-Language', () => {
    const F = 'electron-updater/out/AppUpdater.js';
    mustEqual(where(/x-user-staging-id/gi), { [F]: 1 }, 'x-user-staging-id appears once in both packages', F);
    must(APP_UPDATER.includes('const stagingUserId = await this.stagingUserIdPromise.value;\n        client.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId }));'), 'getUpdateInfoAndProvider reads the ID and sets it as a provider header on every check', F);
    mustEqual(where(/accept-language/gi), {}, 'the library never sets Accept-Language', 'both packages');
    must(PROVIDER.includes('result.headers = headers == null ? this.requestHeaders : { ...this.requestHeaders, ...headers };'), 'provider requestHeaders go on every check request', 'electron-updater/out/providers/Provider.js');
    expect(true).toBe(true);
  });

  test('(b) rollout: a public setter, used once in isUpdateAvailable; the default reads the ID through isStagingMatch', () => {
    const F = 'electron-updater/out/AppUpdater.js';
    must(APP_UPDATER.includes('set isUserWithinRollout(value) {\n        if (value) {\n            this._isUserWithinRollout = value;'), 'isUserWithinRollout has a public setter', F);
    must(APP_UPDATER.includes('this._isUserWithinRollout = updateInfo => this.isStagingMatch(updateInfo);'), 'the default rollout check is isStagingMatch', F);
    mustEqual(where('this.isUserWithinRollout(updateInfo)'), { [F]: 1 }, 'isUpdateAvailable calls isUserWithinRollout once', F);
    mustEqual(where('isStagingMatch('), { [F]: 2 }, 'isStagingMatch is defined once and used only as the default', F);
    expect(true).toBe(true);
  });

  test('(c) one request-creating function: ElectronHttpExecutor.createRequest, on every platform', () => {
    const X = 'electron-updater/out/electronHttpExecutor.js';
    mustEqual(where('net.request('), { [X]: 1 }, 'net.request is called once', X);
    must(EXECUTOR.includes('createRequest(options, callback) {') && EXECUTOR.includes('const request = require("electron").net.request({\n            ...options,\n            session: this.cachedSession,\n        });\n        request.on("response", callback);'), 'createRequest is the net.request call site and hands the response to the callback', X);
    must(EXECUTOR.includes('if (options.headers && options.headers.Host) {'), 'createRequest still moves a Host header to options.host (the proof transport copies this)', X);
    mustEqual(where(/createRequest\(options, callback\) \{/g), { [X]: 1 }, 'createRequest is defined only in ElectronHttpExecutor (builder-util-runtime HttpExecutor leaves it abstract)', X);
    mustEqual(where(/createRequest\(/g), {
      'builder-util-runtime/out/httpExecutor.js': 2,
      'electron-updater/out/differentialDownloader/DifferentialDownloader.js': 2,
      'electron-updater/out/differentialDownloader/multipleRangeDownloader.js': 2,
      [X]: 1,
    }, 'createRequest call sites: doApiRequest, doDownload, the two differential downloaders', 'both packages');
    mustEqual(where(/require\("(?:https|http2|net|tls|dgram|undici|node-fetch|axios)"\)/g), {}, 'no other network module is loaded', 'both packages');
    mustEqual(where('require("http")'), { 'electron-updater/out/MacUpdater.js': 1 }, 'http is loaded only by MacUpdater', 'electron-updater/out/MacUpdater.js');
    mustEqual(where(/http_1\.[A-Za-z]+/g), { 'electron-updater/out/MacUpdater.js': 1 }, 'MacUpdater uses http once', 'electron-updater/out/MacUpdater.js');
    must(read(EU, 'out/MacUpdater.js').includes('this.server = (0, http_1.createServer)();'), 'MacUpdater uses http only for its local Squirrel proxy server', 'electron-updater/out/MacUpdater.js');
    mustEqual(where(/\bfetch\(/g), {}, 'no fetch', 'both packages');
    mustEqual(where('require("electron")'), {
      'electron-updater/out/AppUpdater.js': 1,
      'electron-updater/out/BaseUpdater.js': 1,
      'electron-updater/out/ElectronAppAdapter.js': 1,
      'electron-updater/out/MacUpdater.js': 1,
      'electron-updater/out/NsisUpdater.js': 1,
      [X]: 2,
    }, 'the known electron uses only (Notification, autoUpdater, app, shell, session, net)', 'both packages');
    const F = 'electron-updater/out/AppUpdater.js';
    mustEqual(where(/\.httpExecutor = /g), { [F]: 2, 'electron-updater/out/differentialDownloader/DifferentialDownloader.js': 1 }, 'httpExecutor is set only in the AppUpdater constructor (and kept by DifferentialDownloader as given)', F);
    must(APP_UPDATER.includes('this.httpExecutor = new electronHttpExecutor_1.ElectronHttpExecutor((authInfo, callback) => this.emit("login", authInfo, callback));'), 'the constructor creates the ElectronHttpExecutor when no app adapter is passed', F);
    mustEqual(where('executor: this.httpExecutor'), { [F]: 1 }, 'providers get the same executor object', F);
    must(PROVIDER.includes('this.executor = runtimeOptions.executor;'), 'each provider keeps that executor object', 'electron-updater/out/providers/Provider.js');
    for (const cls of ['NsisUpdater', 'MacUpdater', 'AppImageUpdater', 'DebUpdater', 'RpmUpdater', 'PacmanUpdater']) {
      must(MAIN.includes(`new (require("./${cls}").${cls})()`), `the autoUpdater singleton for ${cls} is built with no app adapter (so it gets ElectronHttpExecutor)`, 'electron-updater/out/main.js');
    }
    expect(true).toBe(true);
  });

  test('redirects: the cross-origin strip list, and who follows a redirect', () => {
    const H = 'builder-util-runtime/out/httpExecutor.js';
    must(HTTP.includes('const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "proxyauthorization", "privatetoken", "xapikey", "xauthtoken", "xaccesstoken", "xgitlabtoken", "cookie", "xcsrftoken"]);'), 'the cross-origin redirect strip list is unchanged (and does not include x-user-staging-id)', H);
    must(HTTP.includes('const newOptions = configureRequestOptionsFromUrl(redirectUrl, { ...options });'), 'prepareRedirectUrlOptions copies the original options, headers included', H);
    const X = 'electron-updater/out/electronHttpExecutor.js';
    must(EXECUTOR.includes('request.on("redirect", (statusCode, method, redirectUrl) => {') && EXECUTOR.includes('request.abort();') && EXECUTOR.includes('handler(builder_util_runtime_1.HttpExecutor.prepareRedirectUrlOptions(redirectUrl, options));'), 'checks and full downloads: the library aborts a redirect and re-issues it through createRequest', X);
    must(EXECUTOR.includes('redirect: "manual",'), 'download() asks net for manual redirects', X);
    const D = 'electron-updater/out/differentialDownloader/DifferentialDownloader.js';
    must(DIFF.includes('requestOptions.redirect = "manual";') && DIFF.includes('request.followRedirect();'), 'differential single-range requests let net follow the redirect itself, with the same headers', D);
    expect(true).toBe(true);
  });

  test('download headers: accept */* plus the common ones; no provider adds its own on this config', () => {
    const F = 'electron-updater/out/AppUpdater.js';
    must(APP_UPDATER.includes('return this.computeFinalHeaders({ accept: "*/*" });'), 'downloads use {accept: */*} when the provider adds nothing', F);
    must(PROVIDER.includes('get fileExtraDownloadHeaders() {\n        return null;'), 'the base provider adds no download headers', 'electron-updater/out/providers/Provider.js');
    mustEqual(where('get fileExtraDownloadHeaders()'), { 'electron-updater/out/providers/Provider.js': 1, 'electron-updater/out/providers/PrivateGitHubProvider.js': 1 }, 'only PrivateGitHubProvider adds download headers', 'electron-updater/out/providers');
    must(read(EU, 'out/providerFactory.js').includes('const token = (githubOptions.private ? process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"] : null) || githubOptions.token;\n            if (token == null) {\n                return new GitHubProvider_1.GitHubProvider('), 'the public GitHub provider (no authorization header) is used unless private: true with GH_TOKEN or a token is configured', 'electron-updater/out/providerFactory.js');
    must(HTTP.includes('headers["User-Agent"] = "electron-builder";') && HTTP.includes('headers["Cache-Control"] = "no-cache";'), 'configureRequestOptions adds a constant User-Agent and Cache-Control', 'builder-util-runtime/out/httpExecutor.js');
    must(DIFF.includes('headers: {\n                ...this.options.requestHeaders,\n                accept: "*/*",\n            },'), 'range requests use the download headers plus accept', 'electron-updater/out/differentialDownloader/DifferentialDownloader.js');
    expect(true).toBe(true);
  });

  test('the installed version on a differential download: the old blockmap URL path', () => {
    must(PROVIDER.includes('`${baseUrl.pathname.replace(new RegExp(escapeRegExp(newVersion), "g"), oldVersion)}.blockmap`'), 'the old blockmap path is the new file path with every occurrence of the new version replaced by the installed one', 'electron-updater/out/providers/Provider.js');
    must(APP_UPDATER.includes('provider.getBlockMapFiles(fileInfo.url, this.app.version, downloadUpdateOptions.updateInfoAndProvider.info.version, this.previousBlockmapBaseUrlOverride)'), 'the installed version passed in is this.app.version', 'electron-updater/out/AppUpdater.js');
    must(APP_UPDATER.includes('let oldBlockMapData = await getBlockMapFromCacheDir(this.downloadedUpdateHelper.cacheDir);\n            if (oldBlockMapData == null) {\n                oldBlockMapData = await downloadBlockMap(blockmapFileUrls[0]);'), 'the old blockmap is fetched only when the cache has no current.blockmap', 'electron-updater/out/AppUpdater.js');
    must(read(EU, 'out/MacUpdater.js').includes('if (!(0, fs_extra_1.pathExistsSync)(cachedUpdateFilePath)) {'), 'macOS tries a differential download only when a previous update.zip is cached', 'electron-updater/out/MacUpdater.js');
    must(read(EU, 'out/NsisUpdater.js').includes('(await this.differentialDownloadInstaller(fileInfo, downloadUpdateOptions, destinationFile, provider, builder_util_runtime_1.CURRENT_APP_INSTALLER_FILE_NAME))'), 'Windows tries a differential download on every non-web-installer update', 'electron-updater/out/NsisUpdater.js');
    must(read(EU, 'out/AppImageUpdater.js').includes('FileWithEmbeddedBlockMapDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download()'), 'AppImage uses the embedded blockmap (no old-version URL)', 'electron-updater/out/AppImageUpdater.js');
    expect(true).toBe(true);
  });
});
