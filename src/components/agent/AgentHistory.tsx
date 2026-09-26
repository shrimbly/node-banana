"use client";

import { Trash2Icon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { conversationLabel, type AgentConversation } from "@/lib/agent/client/history";
import { HARNESS_LABELS } from "@/lib/agent/client/readiness";

/** "Just now", "12 min ago", "3 h ago", "Yesterday", then a date. */
export function relativeTime(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "Yesterday";
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export interface AgentHistoryProps {
  conversations: AgentConversation[];
  currentId: string;
  /** A turn is running: switching conversations waits for it. */
  locked: boolean;
  onOpen: (conversation: AgentConversation) => void;
  onDelete: (id: string) => void;
}

/** Past conversations, newest first: the agent's summary, when and where, a delete on hover. */
export function AgentHistory({ conversations, currentId, locked, onOpen, onDelete }: AgentHistoryProps) {
  if (conversations.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-[13px] text-neutral-300">No conversations yet</p>
        <p className="text-xs text-ink-3">Your chats with the agent will show up here.</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2" role="list" aria-label="Conversations">
      <p className="px-2 pb-1.5 pt-1 font-mono text-[10px] uppercase leading-[14px] tracking-eyebrow text-ink-3">
        History
      </p>
      {conversations.map((conversation) => {
        const current = conversation.id === currentId;
        const label = conversationLabel(conversation);
        const meta = [
          relativeTime(conversation.updatedAt),
          conversation.workflowName,
          conversation.harness ? HARNESS_LABELS[conversation.harness] : undefined,
        ].filter(Boolean);
        return (
          <div key={conversation.id} role="listitem" className="group relative">
            <button
              type="button"
              aria-current={current || undefined}
              aria-disabled={(locked && !current) || undefined}
              onClick={() => {
                if (!locked || current) onOpen(conversation);
              }}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-lg squircle py-2 pl-2.5 pr-9 text-left transition-colors duration-[120ms]",
                "hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
                current && "bg-white/[0.07]",
              )}
            >
              <span className="truncate text-[13px] leading-5 text-neutral-100">{label}</span>
              <span className="truncate text-xs leading-4 text-ink-3">{meta.join(" · ")}</span>
            </button>
            <button
              type="button"
              aria-label={`Delete “${label}”`}
              onClick={() => onDelete(conversation.id)}
              className={cn(
                "absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 opacity-0 transition-[opacity,background-color,color]",
                "hover:bg-white/10 hover:text-neutral-200 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              )}
            >
              <Trash2Icon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
