/**
 * Updater privacy hardening for electron-updater (row UPDATE-CHECK-SENDS-INSTALL-ID-1).
 *
 * PORTABLE: this file has no imports and knows nothing about the app that uses it. Copy it as is.
 * Proven on electron-updater 6.8.9 (builder-util-runtime 9.7.0). Any other version must be re-proven
 * with the drift test and the request-level test before it ships (see docs/updater-privacy-PORTING.md).
 *
 * What the library does without this (6.8.9, out/AppUpdater.js):
 * - The constructor sets an own property `stagingUserIdPromise = new Lazy(() => this.getOrCreateStagingUserId())`.
 * - `getOrCreateStagingUserId()` reads `<userData>/.updaterId`, and if it is missing writes a new random UUID there.
 * - Every update check runs `getUpdateInfoAndProvider()`, which awaits `stagingUserIdPromise.value` and puts it on
 *   the provider as the request header `x-user-staging-id`. So the first check creates the file, and every check
 *   request sends a per-install ID. The header is not in builder-util-runtime's list of headers dropped at a
 *   cross-origin redirect, so it also follows GitHub's redirect to its asset host.
 * - `isStagingMatch()` (the default `isUserWithinRollout`) reads the same ID when a feed sets `stagingPercentage`.
 *
 * What this function does, on the live updater object (no library file is edited):
 * (a) id: replaces `stagingUserIdPromise` with a fixed, already-resolved all-zero UUID, and shadows
 *     `getOrCreateStagingUserId` with a function that returns the same value. The library's own Lazy is never read,
 *     so `.updaterId` is never created, never read, never sent, and an existing one is left on disk untouched.
 * (b) rollout: sets `isUserWithinRollout` (the library's public setter) to always pass, so a feed that sets
 *     `stagingPercentage` can never withhold an update because of the fixed ID.
 * (c) headers: wraps `httpExecutor.createRequest` in place on the executor object the library already holds. That
 *     method is the library's only network egress (checks, redirects re-issued by the library, full downloads,
 *     blockmaps, differential range requests, on every platform). The wrapper gives each request a fresh headers
 *     object without `x-user-staging-id` and without `Accept-Language`, matched in any letter case. A redirect that
 *     the library re-issues goes through the wrapper again; a redirect that Electron's net layer follows by itself
 *     reuses the headers already stripped here. Headers that Chromium adds below this point cannot be seen here.
 *
 * Every member is checked for its expected type before anything is changed. If any check fails, nothing is changed
 * and the result says which part could not be applied. The caller must then refuse update checks.
 */

/** The fixed ID the library gets instead of a per-install one. Valid for the library's UUID parser. */
export const FIXED_UPDATER_ID = '00000000-0000-0000-0000-000000000000';

/** Header names removed from every updater request, compared in lower case. */
export const STRIPPED_UPDATER_HEADERS: readonly string[] = Object.freeze(['x-user-staging-id', 'accept-language']);

export type UpdaterPrivacyPart = 'id' | 'rollout' | 'headers';

export interface UpdaterPrivacyResult {
  /** True only when all three parts are in place. */
  ok: boolean;
  /** Which parts are in place after this call. */
  applied: Record<UpdaterPrivacyPart, boolean>;
  /** One plain line per failed check, naming the member. Empty when ok. */
  missing: string[];
}

// Module-local, never a registered symbol: other code in the process cannot mark an updater as hardened or a
// function as the wrapper (Security L2). A second call reads the real state back against what is kept here.
interface Kept { fixedId: Promise<string>; alwaysWithin: () => boolean; exec: any }
const HARDENED = new WeakMap<object, Kept>();
const WRAPPED = new WeakSet<object>();

function readBack(u: Record<string, any>, k: Kept): Record<UpdaterPrivacyPart, boolean> {
  const out: Record<UpdaterPrivacyPart, boolean> = { id: false, rollout: false, headers: false };
  try { out.id = u.stagingUserIdPromise?.value === k.fixedId && u.stagingUserIdPromise?.hasValue === true; } catch { /* false */ }
  try { out.rollout = u.isUserWithinRollout === k.alwaysWithin; } catch { /* false */ }
  try { out.headers = u.httpExecutor === k.exec && typeof k.exec.createRequest === 'function' && WRAPPED.has(k.exec.createRequest); } catch { /* false */ }
  return out;
}

function report(applied: Record<UpdaterPrivacyPart, boolean>, missing: string[]): UpdaterPrivacyResult {
  if (!applied.id) missing.push('stagingUserIdPromise: replacement did not hold');
  if (!applied.rollout) missing.push('isUserWithinRollout: replacement did not hold');
  if (!applied.headers) missing.push('httpExecutor.createRequest: wrapper did not hold');
  return { ok: applied.id && applied.rollout && applied.headers, applied, missing };
}

function findSetter(obj: object, name: string): ((v: unknown) => void) | null {
  let o: object | null = obj;
  while (o) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return typeof d.set === 'function' ? d.set : null;
    o = Object.getPrototypeOf(o);
  }
  return null;
}

