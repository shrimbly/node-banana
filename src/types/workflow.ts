/**
 * Workflow Types
 *
 * Types for workflow management including edges, save configuration,
 * cost tracking, and node groups.
 */

import { Edge } from "@xyflow/react";

// Workflow Edge Data
export interface WorkflowEdgeData extends Record<string, unknown> {
  hasPause?: boolean;
  createdAt?: number;
  isLoop?: boolean;
  loopCount?: number;
  /** Drawn as labelled stubs at its handles instead of a line; still executes. */
  hidden?: boolean;
  /** The user's own label; empty means show the automatic one. */
  label?: string;
  /** Manual bundle this edge belongs to (with others between the same nodes). */
  bundleId?: string;
}

// Workflow Edge
export type WorkflowEdge = Edge<WorkflowEdgeData>;

// How the line of a connection is routed. Saved per workflow as `edgeStyle`.
export type EdgeStyle = "angular" | "curved" | "straight";

// How connections are drawn, beyond the line style. Saved per workflow as
// `edgeAppearance`, with the user's default kept in localStorage.
export type EdgeThickness = "thin" | "regular" | "thick";

/** When automatic labels (type, image order) show. Typed labels always show. */
export type EdgeLabelMode = "always" | "hover" | "never";

export interface EdgeAppearance {
  thickness: EdgeThickness;
  /** Opacity of connections not attached to a selected node, 0 to 1. */
  fadedOpacity: number;
  /** Fade the middle of each connection so the ends stay readable. */
  gradient: boolean;
  /** Animate connections into a node while it generates. */
  loadingPulse: boolean;
  labels: EdgeLabelMode;
}

export const defaultEdgeAppearance: EdgeAppearance = {
  thickness: "regular",
  fadedOpacity: 0.25,
  gradient: true,
  loadingPulse: true,
  labels: "hover",
};

// Auto-save configuration stored in localStorage
export interface WorkflowSaveConfig {
  workflowId: string;
  name: string;
  directoryPath: string;
  generationsPath: string | null;
  lastSavedAt: number | null;
  useExternalImageStorage?: boolean;  // Whether to store images as files vs embedded base64
}

// Cost tracking data stored per-workflow in localStorage
export interface WorkflowCostData {
  workflowId: string;
  incurredCost: number;
  lastUpdated: number;
}

// Group background color options (dark mode tints)
export type GroupColor =
  | "neutral"
  | "blue"
  | "green"
  | "purple"
  | "orange"
  | "red";

// Group definition stored in workflow
export interface NodeGroup {
  id: string;
  name: string;
  color: GroupColor;
  position: { x: number; y: number };
  size: { width: number; height: number };
  locked?: boolean;
  isNbpInput?: boolean;
}
