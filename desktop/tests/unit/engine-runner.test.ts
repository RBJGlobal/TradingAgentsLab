/**
 * Unit tests for the engine spawn lifecycle (Tier 1, 2026-05-23).
 *
 * Covers the three behaviors the Tier 1 hardening added:
 *   1. Handshake resolves on a valid JSON line.
 *   2. Handshake REJECTS (and SIGKILLs the child) if no handshake arrives
 *      within the timeout — a hung sidecar must not freeze the app forever.
 *   3. A post-handshake crash clears cached state and notifies exit listeners
 *      (so the renderer drops its stale handshake); a deliberate stopEngine()
 *      does NOT notify. Either way the next startEngine() spawns fresh (lazy
 *      respawn).
 *
 * `electron`, `node:child_process`, and `node:fs` are mocked so no real
 * process is spawned and no real pidfile is touched. The integration path
 * (real spawn + real kill -9 recovery) is verified by the manual smoke test.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted holder so the (hoisted) vi.mock factory can reach a per-test spawn
// implementation set in beforeEach.
const h = vi.hoisted(() => ({
  spawnImpl: (() => {}) as (...a: unknown[]) => unknown,
  isPackaged: false,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    getAppPath: () => '/repo/desktop',
    getPath: () => '/tmp/tal-userdata',
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => h.spawnImpl(...args),
}));

// No pidfile on disk in tests: readFileSync throws so reapOrphanEngine() is a
// no-op and never calls the real process.kill.
vi.mock('node:fs', () => ({
  readFileSync: () => {
    throw new Error('ENOENT');
  },
  unlinkSync: () => {},
  // sessions-db.ts migration: no bundle database exists in tests.
  existsSync: () => false,
  copyFileSync: () => {},
  mkdirSync: () => {},
}));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    return true;
  });
  return child;
}

let fakeChild: FakeChild;

beforeEach(() => {
  vi.resetModules(); // fresh module-level state (child, handshakePromise, listeners)
  fakeChild = makeFakeChild();
  h.spawnImpl = () => fakeChild;
  h.isPackaged = false;
});

afterEach(() => {
  vi.useRealTimers();
});

const HANDSHAKE = '{"port":54321,"token":"tok-abc"}\n';

describe('startEngine handshake', () => {
  it('resolves with port/token on a valid handshake line', async () => {
    const { startEngine } = await import('../../electron/engine-runner');
    const p = startEngine();
    fakeChild.stdout.emit('data', Buffer.from(HANDSHAKE));
    await expect(p).resolves.toEqual({ port: 54321, token: 'tok-abc' });
  });

  it('rejects and SIGKILLs the child if no handshake arrives before the timeout', async () => {
    vi.useFakeTimers();
    const { startEngine } = await import('../../electron/engine-runner');
    const p = startEngine();
    const assertion = expect(p).rejects.toThrow(/handshake not received/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects on a malformed handshake line', async () => {
    const { startEngine } = await import('../../electron/engine-runner');
    const p = startEngine();
    fakeChild.stdout.emit('data', Buffer.from('not json\n'));
    await expect(p).rejects.toThrow(/invalid handshake/i);
  });
});

describe('post-handshake lifecycle', () => {
  it('notifies exit listeners and clears state on an unexpected crash, then respawns lazily', async () => {
    const { startEngine, onEngineExit } = await import('../../electron/engine-runner');
    const onExit = vi.fn();
    onEngineExit(onExit);

    const p = startEngine();
    fakeChild.stdout.emit('data', Buffer.from(HANDSHAKE));
    await p;

    // Simulate a crash.
    fakeChild.emit('exit', 1);
    expect(onExit).toHaveBeenCalledTimes(1);

    // Cached promise was cleared, so the next call spawns a fresh engine.
    const next = makeFakeChild();
    h.spawnImpl = () => next;
    const p2 = startEngine();
    next.stdout.emit('data', Buffer.from(HANDSHAKE));
    await expect(p2).resolves.toEqual({ port: 54321, token: 'tok-abc' });
  });

  it('does NOT notify exit listeners when stopEngine() drives the exit', async () => {
    const { startEngine, stopEngine, onEngineExit } = await import(
      '../../electron/engine-runner'
    );
    const onExit = vi.fn();
    onEngineExit(onExit);

    const p = startEngine();
    fakeChild.stdout.emit('data', Buffer.from(HANDSHAKE));
    await p;

    stopEngine();
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    // The child's exit event still fires after the kill; it must be silent.
    fakeChild.emit('exit', null);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('caches the handshake across calls while the engine is alive', async () => {
    const { startEngine } = await import('../../electron/engine-runner');
    let spawnCount = 0;
    h.spawnImpl = () => {
      spawnCount += 1;
      return fakeChild;
    };
    const p = startEngine();
    fakeChild.stdout.emit('data', Buffer.from(HANDSHAKE));
    await p;
    // Second call returns the cached promise without spawning again.
    await startEngine();
    expect(spawnCount).toBe(1);
  });
});

describe('database location (history must survive updates)', () => {
  function spawnEnv(): Record<string, string | undefined> {
    let env: Record<string, string | undefined> = {};
    h.spawnImpl = (...args: unknown[]) => {
      env = (args[2] as { env: Record<string, string | undefined> }).env;
      return fakeChild;
    };
    return new Proxy({}, { get: (_t, k: string) => env[k] }) as Record<string, string | undefined>;
  }

  it('packaged builds point the engine database at userData, not the app bundle', async () => {
    h.isPackaged = true;
    (process as unknown as { resourcesPath: string }).resourcesPath = '/Applications/TAL.app/Contents/Resources';
    const env = spawnEnv();
    const { startEngine } = await import('../../electron/engine-runner');
    void startEngine().catch(() => undefined);
    expect(env.TAL_SESSIONS_DB).toBe('/tmp/tal-userdata/sessions.db');
    expect(env.TAL_SESSIONS_DB).not.toContain('.app/');
  });

  it('dev builds leave the database at the repo default (no override)', async () => {
    const before = process.env.TAL_SESSIONS_DB;
    delete process.env.TAL_SESSIONS_DB;
    const env = spawnEnv();
    const { startEngine } = await import('../../electron/engine-runner');
    void startEngine().catch(() => undefined);
    expect(env.TAL_SESSIONS_DB).toBeUndefined();
    if (before !== undefined) process.env.TAL_SESSIONS_DB = before;
  });
});
