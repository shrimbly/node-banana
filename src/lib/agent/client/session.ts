/**
 * Which CLI session the next turn should resume.
 *
 * Each assistant message carries a persisted `data-agent-session` part naming
 * the harness session it ran in. The next turn resumes that session only when
 * it was the most recent one in the chat and belongs to the harness the user
 * is on now. After a harness switch (Claude → Codex → Claude) the old Claude
 * session is missing the Codex turns, so the server starts a fresh session and
 * seeds it with the whole conversation instead.
 */

import type { AgentDataParts, AgentHarnessId, AgentUIMessage } from "../types";

export type AgentSessionRef = AgentDataParts["agent-session"];

export function findLatestAgentSession(messages: readonly AgentUIMessage[]): AgentSessionRef | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const { parts } = messages[m];
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type === "data-agent-session") return part.data;
    }
  }
  return undefined;
}

export function sessionIdForHarness(
  messages: readonly AgentUIMessage[],
  harness: AgentHarnessId,
): string | undefined {
  const latest = findLatestAgentSession(messages);
  return latest && latest.harness === harness ? latest.sessionId : undefined;
}
