"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

type WindowAction = "close" | "minimize" | "toggleFullscreen" | "toggleMaximize";
type WindowControl = { action: WindowAction; label: string; className: string; title?: string; glyph: ReactNode; onClick?: (event: MouseEvent<HTMLButtonElement>) => void };

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

/**
 * The preload exposes the platform synchronously; the <html> attribute it also
 * stamps arrives only at DOMContentLoaded, which hydration can precede. Read in
 * an effect so the server-rendered markup matches.
 */
function useDesktopPlatform() {
  const [platform, setPlatform] = useState<string | undefined>();
  useEffect(() => { setPlatform(window.nodeBananaDesktop?.platform ?? document.documentElement.dataset.desktopPlatform); }, []);
  return platform;
}

/** One button per window action, the same markup on both platforms. */
function WindowControlButtons({ className, controls }: { className?: string; controls: readonly WindowControl[] }) {
  return (
    <div className={`desktop-window-controls${className ? ` ${className}` : ""}`} role="group" aria-label="Window controls">
      {controls.map(({ action, label, className, title, glyph, onClick }) => (
        <button
          key={action}
          type="button"
          className={`desktop-window-control ${className}`}
          aria-label={label}
          title={title ?? label}
          onClick={onClick ?? (() => window.nodeBananaWindow?.[action]())}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

/** macOS traffic lights, drawn inside the tab strip at the top left. */
function MacWindowControls() {
  const controls: WindowControl[] = macControls.map(({ action, label, className, icon }) => ({
    action, label, className,
    title: action === "toggleFullscreen" ? `${label} (Option-click to zoom)` : undefined,
    onClick: action === "toggleFullscreen"
      ? (event) => { if (event.altKey) window.nodeBananaWindow?.toggleMaximize(); else window.nodeBananaWindow?.toggleFullscreen(); }
      : undefined,
    glyph: <span className="desktop-window-control-dot"><svg viewBox="0 0 14 14" aria-hidden="true"><path d={icon} /></svg></span>,
  }));
  return <WindowControlButtons controls={controls} />;
}

/**
 * Windows caption buttons at the top right, in the native order, replacing the
 * frame the window no longer has. The middle button follows the window's
 * maximised state, which the main process pushes over IPC.
 */
function WindowsWindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.nodeBananaWindow?.onMaximized?.(setMaximized), []);
  const glyph = (path: string) => <svg viewBox="0 0 10 10" aria-hidden="true"><path d={path} /></svg>;
  const controls: WindowControl[] = [
    { action: "minimize", label: "Minimise window", className: "desktop-window-minimize", glyph: glyph(windowsGlyphs.minimize) },
    { action: "toggleMaximize", label: maximized ? "Restore window" : "Maximise window", className: "desktop-window-maximize", glyph: glyph(maximized ? windowsGlyphs.restore : windowsGlyphs.maximize) },
    { action: "close", label: "Close window", className: "desktop-window-close", glyph: glyph(windowsGlyphs.close) },
  ];
  return <WindowControlButtons className="desktop-window-controls-windows" controls={controls} />;
}

/** Window actions for the platforms whose chrome the renderer draws, exposed by Electron's isolated preload. */
export function DesktopWindowControls() {
  const platform = useDesktopPlatform();
  return platform === "win32" ? <WindowsWindowControls /> : <MacWindowControls />;
}
