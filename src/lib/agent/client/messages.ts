/**
 * Small, pure helpers for rendering agent chat messages.
 */

import type { DynamicToolUIPart } from "ai";
import type { AgentGraphPreview, AgentHarnessId, AgentToolUIOutput, AgentUIMessage } from "../types";

const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;

/** "mcp__node_banana__edit_workflow" or "edit_workflow" → "Edit workflow". */
export function humanizeToolName(toolName: string): string {
  const bare = toolName.replace(MCP_PREFIX, "").replace(/[_-]+/g, " ").trim();
  if (!bare) return "Tool";
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export function toolDisplayTitle(part: Pick<DynamicToolUIPart, "title" | "toolName">): string {
  return part.title?.trim() || humanizeToolName(part.toolName);
}

/** The route's tool output is `{ ok, summary }`; anything else is ignored. */
export function readToolOutput(output: unknown): AgentToolUIOutput | null {
  if (!output || typeof output !== "object") return null;
  const { ok, summary } = output as Partial<AgentToolUIOutput>;
  if (typeof ok !== "boolean") return null;
  return { ok, summary: typeof summary === "string" ? summary : "" };
}

/** A run_workflow call: the results of the run it started show under the tool rows. */
export function isRunWorkflowPart(part: Pick<DynamicToolUIPart, "toolName">): boolean {
  return part.toolName.replace(MCP_PREFIX, "") === "run_workflow";
}

/** A create_workflow call: the full-page chat draws the workflow it built. */
export function isCreateWorkflowPart(part: Pick<DynamicToolUIPart, "toolName">): boolean {
  return part.toolName.replace(MCP_PREFIX, "") === "create_workflow";
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The workflow a finished call left, in miniature (its output's `graph`); null when it carries none, or a malformed one. */
export function toolGraphPreview(part: Pick<DynamicToolUIPart, "state" | "output">): AgentGraphPreview | null {
  if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return null;
  const { ok, graph } = part.output as { ok?: unknown; graph?: Partial<AgentGraphPreview> };
  if (ok !== true || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length === 0) return null;
  const nodesOk = graph.nodes.every(
    (node) => Array.isArray(node) && node.length === 5 && typeof node[0] === "string" && node.slice(1).every(isCount),
  );
  const edgesOk = graph.edges.every(
    (edge) =>
      Array.isArray(edge) && edge.length === 2 && edge.every((end) => Number.isInteger(end) && end >= 0 && end < graph.nodes!.length),
  );
  if (!nodesOk || !edgesOk) return null;
  return {
    ...(typeof graph.name === "string" && graph.name.trim() ? { name: graph.name.trim() } : {}),
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

/** A tool output without the map of the workflow it built. */
export function outputWithoutGraph(output: unknown): unknown {
  if (!output || typeof output !== "object" || !("graph" in output)) return output;
  const rest = { ...(output as Record<string, unknown>) };
  delete rest.graph;
  return rest;
}

export interface BuiltWorkflow {
  tabId?: string;
  graph: AgentGraphPreview;
}

/**
 * The workflows a reply built, one per tab, by the create_workflow call that
 * built each: drawn as the reply's last edit to that tab left it.
 */
export function builtWorkflows(parts: AgentUIMessage["parts"]): Map<string, BuiltWorkflow> {
  const byCall = new Map<string, BuiltWorkflow>();
  const byTab = new Map<string, BuiltWorkflow>();
  for (const part of parts) {
    if (part.type !== "dynamic-tool") continue;
    const graph = toolGraphPreview(part);
    if (!graph) continue;
    const tabId = (part.output as { tabId?: unknown }).tabId;
    const key = typeof tabId === "string" ? tabId : "";
    const built = byTab.get(key);
    if (built) {
      built.graph = graph;
    } else if (isCreateWorkflowPart(part)) {
      const entry: BuiltWorkflow = { ...(key ? { tabId: key } : {}), graph };
      byTab.set(key, entry);
      byCall.set(part.toolCallId, entry);
    }
  }
  return byCall;
}

/** What a finished call's "Show on canvas" brings into view: the nodes it changed, in the tab it worked in. */
export function toolCanvasTarget(
  part: Pick<DynamicToolUIPart, "state" | "output">,
): { tabId?: string; nodeIds: string[] } | null {
  if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return null;
  const { ok, tabId, nodeIds } = part.output as { ok?: unknown; tabId?: unknown; nodeIds?: unknown };
  if (ok !== true || !Array.isArray(nodeIds)) return null;
  const ids = nodeIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return null;
  return typeof tabId === "string" && tabId ? { tabId, nodeIds: ids } : { nodeIds: ids };
}

/** A completed call the tool rejected (`ok: false`) reads as an error in the UI. */
export function toolDisplayState(part: Pick<DynamicToolUIPart, "state" | "output">): DynamicToolUIPart["state"] {
  if (part.state === "output-available" && readToolOutput(part.output)?.ok === false) {
    return "output-error";
  }
  return part.state;
}

/** One line under a tool card: the result summary, or the error. */
export function toolSummaryLine(part: DynamicToolUIPart): string | null {
  if (part.state === "output-error") return part.errorText || "The tool failed.";
  if (part.state === "output-available") return readToolOutput(part.output)?.summary || null;
  return null;
}

/** "Added 3 nodes" → "added 3 nodes", to follow "Used 2 tools · ". Leaves "LLM …" alone. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

const isFailedState = (state: DynamicToolUIPart["state"]) => state === "output-error" || state === "output-denied";

export interface ToolGroupSummary {
  /** "Used 3 tools". */
  label: string;
  /** The call still running, by title ("Edit workflow…"): the folded line names it while it works. */
  running: string | null;
  /** What came of the calls: the canvas change, else a lone call's result, else the run started. */
  result: string | null;
  /** "1 failed", when a call failed or the tool refused it. */
  failed: string | null;
}

/** The folded line over a run of tool calls. */
export function toolGroupSummary(parts: readonly DynamicToolUIPart[]): ToolGroupSummary {
  const label = `Used ${parts.length} tool${parts.length === 1 ? "" : "s"}`;
  const runningPart = parts.findLast((part) => part.state === "input-streaming" || part.state === "input-available");
  const failedCount = parts.filter((part) => isFailedState(toolDisplayState(part))).length;
  const failed = failedCount === 0 ? null : parts.length === 1 ? "failed" : `${failedCount} failed`;

  let result: string | null = null;
  const edits = parts.flatMap((part) => {
    const target = toolCanvasTarget(part);
    return target ? [{ part, target }] : [];
  });
  if (edits.length === 1) {
    result = toolSummaryLine(edits[0].part);
  } else if (edits.length > 1) {
    // Several edits: the nodes they touched between them, each once.
    const nodes = new Set(edits.flatMap(({ target }) => target.nodeIds.map((id) => `${target.tabId ?? ""}:${id}`)));
    result = `changed ${nodes.size} node${nodes.size === 1 ? "" : "s"}`;
  } else if (parts.length === 1) {
    result = isFailedState(toolDisplayState(parts[0])) ? null : toolSummaryLine(parts[0]);
  } else {
    const run = parts.findLast((part) => isRunWorkflowPart(part) && toolDisplayState(part) === "output-available");
    result = run ? toolSummaryLine(run) : null;
  }

  return {
    label,
    running: runningPart ? `${toolDisplayTitle(runningPart)}…` : null,
    result: result ? lowerFirst(result) : null,
    failed,
  };
}

type AgentMessagePart = AgentUIMessage["parts"][number];

/** Whether a part draws anything (Claude streams empty reasoning parts when thinking is hidden). */
export function isRenderedPart(part: AgentMessagePart): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.trim().length > 0;
    case "dynamic-tool":
    case "data-agent-notice":
    case "data-run-offer":
      return true;
    default:
      return false;
  }
}

/** How many parts of the current turn's reply are on screen; 0 while the user's message is still last. */
export function countRenderedParts(messages: readonly AgentUIMessage[]): number {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return 0;
  return last.parts.filter(isRenderedPart).length;
}

/** The last part of the current reply that draws something. */
export function lastRenderedPart(messages: readonly AgentUIMessage[]): AgentMessagePart | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return undefined;
  return last.parts.findLast(isRenderedPart);
}

/**
 * The shimmering progress line under a running turn, or null when the reply
 * itself shows progress (text or reasoning streaming in, a tool card running).
 * A status line from the server ("Planning edits…") shows until something new
 * renders after it.
 */
export function turnIndicatorText(
  messages: readonly AgentUIMessage[],
  busy: boolean,
  statusLine: { text: string; renderedParts: number } | null,
): string | null {
  if (!busy) return null;
  if (statusLine && statusLine.renderedParts === countRenderedParts(messages)) return statusLine.text;
  const last = lastRenderedPart(messages);
  if (!last) return "Thinking…";
  if ((last.type === "text" || last.type === "reasoning") && last.state === "streaming") return null;
  if (last.type === "dynamic-tool" && (last.state === "input-streaming" || last.state === "input-available")) {
    return null;
  }
  return "Working…";
}

/** Whether an assistant message would render anything at all. */
export function hasVisibleParts(message: AgentUIMessage): boolean {
  return message.parts.some(isRenderedPart);
}

/**
 * Where the transcript changed harness, mapped to the harness it switched to:
 * the first message of the turn that ran on a different harness than the
 * reply before it. That is the user message the new harness answered (so the
 * divider sits above it, not between it and the answer), or the reply itself
 * when no user message leads its turn. The panel draws a divider there so a
 * mid-chat switch is visible in the transcript.
 */
export function findHarnessSwitches(messages: readonly AgentUIMessage[]): Map<string, AgentHarnessId> {
  const switches = new Map<string, AgentHarnessId>();
  let previous: AgentHarnessId | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const harness = message.metadata?.harness;
    if (!harness) return;
    if (previous && harness !== previous) {
      const asked = messages[index - 1];
      switches.set(asked?.role === "user" ? asked.id : message.id, harness);
    }
    previous = harness;
  });
  return switches;
}

