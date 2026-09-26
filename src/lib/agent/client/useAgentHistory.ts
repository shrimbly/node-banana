"use client";

import { useCallback, useState } from "react";
import type { AgentHarnessId, AgentUIMessage } from "../types";
import {
  conversationSummary,
  loadConversations,
  saveConversations,
  type AgentConversation,
} from "./history";

export interface UseAgentHistoryResult {
  conversations: AgentConversation[];
  /** Adds or updates the conversation with this id (its summary is read from the messages). */
  record: (entry: { id: string; messages: AgentUIMessage[]; workflowName?: string; harness?: AgentHarnessId }) => void;
  remove: (id: string) => void;
}

/** The persisted chat history. Client-only (reads localStorage on mount). */
export function useAgentHistory(): UseAgentHistoryResult {
  const [conversations, setConversations] = useState<AgentConversation[]>(loadConversations);

  const record = useCallback<UseAgentHistoryResult["record"]>(({ id, messages, workflowName, harness }) => {
    if (messages.length === 0) return;
    setConversations((previous) => {
      const existing = previous.find((conversation) => conversation.id === id);
      // Nothing new since it was saved (reopening an old chat): keep its place in the list.
      if (existing && sameMessages(existing.messages, messages)) return previous;
      const now = Date.now();
      const summary = conversationSummary(messages) ?? existing?.summary;
      const entry: AgentConversation = {
        id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
        ...(summary ? { summary } : {}),
        ...((workflowName ?? existing?.workflowName) ? { workflowName: workflowName ?? existing?.workflowName } : {}),
        ...((harness ?? existing?.harness) ? { harness: harness ?? existing?.harness } : {}),
      };
      return saveConversations([entry, ...previous.filter((conversation) => conversation.id !== id)]);
    });
  }, []);

  const remove = useCallback((id: string) => {
    setConversations((previous) => saveConversations(previous.filter((conversation) => conversation.id !== id)));
  }, []);

  return { conversations, record, remove };
}

/** Same turns (a reopened chat before anything new was sent): compared by count and the last message's id. */
function sameMessages(a: readonly AgentUIMessage[], b: readonly AgentUIMessage[]): boolean {
  return a.length === b.length && a[a.length - 1]?.id === b[b.length - 1]?.id;
}
