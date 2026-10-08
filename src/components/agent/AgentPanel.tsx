"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CHROME_SURFACE } from "@/components/chromeStyles";
import { cn } from "@/components/agent/lib/utils";
import { TooltipProvider } from "@/components/agent/ui/tooltip";
import {
  getAgentPanelFrame,
  getAgentPanelOcclusion,
  AGENT_PANEL_EDGE,
} from "@/lib/agent/client/layout";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import { agentSuggestions } from "@/lib/agent/client/messages";
import type { AgentConversation as SavedConversation } from "@/lib/agent/client/history";
import { AgentComposer } from "./AgentComposer";
import { AgentHistory } from "./AgentHistory";
import { AgentBillingNote, AgentConversation, AgentEmptyState } from "./AgentConversation";
import type { AgentNoticeSignIn } from "./AgentNotice";
import { AgentPanelHeader } from "./AgentPanelHeader";
import { useAgentSession } from "./AgentSession";
import { AgentAlreadySignedInHint, AgentSignInCard, AgentSignedInBanner, type AgentBlockedReadiness } from "./AgentSignInCard";
import { AgentChooserCard } from "./AgentChooserCard";
import { useViewportWidth } from "./hooks/useViewportWidth";

export interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
  /** The window's offsets from the canvas's right edge and from its bottom (above the navigator). */
  buttonRight: number;
  buttonBottom: number;
}

/**
 * The agent chat window, one surface of the page's agent session (the
 * full-page chat view is the other). Mounted once on first open and then kept
 * (hidden while closed); the conversation and a running turn live in the
 * session, so they outlive closing it.
 */
