"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/agent/lib/utils";
import { TooltipProvider } from "@/components/agent/ui/tooltip";
import type { AgentConversation as SavedConversation } from "@/lib/agent/client/history";
import { agentSuggestions } from "@/lib/agent/client/messages";
import { useAssetStore } from "@/store/assetStore";
import { requestSave } from "@/store/saveRequestStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { isSaveShortcut } from "@/utils/saveShortcut";
import { AgentChatHeader, type AgentChatHeaderProps } from "./AgentChatHeader";
import { AgentChatSidebar, loadChatSidebarCollapsed, saveChatSidebarCollapsed } from "./AgentChatSidebar";
import { AgentChooserCard } from "./AgentChooserCard";
import { AgentComposer } from "./AgentComposer";
import { AgentBillingNote, AgentConversation, AgentPageIntro, AgentSuggestionCards, PAGE_COLUMN } from "./AgentConversation";
import { useAgentSession } from "./AgentSession";
import { AgentAlreadySignedInHint, AgentSignInCard, AgentSignedInBanner, type AgentBlockedReadiness } from "./AgentSignInCard";
import { AgentSurfaceProvider } from "./AgentSurface";

/** A text field: its letters are typing, not shortcuts. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null)
  );
}

/**
 * The view's own keys, once nothing closer has taken them: bare C goes back
 * to the canvas and ? shows the shortcuts. Never while typing, nor while a
 * menu or a dialog is up (their letters are theirs). Escape is not one of
 * them: the view is left on purpose, never by dismissing something.
 */
function handleChatViewKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || useAssetStore.getState().appView !== "chat") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  if (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return;
  if (document.querySelector('[role="menu"], [role="listbox"], [data-dialog-overlay]')) return;
  if (event.key.toLowerCase() === "c" && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat) useAssetStore.getState().setAppView("canvas");
  } else if (event.key === "?") {
    event.preventDefault();
    useWorkflowStore.getState().setShortcutsDialogOpen(true);
  }
}

/** A card standing alone in the main column (the first check, the chooser, sign-in), centred at a reading width. */
function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="m-auto w-full max-w-[440px] px-2 py-10">{children}</div>
    </div>
  );
}

/**
 * The full-page agent chat, shown from the tab strip's Chat toggle: past
 * conversations down the left, the workflow the agent works in and who
 * answers along the top, and the conversation in a centred column with the
 * message box docked under it (in the middle of the page while the chat is
 * empty). The same session as the floating window: one conversation, one
 * draft. The canvas stays mounted underneath; "Canvas", C, and every tab in
 * the strip go back to it.
 */
