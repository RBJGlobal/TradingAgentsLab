import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret storage backed by Electron's `safeStorage` (OS keychain on macOS,
 * DPAPI on Windows, libsecret on Linux). Plaintext is never written to disk.
 * The `secrets.json` file under `<userData>` only contains base64-encoded
 * encrypted blobs that can only be decrypted on the same machine + user.
 *
 * Hard-fail design: if the OS doesn't expose an encryption backend
 * (e.g. headless Linux without a keyring), every operation throws rather
 * than silently falling back to plaintext storage.
 *
 * Corruption recovery (Tier 2, 2026-05-24): if the secrets file exists but
 * has unparseable JSON, we rename it to `secrets.json.corrupt-<iso>.bak`
 * and proceed as if it were missing. The user has to re-enter their keys
 * once, which is strictly better than every Settings interaction throwing
 * a crash error indefinitely. The renderer surfaces a banner above the
 * Settings tabs so the recovery isn't silent — see `onSecretsRecovered`.
 */

const SCHEMA_VERSION = 1;

export interface SecretEntry {
  /** Last 4 plaintext characters — for UI hinting. Never the full value. */
  hint: string;
  /** ISO-8601 timestamp of when the entry was last set. */
  updatedAt: string;
  /** Base64 of the safeStorage-encrypted bytes. */
  cipher: string;
}

interface SecretsFile {
  version: number;
  entries: Record<string, SecretEntry>;
}

export interface SecretListing {
  key: string;
  hint: string;
  updatedAt: string;
}

export interface CorruptionRecovery {
  /** Where the unreadable original was moved. Surfaced to the user. */
  backupPath: string;
  /** ISO-8601 timestamp of when recovery happened. */
  recoveredAt: string;
}

class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Encryption backend unavailable on this OS — refusing to store secrets ' +
      'in plaintext. On Linux this typically means no keyring is running.',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

function secretsFilePath(): string {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function ensureEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError();
  }
}

// Tracks the most recent corruption recovery for both push (event to renderer
// the moment it happens) and pull (included in `secrets:availability` so the
// banner appears even if the renderer subscribed after recovery).
let _recovery: CorruptionRecovery | null = null;
type RecoveryListener = (info: CorruptionRecovery) => void;
const _recoveryListeners: RecoveryListener[] = [];

export function onSecretsRecovered(listener: RecoveryListener): void {
  _recoveryListeners.push(listener);
}

export function getCorruptionRecovery(): CorruptionRecovery | null {
  return _recovery;
}

function recordRecovery(backupPath: string): void {
  _recovery = { backupPath, recoveredAt: new Date().toISOString() };
  for (const listener of _recoveryListeners) {
    try {
      listener(_recovery);
    } catch {
      // A bad listener must not break secrets I/O.
    }
  }
}

function backupCorruptFile(file: string, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}.bak`;
  try {
    fs.renameSync(file, backup);
  } catch (err) {
    // If rename fails (cross-device, permissions), fall back to copy+unlink so
    // we still get out of the corrupt state. If even that fails, leave the
    // original in place — the throw below would have rendered Settings broken
    // anyway, and the user can manually delete the file.
    try {
      fs.copyFileSync(file, backup);
      fs.unlinkSync(file);
    } catch {
      /* swallow — we'll log and proceed with empty entries */
    }
  }
  process.stderr.write(
    `[secrets] ${reason}; backed up to ${backup} and starting fresh\n`,
  );
  recordRecovery(backup);
  return backup;
}

function readFile(): SecretsFile {
  const file = secretsFilePath();
  if (!fs.existsSync(file)) {
    return { version: SCHEMA_VERSION, entries: {} };
  }
  const raw = fs.readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupCorruptFile(file, `secrets.json is corrupt: ${(err as Error).message}`);
    return { version: SCHEMA_VERSION, entries: {} };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as SecretsFile).version !== 'number'
  ) {
    backupCorruptFile(file, 'secrets.json missing version field');
    return { version: SCHEMA_VERSION, entries: {} };
  }
  if ((parsed as SecretsFile).version > SCHEMA_VERSION) {
    // Forward-compat: a file from a newer app version may carry fields we'd
    // drop on rewrite. Keep the loud throw — better to refuse than silently
    // downgrade and lose data. The user should reinstall the newer build.
    throw new Error(
      `secrets.json version ${(parsed as SecretsFile).version} is newer than ` +
      `this app supports (${SCHEMA_VERSION}); refusing to overwrite`,
    );
  }
  return parsed as SecretsFile;
}

function writeFile(data: SecretsFile): void {
  const file = secretsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write atomically: write tmp + rename.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

function hintOf(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `…${value.slice(-4)}`;
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function setSecret(key: string, value: string): SecretEntry {
  ensureEncryption();
  if (!key) throw new Error('secret key required');
  if (!value) throw new Error('secret value required');

  const data = readFile();
  const cipher = safeStorage.encryptString(value).toString('base64');
  const entry: SecretEntry = {
    hint: hintOf(value),
    updatedAt: new Date().toISOString(),
    cipher,
  };
  data.entries[key] = entry;
  data.version = SCHEMA_VERSION;
  writeFile(data);
  return entry;
}

export function getSecret(key: string): string | null {
  ensureEncryption();
  const data = readFile();
  const entry = data.entries[key];
  if (!entry) return null;
  const buf = Buffer.from(entry.cipher, 'base64');
  return safeStorage.decryptString(buf);
}

export function deleteSecret(key: string): boolean {
  // Note: deletion does not technically need encryption; we still call it for
  // consistency with the rest of the surface.
  ensureEncryption();
  const data = readFile();
  if (!(key in data.entries)) return false;
  delete data.entries[key];
  data.version = SCHEMA_VERSION;
  writeFile(data);
  return true;
}

export function listSecrets(): SecretListing[] {
  ensureEncryption();
  const data = readFile();
  return Object.entries(data.entries).map(([key, entry]) => ({
    key,
    hint: entry.hint,
    updatedAt: entry.updatedAt,
  }));
}

export function secretsFileLocation(): string {
  return secretsFilePath();
}
