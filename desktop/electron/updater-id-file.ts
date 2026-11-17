/**
 * Removes the per-install ID file electron-updater left behind before UPDATE-CHECK-SENDS-INSTALL-ID-1
 * (advisor ruling 2026-11-17). After the hardening the file is never read, created or sent, but an older
 * build would send it again after a downgrade, so it is taken away.
 *
 * Rules: the caller runs this only after the hardening succeeded in this start. The path is built here from
 * the app's own user-data folder and the fixed name, never taken from the library. Only a regular file of at
 * most MAX_ID_FILE_BYTES is removed (the library writes a 36 character UUID); a symlink, a folder or anything
 * larger is left and logged. A failure is logged and never thrown.
 */
import * as fs from 'fs';
import * as path from 'path';

export const UPDATER_ID_FILE_NAME = '.updaterId';
export const MAX_ID_FILE_BYTES = 256;

export type UpdaterIdFileOutcome = 'removed' | 'absent' | 'left' | 'failed';

export function removeLeftoverUpdaterIdFile(
  userDataDir: string,
  log: { warn: (line: string) => void } = console,
): UpdaterIdFileOutcome {
  try {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) {
      log.warn('[updater-id-file] not removed: the user-data folder is not an absolute path');
      return 'failed';
    }
    const file = path.join(userDataDir, UPDATER_ID_FILE_NAME);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';
      throw err;
    }
    if (!st.isFile()) {
      log.warn('[updater-id-file] left in place: not a regular file');
      return 'left';
    }
    if (st.size > MAX_ID_FILE_BYTES) {
      log.warn(`[updater-id-file] left in place: ${st.size} bytes is larger than an ID file`);
      return 'left';
    }
    fs.unlinkSync(file);
    return 'removed';
  } catch (err) {
    log.warn(`[updater-id-file] not removed: ${(err as NodeJS.ErrnoException)?.code ?? 'error'}`);
    return 'failed';
  }
}
