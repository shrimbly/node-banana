/**
 * Calling the tool runtime from a harness. Server-only.
 */

import type { AgentToolResult, AgentToolRuntime } from "../types";

/**
 * Run one tool call. The runtime promises never to throw; if it does anyway,
 * the model gets a failed result it can read instead of a broken turn.
 */
export async function executeTool(runtime: AgentToolRuntime, name: string, args: unknown): Promise<AgentToolResult> {
  try {
    return await runtime.execute(name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: `The ${name} tool failed: ${message}`, summary: "Tool failed", ops: [] };
  }
}
