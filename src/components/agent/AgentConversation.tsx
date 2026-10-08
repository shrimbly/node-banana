"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowRightIcon, RotateCcwIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/components/agent/lib/utils";
import { prefersReducedMotion } from "@/components/assets/useVirtualWindow";
import { findHarnessSwitches, turnIndicatorText } from "@/lib/agent/client/messages";
import { HARNESS_BILLING_COPY, HARNESS_LABELS } from "@/lib/agent/client/readiness";
import type { AgentHarnessId, AgentUIMessage } from "@/lib/agent/types";
import { AgentMessage } from "./AgentMessage";
import { AgentAlert, AgentTextButton, type AgentNoticeSignIn } from "./AgentNotice";
import { useAgentSurface } from "./AgentSurface";
import { HarnessIcon } from "./HarnessIcon";
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
  /** Told whether the transcript is scrolled off its top (the chat view's header draws its hairline then). */
  onScrolledChange?: (scrolled: boolean) => void;
}

/**
 * The transcript: messages, a divider where the harness changed, progress,
 * stop markers and errors. In the window it fills the panel; on the page it
 * is a centred reading column inside a full-width scroller (the scrollbar
 * sits at the window's edge), fading out above the composer docked below it.
 */
export function AgentConversation({
  messages,
  busy,
  statusLine,
  stoppedMessageIds,
  error,
  onRetry,
  onDismissError,
  onSignIn,
  onScrolledChange,
}: AgentConversationProps) {
  const page = useAgentSurface() === "page";
  const switches = useMemo(() => findHarnessSwitches(messages), [messages]);
  const indicator = turnIndicatorText(messages, busy, statusLine);
  const [reducedMotion] = useState(prefersReducedMotion);

  return (
    // Opens at the newest line rather than gliding down from the top each time it mounts
    // (opening a chat, coming back to the view); a reply grows into view, at once under reduced motion.
    <Conversation className="min-h-0 flex-1" initial="instant" resize={reducedMotion ? "instant" : "smooth"}>
      <ConversationContent className={page ? `${PAGE_COLUMN} gap-7 pb-10 pt-6` : "gap-5 px-4 py-4"}>
        {messages.map((message, index) => {
          const switchedTo = switches.get(message.id);
          const streaming = busy && index === messages.length - 1;
          const stopped = stoppedMessageIds.has(message.id);
          return (
            <Fragment key={message.id}>
              {switchedTo && <HarnessDivider harness={switchedTo} />}
              <AgentMessage message={message} streaming={streaming} latest={index === messages.length - 1} onSignIn={onSignIn} />
              {stopped && (
                <p className={cn("font-mono text-[10px] leading-4 uppercase tracking-eyebrow text-ink-3", page ? "-mt-5" : "-mt-3")}>
                  Stopped
                </p>
              )}
            </Fragment>
          );
        })}
        {indicator && (
          <div role="status" aria-live="polite">
            <Shimmer className={page ? "text-[15px] leading-[26px]" : "text-[13px] leading-5"} duration={1.6}>
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
      {/* The reply scrolls under the composer: its last lines fade into the page rather than stop at an edge. */}
      {page && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-8 max-w-[768px] bg-linear-to-b from-transparent to-canvas-bg"
        />
      )}
      <ConversationScrollButton className={page ? "bottom-4" : undefined} />
      <StayPinnedWhenShrunk />
      <ScrollToSentMessage messages={messages} />
      {onScrolledChange && <ReportScrolled onChange={onScrolledChange} />}
    </Conversation>
  );
}

/** The chat view's reading column: the transcript, the composer and the empty state all line up on it. */
export const PAGE_COLUMN = "mx-auto w-full max-w-[768px] px-6";

/** Says whether the scroller has left its top, once per change. */
function ReportScrolled({ onChange }: { onChange: (scrolled: boolean) => void }) {
  const { scrollRef } = useStickToBottomContext();
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let last: boolean | undefined;
    const update = () => {
      const scrolled = scroller.scrollTop > 0;
      if (scrolled === last) return;
      last = scrolled;
      onChange(scrolled);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", update);
      onChange(false);
    };
  }, [scrollRef, onChange]);
  return null;
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

