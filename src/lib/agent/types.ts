/**
 * Node Banana agent: shared contracts.
 *
 * The agent is a chat window on the canvas. Each turn runs on the user's own
 * Claude Code or Codex (ChatGPT) login through the official CLI, never on API
 * credits. The CLI calls our tools; the tools edit a server-side draft of the
 * canvas and stream the resulting graph operations back to the browser, which
 * applies them to the Zustand store.
 *
 *   browser ──POST /api/agent/chat {messages, harness, sessionId, workflow}──▶ route
 *   route ──runTurn──▶ harness (Claude Agent SDK | codex app-server)
 *   harness ──tool call──▶ AgentToolRuntime.execute ──▶ AgentToolResult{ops}
 *   route ──UI message stream (text, reasoning, dynamic-tool, data-graph-ops)──▶ browser
 *   browser onData(data-graph-ops) ──▶ workflowStore.applyAgentGraphOps
 */

import type { UIMessage } from "ai";
import type { NodeType } from "@/types";

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

export type AgentHarnessId = "claude" | "codex";

export const AGENT_HARNESS_IDS: readonly AgentHarnessId[] = ["claude", "codex"];

/** Who pays for a turn. Only "subscription" may run. */
export type AgentBilling = "subscription" | "api" | "none" | "unknown";

export interface AgentModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  /** One line from the vendor ("Most capable for ambitious work"). */
  description?: string;
  /** The exact model an alias runs today (`opus` → `claude-opus-5-5`), when the CLI says. */
  resolvedModel?: string;
}

export interface AgentSignInState {
  state: "idle" | "pending" | "failed";
  /**
   * The vendor's own sign-in page, when its CLI hands one to the client
   * (Codex's app-server login). Never set for Claude Code: the URL it prints
   * is its manual flow, which ends in a code pasted back into the CLI, and
   * relaying it would put the app between the user and their credential.
   */
  url?: string;
  /** Device-code flow: the code the user types at `url`. */
  userCode?: string;
  error?: string;
}

export interface AgentHarnessStatus {
  id: AgentHarnessId;
  /** "Claude Code" | "Codex" */
  label: string;
  /** The CLI binary could be found and started. */
  installed: boolean;
  version?: string;
  signedIn: boolean;
  billing: AgentBilling;
  account?: { email?: string; plan?: string };
  models: AgentModelOption[];
  signIn: AgentSignInState;
  /**
   * Why the harness cannot run right now, in plain words for the panel
   * (not installed, signed out, an API key would be billed, ...). Absent when
   * the harness is ready: installed && signedIn && billing === "subscription".
   */
  problem?: string;
  /**
   * The plan's included usage ran out at the last check: turns are refused
   * (never billed as extra usage or credits) until `until`. The login itself
   * is fine, so the status may still read ready; `problem` carries the same
   * message. Absent when no limit is known.
   */
  usageLimit?: {
    message: string;
    /** When turns may run again (ms epoch): the plan's reset time, or a short back-off when the vendor gave none. */
    until: number;
  };
  /** The terminal command that signs in with the vendor's own flow. */
  signInCommand: string;
}

/** Options for {@link AgentHarness.startSignIn}. */
export interface AgentSignInOptions {
  /**
   * Start the vendor's sign-in even though the CLI's local status looks
   * signed in: the vendor rejected that login during a turn (expired or
   * revoked), which the local status can't see. Without it a harness that
   * reads as ready answers `already_signed_in`.
   */
  force?: boolean;
}

export interface AgentSignInStart {
  state: "pending" | "already_signed_in" | "failed";
  /** As {@link AgentSignInState.url}: Codex only. */
  url?: string;
  userCode?: string;
  message?: string;
}

export type AgentErrorCode =
  | "not_installed"
  | "not_signed_in"
  | "wrong_billing"
  | "usage_limit"
  | "session_busy"
  | "bad_request"
  | "aborted"
  | "harness_error";

/** Events a harness yields while running one turn. The iterator ending means the turn is done. */
export type HarnessEvent =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  /** The model started writing a call to one of our tools (input still streaming). */
  | { type: "tool-pending"; toolName: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: AgentErrorCode; message: string };

