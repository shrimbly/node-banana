"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentHarnessId, AgentUIMessage } from "../types";
import {
  conversationSummary,
  loadConversations,
  saveConversations,
  type AgentConversation,
} from "./history";
import { forgetChatRuns } from "./runs";

export interface UseAgentHistoryResult {
  conversations: AgentConversation[];
  /** Adds or updates the conversation with this id (its summary is read from the messages); never one removed since. */
  record: (entry: {
    id: string;
    messages: AgentUIMessage[];
    workflowName?: string;
    tabId?: string;
    workflowId?: string;
    harness?: AgentHarnessId;
  }) => void;
  remove: (id: string) => void;
}

/** The persisted chat history. Client-only (reads localStorage on mount). */
export function useAgentHistory(): UseAgentHistoryResult {
  const [conversations, setConversations] = useState<AgentConversation[]>(loadConversations);
  // A turn's record can land after its conversation was deleted (it waits for the turn's
  // steps: a save, a tab switch). Conversation ids are never reused, so a removed one stays out.
  const removed = useRef(new Set<string>());

  const record = useCallback<UseAgentHistoryResult["record"]>(({ id, messages, workflowName, tabId, workflowId, harness }) => {
    if (messages.length === 0 || removed.current.has(id)) return;
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
        ...((tabId ?? existing?.tabId) ? { tabId: tabId ?? existing?.tabId } : {}),
        ...((workflowId ?? existing?.workflowId) ? { workflowId: workflowId ?? existing?.workflowId } : {}),
        ...((harness ?? existing?.harness) ? { harness: harness ?? existing?.harness } : {}),
      };
      return saveConversations([entry, ...previous.filter((conversation) => conversation.id !== id)]);
    });
  }, []);

  const remove = useCallback((id: string) => {
    removed.current.add(id);
    setConversations((previous) => saveConversations(previous.filter((conversation) => conversation.id !== id)));
    forgetChatRuns(id);
  }, []);

  return { conversations, record, remove };
}

/** Same turns (a reopened chat before anything new was sent): compared by count and the last message's id. */
function sameMessages(a: readonly AgentUIMessage[], b: readonly AgentUIMessage[]): boolean {
  return a.length === b.length && a[a.length - 1]?.id === b[b.length - 1]?.id;
}
