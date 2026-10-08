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
import type { GroupColor, NodeType } from "@/types";
import type { RunScope } from "@/store/utils/runBatch";

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

export type AgentHarnessId = "claude" | "codex";

export const AGENT_HARNESS_IDS: readonly AgentHarnessId[] = ["claude", "codex"];

/** The turn's opening status line, from the moment it is sent until the reply starts. */
export const AGENT_OPENING_STATUS = "Fallooning…";

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
  /** Thinking effort levels the model accepts, lowest first (`low` … `max`). Absent: no effort control. */
  efforts?: string[];
  /** The level a turn runs at when the user has picked none. */
  defaultEffort?: string;
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
  /**
   * `models` is the built-in list because the CLI's own couldn't be read; the
   * picker says so. The panel re-checks status each time it opens.
   */
  modelsFallback?: boolean;
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

/** The tool name harnesses report as pending while their own web search runs (research turns). */
export const WEB_TOOL_PENDING = "web_search";

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
  /** Thinking effort, already checked against the model's own levels. */
  effort?: string;
  /** Turn on the harness's own web search (research turns only, which have no canvas tools). */
  webAccess?: boolean;
  signal: AbortSignal;
}

export interface AgentHarness {
  id: AgentHarnessId;
  label: string;
  getStatus(): Promise<AgentHarnessStatus>;
  /** Start the vendor's own sign-in flow (the official CLI). Never touches tokens. */
  startSignIn(options?: AgentSignInOptions): Promise<AgentSignInStart>;
  /** Stop a running sign-in: the CLI is killed (or its login cancelled) and the status reads idle again. */
  cancelSignIn(): Promise<void>;
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
  /** A tab or save step for the browser instead of canvas edits (`ops` is empty). */
  workspace?: AgentWorkspaceOp;
  /**
   * The workflow tab the call worked in (the runtime's live tab when it
   * returned). Absent when the turn's snapshot carried no tab id.
   */
  tabId?: string;
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
  /**
   * Read once the turn has ended: the Run button the chat should offer for
   * what this turn built or changed, or null (nothing runnable changed, the
   * turn started a run itself, or what changed can't run yet).
   */
  runOffer?(): AgentRunOffer | null;
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
 * counter reset only reads an all-digit suffix); agent-created group ids
 * likewise look like `group-ag${base36}` next to the store's `group-${counter}`.
 * Edge ids follow the store: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`.
 *
 * Groups: a group is a named, coloured box (`state.groups`) and a node joins
 * it through `node.groupId`. The canvas never resizes a box by itself, so the
 * server sends every box it fits (addGroup, updateGroup) with the membership
 * that goes with it.
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
  | { op: "removeEdge"; id: string }
  /** A new group box; `nodeIds` join it (their groupId is set). */
  | {
      op: "addGroup";
      id: string;
      name: string;
      color: AgentGroupColor;
      /** The box in flow coordinates. The title pill is drawn above it, outside the box. */
      position: { x: number; y: number };
      size: { width: number; height: number };
      nodeIds: string[];
    }
  /** Rename, recolour, move or resize a group box; absent fields stay as they are. */
  | {
      op: "updateGroup";
      id: string;
      name?: string;
      color?: AgentGroupColor;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
    }
  /** Delete a group box. Its nodes stay where they are; their groupId clears. */
  | { op: "removeGroup"; id: string }
  /** Put a node into a group (`groupId`) or take it out of the one it is in (null). */
  | { op: "setNodeGroup"; id: string; groupId: string | null }
  /**
   * Start a run through the store's runBatch, `runs` times (1–50), after the
   * batch's other ops. Not part of the undo step; ignored while a run is going.
   */
  | { op: "run"; scope: RunScope; runs: number };

/** The colours a group can have (the canvas's GROUP_COLOR_ORDER). */
export type AgentGroupColor = GroupColor;

/**
 * A step on the open workflows rather than on one canvas, applied by the
 * chat in stream order (it waits for each, a save included, before the next
 * batch). Each comes alone in its batch.
 */
export type AgentWorkspaceOp =
  /** Bring another open tab into the canvas (store.switchTab). Later batches apply to it. */
  | { op: "switchTab"; tabId: string }
  /** Park the live workflow and open an empty one in a new tab with this id (store.newTab), optionally named. */
  | { op: "newTab"; tabId: string; name?: string }
  /**
   * Save the live workflow as the user's Save does: into its folder when it
   * has one, else a first save as `name` (or its current name) in the Node
   * Banana folder.
   */
  | { op: "save"; name?: string };

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
  /** As {@link AgentToolResult.workspace}; `ops` is then empty. */
  workspace?: AgentWorkspaceOp;
  /**
   * The tab the batch belongs to: graph ops apply only while it is live, a
   * switchTab or newTab makes it live, a save saves it. Absent when the
   * turn's snapshot had no tab id (then the live canvas is assumed).
   */
  tabId?: string;
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
  /** The canvas has not measured the node yet: `height` is an estimate from its type and settings. */
  heightEstimated?: true;
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
  /** The workflow tab this is a picture of (store.activeTabId for the live one). */
  tabId?: string;
  nodes: AgentSnapshotNode[];
  edges: AgentSnapshotEdge[];
  groups: AgentSnapshotGroup[];
  selectedNodeIds: string[];
  /** Visible area in flow coordinates, for placing new work where the user is looking. */
  viewport?: { x: number; y: number; width: number; height: number; zoom: number };
  workflowName?: string;
  /**
   * A run (or a batch of runs) was going on the canvas when the message was
   * sent; nodes' `status` shows how far it got. Set only when true.
   */
  running?: true;
  /**
   * What a new node of these types starts with in this browser: the user's
   * saved model and settings (sticky defaults), whitelisted like node data.
   * The server draft starts new nodes from these so what the agent reports
   * matches what the browser creates. Absent types use the built-in defaults.
   */
  nodeDefaults?: Partial<Record<NodeType, Record<string, unknown>>>;
}

/** One open workflow tab, in strip order, as the agent sees the tab strip. */
export interface AgentTabSummary {
  id: string;
  /** The workflow's name; absent while untitled. */
  name?: string;
  /** The tab live in the canvas: the one the request's `workflow` describes. */
  active?: true;
  nodeCount: number;
  /** It has a project folder, so save_workflow needs no name. */
  saved?: true;
  /** It has changes no save has written yet. */
  unsaved?: true;
}

// ---------------------------------------------------------------------------
// Runs the chat offers and follows
// ---------------------------------------------------------------------------

/** One way to run, as the chat's Run button offers it. */
export interface AgentRunOption {
  scope: RunScope;
  /** What the button says: "Run workflow", "Run Hero shots", "Run 3 changed nodes", "Run Nano Banana". */
  label: string;
  /**
   * The nodes the run will execute, in run order where known (for "all",
   * every node outside a locked group). For the card's count, cost and
   * progress; the scope decides what actually runs.
   */
  nodeIds: string[];
}

/** A Run button under a reply, for what the turn built or changed (`data-run-offer`). */
export interface AgentRunOffer {
  /** Unique per offer: the runs started from it are found by it. */
  offerId: string;
  /** The tab the offer is for; running it from another tab switches there first. */
  tabId?: string;
  workflowName?: string;
  primary: AgentRunOption;
  /** Other scopes worth offering, e.g. the whole workflow when the primary is narrower. */
  alternatives: AgentRunOption[];
}

/** One output a chat-started run produced, held as ids and text (never media bytes). */
export interface AgentRunOutput {
  /** Stable key: the asset id, else `${nodeId}:${index}`. */
  id: string;
  nodeId: string;
  /** The node's title or display name when the run ended. */
  nodeTitle: string;
  nodeType: NodeType;
  kind: "image" | "video" | "audio" | "text" | "model3d";
  /** The asset library record (served by /api/assets/<id>/file), when the library recorded it. */
  assetId?: string;
  /** The file's hash, for /api/assets/thumb/<sha256>. */
  sha256?: string;
  /** A video asset with a stored poster frame. */
  hasPoster?: boolean;
  width?: number;
  height?: number;
  /** Text outputs (LLM), capped. */
  text?: string;
  /** The model that ran, and the resolved prompt, when known. */
  model?: string;
  prompt?: string;
  /** Which run of a batch produced it (0-based). */
  batchIndex?: number;
  /**
   * No library record: the output is only on the node, shown from the live
   * canvas while its tab is open (the chat never keeps media bytes).
   */
  live?: true;
}

export type AgentRunStatus = "running" | "done" | "failed" | "stopped" | "paused";

/** A run the chat started (the agent's run_workflow, or the Run button) and what came of it. */
export interface AgentRunRecord {
  id: string;
  chatId: string;
  /** Where it shows in the transcript: under that tool call, or that offer's card. */
  anchor: { toolCallId: string } | { offerId: string };
  tabId: string;
  workflowName?: string;
  label: string;
  scope: RunScope;
  runs: number;
  startedAt: number;
  finishedAt?: number;
  status: AgentRunStatus;
  /** Batch progress: which run (1-based) of how many is going or went last. */
  progress: { index: number; count: number };
  /** The nodes expected to run (from the offer or the scope), for placeholders. */
  plannedNodeIds: string[];
  /** Nodes seen running, in the order they started. */
  ranNodeIds: string[];
  outputs: AgentRunOutput[];
  errors: Array<{ nodeId: string; nodeTitle: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Chat transport
// ---------------------------------------------------------------------------

/** The model a research turn looks up prompting tips for. */
export interface AgentResearchTarget {
  provider: string;
  modelId: string;
  /** The name the node shows. */
  name?: string;
  /** The node type it runs in. */
  nodeType?: string;
}

export interface AgentMessageMetadata {
  harness?: AgentHarnessId;
  model?: string;
  /** The model's display name, shown under the reply ("Opus 5.5"). */
  modelLabel?: string;
  /** On a user message: this turn looks up prompting tips for that model (web on, canvas tools off). */
  research?: AgentResearchTarget;
}

export interface AgentToolUIOutput {
  ok: boolean;
  summary: string;
  /** The tab the call worked in, and the nodes it changed or created: the card's "Show on canvas". */
  tabId?: string;
  nodeIds?: string[];
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
  /** Persisted: the conversation's short label in the chat history (the agent's name_conversation call). */
  "agent-summary": { summary: string };
  /** Persisted (id "run-offer"): a Run button for what the turn built or changed, written as the turn ends. */
  "run-offer": AgentRunOffer;
};

export type AgentUIMessage = UIMessage<AgentMessageMetadata, AgentDataParts>;

export interface AgentChatRequestBody {
  /** Chat id from useChat. */
  id: string;
  messages: AgentUIMessage[];
  harness: AgentHarnessId;
  model?: string;
  effort?: string;
  sessionId?: string;
  workflow: AgentWorkflowSnapshot;
  /** Every open workflow tab, in strip order (the live one marked `active`). */
  tabs?: AgentTabSummary[];
  /** Media-free snapshots of the parked tabs, by tab id: the live tab is `workflow`. */
  parkedWorkflows?: Record<string, AgentWorkflowSnapshot>;
}

export interface AgentStatusResponse {
  harnesses: AgentHarnessStatus[];
}

export interface AgentSignInRequestBody {
  harness: AgentHarnessId;
  /** See {@link AgentSignInOptions.force}: sent when signing in after a turn the vendor rejected. */
  force?: boolean;
}
