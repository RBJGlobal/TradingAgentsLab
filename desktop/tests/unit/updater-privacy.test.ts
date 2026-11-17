/**
 * hardenUpdaterPrivacy unit tests (UPDATE-CHECK-SENDS-INSTALL-ID-1). PORTABLE: imports only the function under
 * test and bun:test. The request-level proof against the real library is updater-privacy.request.test.ts; the
 * library source pins are updater-privacy.drift.test.ts.
 */
import { describe, expect, test } from 'vitest';
import { FIXED_UPDATER_ID, STRIPPED_UPDATER_HEADERS, hardenUpdaterPrivacy, stripUpdaterHeaders } from '../../electron/updater-privacy';

/** An object shaped like electron-updater 6.8.9's AppUpdater in the members the function touches. */
function shaped() {
  const seen: Array<{ self: unknown; options: any }> = [];
  class Base {
    private _rollout: unknown = () => false;
    get isUserWithinRollout(): unknown { return this._rollout; }
    set isUserWithinRollout(v: unknown) { if (v) this._rollout = v; }
    async getOrCreateStagingUserId(): Promise<string> { throw new Error('the ID file path must never run'); }
  }
  const u: any = new Base();
  u.stagingUserIdPromise = { hasValue: false, get value(): never { throw new Error('the library Lazy must never be read'); } };
  const exec: any = { createRequest(this: unknown, options: any) { seen.push({ self: this, options }); return 'request'; } };
  u.httpExecutor = exec;
  return { u, exec, seen };
}

