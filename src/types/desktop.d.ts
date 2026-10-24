export type CredentialName = `provider.${"gemini" | "openai" | "anthropic" | "replicate" | "fal" | "kie" | "wavespeed" | "comfy"}` | `comfy.${"cloudApiKey" | "remoteApiKey" | "comfyOrgApiKey" | "cloudUrl" | "localUrl" | "remoteUrl"}`;
export type DesktopCredentials = Partial<Record<CredentialName, string | null>>;
export type EnvironmentImport = { cancelled: true } | {
  cancelled: false;
  imported: string[];
  skipped: string[];
  credentials: DesktopCredentials;
  preferences: { mode?: 'cloud' | 'local' | 'remote'; localUsesApiV2?: boolean; remoteUsesApiV2?: boolean };
};
/** `code` names a failure the renderer can act on beyond retrying; today only `undecryptable`. */
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };
/** Where the app's updater stands (electron/lib/updates.cjs). */
export interface DesktopUpdateState {
  /** False outside a packaged app; every status is then `idle`. */
  supported: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error';
  currentVersion: string;
  /** The newer release, from `available` on. */
  version?: string;
  /** The release page (or the releases list, for an error before a version was known). */
  url?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
  /** The user asked for this check, so its outcome is worth showing even when it is nothing. */
  manual?: boolean;
}

declare global {
  interface Window {
    readonly nodeBananaDesktop?: {
      /** Node's `process.platform`; the same value the preload stamps on `<html data-desktop-platform>` at DOMContentLoaded. */
      platform: string;
      backend: {
        state: () => Promise<boolean>;
        restart: () => Promise<boolean>;
        onStatus: (callback: (online: boolean) => void) => () => void;
      };
      openLogs: () => Promise<void>;
      /** File › Save in the app menu (Cmd/Ctrl+S); the page saves the current workflow. */
      onSaveRequest: (callback: () => void) => () => void;
      updates: {
        state: () => Promise<DesktopUpdateState>;
        /** A manual check: its result is shown even when there is nothing new. */
        check: () => Promise<DesktopUpdateState>;
        download: () => Promise<DesktopUpdateState>;
        /** Quits and installs a downloaded update. */
        install: () => Promise<DesktopUpdateState>;
        /** Stops offering this version until the next manual check. */
        skip: () => Promise<DesktopUpdateState>;
        /** Puts the notice away until the next check. */
        dismiss: () => Promise<DesktopUpdateState>;
        onChange: (callback: (state: DesktopUpdateState) => void) => () => void;
      };
      recovery: {
        read: () => Promise<DesktopResult<{ snapshot: unknown; warnings: string[] }>>;
        write: (snapshot: unknown) => Promise<DesktopResult<boolean>>;
        putAsset: (asset: { bytes: Uint8Array; mime: string }) => Promise<DesktopResult<{ $recoveryAsset: string; mime: string }>>;
        readAsset: (request: { asset: { $recoveryAsset: string; mime: string }; offset: number }) => Promise<DesktopResult<{ bytes: Uint8Array; size: number }>>;
        hydrate: (snapshot: unknown) => Promise<DesktopResult<{ snapshot: unknown; warnings: string[] }>>;
        discardTab: (id: string) => DesktopResult<void | { warning: string }>;
        discard: () => Promise<DesktopResult<void>>;
      };
      credentials: {
        importEnvironment: () => Promise<DesktopResult<EnvironmentImport>>;
        read: () => Promise<DesktopResult<DesktopCredentials>>;
        write: (patch: DesktopCredentials) => Promise<DesktopResult<DesktopCredentials>>;
        delete: (name: CredentialName) => Promise<DesktopResult<DesktopCredentials>>;
        /** Moves an undecryptable store aside and starts an empty one. */
        reset: () => Promise<DesktopResult<DesktopCredentials>>;
      };
    };
    readonly nodeBananaWindow?: {
      close: () => void;
      minimize: () => void;
      toggleFullscreen: () => void;
      toggleMaximize: () => void;
      onMaximized: (callback: (maximized: boolean) => void) => () => void;
    };
  }
}