export interface HarnessTurnParams {
  /** Resume this Claude session / Codex thread when possible. */
  sessionId?: string;
  /**
   * Earlier turns of this chat as plain text. Used only when there is no
   * resumable session (first turn on this harness, harness switched mid-chat,
   * app-server restarted), so the new session starts with the conversation.
   */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** This turn's user message, already combined with the canvas context. */
  prompt: string;
  systemPrompt: string;
  tools: AgentToolRuntime;
  model?: string;
  signal: AbortSignal;
}

export interface AgentHarness {
  id: AgentHarnessId;
  label: string;
  getStatus(): Promise<AgentHarnessStatus>;
  /** Start the vendor's own sign-in flow (the official CLI). Never touches tokens. */
  startSignIn(options?: AgentSignInOptions): Promise<AgentSignInStart>;
  runTurn(params: HarnessTurnParams): AsyncIterable<HarnessEvent>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface AgentToolDefinition {
  /** snake_case name the model sees, e.g. "edit_workflow". */
  name: string;
  /** Short label for the chat UI, e.g. "Edit workflow". */
  title: string;
  description: string;
  /**
   * zod raw shape (the object passed to z.object). The Claude harness hands it
   * to the Agent SDK's tool(); the Codex harness converts
   * z.toJSONSchema(z.object(inputShape)) for dynamic tools.
   */
  inputShape: import("zod").ZodRawShape;
  readOnly: boolean;
}

export interface AgentToolResult {
  ok: boolean;
  /** Returned to the model: ids, what changed, or a precise error with the fix. */
  text: string;
  /** One short line for the chat UI, e.g. "Added 4 nodes and 3 connections". */
  summary: string;
  /** Canvas changes to apply in the browser, in order. Empty for read-only tools and failures. */
  ops: AgentGraphOp[];
  /** Nodes worth bringing into view after the ops are applied. */
  focusNodeIds?: string[];
  /**
   * The call replaced the canvas: the batch starts by removing every node of
   * the turn's snapshot, one `removeNode` each (never `clearCanvas`), so a
   * node the user added while the turn ran survives. Never set when the
   * canvas was already empty.
   */
  replacedCanvas?: boolean;
}

export interface AgentToolRuntime {
  definitions: AgentToolDefinition[];
  /** Validates args against the tool's shape. Never throws: failures come back as ok:false. */
  execute(name: string, args: unknown): Promise<AgentToolResult>;
}

// ---------------------------------------------------------------------------
// Graph operations (resolved server-side, applied client-side)
// ---------------------------------------------------------------------------

/**
 * Fully resolved canvas change. Ids, handles and positions are decided by the
 * server so the browser can apply them verbatim and both sides agree.
 *
 * Agent-created node ids look like `${nodeType}-ag${base36}` so they never
 * collide with the store's `${type}-${counter}` scheme (loadWorkflow's
 * counter reset only reads an all-digit suffix).
 * Edge ids follow the store: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`.
 */
export type AgentGraphOp =
  /**
   * Remove every node and edge (and the caller drops the groups). The server
   * no longer emits it (see AgentToolResult.replacedCanvas); the browser still
   * applies it.
   */
  | { op: "clearCanvas" }
  | {
      op: "addNode";
      id: string;
      nodeType: NodeType;
      position: { x: number; y: number };
      /** Merged over createDefaultNodeData(nodeType) in the browser (sticky user defaults apply). */
      data: Record<string, unknown>;
      /** The group whose box the node was placed in: it joins that group, as a node dropped there would. */
      groupId?: string;
    }
  /** Shallow merge into node.data. */
  | { op: "updateNode"; id: string; data: Record<string, unknown> }
  | { op: "removeNode"; id: string }
  | {
      op: "moveNode";
      id: string;
      position: { x: number; y: number };
      /**
       * Group membership after the move, by where the node's centre landed
       * (the canvas's drop rule): a group id joins it, null leaves the group
       * the node was in, absent keeps membership as it is.
       */
      groupId?: string | null;
    }
  | {
      op: "addEdge";
      id: string;
      source: string;
      sourceHandle: string;
      target: string;
      targetHandle: string;
      /** Edge data such as arrayItemIndex or isLoop; createdAt is added when applied. */
      data?: Record<string, unknown>;
    }
  | { op: "removeEdge"; id: string };

export interface AgentGraphOpBatch {
  /** Unique per batch. */
  batchId: string;
  /** The dynamic-tool part this batch belongs to. */
  toolCallId: string;
  ops: AgentGraphOp[];
  summary: string;
  focusNodeIds?: string[];
  /** As {@link AgentToolResult.replacedCanvas}. */
  replacedCanvas?: boolean;
}

// ---------------------------------------------------------------------------
// Canvas snapshot (browser → server, every turn)
// ---------------------------------------------------------------------------

export interface AgentSnapshotNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  width: number;
  height: number;
  /** data.customTitle */
  title?: string;
  groupId?: string;
  /**
   * Settings and the structural fields handles depend on (selectedModel,
   * inputSchema, switches, rules, comfy app outputs, ...). Never media
   * payloads, histories or storage refs.
   */
  data: Record<string, unknown>;
  /** What content the node currently holds (uploaded or generated), without the bytes. */
  content?: {
    image?: boolean;
    video?: boolean;
    audio?: boolean;
    model3d?: boolean;
    text?: string;
  };
  status?: string;
  error?: string | null;
}