describe('hardenUpdaterPrivacy', () => {
  test('applies all three parts on a complete updater and reports ok', async () => {
    const { u, exec } = shaped();
    const r = hardenUpdaterPrivacy(u);
    expect(r).toEqual({ ok: true, applied: { id: true, rollout: true, headers: true }, missing: [] });
    expect(await u.stagingUserIdPromise.value).toBe(FIXED_UPDATER_ID);
    expect(u.stagingUserIdPromise.hasValue).toBe(true);
    expect(await u.getOrCreateStagingUserId()).toBe(FIXED_UPDATER_ID);
    expect(u.isUserWithinRollout({ stagingPercentage: 0 })).toBe(true);
    expect(u.httpExecutor).toBe(exec);
    expect(FIXED_UPDATER_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('the wrapper removes the ID header and Accept-Language in any letter case, keeps the rest, calls the original on the executor', () => {
    const { u, exec, seen } = shaped();
    hardenUpdaterPrivacy(u);
    const passed = { 'x-user-staging-id': 'a', 'X-User-Staging-Id': 'b', 'X-USER-STAGING-ID': 'c', 'Accept-Language': 'en', 'accept-language': 'fr', accept: '*/*', 'User-Agent': 'electron-builder', range: 'bytes=0-1' };
    const options: any = { headers: passed, hostname: 'example.invalid', path: '/x' };
    expect(exec.createRequest(options, () => {})).toBe('request');
    expect(seen).toHaveLength(1);
    expect(seen[0].self).toBe(exec);
    expect(seen[0].options).toBe(options);
    expect(options.headers).toEqual({ accept: '*/*', 'User-Agent': 'electron-builder', range: 'bytes=0-1' });
    // The caller's own headers object is not mutated (the provider's shared requestHeaders stay intact).
    expect(passed['x-user-staging-id']).toBe('a');
    expect(options.headers).not.toBe(passed);
  });

  test('a request without headers passes through', () => {
    const { u, exec, seen } = shaped();
    hardenUpdaterPrivacy(u);
    exec.createRequest({ path: '/x' }, () => {});
    expect(seen[0].options).toEqual({ path: '/x' });
  });

  test('idempotent: a second call reports ok and does not wrap twice', () => {
    const { u, exec, seen } = shaped();
    hardenUpdaterPrivacy(u);
    const once = exec.createRequest;
    expect(hardenUpdaterPrivacy(u).ok).toBe(true);
    expect(exec.createRequest).toBe(once);
    exec.createRequest({ headers: { 'x-user-staging-id': 'z' } }, () => {});
    expect(seen).toHaveLength(1);
  });

  test('the replaced members cannot be put back by plain assignment', () => {
    const { u, exec } = shaped();
    hardenUpdaterPrivacy(u);
    const wrapped = exec.createRequest;
    expect(() => { 'use strict'; u.stagingUserIdPromise = { value: Promise.resolve('x'), hasValue: true }; }).toThrow();
    expect(() => { 'use strict'; exec.createRequest = () => 'raw'; }).toThrow();
    expect(exec.createRequest).toBe(wrapped);
  });

  const cases: Array<[string, (u: any) => void, string]> = [
    ['no stagingUserIdPromise', (u) => { delete u.stagingUserIdPromise; }, 'stagingUserIdPromise: not an own property'],
    ['stagingUserIdPromise only on the prototype', (u) => { const v = u.stagingUserIdPromise; delete u.stagingUserIdPromise; Object.getPrototypeOf(u).stagingUserIdPromise = v; }, 'stagingUserIdPromise: not an own property'],
    ['stagingUserIdPromise a getter', (u) => { delete u.stagingUserIdPromise; Object.defineProperty(u, 'stagingUserIdPromise', { get: () => ({ hasValue: false }), configurable: true }); }, 'stagingUserIdPromise: not a writable data property'],
    ['stagingUserIdPromise not an object', (u) => { u.stagingUserIdPromise = 'id'; }, 'stagingUserIdPromise: not an object'],
    ['stagingUserIdPromise already read', (u) => { u.stagingUserIdPromise = { hasValue: true, value: Promise.resolve('x') }; }, 'stagingUserIdPromise: already read (hasValue is not false), the ID file may already have been read or created'],
    ['stagingUserIdPromise without hasValue', (u) => { u.stagingUserIdPromise = { value: Promise.resolve('x') }; }, 'stagingUserIdPromise: already read (hasValue is not false), the ID file may already have been read or created'],
    ['no getOrCreateStagingUserId', (u) => { Object.defineProperty(u, 'getOrCreateStagingUserId', { value: undefined }); }, 'getOrCreateStagingUserId: not a function'],
    ['no isUserWithinRollout setter', (u) => { Object.defineProperty(u, 'isUserWithinRollout', { value: () => true, writable: true }); }, 'isUserWithinRollout: no setter'],
    ['isUserWithinRollout not a function', (u) => { Object.defineProperty(u, 'isUserWithinRollout', { get: () => 1, set: () => {} }); }, 'isUserWithinRollout: not a function'],
    ['no httpExecutor', (u) => { u.httpExecutor = null; }, 'httpExecutor: not an object'],
    ['httpExecutor without createRequest', (u) => { u.httpExecutor = { request() {} }; }, 'httpExecutor.createRequest: not a function'],
  ];
  for (const [name, breakIt, line] of cases) {
    test(`fails closed and changes nothing: ${name}`, () => {
      const { u } = shaped();
      breakIt(u);
      const idBefore = Object.getOwnPropertyDescriptor(u, 'stagingUserIdPromise');
      const execBefore = u.httpExecutor;
      const createBefore = execBefore?.createRequest;
      const r = hardenUpdaterPrivacy(u);
      expect(r.ok).toBe(false);
      expect(r.applied).toEqual({ id: false, rollout: false, headers: false });
      expect(r.missing).toContain(line);
      expect(Object.getOwnPropertyDescriptor(u, 'stagingUserIdPromise')).toEqual(idBefore);
      expect(u.httpExecutor).toBe(execBefore);
      if (execBefore) expect(execBefore.createRequest).toBe(createBefore);
    });
  }

  test('reports every missing part at once', () => {
    const r = hardenUpdaterPrivacy({});
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      'stagingUserIdPromise: not an own property',
      'getOrCreateStagingUserId: not a function',
      'isUserWithinRollout: no setter',
      'httpExecutor: not an object',
    ]);
  });

  test('non-objects are refused', () => {
    for (const v of [null, undefined, 1, 'x', true]) expect(hardenUpdaterPrivacy(v).ok).toBe(false);
  });

  test('stripUpdaterHeaders: the stripped list is exactly the ID header and Accept-Language', () => {
    expect([...STRIPPED_UPDATER_HEADERS]).toEqual(['x-user-staging-id', 'accept-language']);
    expect(stripUpdaterHeaders(undefined)).toBeUndefined();
    expect(stripUpdaterHeaders({ A: '1', 'x-User-STAGING-id': '2' })).toEqual({ A: '1' });
  });

  test('a process-wide marker cannot fake the hardened state (Security L2)', () => {
    const { u, exec } = shaped();
    Object.defineProperty(u, Symbol.for('updater-privacy.hardened'), { value: true });
    Object.defineProperty(exec.createRequest, Symbol.for('updater-privacy.createRequest'), { value: true });
    const before = exec.createRequest;
    const r = hardenUpdaterPrivacy(u);
    expect(r.ok).toBe(true);
    // The parts were really applied, the forged marks did not short-cut them.
    expect(exec.createRequest).not.toBe(before);
    const options: any = { headers: { 'x-user-staging-id': 'a', accept: '*/*' } };
    exec.createRequest(options, () => {});
    expect(options.headers).toEqual({ accept: '*/*' });
    expect(u.stagingUserIdPromise.hasValue).toBe(true);
  });

  test('a second call reads the real state back: an executor swapped after the first call is reported, not ok', () => {
    const { u } = shaped();
    expect(hardenUpdaterPrivacy(u).ok).toBe(true);
    u.httpExecutor = { createRequest() { return 'unwrapped'; } };
    const r = hardenUpdaterPrivacy(u);
    expect(r.ok).toBe(false);
    expect(r.applied).toEqual({ id: true, rollout: true, headers: false });
    expect(r.missing).toEqual(['httpExecutor.createRequest: wrapper did not hold']);
  });

  test('an updater that cannot be changed is a refusal, never an exception', () => {
    const frozen = shaped();
    Object.freeze(frozen.exec);
    let r = hardenUpdaterPrivacy(frozen.u);
    expect(r.ok).toBe(false);
    expect(r.missing.join(' ')).toContain('could not be changed');

    const throwing: any = shaped().u;
    Object.defineProperty(throwing, 'httpExecutor', { get() { throw new Error('boom'); } });
    r = hardenUpdaterPrivacy(throwing);
    expect(r.ok).toBe(false);
    expect(r.applied).toEqual({ id: false, rollout: false, headers: false });
    expect(r.missing.join(' ')).toContain('boom');

    const setterThrows: any = shaped().u;
    Object.defineProperty(setterThrows, 'isUserWithinRollout', { get() { return () => false; }, set() { throw new Error('no'); }, configurable: true });
    r = hardenUpdaterPrivacy(setterThrows);
    expect(r.ok).toBe(false);
  });
});
