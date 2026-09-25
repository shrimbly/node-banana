"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { CircleStopIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/agent/ui/button";
import { findHarnessSwitches, turnIndicatorText } from "@/lib/agent/client/messages";
import { HARNESS_BILLING_COPY, HARNESS_LABELS } from "@/lib/agent/client/readiness";
import type { AgentHarnessId, AgentUIMessage } from "@/lib/agent/types";
import { AgentMessage } from "./AgentMessage";
import { AgentAlert, type AgentNoticeSignIn } from "./AgentNotice";
import type { AgentStatusLine } from "./hooks/useAgentChat";

export interface AgentConversationProps {
  messages: AgentUIMessage[];
  busy: boolean;
  statusLine: AgentStatusLine | null;
  stoppedMessageIds: ReadonlySet<string>;
  error: Error | undefined;
  onRetry: () => void;
  onDismissError: () => void;
  onSignIn: AgentNoticeSignIn;
}

/** The transcript: messages, a divider where the harness changed, progress, stop markers and errors. */
export function AgentConversation({
  messages,
  busy,
  statusLine,
  stoppedMessageIds,
  error,
  onRetry,
  onDismissError,
  onSignIn,
}: AgentConversationProps) {
  const switches = useMemo(() => findHarnessSwitches(messages), [messages]);
  const indicator = turnIndicatorText(messages, busy, statusLine);

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className="gap-5 px-3.5 py-4">
        {messages.map((message, index) => {
          const switchedTo = switches.get(message.id);
          return (
            <Fragment key={message.id}>
              {switchedTo && <HarnessDivider harness={switchedTo} />}
              <AgentMessage
                message={message}
                streaming={busy && index === messages.length - 1}
                onSignIn={onSignIn}
              />
              {stoppedMessageIds.has(message.id) && (
                <p className="-mt-3 flex items-center gap-1.5 text-xs text-neutral-500">
                  <CircleStopIcon className="size-3" aria-hidden="true" />
                  Stopped
                </p>
              )}
            </Fragment>
          );
        })}
        {indicator && (
          <div role="status" aria-live="polite">
            <Shimmer className="text-[13px]" duration={1.6}>
              {indicator}
            </Shimmer>
          </div>
        )}
        {error && !busy && (
          <AgentAlert
            tone="danger"
            actions={
              <>
                <Button size="xs" variant="secondary" onClick={onRetry}>
                  <RotateCcwIcon />
                  Try again
                </Button>
                <Button size="xs" variant="ghost" onClick={onDismissError}>
                  Dismiss
                </Button>
              </>
            }
          >
            {error.message || "The agent stopped unexpectedly."}
          </AgentAlert>
        )}
      </ConversationContent>
      <ConversationScrollButton className="bottom-3 size-7 border-neutral-600 bg-neutral-800 dark:bg-neutral-800 dark:hover:bg-neutral-700" />
      <StayPinnedWhenShrunk />
    </Conversation>
  );
}

/**
 * Keeps the newest line in view when the transcript's box gets shorter while
 * it was pinned to the bottom: a chip appearing above the message box (a
 * selection, a harness switch) or the textarea growing. use-stick-to-bottom
 * only follows its content's size, not its own, so without this the last
 * line of the latest reply slides under the composer.
 */
export function StayPinnedWhenShrunk() {
  const { scrollRef, isAtBottom, escapedFromLock, scrollToBottom } = useStickToBottomContext();
  const pinned = useRef(false);
  pinned.current = isAtBottom && !escapedFromLock;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = scroller.clientHeight;
      if (next < height && pinned.current) void scrollToBottom("instant");
      height = next;
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom]);

  return null;
}

function HarnessDivider({ harness }: { harness: AgentHarnessId }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-500">
      <span className="h-px flex-1 bg-neutral-700" />
      Continued with {HARNESS_LABELS[harness]}
      <span className="h-px flex-1 bg-neutral-700" />
    </div>
  );
}

export interface AgentEmptyStateProps {
  suggestions: string[];
  onSuggestion: (suggestion: string) => void;
}

/**
 * A fresh chat: what the agent is for, and a few things to try. On a short
 * window the panel is short too (under ~450px tall at 760px, ~360px at 640px):
 * there the icon and the description give way, and then all but two
 * suggestions, so what shows fits without scrolling.
 */
export function AgentEmptyState({ suggestions, onSuggestion }: AgentEmptyStateProps) {
  return (
    <ConversationEmptyState className="my-auto h-auto gap-4 px-5 py-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border border-neutral-700 bg-neutral-900 text-blue-400 [@media(max-height:760px)]:hidden">
          <SparklesIcon className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-neutral-100">What should we build?</h3>
          <p className="text-[13px] leading-5 text-neutral-400 [@media(max-height:760px)]:hidden">
            Describe a workflow, or ask for a change to the one on the canvas.
          </p>
        </div>
      </div>
      <div className="flex w-full flex-col gap-1.5 [@media(max-height:680px)]:[&>*:nth-child(n+3)]:hidden">
        {suggestions.map((suggestion) => (
          <Suggestion
            key={suggestion}
            suggestion={suggestion}
            onClick={onSuggestion}
            className="h-auto w-full justify-start whitespace-normal rounded-lg border-neutral-700 px-3 py-2 text-left text-[13px] font-normal text-neutral-300 dark:bg-neutral-900/40 dark:hover:bg-neutral-700/60"
          />
        ))}
      </div>
    </ConversationEmptyState>
  );
}

/**
 * Who pays for the agent (the plan's own limits, never an API key or extra
 * usage). A fixed row above the message box, outside the scrolling empty
 * state, so it is never cut off or scrolled out of view.
 */
export function AgentBillingNote({ harness }: { harness: AgentHarnessId }) {
  return (
    <p className="shrink-0 px-5 pb-2.5 pt-1 text-center text-[11px] leading-4 text-neutral-500">
      {HARNESS_BILLING_COPY[harness].footer}
    </p>
  );
}
