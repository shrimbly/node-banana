export type CredentialName = `provider.${"gemini" | "openai" | "anthropic" | "replicate" | "fal" | "kie" | "wavespeed"}` | `comfy.${"cloudApiKey" | "remoteApiKey" | "comfyOrgApiKey" | "cloudUrl" | "localUrl" | "remoteUrl"}`;
export type DesktopCredentials = Partial<Record<CredentialName, string | null>>;
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: string };

declare global {
  interface Window {
    readonly nodeBananaDesktop?: {
      credentials: {
        read: () => Promise<DesktopResult<DesktopCredentials>>;
        write: (patch: DesktopCredentials) => Promise<DesktopResult<DesktopCredentials>>;
        delete: (name: CredentialName) => Promise<DesktopResult<DesktopCredentials>>;
      };
    };
    readonly nodeBananaWindow?: {
      close: () => void;
      minimize: () => void;
      toggleFullscreen: () => void;
      toggleMaximize: () => void;
    };
  }
}
