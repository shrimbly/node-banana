"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CHROME_SURFACE } from "@/components/chromeStyles";
import { cn } from "@/components/agent/lib/utils";
import { TooltipProvider } from "@/components/agent/ui/tooltip";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  getAgentPanelFrame,
  getAgentPanelOcclusion,
  AGENT_PANEL_EDGE,
} from "@/lib/agent/client/layout";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import { agentSuggestions, latestTurnRejectedSignIn, selectionLabel } from "@/lib/agent/client/messages";
import {
  deriveAgentReadiness,
  HARNESS_LABELS,
  shouldPollReadiness,
  type AgentReadiness,
} from "@/lib/agent/client/readiness";
import { findLatestAgentSession } from "@/lib/agent/client/session";
import { resolveAgentEffort, resolveAgentModel } from "@/lib/agent/client/settings";
import { useAgentSettings } from "@/lib/agent/client/useAgentSettings";
import { useAgentStatus } from "@/lib/agent/client/useAgentStatus";
import { useAgentHistory } from "@/lib/agent/client/useAgentHistory";
import type { AgentConversation as SavedConversation } from "@/lib/agent/client/history";
import {
  AGENT_HARNESS_IDS,
  type AgentDataParts,
  type AgentGraphOpBatch,
  type AgentErrorCode,
  type AgentHarnessId,
} from "@/lib/agent/types";
import { AgentComposer, type AgentComposerProps } from "./AgentComposer";
import { AgentHistory } from "./AgentHistory";
import { AgentBillingNote, AgentConversation, AgentEmptyState } from "./AgentConversation";
import { AgentPanelHeader } from "./AgentPanelHeader";
import { AgentAlreadySignedInHint, AgentSignInCard, type AgentBlockedReadiness } from "./AgentSignInCard";
import { useAgentCanvasView } from "./hooks/useAgentCanvasView";
import { useAgentShimmer } from "./hooks/useAgentShimmer";
import { useAgentChat } from "./hooks/useAgentChat";
import { useAgentSignIn } from "./hooks/useAgentSignIn";
import { useViewportWidth } from "./hooks/useViewportWidth";

export interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
  /** The agent button's offsets from the canvas's right and bottom edges; the window stacks above it. */
  buttonRight: number;
  buttonBottom: number;
  /** A turn started or ended (the button shows a dot while the window is closed). */
  onBusyChange?: (busy: boolean) => void;
}

/** Notices that mean the harness status is stale. */
const STATUS_NOTICE_CODES = new Set<AgentDataParts["agent-notice"]["code"]>([
  "not_signed_in",
  "wrong_billing",
  "not_installed",
]);

/**
 * The agent chat window. Mounted once on first open and then kept (hidden
 * while closed), so a running turn and the conversation survive closing it.
 */
