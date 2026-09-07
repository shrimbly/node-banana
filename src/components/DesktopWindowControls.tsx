"use client";

const controls = [
  { action: "close", label: "Close window", className: "desktop-window-close", icon: "m4.5 4.5 5 5m0-5-5 5" },
  { action: "minimize", label: "Minimise window", className: "desktop-window-minimize", icon: "M3.5 7h7" },
  { action: "toggleFullscreen", label: "Toggle fullscreen", className: "desktop-window-fullscreen", icon: "M4 7V4h3m3 3v3H7" },
] as const;

/** macOS window actions, exposed by Electron's isolated preload. */
export function DesktopWindowControls() {
  return (
    <div className="desktop-window-controls" role="group" aria-label="Window controls">
      {controls.map(({ action, label, className, icon }) => (
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
