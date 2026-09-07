export {};

declare global {
  interface Window {
    readonly nodeBananaWindow?: {
      close: () => void;
      minimize: () => void;
      toggleFullscreen: () => void;
      toggleMaximize: () => void;
    };
  }
}