export function AgentPanel({ open, onClose, buttonRight, buttonBottom, onBusyChange }: AgentPanelProps) {
  const viewportWidth = useViewportWidth();
  const frame = getAgentPanelFrame({ buttonRight, buttonBottom, viewportWidth });
  const occludedRight = open ? getAgentPanelOcclusion(frame) : 0;

  // --- Harness, model, status and sign-in ---------------------------------
  const { settings, setHarness, setModel, setEffort } = useAgentSettings();
  const harness = settings.harness;
  const signIn = useAgentSignIn();
  const [pollHarness, setPollHarness] = useState<AgentHarnessId | null>(null);
  const status = useAgentStatus({ active: open, pollHarness });

  const readiness = useMemo(() => {
    const entries = AGENT_HARNESS_IDS.map((id) => [
      id,
      deriveAgentReadiness({
        status: status.statuses[id],
        statusCheckedAt: status.checkedAt[id],
        signIn: signIn.attempts[id],
        fetchError: status.error,
      }),
    ]);
    return Object.fromEntries(entries) as Record<AgentHarnessId, AgentReadiness>;
  }, [status.statuses, status.checkedAt, status.error, signIn.attempts]);
  const current = readiness[harness];
  const ready = current.kind === "ready";

  // Poll only the harness the user is signing in to, only while it is pending.
  const pollTarget = shouldPollReadiness(current) ? harness : null;
  useEffect(() => setPollHarness(pollTarget), [pollTarget]);

  const refreshStatus = status.refresh;
  const [checking, setChecking] = useState(false);
  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      await refreshStatus(harness);
    } finally {
      setChecking(false);
    }
  }, [refreshStatus, harness]);

  const models = status.statuses[harness]?.models ?? [];
  const model = resolveAgentModel(models, settings.models[harness]);
  const modelOption = models.find((option) => option.id === model);
  const effort = resolveAgentEffort(modelOption, settings.efforts[harness]);
  // Saved only when this harness offers it: a pick stays until the user changes it,
  // and a stray value (another harness's id) can never replace it.
  const chooseModel = useCallback(
    (next: string) => {
      if (models.some((option) => option.id === next)) setModel(harness, next);
    },
    [models, harness, setModel],
  );
  const chooseEffort = useCallback(
    (next: string) => {
      if (modelOption?.efforts?.includes(next)) setEffort(harness, next);
    },
    [modelOption, harness, setEffort],
  );

  // --- Conversation ----------------------------------------------------------
  const canvasView = useAgentCanvasView(occludedRight);
  const shimmer = useAgentShimmer();
  const { focusBatch } = canvasView;
  // Bring the edit into view and mark the nodes it changed.
  const showBatch = useCallback(
    (batch: AgentGraphOpBatch) => {
      focusBatch(batch);
      shimmer(batch);
    },
    [focusBatch, shimmer],
  );
  const handleNotice = useCallback(
    (notice: AgentDataParts["agent-notice"]) => {
      if (STATUS_NOTICE_CODES.has(notice.code)) void refreshStatus(notice.harness);
    },
    [refreshStatus],
  );
  const chat = useAgentChat({
    harness,
    model,
    effort,
    getViewport: canvasView.getViewport,
    onBatchApplied: showBatch,
    onNotice: handleNotice,
  });
  const { busy, messages } = chat;
  // Kept here, not in the composer: the composer unmounts whenever the harness
  // isn't ready (switching harness, a re-check), and the unsent text must survive.
  const [draft, setDraft] = useState("");

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  // --- History ---------------------------------------------------------------
  const history = useAgentHistory();
  const [historyOpen, setHistoryOpen] = useState(false);
  const recordConversation = history.record;
  const { chatId } = chat;
  // Saved once each turn has finished (and on reopening, which changes nothing).
  useEffect(() => {
    if (busy || messages.length === 0) return;
    recordConversation({
      id: chatId,
      messages,
      workflowName: useWorkflowStore.getState().workflowName ?? undefined,
      harness: findLatestAgentSession(messages)?.harness ?? harness,
    });
    // harness is read, not watched: switching harness is not a change to the conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages, chatId, recordConversation]);

  // "Sign in" answered already_signed_in: say so, with the terminal command, instead of doing nothing.
  const [alreadySignedIn, setAlreadySignedIn] = useState<{ harness: AgentHarnessId; message?: string } | null>(null);
  // A new turn makes it moot.
  useEffect(() => {
    if (busy) setAlreadySignedIn(null);
  }, [busy]);

  const startSignIn = useCallback(
    async (target: AgentHarnessId, noticeCode?: AgentErrorCode) => {
      // A notice's "Sign in" may name the other harness: switch to it first.
      if (target !== harness && !busy) setHarness(target);
      setAlreadySignedIn(null);
      // After a turn the vendor rejected, the CLI's own status may still read
      // signed in: force the vendor's sign-in rather than be told it's fine.
      // From the card, or from that turn's not_signed_in notice; an older notice
      // whose turn was followed by a working one doesn't force.
      const force =
        (noticeCode === undefined || noticeCode === "not_signed_in") && latestTurnRejectedSignIn(messages, target);
      const attempt = await signIn.start(target, force ? { force: true } : {});
      if (attempt.state === "already_signed_in") {
        setAlreadySignedIn({ harness: target, message: attempt.message });
        void refreshStatus(target);
      }
    },
    [harness, busy, setHarness, signIn, refreshStatus, messages],
  );

  const selectionCount = useWorkflowStore((state) => {
    let count = 0;
    for (const node of state.nodes) if (node.selected) count++;
    return count;
  });
  const canvasHasNodes = useWorkflowStore((state) => state.nodes.length > 0);
  const clearSelection = useCallback(() => {
    const { nodes, onNodesChange } = useWorkflowStore.getState();
    onNodesChange(nodes.filter((node) => node.selected).map((node) => ({ type: "select", id: node.id, selected: false })));
  }, []);

  const notes = useMemo(() => {
    const list: NonNullable<AgentComposerProps["notes"]> = [];
    const selected = selectionLabel(selectionCount);
    if (selected) {
      list.push({
        key: "selection",
        kind: "selection",
        text: selected,
        // The selection is what the agent focuses on: clearing it widens the turn to the whole canvas.
        onDismiss: clearSelection,
        dismissLabel: "Clear the selection",
      });
    }
    const lastSession = findLatestAgentSession(messages);
    if (lastSession && lastSession.harness !== harness) {
      list.push({
        key: "switch",
        kind: "switch",
        text: `${HARNESS_LABELS[harness]} picks up from here with the conversation so far`,
      });
    }
    return list;
  }, [selectionCount, messages, harness, clearSelection]);

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
    // After the next frame: the agent button is hidden while the window is open.
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

  const newChat = useCallback(() => {
    chat.newChat();
    setHistoryOpen(false);
    focusInput();
  }, [chat, focusInput]);

  const openConversation = useCallback(
    (conversation: SavedConversation) => {
      if (conversation.id !== chat.chatId) chat.openConversation(conversation);
      setHistoryOpen(false);
      focusInput();
    },
    [chat, focusInput],
  );
  const deleteConversation = useCallback(
    (id: string) => {
      history.remove(id);
      // Deleting the open conversation leaves an empty chat, not a conversation that no longer exists.
      if (id === chat.chatId) chat.newChat();
    },
    [history, chat],
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
  const dismissError = useCallback(() => {
    chat.clearError();
    focusInput();
  }, [chat, focusInput]);

  // --- Render -----------------------------------------------------------------
  const hasMessages = messages.length > 0;
  const blocked = ready ? null : (current as AgentBlockedReadiness);
  const signInCard = (variant: "full" | "inline") =>
    blocked && (
      <AgentSignInCard
        harness={harness}
        readiness={blocked}
        variant={variant}
        startingSignIn={signIn.starting === harness}
        checking={checking}
        onSignIn={() => void startSignIn(harness)}
        onCheckAgain={() => void checkAgain()}
      />
    );

  let body;
  if (historyOpen) {
    body = (
      <AgentHistory
        conversations={history.conversations}
        currentId={chat.chatId}
        locked={busy}
        onOpen={openConversation}
        onDelete={deleteConversation}
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
        onSignIn={(target, noticeCode) => void startSignIn(target, noticeCode)}
      />
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {ready ? (
          <AgentEmptyState
            suggestions={agentSuggestions(canvasHasNodes)}
            onSuggestion={sendSuggestion}
          />
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
          readiness={readiness}
          switchDisabled={busy}
          onHarnessChange={setHarness}
          models={models}
          model={model}
          onModelChange={chooseModel}
          canStartNewChat={hasMessages}
          onNewChat={newChat}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen((shown) => !shown)}
          onClose={close}
        />
        {body}
        {!historyOpen && !hasMessages && ready && <AgentBillingNote harness={harness} />}
        {alreadySignedIn?.harness === harness && (
          <div className="shrink-0 px-4 pb-3">
            <AgentAlreadySignedInHint
              harness={harness}
              message={alreadySignedIn.message}
              command={status.statuses[harness]?.signInCommand}
              onDismiss={() => {
                setAlreadySignedIn(null);
                focusInput();
              }}
            />
          </div>
        )}
        {historyOpen ? null : ready || busy ? (
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
          />
        ) : (
          hasMessages && signInCard("inline")
        )}
      </section>
    </TooltipProvider>,
    document.body,
  );
}
