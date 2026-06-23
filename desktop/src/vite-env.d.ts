/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface EngineHandshakeBridge {
  port: number;
  token: string;
}

interface SecretListingBridge {
  key: string;
  hint: string;
  updatedAt: string;
}

interface SecretEntryBridge {
  hint: string;
  updatedAt: string;
  cipher: string;
}

interface CorruptionRecoveryBridge {
  backupPath: string;
  recoveredAt: string;
}

interface SecretsAvailabilityBridge {
  available: boolean;
  filePath: string;
  corruptionRecovery: CorruptionRecoveryBridge | null;
}

interface SecretsBridge {
  availability: () => Promise<SecretsAvailabilityBridge>;
  set: (key: string, value: string) => Promise<SecretEntryBridge>;
  get: (key: string) => Promise<string | null>;
  list: () => Promise<SecretListingBridge[]>;
  delete: (key: string) => Promise<boolean>;
  onRecovered: (
    handler: (info: CorruptionRecoveryBridge) => void,
  ) => () => void;
}

interface OAuthStartResultBridge {
  success: boolean;
  email?: string;
  error?: string;
}

interface OAuthStatusBridge {
  connected: boolean;
  email?: string;
  expiresAt?: number;
  needsRefresh?: boolean;
  planType?: string;
  isFreeTier?: boolean;
}

interface OAuthProgressEventBridge { message: string }
interface OAuthPromptEventBridge { message: string; placeholder?: string }

interface OAuthCredentialsBridge {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
}

interface OAuthBridge {
  openaiStart: () => Promise<OAuthStartResultBridge>;
  openaiStatus: () => Promise<OAuthStatusBridge>;
  openaiDisconnect: () => Promise<boolean>;
  openaiPromptResponse: (value: string) => void;
  openaiCredentials: () => Promise<OAuthCredentialsBridge | null>;
  onProgress: (handler: (event: OAuthProgressEventBridge) => void) => () => void;
  onPrompt: (handler: (event: OAuthPromptEventBridge) => void) => () => void;
}

type MenuChannel =
  | 'menu:navigate'
  | 'menu:new-analysis'
  | 'menu:stop-stream'
  | 'menu:check-upstream';

interface UpstreamCheckResultBridge {
  status: 'ok' | 'behind' | 'error';
  latestTag: string;
  upstreamHead: string;
  ourHead: string;
  behindCount: number;
  aheadCount: number;
  behindCommits: string[];
  checkedAt: string;
  error?: string;
  compareUrl: string;
}

interface ConsentStateBridge {
  acceptedVersion: number | null;
  requiredVersion: number;
}

interface ConsentBridge {
  get: () => Promise<ConsentStateBridge>;
  accept: () => Promise<boolean>;
  decline: () => Promise<void>;
}

interface UpdatesStateBridge {
  autoUpdate: boolean;
  currentVersion: string;
  supported: boolean;
}

interface UpdatesStatusBridge {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'dev';
  version?: string;
  percent?: number;
  message?: string;
}

interface UpdatesBridge {
  getState: () => Promise<UpdatesStateBridge>;
  setAuto: (enabled: boolean) => Promise<boolean>;
  check: () => Promise<{ ok: boolean; reason?: string }>;
  install: () => Promise<void>;
  onStatus: (handler: (status: UpdatesStatusBridge) => void) => () => void;
}

interface TradingAgentsLabBridge {
  version: string;
  platform: NodeJS.Platform;
  getEngineHandshake: () => Promise<EngineHandshakeBridge>;
  onEngineExited: (handler: () => void) => () => void;
  consent: ConsentBridge;
  updates: UpdatesBridge;
  secrets: SecretsBridge;
  oauth: OAuthBridge;
  onMenuCommand: (
    channel: MenuChannel,
    handler: (...args: unknown[]) => void,
  ) => () => void;
  checkUpstream: () => Promise<UpstreamCheckResultBridge>;
  shutdown: () => Promise<void>;
  restart: () => Promise<void>;
}

declare global {
  interface Window {
    tradingAgentsLab: TradingAgentsLabBridge;
  }
}

export {};
