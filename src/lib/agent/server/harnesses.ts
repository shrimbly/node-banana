/**
 * The agent's harnesses by id. Server-only.
 *
 * Harness objects are cheap and per module instance; the state that must
 * outlive a Next dev reload (the Codex app-server, running sign-ins, Codex
 * threads) lives on globalThis inside the harness modules.
 */

import type { AgentHarness, AgentHarnessId } from "../types";
import { createClaudeHarness } from "./claudeHarness";
import { createCodexHarness } from "./codexHarness";

const harnesses: Partial<Record<AgentHarnessId, AgentHarness>> = {};

export function getHarness(id: AgentHarnessId): AgentHarness {
  switch (id) {
    case "claude":
      return (harnesses.claude ??= createClaudeHarness());
    case "codex":
      return (harnesses.codex ??= createCodexHarness());
    default:
      throw new Error(`Unknown agent harness: ${String(id)}`);
  }
}
