"use client";

import { useState, type ReactNode } from "react";
import {
  MiniMap,
  Panel,
  useReactFlow,
  useStore,
  useStoreApi,
  useViewport,
  type Node,
} from "@xyflow/react";
import { ChromeIconButton } from "./ChromeIconButton";
import { CHROME_DIVIDER, CHROME_SURFACE } from "./chromeStyles";

/**
 * The navigator: minimap on top, one row of canvas controls beneath. Hiding
 * the minimap leaves the row on its own, so zoom, fit and lock never move.
 */
/** Card width, with its 1px border: wide enough for the control row. Neighbours to the left offset from this. */
export const NAVIGATOR_WIDTH = 280;

export const MINIMAP_GEOMETRY = {
  /** Fills the card between the insets. */
  width: NAVIGATOR_WIDTH - 6 * 2 - 2,
  height: 150,
  /** Distance from the canvas edges. */
  margin: 16,
  /** Inset between the card edge and the minimap. */
  padding: 6,
} as const;

export function getMiniMapNodeColor(node: Node): string {
  switch (node.type) {
    case "imageInput": return "#3b82f6";
    case "audioInput": return "#a78bfa";
    case "videoInput": return "#c084fc";
    case "annotation": return "#8b5cf6";
    case "prompt": return "#f97316";
    case "array": return "#a3e635";
    case "promptConstructor": return "#f472b6";
    case "nanoBanana": return "#22c55e";
    case "generateVideo": return "#9333ea";
    case "generate3d": return "#fb923c";
    case "generateAudio": return "#d946ef";
    case "llmGenerate": return "#06b6d4";
    case "splitGrid": return "#f59e0b";
    case "output": return "#ef4444";
    case "outputGallery": return "#ec4899";
    case "imageCompare": return "#14b8a6";
    case "videoStitch": return "#f97316";
    case "easeCurve": return "#bef264";
    case "videoTrim": return "#60a5fa";
    case "videoFrameGrab": return "#38bdf8";
    case "removeBackground": return "#2dd4bf";
    case "imageResize": return "#0d9488";
    case "gifEncoder": return "#f472b6";
    case "router": return "#6b7280";
    case "switch": return "#8b5cf6";
    case "conditionalSwitch": return "#06b6d4";
    case "glbViewer": return "#0ea5e9";
    case "comfyApp": return "#7dd3fc";
    default: return "#94a3b8";
  }
}

const iconProps = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;

interface ControlButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
  on?: boolean;
  pressed?: boolean;
  children: ReactNode;
}

function ControlButton({ label, disabled, onClick, on = false, pressed, children }: ControlButtonProps) {
  return (
    <ChromeIconButton label={label} aria-pressed={pressed} open={on} disabled={disabled} onClick={onClick}>
      {children}
    </ChromeIconButton>
  );
}

/** Subscribes to the viewport on its own so panning re-renders only this label. */
function ZoomReadout() {
  const { zoom } = useViewport();
  return (
    <span
      className="min-w-9 text-center text-[10px] font-medium tabular-nums text-neutral-300"
      aria-label="Zoom level"
    >
      {Math.round(zoom * 100)}%
    </span>
  );
}

interface CanvasMinimapProps {
  /** Tutorial lock: greyed out and inert. */
  disabled?: boolean;
}

export function CanvasMinimap({ disabled = false }: CanvasMinimapProps) {
  const [isMinimapVisible, setIsMinimapVisible] = useState(true);
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const store = useStoreApi();
  const isInteractive = useStore(
    (s) => Boolean(s.nodesDraggable || s.nodesConnectable || s.elementsSelectable),
  );

  const toggleInteractive = () => {
    store.setState({
      nodesDraggable: !isInteractive,
      nodesConnectable: !isInteractive,
      elementsSelectable: !isInteractive,
    });
  };

  return (
    <Panel
      position="bottom-right"
      data-testid="canvas-navigator"
      style={{ margin: MINIMAP_GEOMETRY.margin, width: NAVIGATOR_WIDTH }}
      className={`${CHROME_SURFACE} nodrag nopan nowheel flex flex-col overflow-hidden rounded-xl ${
        disabled ? "opacity-30 pointer-events-none" : ""
      }`}
    >
      {isMinimapVisible && (
        <div style={{ padding: `${MINIMAP_GEOMETRY.padding}px ${MINIMAP_GEOMETRY.padding}px 0` }}>
          <MiniMap
            // 6px radius = the card's 12px minus the 6px inset, so the corners run concentric.
            className="overflow-hidden rounded-md squircle bg-well shadow-well"
            style={{
              position: "static",
              margin: 0,
              width: MINIMAP_GEOMETRY.width,
              height: MINIMAP_GEOMETRY.height,
            }}
            bgColor="#1a1a1a"
            maskColor="rgba(0, 0, 0, 0.6)"
            maskStrokeColor="rgba(255, 255, 255, 0.35)"
            maskStrokeWidth={1}
            pannable
            zoomable
            nodeColor={getMiniMapNodeColor}
          />
        </div>
      )}
      <div className="flex h-[38px] items-center justify-center gap-0.5 px-1">
        <ControlButton label="Zoom out" disabled={disabled} onClick={() => zoomOut()}>
          <svg className="h-[18px] w-[18px]" {...iconProps}><path d="M5 12h14" /></svg>
        </ControlButton>
        <ZoomReadout />
        <ControlButton label="Zoom in" disabled={disabled} onClick={() => zoomIn()}>
          <svg className="h-[18px] w-[18px]" {...iconProps}><path d="M12 5v14M5 12h14" /></svg>
        </ControlButton>
        <div className={CHROME_DIVIDER} />
        <ControlButton label="Fit view" disabled={disabled} onClick={() => fitView()}>
          <svg className="h-[18px] w-[18px]" {...iconProps}>
            <path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" />
          </svg>
        </ControlButton>
        <ControlButton
          label={isInteractive ? "Lock canvas" : "Unlock canvas"}
          pressed={!isInteractive}
          on={!isInteractive}
          disabled={disabled}
          onClick={toggleInteractive}
        >
          <svg className="h-[18px] w-[18px]" {...iconProps}>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d={isInteractive ? "M8 11V7a4 4 0 018 0" : "M8 11V7a4 4 0 018 0v4"} />
          </svg>
        </ControlButton>
        <div className={CHROME_DIVIDER} />
        <ControlButton
          label={isMinimapVisible ? "Hide minimap" : "Show minimap"}
          pressed={isMinimapVisible}
          on={isMinimapVisible}
          disabled={disabled}
          onClick={() => setIsMinimapVisible((v) => !v)}
        >
          <svg className="h-[18px] w-[18px]" {...iconProps} strokeWidth={1.5}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 8h3v3H7zM12 8h3v3h-3zM7 13h8v3H7z" fill="currentColor" stroke="none" />
          </svg>
        </ControlButton>
      </div>
    </Panel>
  );
}
