/**
 * Unit tests for app preferences persistence (Phase 7c.4). electron's
 * `app.getPath` is mocked to a temp dir; real node:fs is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USERDATA = path.join(os.tmpdir(), 'tal-prefs-test');

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
}));

import { getAutoUpdate, setAutoUpdate } from '../../electron/prefs';

const prefsFile = path.join(USERDATA, 'preferences.json');

describe('app preferences (autoUpdate)', () => {
  beforeEach(() => fs.rmSync(USERDATA, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(USERDATA, { recursive: true, force: true }));

  it('defaults autoUpdate to true when no file exists', () => {
    expect(getAutoUpdate()).toBe(true);
  });

  it('persists a disabled setting and reads it back', () => {
    expect(setAutoUpdate(false)).toBe(false);
    expect(getAutoUpdate()).toBe(false);
  });

  it('round-trips re-enabling', () => {
    setAutoUpdate(false);
    setAutoUpdate(true);
    expect(getAutoUpdate()).toBe(true);
  });

  it('falls back to the default on a corrupt prefs file', () => {
    fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(prefsFile, '{ broken');
    expect(getAutoUpdate()).toBe(true);
  });

  it('preserves unknown keys written by a future version', () => {
    fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(
      prefsFile,
      JSON.stringify({ autoUpdate: false, futureThing: 'x' }),
    );
    setAutoUpdate(true);
    const onDisk = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    expect(onDisk.autoUpdate).toBe(true);
    expect(onDisk.futureThing).toBe('x');
  });
});