/**
 * Brings the user's own message into view as they send it (typed, queued, a
 * suggestion or a card's "Ask the agent"), even from scrolled up: the
 * scroller only follows while pinned, so the bubble and the reply would grow
 * below the fold. Pinned again, it follows the reply. Opening a conversation
 * is not a send: the count starts from the one it mounted with.
 */
function ScrollToSentMessage({ messages }: { messages: readonly AgentUIMessage[] }) {
  const { scrollToBottom } = useStickToBottomContext();
  const seen = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > seen.current;
    seen.current = messages.length;
    if (grew && messages[messages.length - 1]?.role === "user") void scrollToBottom("instant");
  }, [messages, scrollToBottom]);
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
      <div className="flex flex-col divide-y *:fade-rule [@media(max-height:680px)]:[&>*:nth-child(n+3)]:hidden">
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

export interface AgentPageIntroProps {
  harness: AgentHarnessId;
  /** The live workflow's name (null while untitled) and its node count, for the lead. */
  workflowName: string | null;
  nodeCount: number;
}

/**
 * A fresh chat in the chat view, above the composer: the harness's mark, the
 * question, and a lead that says which workflow the agent will work in.
 */
export function AgentPageIntro({ harness, workflowName, nodeCount }: AgentPageIntroProps) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <HarnessIcon harness={harness} className="size-[22px]" />
      </span>
      <h2 className="mt-5 font-display text-[30px] font-bold leading-9 tracking-display text-balance text-neutral-100">
        What should we make?
      </h2>
      <p className="mt-2 max-w-full truncate font-display text-[15px] font-medium leading-6 text-ink-3">
        {nodeCount > 0 ? (
          <>
            Working in{" "}
            <span className={workflowName ? "text-neutral-300" : "italic text-neutral-400"}>{workflowName ?? "Untitled"}</span>
            {" · "}
            {nodeCount === 1 ? "1 node" : `${nodeCount} nodes`}
          </>
        ) : (
          "Describe a workflow and the agent builds it"
        )}
      </p>
    </div>
  );
}

/**
 * Things to try under the chat view's empty composer, as cards two to a row
 * (one, when the column is narrower than two cards read well). Each sends itself.
 */
export function AgentSuggestionCards({ suggestions, onSuggestion }: AgentEmptyStateProps) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-2.5 @md:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            data-agent-suggestion
            onClick={() => onSuggestion(suggestion)}
            className={cn(
              "group flex min-h-16 items-start gap-3 rounded-[14px] squircle border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-left text-[13px] leading-5 text-neutral-300",
              "transition-[background-color,border-color,color] duration-[120ms] hover:border-white/[0.12] hover:bg-white/[0.04] hover:text-neutral-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
            )}
          >
            <span className="min-w-0 flex-1">{suggestion}</span>
            <ArrowRightIcon
              aria-hidden="true"
              strokeWidth={1.75}
              className="mt-0.5 size-4 shrink-0 text-neutral-600 transition-colors duration-[120ms] group-hover:text-neutral-300"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Who pays for the agent (the plan's own limits, never an API key or extra
 * usage). A fixed row above the message box, outside the scrolling empty
 * state, so it is never cut off or scrolled out of view. On the page it is
 * one centred line under the composer.
 */
export function AgentBillingNote({ harness }: { harness: AgentHarnessId }) {
  const page = useAgentSurface() === "page";
  return (
    <p className={page ? `${PAGE_COLUMN} shrink-0 pb-3 pt-2.5 text-center text-[11px] leading-4 text-ink-3` : "shrink-0 px-4 pb-2.5 pt-1 text-[11px] leading-4 text-ink-3"}>
      {HARNESS_BILLING_COPY[harness].footer}
    </p>
  );
}
