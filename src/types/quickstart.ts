import type { NodeType } from "./nodes";

export type QuickstartView = "initial" | "templates" | "browse";

export type TemplateCategory = "simple" | "advanced" | "community";

export interface TemplateMetadata {
  nodeCount: number;
  category: TemplateCategory;
  tags: string[];
  previewImage?: string;
}

export interface CommunityWorkflowMeta {
  id: string;
  name: string;
  filename: string;
  author: string;
  size: number;
  description: string;
  nodeCount: number;
  tags: string[];
  previewImage?: string;
  hoverImage?: string;
  sortOrder?: number;
}

// ============================================================================
// Workflow Proposal Types
// ============================================================================

/**
 * A proposed node in the workflow - describes purpose and configuration
 * without internal state or positioning details
 */
export interface ProposedNode {
  /** Temporary ID like "node-1" */
  id: string;
  /** Node type: imageInput, prompt, nanoBanana, etc. */
  type: NodeType;
  /** Human-readable description of this node's role */
  purpose: string;
  /** customTitle for the node */
  suggestedTitle: string;
  /** For prompt nodes: the suggested prompt text */
  suggestedPrompt?: string;
  /** For nanoBanana/generateVideo: the suggested model */
  suggestedModel?: string;
  /** For nanoBanana/generateVideo: suggested settings like aspectRatio */
  suggestedSettings?: Record<string, unknown>;
}

/**
 * A proposed connection between nodes - describes data flow
 */
export interface ProposedConnection {
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /** Connection type */
  type: "image" | "text" | "reference";
  /** Human-readable description of data flow */
  description: string;
}

/**
 * A proposed group for organizing related nodes
 */
export interface ProposedGroup {
  /** Group name */
  name: string;
  /** Group color */
  color: "neutral" | "blue" | "green" | "purple" | "orange";
  /** IDs of nodes in this group */
  nodeIds: string[];
  /** Human-readable description of what this group represents */
  purpose: string;
}

/**
 * Workflow complexity estimate
 */
export type WorkflowComplexity = "simple" | "moderate" | "complex";

/**
 * A complete workflow proposal - reviewable structure before JSON generation
 */
export interface WorkflowProposal {
  /** Workflow name */
  name: string;
  /** One-paragraph summary of what workflow does */
  description: string;
  /** Proposed nodes */
  nodes: ProposedNode[];
  /** Proposed connections */
  connections: ProposedConnection[];
  /** Optional groups for organizing nodes */
  groups?: ProposedGroup[];
  /** Estimated complexity */
  estimatedComplexity: WorkflowComplexity;
  /** Any caveats or limitations */
  warnings?: string[];
}