export function AgentPanel({ open, onClose, buttonRight, buttonBottom }: AgentPanelProps) {
  const session = useAgentSession();
  const {
    harness,
    setHarness,
    readiness,
    ready,
    mode,
    harnessStatus,
    models,
    model,
    modelOption,
    effort,
    chooseModel,
    chooseEffort,
    signInStarting,
    signInStartedAt,
    checking,
    checkAgain,
    cancelSignIn,
    startSignIn,
    pickHarness,
    signedInBanner,
    dismissSignedInBanner,
    alreadySignedIn,
    dismissAlreadySignedIn,
    chat,
    busy,
    draft,
    setDraft,
    notes,
    canvasHasNodes,
    conversations,
    setWindowOpen,
    setWindowOcclusion,
  } = session;
  const { messages } = chat;

  const viewportWidth = useViewportWidth();
  const frame = getAgentPanelFrame({ buttonRight, buttonBottom, viewportWidth });
  const occludedRight = open ? getAgentPanelOcclusion(frame) : 0;
  // The session checks the harness while a surface shows, and builds clear of the strip this one covers.
  useEffect(() => setWindowOpen(open), [open, setWindowOpen]);
  useEffect(() => setWindowOcclusion(occludedRight), [occludedRight, setWindowOcclusion]);
  useEffect(
    () => () => {
      setWindowOpen(false);
      setWindowOcclusion(0);
    },
    [setWindowOpen, setWindowOcclusion],
  );

  const [historyOpen, setHistoryOpen] = useState(false);

  // --- Focus and keyboard ----------------------------------------------------
  const panelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => (textareaRef.current ?? panelRef.current)?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && !panelRef.current?.contains(active) ? active : null;
    focusInput();
  }, [open, focusInput]);

  // Signing in finished while the window is open: put the cursor in the message box.
  const wasReady = useRef(ready);
  useEffect(() => {
    if (open && ready && !wasReady.current) {
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) focusInput();
    }
    wasReady.current = ready;
  }, [open, ready, focusInput]);

  const close = useCallback(() => {
    onClose();
    const target = returnFocusRef.current;
    // After the next frame, once the window has closed.
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
    });
  }, [onClose]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Keys typed here are for the chat, never canvas shortcuts (the canvas listens on window).
      event.stopPropagation();
      // Escape closes the window unless something inside (a select, IME composition) used it.
      // isImeKeyEvent also catches Safari, which ends a cancelled composition before this keydown.
      if (event.key === "Escape" && !event.defaultPrevented && !isImeKeyEvent(event)) {
        event.preventDefault();
        close();
      }
    },
    [close],
  );

  // The window is portalled but still a React child of the canvas: keep file drags from reaching its drop zone.
  const swallowDrag = useCallback((event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const { newChat: startNewChat, openConversation: openSavedConversation } = session;
  const newChat = useCallback(() => {
    startNewChat();
    setHistoryOpen(false);
    focusInput();
  }, [startNewChat, focusInput]);

  const openConversation = useCallback(
    (conversation: SavedConversation) => {
      openSavedConversation(conversation);
      setHistoryOpen(false);
      focusInput();
    },
    [openSavedConversation, focusInput],
  );

  // The buttons below vanish once clicked (the empty state, the error box). Put
  // the cursor back in the message box: focus left on <body> would send the next
  // keys to canvas shortcuts and make Escape stop closing the window.
  const sendSuggestion = useCallback(
    (suggestion: string) => {
      if (chat.send(suggestion)) focusInput();
    },
    [chat, focusInput],
  );
  const retry = useCallback(() => {
    chat.retry();
    focusInput();
  }, [chat, focusInput]);
  // A queued message goes back into the box to be edited (after anything already typed there).
  const editQueued = useCallback(
    (id: string) => {
      const text = chat.takeQueued(id);
      if (text === undefined) return;
      setDraft((current) => (current.trim() ? `${current}\n${text}` : text));
      focusInput();
    },
    [chat, setDraft, focusInput],
  );
  const dismissError = useCallback(() => {
    chat.clearError();
    focusInput();
  }, [chat, focusInput]);
  // Stable, so a finished message (memoised) skips the re-render for every streamed token and keystroke.
  const noticeSignIn = useCallback<AgentNoticeSignIn>((target, noticeCode) => void startSignIn(target, noticeCode), [startSignIn]);

  // --- Render -----------------------------------------------------------------
  const hasMessages = messages.length > 0;
  const blocked = ready ? null : (readiness[harness] as AgentBlockedReadiness);
  const signInCard = (variant: "full" | "inline") =>
    blocked && (
      <AgentSignInCard
        harness={harness}
        readiness={blocked}
        variant={variant}
        startingSignIn={signInStarting === harness}
        checking={checking}
        signInStartedAt={signInStartedAt}
        onSignIn={() => void startSignIn(harness)}
        onCheckAgain={() => void checkAgain()}
        onCancelSignIn={() => void cancelSignIn()}
      />
    );

  let body;
  if (historyOpen) {
    body = (
      <AgentHistory
        conversations={conversations}
        currentId={chat.chatId}
        locked={busy}
        onOpen={openConversation}
        onDelete={session.deleteConversation}
      />
    );
  } else if (hasMessages) {
    body = (
      <AgentConversation
        messages={messages}
        busy={busy}
        statusLine={chat.statusLine}
        stoppedMessageIds={chat.stoppedMessageIds}
        error={chat.error}
        onRetry={retry}
        onDismissError={dismissError}
        onSignIn={noticeSignIn}
      />
    );
  } else if (mode === "checking") {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <AgentSignInCard harness={harness} readiness={{ kind: "loading" }} eyebrow="Agent" onSignIn={() => {}} onCheckAgain={() => {}} />
      </div>
    );
  } else if (mode === "chooser") {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <AgentChooserCard readiness={readiness} onPick={pickHarness} onCheckAgain={() => void checkAgain()} checking={checking} />
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {ready ? (
          <>
            {signedInBanner === harness && (
              <AgentSignedInBanner
                harness={harness}
                email={harnessStatus?.account?.email}
                plan={harnessStatus?.account?.plan}
                model={modelOption?.label}
                onDismiss={() => {
                  dismissSignedInBanner();
                  focusInput();
                }}
              />
            )}
            <AgentEmptyState
              suggestions={agentSuggestions(canvasHasNodes)}
              onSuggestion={sendSuggestion}
            />
          </>
        ) : (
          signInCard("full")
        )}
      </div>
    );
  }

  return createPortal(
    <TooltipProvider delayDuration={400}>
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label="Agent"
        aria-busy={busy}
        tabIndex={-1}
        data-testid="agent-panel"
        className={cn(
          // The navigator's glass, one size up: the window stacks on the same chrome as the button below it.
          CHROME_SURFACE,
          "nb-agent nowheel nokey nodrag nopan fixed flex-col overflow-hidden rounded-xl text-[13px] leading-5 text-neutral-200 outline-none",
          // Fades up on open.
          "animate-in fade-in-0 slide-in-from-bottom-2 transition-[right] duration-150 motion-reduce:animate-none motion-reduce:transition-none",
          open ? "flex" : "hidden",
          "z-[80]",
        )}
        style={{
          right: frame.right,
          bottom: frame.bottom,
          width: frame.width,
          // Full height: from under the tabs down to the navigator.
          height: frame.maxHeight,
          // Guard only: the frame already fits the viewport it was computed for.
          maxWidth: `calc(100vw - ${frame.right + AGENT_PANEL_EDGE}px)`,
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => event.stopPropagation()}
        onDragEnter={swallowDrag}
        onDragOver={swallowDrag}
        onDragLeave={swallowDrag}
        onDrop={swallowDrag}
      >
        <AgentPanelHeader
          harness={harness}
          neutral={mode !== "harness"}
          readiness={readiness}
          switchDisabled={busy}
          onHarnessChange={setHarness}
          models={models}
          modelsFallback={harnessStatus?.modelsFallback}
          model={model}
          onModelChange={chooseModel}
          canStartNewChat={hasMessages}
          onNewChat={newChat}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen((shown) => !shown)}
          onClose={close}
        />
        {body}
        {!historyOpen && !hasMessages && ready && mode === "harness" && <AgentBillingNote harness={harness} />}
        {alreadySignedIn?.harness === harness && (
          <div className="shrink-0 px-4 pb-3">
            <AgentAlreadySignedInHint
              harness={harness}
              message={alreadySignedIn.message}
              command={harnessStatus?.signInCommand}
              onDismiss={() => {
                dismissAlreadySignedIn();
                focusInput();
              }}
            />
          </div>
        )}
        {historyOpen ? null : mode !== "harness" ? (
          // A reopened chat before any harness was picked, with none able to answer: the
          // chooser (or the first check) where the message box goes.
          hasMessages &&
          (mode === "chooser" ? (
            // Capped like the inline sign-in card, so the transcript keeps some room.
            <div className="max-h-[65%] shrink-0 overflow-y-auto border-t fade-rule">
              <AgentChooserCard readiness={readiness} onPick={pickHarness} onCheckAgain={() => void checkAgain()} checking={checking} />
            </div>
          ) : (
            <AgentSignInCard harness={harness} readiness={{ kind: "loading" }} variant="inline" eyebrow="Agent" onSignIn={() => {}} onCheckAgain={() => {}} />
          ))
        ) : ready || busy ? (
          <AgentComposer
            status={chat.status}
            busy={busy}
            efforts={modelOption?.efforts ?? []}
            effort={effort}
            defaultEffort={modelOption?.defaultEffort}
            onEffortChange={chooseEffort}
            onSend={chat.send}
            onStop={chat.stop}
            notes={notes}
            textareaRef={textareaRef}
            draft={draft}
            onDraftChange={setDraft}
            queued={chat.queued}
            queueHeld={chat.queueHeld}
            onEditQueued={editQueued}
            onRemoveQueued={chat.removeQueued}
            onSendQueuedNow={chat.sendQueuedNow}
          />
        ) : (
          hasMessages && signInCard("inline")
        )}
      </section>
    </TooltipProvider>,
    document.body,
  );
}
