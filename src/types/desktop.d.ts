export type CredentialName = `provider.${"gemini" | "openai" | "anthropic" | "replicate" | "fal" | "kie" | "wavespeed"}` | `comfy.${"cloudApiKey" | "remoteApiKey" | "comfyOrgApiKey" | "cloudUrl" | "localUrl" | "remoteUrl"}`;
export type DesktopCredentials = Partial<Record<CredentialName, string | null>>;
export type EnvironmentImport = { cancelled: true } | {
  cancelled: false;
  imported: string[];
  skipped: string[];
  credentials: DesktopCredentials;
  preferences: { mode?: 'cloud' | 'local' | 'remote'; localUsesApiV2?: boolean; remoteUsesApiV2?: boolean };
};
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: string };

declare global {
  interface Window {
    readonly nodeBananaDesktop?: {
      backend: {
        state: () => Promise<boolean>;
        restart: () => Promise<boolean>;
        onStatus: (callback: (online: boolean) => void) => () => void;
      };
      openLogs: () => Promise<void>;
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
