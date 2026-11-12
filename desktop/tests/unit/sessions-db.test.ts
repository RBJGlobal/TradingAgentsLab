/**
 * Unit tests for moving the engine database out of the app bundle
 * (electron/sessions-db.ts). Uses a real temp directory: the behavior under
 * test IS file copying, so mocking fs would test nothing.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  legacyBundleSessionsDbPath,
  migrateLegacySessionsDb,
  packagedSessionsDbPath,
} from '../../electron/sessions-db';

let root: string;
let engineDir: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tal-sessions-db-'));
  engineDir = path.join(root, 'App.app', 'Contents', 'Resources', 'engine');
  userData = path.join(root, 'Application Support', 'Trading Agents Lab');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLegacy(contents: string, sideFiles: Record<string, string> = {}): string {
  const legacy = legacyBundleSessionsDbPath(engineDir);
  mkdirSync(path.dirname(legacy), { recursive: true });
  writeFileSync(legacy, contents);
  for (const [suffix, data] of Object.entries(sideFiles)) writeFileSync(legacy + suffix, data);
  return legacy;
}

describe('sessions-db paths', () => {
  it('puts the packaged database in userData, not the bundle', () => {
    expect(packagedSessionsDbPath(userData)).toBe(path.join(userData, 'sessions.db'));
    expect(legacyBundleSessionsDbPath(engineDir)).toBe(path.join(engineDir, 'data', 'sessions.db'));
  });
});

describe('migrateLegacySessionsDb', () => {
  it('copies the bundle database (and WAL side files) to userData on first run', () => {
    const legacy = writeLegacy('history', { '-wal': 'wal-frames', '-shm': 'shm' });
    const target = packagedSessionsDbPath(userData);

    expect(migrateLegacySessionsDb(legacy, target)).toBe('migrated');
    expect(readFileSync(target, 'utf-8')).toBe('history');
    expect(readFileSync(target + '-wal', 'utf-8')).toBe('wal-frames');
    expect(readFileSync(target + '-shm', 'utf-8')).toBe('shm');
    // Copy, never move: the original stays put.
    expect(readFileSync(legacy, 'utf-8')).toBe('history');
  });

  it('never overwrites an existing userData database', () => {
    const legacy = writeLegacy('old bundle copy');
    const target = packagedSessionsDbPath(userData);
    mkdirSync(userData, { recursive: true });
    writeFileSync(target, 'current history');

    expect(migrateLegacySessionsDb(legacy, target)).toBe('already-present');
    expect(readFileSync(target, 'utf-8')).toBe('current history');
  });

  it('does nothing when the bundle has no database (fresh install or post-update)', () => {
    const target = packagedSessionsDbPath(userData);
    expect(migrateLegacySessionsDb(legacyBundleSessionsDbPath(engineDir), target)).toBe(
      'nothing-to-migrate',
    );
    expect(existsSync(target)).toBe(false);
  });

  it('clears stale side files from a different database before copying', () => {
    const legacy = writeLegacy('history');
    const target = packagedSessionsDbPath(userData);
    mkdirSync(userData, { recursive: true });
    writeFileSync(target + '-wal', 'stale wal from a deleted database');

    expect(migrateLegacySessionsDb(legacy, target)).toBe('migrated');
    expect(readFileSync(target, 'utf-8')).toBe('history');
    expect(existsSync(target + '-wal')).toBe(false);
    expect(existsSync(target + '.migrating')).toBe(false);
  });

  it('is idempotent: a second launch leaves the migrated copy alone', () => {
    const legacy = writeLegacy('history');
    const target = packagedSessionsDbPath(userData);
    expect(migrateLegacySessionsDb(legacy, target)).toBe('migrated');
    writeFileSync(target, 'new runs added since');
    expect(migrateLegacySessionsDb(legacy, target)).toBe('already-present');
    expect(readFileSync(target, 'utf-8')).toBe('new runs added since');
  });
});