/** A copy of `headers` without the stripped names (any case). Non-objects pass through unchanged. */
export function stripUpdaterHeaders<T>(headers: T): T {
  if (headers == null || typeof headers !== 'object') return headers;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(headers as Record<string, unknown>)) {
    if (STRIPPED_UPDATER_HEADERS.includes(key.toLowerCase())) continue;
    out[key] = (headers as Record<string, unknown>)[key];
  }
  return out as T;
}

/**
 * Apply the three privacy parts to an electron-updater AppUpdater instance (for example the `autoUpdater`
 * singleton). Call it before any feed or header configuration and before the first check. Safe to call twice.
 */
export function hardenUpdaterPrivacy(updater: unknown): UpdaterPrivacyResult {
  const applied: Record<UpdaterPrivacyPart, boolean> = { id: false, rollout: false, headers: false };
  const missing: string[] = [];
  if (updater == null || typeof updater !== 'object') {
    return { ok: false, applied, missing: ['updater: not an object'] };
  }
  const u = updater as Record<string, any>;
  const kept = HARDENED.get(u);
  if (kept) return report(readBack(u, kept), missing);
  try {
    return apply(u, applied, missing);
  } catch (err) {
    // A library that throws on a read or refuses a change (a frozen object, a throwing getter) is a refusal,
    // never an exception in the caller: the caller's start-up must go on with update checks off.
    // Building the text can throw too (a message getter that throws, a thrown object with no prototype).
    let why = 'unreadable error';
    try { why = err instanceof Error ? String(err.message) : String(err); } catch { /* keep the fixed text */ }
    missing.push(`updater: could not be changed (${why})`);
    return { ok: false, applied: { id: false, rollout: false, headers: false }, missing };
  }
}

function apply(u: Record<string, any>, applied: Record<UpdaterPrivacyPart, boolean>, missing: string[]): UpdaterPrivacyResult {

  // (a) checks: the library's own Lazy, not yet read, plus the method it would call.
  const idDesc = Object.getOwnPropertyDescriptor(u, 'stagingUserIdPromise');
  const lazy = idDesc && 'value' in idDesc ? idDesc.value : undefined;
  let idOk = true;
  if (!idDesc) { idOk = false; missing.push('stagingUserIdPromise: not an own property'); }
  else if (!('value' in idDesc) || !idDesc.writable || !idDesc.configurable) { idOk = false; missing.push('stagingUserIdPromise: not a writable data property'); }
  else if (lazy == null || typeof lazy !== 'object') { idOk = false; missing.push('stagingUserIdPromise: not an object'); }
  else if (lazy.hasValue !== false) { idOk = false; missing.push('stagingUserIdPromise: already read (hasValue is not false), the ID file may already have been read or created'); }
  if (typeof u.getOrCreateStagingUserId !== 'function') { idOk = false; missing.push('getOrCreateStagingUserId: not a function'); }

  // (b) checks: the public setter and a current function value.
  const rolloutSetter = findSetter(u, 'isUserWithinRollout');
  let rolloutOk = true;
  if (!rolloutSetter) { rolloutOk = false; missing.push('isUserWithinRollout: no setter'); }
  else if (typeof u.isUserWithinRollout !== 'function') { rolloutOk = false; missing.push('isUserWithinRollout: not a function'); }

  // (c) checks: the executor object and its request function.
  const exec = u.httpExecutor;
  let headersOk = true;
  if (exec == null || typeof exec !== 'object') { headersOk = false; missing.push('httpExecutor: not an object'); }
  else if (typeof exec.createRequest !== 'function') { headersOk = false; missing.push('httpExecutor.createRequest: not a function'); }

  if (!idOk || !rolloutOk || !headersOk) return { ok: false, applied, missing };

  // (a) apply.
  const fixedId = Promise.resolve(FIXED_UPDATER_ID);
  Object.defineProperty(u, 'stagingUserIdPromise', {
    value: Object.freeze({ value: fixedId, hasValue: true }),
    writable: false, configurable: false, enumerable: true,
  });
  Object.defineProperty(u, 'getOrCreateStagingUserId', {
    value: () => Promise.resolve(FIXED_UPDATER_ID),
    writable: false, configurable: false, enumerable: false,
  });

  // (b) apply.
  const alwaysWithin = () => true;
  u.isUserWithinRollout = alwaysWithin;

  // (c) apply, in place on the executor every provider already references.
  if (!WRAPPED.has(exec.createRequest)) {
    const original = exec.createRequest;
    const wrapped = function (this: unknown, options: any, callback: unknown) {
      if (options != null && typeof options === 'object' && options.headers != null) {
        options.headers = stripUpdaterHeaders(options.headers);
      }
      return original.call(this, options, callback);
    };
    WRAPPED.add(wrapped);
    Object.defineProperty(exec, 'createRequest', { value: wrapped, writable: false, configurable: false, enumerable: false });
  }

  // Read back.
  const kept: Kept = { fixedId, alwaysWithin, exec };
  const result = report(readBack(u, kept), missing);
  if (result.ok) HARDENED.set(u, kept);
  return result;
}