export function AgentChatView() {
  const session = useAgentSession();
  const {
    harness,
    setHarness,
    readiness,
    ready,
    mode,
    harnessStatus,
    presence,
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
    newChat: startNewChat,
    openConversation: openSavedConversation,
    deleteConversation,
    showOnCanvas,
  } = session;
  const { messages } = chat;
  const workflowName = useWorkflowStore((state) => state.workflowName);
  const nodeCount = useWorkflowStore((state) => state.nodes.length);

  const [collapsed, setCollapsed] = useState(loadChatSidebarCollapsed);
  const changeCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    saveChatSidebarCollapsed(next);
  }, []);
  const [scrolled, setScrolled] = useState(false);

  // --- Focus and keyboard ----------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = useCallback(() => {
    requestAnimationFrame(() => (textareaRef.current ?? rootRef.current)?.focus({ preventScroll: true }));
  }, []);

  // On show: the cursor in the message box (in the view itself while the harness isn't ready).
  useEffect(() => {
    (textareaRef.current ?? rootRef.current)?.focus({ preventScroll: true });
  }, []);

  // The message box appeared (the first check came back, a sign-in finished): put the cursor in it,
  // unless the person has moved on to something else in the view.
  const composerShown = mode === "harness" && (ready || busy);
  const composerWasShown = useRef(composerShown);
  useEffect(() => {
    if (composerShown && !composerWasShown.current) {
      const active = document.activeElement;
      if (!active || active === document.body || active === rootRef.current) focusInput();
    }
    composerWasShown.current = composerShown;
  }, [composerShown, focusInput]);

  // Keys pressed with the focus outside the view (on the page, in the tab strip) still reach it.
  useEffect(() => {
    window.addEventListener("keydown", handleChatViewKey);
    return () => window.removeEventListener("keydown", handleChatViewKey);
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys typed here are the chat's, never canvas shortcuts (the canvas listens on window).
    event.stopPropagation();
    if (isSaveShortcut(event)) {
      // The canvas leaves ⌘S alone inside the agent's surfaces; this view is over every
      // workflow, so ⌘S saves the live one, as the desktop app's File › Save does from here.
      event.preventDefault();
      requestSave("shortcut");
      return;
    }
    handleChatViewKey(event.nativeEvent);
  }, []);

  // Files dropped on the view would otherwise be opened by the browser in place of the app.
  const swallowDrag = useCallback((event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
  }, []);

  // --- Actions -------------------------------------------------------------------
  const newChat = useCallback(() => {
    startNewChat();
    focusInput();
  }, [startNewChat, focusInput]);
  const openConversation = useCallback(
    (conversation: SavedConversation) => {
      openSavedConversation(conversation);
      focusInput();
    },
    [openSavedConversation, focusInput],
  );
  const openCanvas = useCallback(() => {
    showOnCanvas();
  }, [showOnCanvas]);
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
  const dismissError = useCallback(() => {
    chat.clearError();
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

  const neutral = mode !== "harness";
  const menu = useMemo<AgentChatHeaderProps["menu"]>(
    () => ({
      harness,
      neutral,
      readiness,
      switchDisabled: busy,
      onHarnessChange: setHarness,
      models,
      modelsFallback: harnessStatus?.modelsFallback,
      model,
      onModelChange: chooseModel,
    }),
    [harness, neutral, readiness, busy, setHarness, models, harnessStatus?.modelsFallback, model, chooseModel],
  );

  // --- Render -------------------------------------------------------------------
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
  const alreadySignedInHint = alreadySignedIn?.harness === harness && (
    <AgentAlreadySignedInHint
      harness={harness}
      message={alreadySignedIn.message}
      command={harnessStatus?.signInCommand}
      onDismiss={() => {
        dismissAlreadySignedIn();
        focusInput();
      }}
    />
  );

  // The column's four slots keep their places, so the message box stays mounted (and focused)
  // when the first message moves it from the middle of the page down to the dock.
  let top: ReactNode;
  if (hasMessages) {
    top = (
      <AgentConversation
        messages={messages}
        busy={busy}
        statusLine={chat.statusLine}
        stoppedMessageIds={chat.stoppedMessageIds}
        error={chat.error}
        onRetry={retry}
        onDismissError={dismissError}
        onSignIn={(target, noticeCode) => void startSignIn(target, noticeCode)}
        onScrolledChange={setScrolled}
      />
    );
  } else if (mode === "checking") {
    top = (
      <CenteredCard>
        <AgentSignInCard harness={harness} readiness={{ kind: "loading" }} eyebrow="Agent" onSignIn={() => {}} onCheckAgain={() => {}} />
      </CenteredCard>
    );
  } else if (mode === "chooser") {
    top = (
      <CenteredCard>
        <AgentChooserCard readiness={readiness} onPick={pickHarness} onCheckAgain={() => void checkAgain()} checking={checking} />
      </CenteredCard>
    );
  } else if (composerShown) {
    // Above the message box, which sits in the middle of the page.
    top = (
      <div className="flex flex-1 flex-col justify-end">
        <div className={cn(PAGE_COLUMN, "pb-8 pt-10")}>
          {signedInBanner === harness && (
            <div className="-mx-4 -mt-4 mb-8">
              <AgentSignedInBanner
                harness={harness}
                email={harnessStatus?.account?.email}
                plan={harnessStatus?.account?.plan}
                model={modelOption?.label}
                onDismiss={dismissSignedInBanner}
              />
            </div>
          )}
          <AgentPageIntro harness={harness} workflowName={workflowName} nodeCount={nodeCount} />
        </div>
      </div>
    );
  } else {
    top = (
      <CenteredCard>
        {signInCard("full")}
        {alreadySignedInHint && <div className="px-4 pt-1">{alreadySignedInHint}</div>}
      </CenteredCard>
    );
  }

  const inlineSignIn = hasMessages && mode === "harness" && !composerShown;
  const dock =
    composerShown || inlineSignIn ? (
      <div className={cn(PAGE_COLUMN, "relative z-[1] shrink-0", inlineSignIn && "pb-4")}>
        {alreadySignedInHint && <div className="pb-3">{alreadySignedInHint}</div>}
        {composerShown ? (
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
          signInCard("inline")
        )}
      </div>
    ) : null;

  const suggestions =
    !hasMessages && composerShown ? (
      <div className={cn(PAGE_COLUMN, "flex-1 pb-6 pt-6")}>
        <AgentSuggestionCards suggestions={agentSuggestions(canvasHasNodes)} onSuggestion={sendSuggestion} />
      </div>
    ) : null;

  return (
    <AgentSurfaceProvider value="page">
      <TooltipProvider delayDuration={400}>
        <div
          ref={rootRef}
          role="region"
          aria-label="Chat"
          aria-busy={busy}
          tabIndex={-1}
          data-agent-surface="page"
          data-testid="agent-chat-view"
          className="nb-agent absolute inset-0 flex bg-canvas-bg text-[13px] leading-5 text-neutral-200 outline-none"
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
          onDragEnter={swallowDrag}
          onDragOver={swallowDrag}
          onDragLeave={swallowDrag}
          onDrop={swallowDrag}
        >
          <AgentChatSidebar
            collapsed={collapsed}
            onCollapsedChange={changeCollapsed}
            conversations={conversations}
            currentId={chat.chatId}
            locked={busy}
            canStartNewChat={hasMessages}
            onNewChat={newChat}
            onOpen={openConversation}
            onDelete={deleteConversation}
            harness={harness}
            neutral={neutral}
            readiness={readiness[harness]}
            attention={presence.attention}
            plan={harnessStatus?.account?.plan}
            modelLabel={modelOption?.label}
          />
          <main className="relative flex min-w-0 flex-1 flex-col">
            <AgentChatHeader scrolled={hasMessages && scrolled} busy={busy} menu={menu} onOpenCanvas={openCanvas} />
            <div className={cn("flex min-h-0 flex-1 flex-col", !hasMessages && "overflow-y-auto")}>
              {top}
              {dock}
              {suggestions}
              {composerShown && <AgentBillingNote harness={harness} />}
            </div>
          </main>
        </div>
      </TooltipProvider>
    </AgentSurfaceProvider>
  );
}