export interface AgentSnapshotEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  data?: {
    isLoop?: boolean;
    /** Loop edges only: how many times the loop runs. */
    loopCount?: number;
    hasPause?: boolean;
    arrayItemIndex?: number;
  };
}

export interface AgentSnapshotGroup {
  id: string;
  name: string;
  color?: string;
  /** The group's box in flow coordinates, when the canvas has one: placing and arranging nodes avoid it. */
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  /** A locked group's nodes are skipped when the workflow runs. Set only when true. */
  locked?: boolean;
}

export interface AgentWorkflowSnapshot {
  nodes: AgentSnapshotNode[];
  edges: AgentSnapshotEdge[];
  groups: AgentSnapshotGroup[];
  selectedNodeIds: string[];
  /** Visible area in flow coordinates, for placing new work where the user is looking. */
  viewport?: { x: number; y: number; width: number; height: number; zoom: number };
  workflowName?: string;
  /**
   * What a new node of these types starts with in this browser: the user's
   * saved model and settings (sticky defaults), whitelisted like node data.
   * The server draft starts new nodes from these so what the agent reports
   * matches what the browser creates. Absent types use the built-in defaults.
   */
  nodeDefaults?: Partial<Record<NodeType, Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Chat transport
// ---------------------------------------------------------------------------

export interface AgentMessageMetadata {
  harness?: AgentHarnessId;
  model?: string;
  /** The model's display name, shown under the reply ("Opus 5.5"). */
  modelLabel?: string;
}

export interface AgentToolUIOutput {
  ok: boolean;
  summary: string;
}

export type AgentDataParts = {
  /** Persisted: the session to resume next turn. */
  "agent-session": { harness: AgentHarnessId; sessionId: string };
  /** Transient (onData only): canvas changes to apply now. */
  "graph-ops": AgentGraphOpBatch;
  /** Transient: a short progress line ("Planning edits…"). */
  "agent-status": { text: string };
  /** Persisted: a problem the panel renders inline (sign-in needed, usage limit, ...). */
  "agent-notice": { code: AgentErrorCode; message: string; harness: AgentHarnessId };
};

export type AgentUIMessage = UIMessage<AgentMessageMetadata, AgentDataParts>;

export interface AgentChatRequestBody {
  /** Chat id from useChat. */
  id: string;
  messages: AgentUIMessage[];
  harness: AgentHarnessId;
  model?: string;
  sessionId?: string;
  workflow: AgentWorkflowSnapshot;
}

export interface AgentStatusResponse {
  harnesses: AgentHarnessStatus[];
}

export interface AgentSignInRequestBody {
  harness: AgentHarnessId;
  /** See {@link AgentSignInOptions.force}: sent when signing in after a turn the vendor rejected. */
  force?: boolean;
}
