/**
 * The leftover updater ID file (UPDATE-CHECK-SENDS-INSTALL-ID-1, advisor ruling 2026-11-17): removed only as a
 * small regular file at <userData>/.updaterId, never anything else, never a throw. Real files in a temp folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_ID_FILE_BYTES, UPDATER_ID_FILE_NAME, removeLeftoverUpdaterIdFile } from '../../electron/updater-id-file';

let dir = '';
let lines: string[] = [];
const log = { warn: (l: string) => { lines.push(l); } };
const idFile = () => path.join(dir, '.updaterId');

beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'updater-id-')); lines = []; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('removeLeftoverUpdaterIdFile', () => {
  test('the name is the library\'s own, fixed here', () => {
    expect(UPDATER_ID_FILE_NAME).toBe('.updaterId');
  });

  test('a small regular file is removed; other files in the folder are untouched', () => {
    fs.writeFileSync(idFile(), '11111111-1111-4111-8111-111111111111');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.updaterId.bak'), 'y');
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('removed');
    expect(fs.readdirSync(dir).sort()).toEqual(['.updaterId.bak', 'keep.txt']);
    expect(lines).toEqual([]);
  });

  test('absent: nothing happens, nothing is logged, and a second call is the same', () => {
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('absent');
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('absent');
    expect(lines).toEqual([]);
  });

  test('a symlink is left and logged, and its target is untouched (to a file, to a folder, dangling)', () => {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'precious');
    for (const to of [target, dir, path.join(dir, 'nowhere')]) {
      fs.symlinkSync(to, idFile());
      expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('left');
      expect(fs.lstatSync(idFile()).isSymbolicLink()).toBe(true);
      fs.unlinkSync(idFile());
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(lines).toHaveLength(3);
  });

  test('a folder with that name is left and logged, with what is inside it', () => {
    fs.mkdirSync(idFile());
    fs.writeFileSync(path.join(idFile(), 'inside'), 'x');
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('left');
    expect(fs.readFileSync(path.join(idFile(), 'inside'), 'utf8')).toBe('x');
    expect(lines).toHaveLength(1);
  });

  test('size: exactly the limit is removed, one byte more is left and logged; an empty file is removed', () => {
    fs.writeFileSync(idFile(), 'a'.repeat(MAX_ID_FILE_BYTES));
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('removed');
    fs.writeFileSync(idFile(), 'a'.repeat(MAX_ID_FILE_BYTES + 1));
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('left');
    expect(fs.statSync(idFile()).size).toBe(MAX_ID_FILE_BYTES + 1);
    fs.unlinkSync(idFile());
    fs.writeFileSync(idFile(), '');
    expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('removed');
    expect(lines).toHaveLength(1);
  });

  test('a failure is logged and never thrown: a folder that cannot be written, and paths that are not a folder path', () => {
    fs.writeFileSync(idFile(), 'id');
    fs.chmodSync(dir, 0o500);
    try {
      expect(removeLeftoverUpdaterIdFile(dir, log)).toBe('failed');
    } finally { fs.chmodSync(dir, 0o700); }
    expect(fs.existsSync(idFile())).toBe(true);
    for (const bad of ['', 'relative/dir', undefined, null, 7, {}] as any[]) {
      expect(removeLeftoverUpdaterIdFile(bad, log)).toBe('failed');
    }
    expect(removeLeftoverUpdaterIdFile(path.join(dir, 'no-such-folder'), log)).toBe('absent');
    // The log never carries the file's content.
    expect(lines.join('\n')).not.toContain('id\n');
    expect(lines.every((l) => l.startsWith('[updater-id-file] '))).toBe(true);
  });

  test('the path comes from the folder given and the fixed name only: a library object is never asked (source pin)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../electron/updater-id-file.ts'), 'utf8');
    expect(src).toContain('path.join(userDataDir, UPDATER_ID_FILE_NAME)');
    expect(src).not.toMatch(/from 'electron/);
    expect(src.match(/^import .*$/gm)).toEqual(["import * as fs from 'fs';", "import * as path from 'path';"]);
    // TAL port: in electron/updater.ts the removal runs only after the refusal
    // check, only when packaged, and is the only call.
    const um = fs.readFileSync(path.join(__dirname, '../../electron/updater.ts'), 'utf8');
    const refusal = um.indexOf('if (checksUnavailable) {');
    const removal = um.indexOf("removeLeftoverUpdaterIdFile(app.getPath('userData'))");
    expect(refusal).toBeGreaterThan(0);
    expect(removal).toBeGreaterThan(refusal);
    expect(um.split('removeLeftoverUpdaterIdFile(').length).toBe(2);
  });
});
