/**
 * The agent's chat history: past conversations kept in localStorage so the
 * user can go back to one and carry on (its messages hold the harness
 * session to resume). Each is labelled by the agent's own short summary
 * (name_conversation), or by its first message until one arrives.
 *
 * Tool inputs can hold whole workflows, so the store has a size budget:
 * the oldest conversations go first, and an oversized one drops the inputs
 * of its tool calls before it is dropped itself.
 */

import type { AgentHarnessId, AgentUIMessage } from "../types";

export const AGENT_HISTORY_KEY = "node-banana-agent-conversations";
export const MAX_CONVERSATIONS = 50;
/** Characters of JSON, well inside a typical 5MB localStorage quota shared with the rest of the app. */
export const HISTORY_BUDGET = 2_000_000;

export interface AgentConversation {
  /** The chat id (useChat's), also the key for "one turn per chat" on the server. */
  id: string;
  /** The agent's label for it, when it gave one. */
  summary?: string;
  createdAt: number;
  updatedAt: number;
  /** The workflow open when it was last used. */
  workflowName?: string;
  harness?: AgentHarnessId;
  messages: AgentUIMessage[];
}

/** The latest name the agent gave the conversation. */
export function conversationSummary(messages: readonly AgentUIMessage[]): string | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type === "data-agent-summary" && part.data.summary.trim()) return part.data.summary.trim();
    }
  }
  return undefined;
}

/** The user's first message, as a stand-in label. */
export function firstUserText(messages: readonly AgentUIMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "New conversation";
}

/** What the history list shows for a conversation. */
export function conversationLabel(conversation: Pick<AgentConversation, "summary" | "messages">): string {
  return conversation.summary ?? firstUserText(conversation.messages);
}

function isConversation(value: unknown): value is AgentConversation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.messages) &&
    record.messages.length > 0
  );
}

export function loadConversations(): AgentConversation[] {
  try {
    const stored = localStorage.getItem(AGENT_HISTORY_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** A copy without its tool calls' inputs (the part that grows with the canvas). */
function withoutToolInputs(conversation: AgentConversation): AgentConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => (part.type === "dynamic-tool" ? ({ ...part, input: {} } as typeof part) : part)),
    })),
  };
}

/** Newest first, capped in count and size. */
export function fitHistory(conversations: AgentConversation[], budget = HISTORY_BUDGET): AgentConversation[] {
  const kept: AgentConversation[] = [];
  let used = 2;
  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (kept.length >= MAX_CONVERSATIONS) break;
    let entry = conversation;
    let size = JSON.stringify(entry).length + 1;
    if (used + size > budget) {
      entry = withoutToolInputs(conversation);
      size = JSON.stringify(entry).length + 1;
    }
    if (used + size > budget) continue;
    kept.push(entry);
    used += size;
  }
  return kept;
}

export function saveConversations(conversations: AgentConversation[]): AgentConversation[] {
  const fitted = fitHistory(conversations);
  try {
    localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify(fitted));
  } catch {
    // Quota or disabled storage: the history still works for this session.
  }
  return fitted;
}
