/**
 * Small, pure helpers for rendering agent chat messages.
 */

import type { DynamicToolUIPart } from "ai";
import type { AgentHarnessId, AgentToolUIOutput, AgentUIMessage } from "../types";

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

type AgentMessagePart = AgentUIMessage["parts"][number];

/** Whether a part draws anything (Claude streams empty reasoning parts when thinking is hidden). */
export function isRenderedPart(part: AgentMessagePart): boolean {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.trim().length > 0;
    case "dynamic-tool":
    case "data-agent-notice":
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
