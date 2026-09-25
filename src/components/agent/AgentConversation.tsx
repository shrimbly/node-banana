"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowRightIcon, RotateCcwIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/components/agent/lib/utils";
import { findHarnessSwitches, turnIndicatorText } from "@/lib/agent/client/messages";
import { HARNESS_BILLING_COPY, HARNESS_LABELS } from "@/lib/agent/client/readiness";
import type { AgentHarnessId, AgentUIMessage } from "@/lib/agent/types";
import { AgentMessage } from "./AgentMessage";
import { AgentAlert, AgentTextButton, type AgentNoticeSignIn } from "./AgentNotice";
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
      <ConversationContent className="gap-5 px-4 py-4">
        {messages.map((message, index) => {
          const switchedTo = switches.get(message.id);
          const streaming = busy && index === messages.length - 1;
          const stopped = stoppedMessageIds.has(message.id);
          // Which model answered, once the reply is done (the one it actually ran on).
          const modelLabel = message.role === "assistant" && !streaming ? message.metadata?.modelLabel : undefined;
          return (
            <Fragment key={message.id}>
              {switchedTo && <HarnessDivider harness={switchedTo} />}
              <AgentMessage message={message} streaming={streaming} onSignIn={onSignIn} />
              {(modelLabel || stopped) && (
                <p className="-mt-3 font-mono text-[10px] leading-4 uppercase tracking-eyebrow text-ink-3">
                  {modelLabel && <span>{modelLabel}</span>}
                  {modelLabel && stopped && " · "}
                  {stopped && <span>Stopped</span>}
                </p>
              )}
            </Fragment>
          );
        })}
        {indicator && (
          <div role="status" aria-live="polite">
            <Shimmer className="text-[13px] leading-5" duration={1.6}>
              {indicator}
            </Shimmer>
          </div>
        )}
        {error && !busy && (
          <AgentAlert
            tone="danger"
            actions={
              <>
                <AgentTextButton onClick={onRetry}>
                  <RotateCcwIcon aria-hidden="true" strokeWidth={1.75} />
                  Try again
                </AgentTextButton>
                <AgentTextButton onClick={onDismissError}>Dismiss</AgentTextButton>
              </>
            }
          >
            {error.message || "The agent stopped unexpectedly."}
          </AgentAlert>
        )}
      </ConversationContent>
      <ConversationScrollButton />
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
    <div className="flex items-center gap-3 font-mono text-[10px] leading-4 uppercase tracking-eyebrow text-ink-3">
      <span className="h-px flex-1 bg-white/[0.08]" />
      Continued with {HARNESS_LABELS[harness]}
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

export interface AgentEmptyStateProps {
  suggestions: string[];
  onSuggestion: (suggestion: string) => void;
}

/**
 * A fresh chat, laid out like a page of the split dialogs: a display heading,
 * a lead, and a few things to try as ruled rows. On a short window the panel
 * is short too (under ~450px tall at 760px, ~310px at 640px): there the lead
 * gives way, and then all but two suggestions and some spacing, so what shows
 * fits without scrolling.
 */
export function AgentEmptyState({ suggestions, onSuggestion }: AgentEmptyStateProps) {
  return (
    <div className="flex w-full flex-col gap-4 px-4 pb-3 pt-5 [@media(max-height:680px)]:gap-2.5 [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-3">
      <div>
        <h3 className="font-display text-[22px] font-bold leading-7 tracking-display text-neutral-100 [@media(max-height:680px)]:text-lg [@media(max-height:680px)]:leading-6">
          What should we build?
        </h3>
        <p className="mt-1 font-display text-[13px] font-medium leading-5 text-ink-3 [@media(max-height:760px)]:hidden">
          Describe a workflow, or ask for a change to the one on the canvas.
        </p>
      </div>
      {/* Ruled on the page column, like the welcome screen's rows; the text sits just inside. */}
      <div className="flex flex-col divide-y divide-white/[0.06] [@media(max-height:680px)]:[&>*:nth-child(n+3)]:hidden">
        {suggestions.map((suggestion) => (
          <div key={suggestion} className="py-0.5 [@media(max-height:680px)]:py-0">
            <button
              type="button"
              data-agent-suggestion
              onClick={() => onSuggestion(suggestion)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-md squircle px-1.5 py-2 text-left text-[13px] leading-5 text-neutral-200 [@media(max-height:680px)]:py-1.5",
                "transition-colors duration-[120ms] hover:bg-white/7 hover:text-white",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              )}
            >
              <span className="min-w-0 flex-1">{suggestion}</span>
              <ArrowRightIcon
                aria-hidden="true"
                strokeWidth={1.75}
                className="size-4 shrink-0 text-neutral-500 transition-colors group-hover:text-neutral-200"
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Who pays for the agent (the plan's own limits, never an API key or extra
 * usage). A fixed row above the message box, outside the scrolling empty
 * state, so it is never cut off or scrolled out of view.
 */
export function AgentBillingNote({ harness }: { harness: AgentHarnessId }) {
  return (
    <p className="shrink-0 px-4 pb-2.5 pt-1 text-[11px] leading-4 text-ink-3">
      {HARNESS_BILLING_COPY[harness].footer}
    </p>
  );
}
