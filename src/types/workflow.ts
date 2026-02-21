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
}

// Workflow Edge
export type WorkflowEdge = Edge<WorkflowEdgeData>;

// Auto-save configuration stored in localStorage
export interface WorkflowSaveConfig {
  workflowId: string;
  name: string;
  directoryPath: string;
  generationsPath: string | null;
  lastSavedAt: number | null;
  useExternalImageStorage?: boolean;  // Whether to store images as files vs embedded base64
  createdAt?: number;       // Set on first save
  updatedAt?: number;       // Set on every save
  nodeCount?: number;       // Snapshot at save time
  edgeCount?: number;       // Snapshot at save time
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
}
