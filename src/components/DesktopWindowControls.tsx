"use client";

import { useEffect, useState } from "react";

const macControls = [
  { action: "close", label: "Close window", className: "desktop-window-close", icon: "m4.5 4.5 5 5m0-5-5 5" },
  { action: "minimize", label: "Minimise window", className: "desktop-window-minimize", icon: "M3.5 7h7" },
  { action: "toggleFullscreen", label: "Toggle fullscreen", className: "desktop-window-fullscreen", icon: "M4 7V4h3m3 3v3H7" },
] as const;

// Windows caption glyphs in a 10×10 box, drawn with a 1px stroke.
const windowsGlyphs = {
  minimize: "M0 5h10",
  maximize: "M0.5 0.5h9v9h-9z",
  restore: "M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z",
  close: "M0.5 0.5l9 9M9.5 0.5l-9 9",
};

/** The tab strip supplies dragging once the editor has opened. */
export function DesktopStartupDragRegion() {
  return <div className="desktop-startup-drag-region" aria-hidden="true" />;
}

/** The preload stamps the platform on <html> before the editor hydrates. */
function useDesktopPlatform() {
  const [platform, setPlatform] = useState<string | undefined>();
  useEffect(() => { setPlatform(document.documentElement.dataset.desktopPlatform); }, []);
  return platform;
}

/** macOS traffic lights, drawn inside the tab strip at the top left. */
function MacWindowControls() {
  return (
    <div className="desktop-window-controls" role="group" aria-label="Window controls">
      {macControls.map(({ action, label, className, icon }) => (
        <button
          key={action}
          type="button"
          className={`desktop-window-control ${className}`}
          aria-label={label}
          title={action === "toggleFullscreen" ? `${label} (Option-click to zoom)` : label}
          onClick={(event) => {
            if (action === "toggleFullscreen" && event.altKey) window.nodeBananaWindow?.toggleMaximize();
            else window.nodeBananaWindow?.[action]();
          }}
        >
          <span className="desktop-window-control-dot">
            <svg viewBox="0 0 14 14" aria-hidden="true"><path d={icon} /></svg>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Windows caption buttons at the top right, in the native order, replacing the
 * frame the window no longer has. The middle button follows the window's
 * maximised state, which the main process pushes over IPC.
 */
function WindowsWindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.nodeBananaWindow?.onMaximized?.(setMaximized), []);
  const controls = [
    { action: "minimize", label: "Minimise window", className: "desktop-window-minimize", icon: windowsGlyphs.minimize },
    { action: "toggleMaximize", label: maximized ? "Restore window" : "Maximise window", className: "desktop-window-maximize", icon: maximized ? windowsGlyphs.restore : windowsGlyphs.maximize },
    { action: "close", label: "Close window", className: "desktop-window-close", icon: windowsGlyphs.close },
  ] as const;
  return (
    <div className="desktop-window-controls desktop-window-controls-windows" role="group" aria-label="Window controls">
      {controls.map(({ action, label, className, icon }) => (
        <button
          key={action}
          type="button"
          className={`desktop-window-control ${className}`}
          aria-label={label}
          title={label}
          onClick={() => window.nodeBananaWindow?.[action]()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d={icon} /></svg>
        </button>
      ))}
    </div>
  );
}

/** Window actions for the platforms whose chrome the renderer draws, exposed by Electron's isolated preload. */
export function DesktopWindowControls() {
  const platform = useDesktopPlatform();
  return platform === "win32" ? <WindowsWindowControls /> : <MacWindowControls />;
}
