/**
 * App preferences — small, non-secret key/value state in
 * userData/preferences.json. (Window bounds and secrets have their own stores;
 * this is for simple user toggles like auto-update.) Best-effort + fail-safe:
 * an unreadable file falls back to defaults.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface Prefs {
  /** Whether the app checks for updates on its own (default on). */
  autoUpdate: boolean;
}

const DEFAULTS: Prefs = { autoUpdate: true };

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function readPrefs(): Prefs {
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function writePrefs(p: Prefs): void {
  try {
    const target = prefsPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort: a failed write just means the toggle reverts next launch.
  }
}

export function getAutoUpdate(): boolean {
  return readPrefs().autoUpdate;
}

export function setAutoUpdate(enabled: boolean): boolean {
  const p = readPrefs();
  p.autoUpdate = enabled;
  writePrefs(p);
  return enabled;
}
