import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the engine keeps its SQLite database (analysis history, watchlist,
 * CostGuard config + spend ledger), and the one-time move out of the app bundle.
 *
 * Why this file exists
 * --------------------
 * Through v1.1.4 the packaged engine ran with cwd = the app bundle
 * (`Trading Agents Lab.app/Contents/Resources/engine`) and the engine's default
 * path is `<cwd>/data/sessions.db`, so the database lived INSIDE the .app. Every
 * update replaces the whole .app (auto-update and drag-to-Applications alike),
 * which silently deleted every user's history and reset the spend-cap ledger on
 * each release. Writing into a signed bundle is also wrong on its own terms.
 *
 * Fix: in packaged builds the engine is told (via TAL_SESSIONS_DB, which
 * engine/storage.py and engine/cost_guard.py already honor) to use
 * `<userData>/sessions.db`. userData (~/Library/Application Support/<productName>)
 * survives updates, the same place secrets.json and engine.pid already live.
 *
 * Dev builds are unchanged: no override, so the engine keeps using
 * `<repo>/data/sessions.db` as before.
 */

export const SESSIONS_DB_FILENAME = 'sessions.db';

/** SQLite side files that may hold committed-but-not-checkpointed data. */
const SQLITE_SIDE_SUFFIXES = ['-wal', '-shm', '-journal'];

/** Database path the packaged engine should use. */
export function packagedSessionsDbPath(userDataDir: string): string {
  return path.join(userDataDir, SESSIONS_DB_FILENAME);
}

/** Pre-1.1.5 location: inside the app bundle, next to the frozen engine. */
export function legacyBundleSessionsDbPath(engineDir: string): string {
  return path.join(engineDir, 'data', SESSIONS_DB_FILENAME);
}

export type MigrationResult = 'already-present' | 'migrated' | 'nothing-to-migrate';

/**
 * Copy the bundle database to userData the first time a fixed build runs.
 *
 * Only useful when the bundle still holds a database (e.g. the user ran the
 * same build that introduced this fix, or a build installed without replacing
 * the bundle). An update FROM v1.1.4 replaces the bundle before this code runs,
 * so that history is already gone; nothing here can recover it.
 *
 * Rules (each one is deliberate):
 * - Never overwrite: if userData already has a database, it wins.
 * - Copy, never move: the bundle copy is left alone, it disappears with the
 *   next update anyway, and a failed copy must not lose the original.
 * - Copy the SQLite side files too, so uncheckpointed WAL data comes along.
 * - Runs before the engine starts, so nothing has the files open.
 */
export function migrateLegacySessionsDb(legacyPath: string, targetPath: string): MigrationResult {
  if (existsSync(targetPath)) return 'already-present';
  if (!existsSync(legacyPath)) return 'nothing-to-migrate';
  mkdirSync(path.dirname(targetPath), { recursive: true });
  // Side files first, main file last: if we crash midway, the target main file
  // does not exist yet and the next launch retries the whole copy.
  for (const suffix of SQLITE_SIDE_SUFFIXES) {
    if (existsSync(legacyPath + suffix)) copyFileSync(legacyPath + suffix, targetPath + suffix);
  }
  copyFileSync(legacyPath, targetPath);
  return 'migrated';
}
