import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface EngineHandshake {
  port: number;
  token: string;
}

/** Hard cap on how long we wait for the Python sidecar to emit its handshake
 * JSON. A healthy cold start (venv python import + uvicorn bind) is 1-3s; this
 * only exists so a hung engine (bad venv, import deadlock) rejects and surfaces
 * an error instead of leaving the app waiting forever on `getEngineHandshake`. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

let child: ChildProcess | null = null;
let handshakePromise: Promise<EngineHandshake> | null = null;

// True only while WE are deliberately killing the engine (stopEngine). Lets the
// exit handler tell an intentional shutdown apart from a crash, so we don't
// fire the "engine exited unexpectedly" listeners on a clean stop.
let stoppingIntentionally = false;

// Listeners notified when the engine exits *unexpectedly* after a successful
// handshake (i.e. a crash, not a stopEngine() call). main.ts registers one to
// push an `engine:exited` IPC event to the renderer so it can drop its cached
// (now-stale) port/token. The next getEngineHandshake() lazily respawns.
type ExitListener = () => void;
const exitListeners: ExitListener[] = [];

export function onEngineExit(listener: ExitListener): void {
  exitListeners.push(listener);
}

function notifyExit(): void {
  for (const listener of exitListeners) {
    try {
      listener();
    } catch {
      // A bad listener must not break engine teardown.
    }
  }
}

/** Absolute path to the pidfile the engine writes on startup. Lives under the
 * app's userData dir so it survives a crash, doesn't collide across installs,
 * and is reaped on the next launch. */
function pidfilePath(): string {
  return path.join(app.getPath('userData'), 'engine.pid');
}

/** Reap an orphaned engine left behind by a previously crashed session.
 *
 * On a clean exit the engine removes its own pidfile (atexit) and stopEngine()
 * kills the tracked child, so this normally finds nothing. But a SIGKILL or an
 * Electron crash leaves the Python sidecar running and the pidfile stale; on
 * the next launch we read that exact pid and SIGTERM it.
 *
 * This is the targeted replacement for the old broad `pkill -f 'engine/.venv/
 * bin/python -m engine'`, which also killed unrelated dev engines running in
 * other terminals. We kill only the pid we recorded — never a pattern match.
 */
function reapOrphanEngine(): void {
  const file = pidfilePath();
  let recorded: number | null = null;
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) recorded = parsed;
  } catch {
    return; // no pidfile — nothing to reap
  }
  if (recorded !== null) {
    try {
      // signal 0 = liveness probe; throws ESRCH if the pid is gone. There's a
      // microsecond TOCTOU between the probe and the SIGTERM where the OS could
      // recycle the pid, but the window is theoretical and the recorded pid is
      // always one we spawned moments-to-minutes ago — acceptable for cleanup.
      process.kill(recorded, 0);
      process.kill(recorded, 'SIGTERM');
    } catch {
      // Already dead (the common case) — fall through to cleanup.
    }
  }
  try {
    unlinkSync(file);
  } catch {
    // Best effort — a stale file the engine will overwrite on next write.
  }
}

export function startEngine(): Promise<EngineHandshake> {
  if (handshakePromise) return handshakePromise;

  // Clear any orphan from a prior crashed session before we bind a new port.
  reapOrphanEngine();

  // Resolve how to launch the engine.
  //   Packaged: the PyInstaller-frozen onedir engine, staged by electron-builder
  //     at Contents/Resources/engine/tal-engine (extraResources). Self-contained;
  //     no venv, no `-m engine`.
  //   Dev: the venv python running `python -m engine` from the repo root (cwd
  //     lets `-m engine` resolve the package via sys.path[0]).
  let engineCmd: string;
  let engineArgs: string[];
  let engineCwd: string;
  if (app.isPackaged) {
    const engineDir = path.join(process.resourcesPath, 'engine');
    engineCmd = path.join(engineDir, 'tal-engine');
    engineArgs = [];
    engineCwd = engineDir;
  } else {
    const repoRoot = path.resolve(app.getAppPath(), '..');
    engineCmd = path.join(repoRoot, 'engine', '.venv', 'bin', 'python');
    engineArgs = ['-m', 'engine'];
    engineCwd = repoRoot;
  }

  stoppingIntentionally = false;
  child = spawn(engineCmd, engineArgs, {
    cwd: engineCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Hand the engine the pidfile path so it records its own pid for reaping.
    env: { ...process.env, TAL_ENGINE_PIDFILE: pidfilePath() },
  });

  // Capture the spawned child in a local so the exit/timeout closures below
  // act on *this* engine instance even after `child` is reassigned by a respawn.
  const thisChild = child;
  let handshakeSettled = false;

  handshakePromise = new Promise<EngineHandshake>((resolve, reject) => {
    if (!thisChild || !thisChild.stdout || !thisChild.stderr) {
      reject(new Error('engine: failed to spawn child process'));
      return;
    }

    // Reject (and tear down) if the engine never hands us a handshake. Without
    // this a hung sidecar would leave getEngineHandshake() pending forever.
    const timeoutTimer = setTimeout(() => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      handshakePromise = null;
      try {
        thisChild.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      if (child === thisChild) child = null;
      reject(
        new Error(
          `engine: handshake not received within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);

    const onFirstChunk = (buf: Buffer) => {
      if (handshakeSettled) return;
      const firstLine = buf.toString().split('\n')[0]?.trim();
      if (!firstLine) {
        handshakeSettled = true;
        clearTimeout(timeoutTimer);
        handshakePromise = null;
        reject(new Error('engine: empty handshake'));
        return;
      }
      try {
        const parsed = JSON.parse(firstLine) as EngineHandshake;
        if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
          throw new Error('handshake missing port/token');
        }
        handshakeSettled = true;
        clearTimeout(timeoutTimer);
        resolve(parsed);
      } catch (err) {
        handshakeSettled = true;
        clearTimeout(timeoutTimer);
        handshakePromise = null;
        // Redact the bearer token before it reaches an error/log surface. A
        // handshake line split across stdout buffers can arrive truncated
        // mid-token; strip the token value (closing quote optional) so a
        // partial token is never echoed.
        const safeLine = firstLine.replace(
          /("token"\s*:\s*")[^"]*("?)/,
          '$1<redacted>$2',
        );
        reject(new Error(`engine: invalid handshake line: ${safeLine}`));
      }
    };

    thisChild.stdout.once('data', onFirstChunk);

    thisChild.on('error', (err) => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      clearTimeout(timeoutTimer);
      handshakePromise = null;
      reject(err);
    });

    thisChild.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      // Pre-handshake exit: surface the failure to the awaiting caller.
      if (!handshakeSettled) {
        handshakeSettled = true;
        handshakePromise = null;
        if (child === thisChild) child = null;
        reject(new Error(`engine exited early with code ${code}`));
        return;
      }
      // Post-handshake exit. Clear cached state so the next getEngineHandshake()
      // spawns a fresh engine (lazy respawn). If the exit was unexpected (a
      // crash, not stopEngine), notify listeners so the renderer drops its
      // stale handshake and re-fetches.
      if (child === thisChild) {
        child = null;
        handshakePromise = null;
        if (!stoppingIntentionally) notifyExit();
      }
    });

    // Tee uvicorn logs to main-process console for dev visibility.
    thisChild.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[engine] ${buf.toString()}`);
    });
  });

  return handshakePromise;
}

export function stopEngine(): void {
  if (child && !child.killed) {
    stoppingIntentionally = true;
    child.kill('SIGTERM');
    child = null;
    handshakePromise = null;
  }
}
