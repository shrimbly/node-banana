"use client";

import React from "react";
import { Handle, Position, useNodeConnections } from "@xyflow/react";
import type { HandleType } from "@/types";
import { cn } from "./cn";
import { SOCKET_H, SOCKET_HOLE_R, SOCKET_RING_W, SOCKET_W, socketCenter } from "./tokens";
import { HandleLabel } from "../HandleLabel";

export type SocketType = HandleType | "reference";

export interface SocketSpec {
  /** Handle id. Unchanged from the pre-redesign handles: edges reference it. */
  id: string;
  type: SocketType;
  label?: string;
  isConnectable?: boolean;
  /**
   * A handle that must exist for saved edges to resolve but is not shown.
   * Takes no row of its own; it sits on the row of the socket before it.
   */
  hidden?: boolean;
  /** Dimmed: a schema slot with nothing to connect yet. */
  placeholder?: boolean;
  /** Explicit row (0-based); defaults to the socket's order among visible ones. */
  row?: number;
  dataTutorial?: string;
}

/**
 * The swell: three tangent arcs from the card border out into a bump and
 * back, in an 18×28 box whose x=14.5 is the centre of the card's 1px border.
 * Stems extend 2px beyond the box top and bottom so the stroke overlaps the
 * border rather than meeting it.
 */
export const SOCKET_SWELL =
  "M14.5,-2 L14.5,0 A5,5 0 0 1 9.5,5 A9,9 0 0 0 9.5,23 A5,5 0 0 1 14.5,28 L14.5,30";
/** Same outline closed a little past the border, so the fill hides the border beneath the swell. */
const SOCKET_FILL = `${SOCKET_SWELL} L16,30 L16,-2 Z`;
const HOLE_CX = 9.5;
const HOLE_CY = 14;

export function socketColor(type: SocketType): string {
  return `var(--color-handle-${type})`;
}

interface SocketProps {
  side: "left" | "right";
  row: number;
  spec: SocketSpec;
  showLabel?: boolean;
}

/**
 * One socket in the media card's border. The React Flow Handle *is* the 18×28
 * box, so edges terminate at the swell and the hit area follows it.
 */
export function Socket({ side, row, spec, showLabel = false }: SocketProps) {
  const handleType = side === "left" ? "target" : "source";
  const connections = useNodeConnections({ handleType, handleId: spec.id });
  const connected = connections.length > 0;
  const color = socketColor(spec.type);
  const position = side === "left" ? Position.Left : Position.Right;

  if (spec.hidden) {
    return (
      <Handle
        type={handleType}
        position={position}
        id={spec.id}
        data-handletype={spec.type}
        isConnectable={false}
        className="socket socket-hidden"
        style={{ top: socketCenter(row), [side]: 0, width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
      />
    );
  }

  return (
    <>
      <Handle
        type={handleType}
        position={position}
        id={spec.id}
        data-handletype={spec.type}
        data-tutorial={spec.dataTutorial}
        data-connected={connected ? "true" : undefined}
        isConnectable={spec.isConnectable ?? true}
        className={cn("socket", spec.placeholder && "socket-placeholder")}
        style={{
          top: socketCenter(row) - SOCKET_H / 2,
          [side]: -(SOCKET_W - 3),
          width: SOCKET_W,
          height: SOCKET_H,
          transform: side === "right" ? "scaleX(-1)" : "none",
          color,
        }}
      >
        <svg width={SOCKET_W} height={SOCKET_H} viewBox={`0 0 ${SOCKET_W} ${SOCKET_H}`} overflow="visible" aria-hidden>
          <path d={SOCKET_FILL} className="fill-card" />
          <path d={SOCKET_SWELL} fill="none" className="stroke-card-border" strokeWidth={1} />
          <circle
            data-socket-hole
            cx={HOLE_CX}
            cy={HOLE_CY}
            r={SOCKET_HOLE_R}
            fill={connected ? "currentColor" : "var(--color-canvas-bg)"}
            stroke="currentColor"
            strokeWidth={SOCKET_RING_W}
            strokeOpacity={connected ? 1 : 0.6}
          />
        </svg>
      </Handle>
      {spec.label && (
        <HandleLabel
          label={spec.label}
          side={handleType}
          color={color}
          top={socketCenter(row) - 7}
          offset="22px"
          visible={showLabel}
          opacity={spec.placeholder ? 0.5 : undefined}
        />
      )}
    </>
  );
}

/** Row index for each socket: visible ones count up, hidden ones borrow the previous row. */
export function assignSocketRows(sockets: ReadonlyArray<SocketSpec>): number[] {
  let next = 0;
  return sockets.map((spec) => {
    if (spec.row !== undefined) {
      if (!spec.hidden) next = Math.max(next, spec.row + 1);
      return spec.row;
    }
    if (spec.hidden) return Math.max(next - 1, 0);
    return next++;
  });
}

/** How many rows a column occupies (for the card's minimum height). */
export function socketRowCount(sockets: ReadonlyArray<SocketSpec>): number {
  const rows = assignSocketRows(sockets);
  let max = -1;
  sockets.forEach((spec, i) => {
    if (!spec.hidden) max = Math.max(max, rows[i]);
  });
  return max + 1;
}

interface SocketColumnProps {
  side: "left" | "right";
  sockets: ReadonlyArray<SocketSpec>;
  showLabels?: boolean;
}

export function SocketColumn({ side, sockets, showLabels = false }: SocketColumnProps) {
  const rows = assignSocketRows(sockets);
  return (
    <>
      {sockets.map((spec, i) => (
        <Socket key={`${side}-${spec.id}`} side={side} row={rows[i]} spec={spec} showLabel={showLabels} />
      ))}
    </>
  );
}