/**
 * Whether the latest turn ended with the vendor rejecting this harness's login
 * (a `not_signed_in` notice for it in the latest assistant message). A sign-in
 * started from there must be forced: the CLI's local status can still read
 * signed in, and would otherwise answer "already signed in". A later turn that
 * ran fine clears it.
 */
export function latestTurnRejectedSignIn(messages: readonly AgentUIMessage[], harness: AgentHarnessId): boolean {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (message.role !== "assistant") continue;
    return message.parts.some(
      (part) => part.type === "data-agent-notice" && part.data.code === "not_signed_in" && part.data.harness === harness,
    );
  }
  return false;
}

export function selectionLabel(count: number): string | null {
  if (count <= 0) return null;
  // A chip beside send: the count alone; the agent focusing on it is the chip's whole meaning.
  return `${count} selected`;
}

export function agentSuggestions(canvasHasNodes: boolean): string[] {
  return canvasHasNodes
    ? [
        "Explain what this workflow does",
        "Add an output node after every generator",
        "Switch every image node to Nano Banana Pro",
        "Make the prompt more cinematic",
      ]
    : [
        "Build a text-to-image workflow",
        "Make a workflow that turns an image into a video",
        "Have an LLM write the prompt for an image model",
        "Compare two image models on the same prompt",
      ];
}
