"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useToast } from "@/components/Toast";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { deletePromptNotes, fetchPromptNotes } from "@/lib/agent/client/api";
import type { AgentConversation as SavedConversation } from "@/lib/agent/client/history";
import { latestTurnRejectedSignIn, selectionLabel } from "@/lib/agent/client/messages";
import {
  decideFirstOpen,
  deriveAgentReadiness,
  HARNESS_LABELS,
  shouldPollReadiness,
  type AgentReadiness,
} from "@/lib/agent/client/readiness";
import { researchMessage, researchTargetForSelection } from "@/lib/agent/client/research";
import { findLatestAgentSession } from "@/lib/agent/client/session";
import { resolveAgentEffort, resolveAgentModel } from "@/lib/agent/client/settings";
import { useAgentHistory } from "@/lib/agent/client/useAgentHistory";
import { useAgentSettings } from "@/lib/agent/client/useAgentSettings";
import { useAgentStatus } from "@/lib/agent/client/useAgentStatus";
import {
  AGENT_HARNESS_IDS,
  type AgentDataParts,
  type AgentErrorCode,
  type AgentGraphOpBatch,
  type AgentHarnessId,
  type AgentHarnessStatus,
  type AgentModelOption,
  type AgentResearchTarget,
} from "@/lib/agent/types";
import type { AgentChooserAction } from "./AgentChooserCard";
import type { AgentComposerNote } from "./AgentComposer";
import { useAgentCanvasView } from "./hooks/useAgentCanvasView";
import { useAgentChat, type UseAgentChatResult } from "./hooks/useAgentChat";
import { useAgentShimmer } from "./hooks/useAgentShimmer";
import { useAgentSignIn } from "./hooks/useAgentSignIn";

/** What the agent button shows: whose mark, and whether that harness can run. */
export interface AgentPresence {
  harness: AgentHarnessId;
  /** The user has opened the agent, so the harness is theirs rather than the default. */
  harnessChosen: boolean;
  /** The harness can't run a turn until the user acts (signed out, wrong account, not installed). */
  attention: boolean;
}

/** What a surface shows in place of the conversation: the first status check, the harness chooser, or the chosen harness. */
export type AgentSessionMode = "checking" | "chooser" | "harness";

/** What `showOnCanvas` brings into view. */
export interface AgentCanvasTarget {
  /** The workflow tab the nodes are in; the live tab when absent. */
  tabId?: string;
  /** Nodes to fit into the visible canvas. */
  nodeIds?: readonly string[];
}

/**
 * The agent conversation and everything around it, shared by the surfaces
 * that show it: the floating window on the canvas and the full-page chat view.
 * Both read and drive the same chat, draft, history and harness state.
 */
export interface AgentSessionValue {
  // --- Harness, model and status ---------------------------------------------
  /** The harness the next turn runs on. */
  harness: AgentHarnessId;
  /** Switch harness. `chosen` (default true): the person picked it, rather than the first open settling on it. */
  setHarness: (harness: AgentHarnessId, options?: { chosen?: boolean }) => void;
  /** Each harness's readiness: its status, the user's sign-in attempt and any failed check, combined. */
  readiness: Record<AgentHarnessId, AgentReadiness>;
  /** The chosen harness can run a turn. */
  ready: boolean;
  /** What to show in place of the conversation while it is empty. */
  mode: AgentSessionMode;
  /** The chosen harness's last status (account, plan, models, sign-in command), once checked. */
  harnessStatus: AgentHarnessStatus | undefined;
  /** What the agent button shows. Also from `useAgentPresence`, which re-renders only when it changes. */
  presence: AgentPresence;
  /** Re-check one harness, or both. Never throws. */
  refreshStatus: (harness?: AgentHarnessId) => Promise<void>;
  /** The chosen harness's models, the one a turn runs on, and its thinking effort. */
  models: AgentModelOption[];
  model: string | undefined;
  modelOption: AgentModelOption | undefined;
  effort: string | undefined;
  /** Keep a model pick for the chosen harness (ignored when that harness doesn't offer it). */
  chooseModel: (model: string) => void;
  /** Keep an effort pick for the chosen model (ignored when the model doesn't offer it). */
  chooseEffort: (effort: string) => void;

  // --- Sign-in ---------------------------------------------------------------
  /** The harness whose sign-in request is in flight. */
  signInStarting: AgentHarnessId | null;
  /** When the chosen harness's running sign-in began: the user's own request, else when its status first said so. */
  signInStartedAt: number | undefined;
  /** A "Check again" is running. */
  checking: boolean;
  /** Re-check the chosen harness (both on the chooser). */
  checkAgain: () => Promise<void>;
  /** Stop the chosen harness's sign-in flow and re-check it. */
  cancelSignIn: () => Promise<void>;
  /**
   * Start a harness's own sign-in (switching to it first when it isn't the
   * chosen one and no turn runs). `noticeCode`: the notice whose button asked.
   */
  startSignIn: (target: AgentHarnessId, noticeCode?: AgentErrorCode) => Promise<void>;
  /** The chooser's pick: choose that harness, and start its sign-in for `sign_in`. */
  pickHarness: (target: AgentHarnessId, action: AgentChooserAction) => void;
  /** The harness a sign-in just landed on (once: who is in, on what). */
  signedInBanner: AgentHarnessId | null;
  dismissSignedInBanner: () => void;
  /** "Sign in" answered already signed in: the hint saying so, with its message. */
  alreadySignedIn: { harness: AgentHarnessId; message?: string } | null;
  dismissAlreadySignedIn: () => void;

  // --- Conversation ----------------------------------------------------------
  /** The chat: messages, status, send/stop, the queue, the conversation's id. */
  chat: UseAgentChatResult;
  /** A turn is being submitted or streamed. */
  busy: boolean;
  /** The unsent message, shared by both composers (it outlives either composer unmounting). */
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** The composer's context chips: the selection, a harness switch, the prompting-tips action. */
  notes: AgentComposerNote[];
  /** The live canvas has nodes (the empty state's suggestions depend on it). */
  canvasHasNodes: boolean;

  // --- History ---------------------------------------------------------------
  /** Saved conversations, newest first. */
  conversations: SavedConversation[];
  /** Start an empty conversation (stopping a running turn). */
  newChat: () => void;
  /**
   * Carry on a saved conversation. When its workflow's tab is still open and
   * not live, that tab comes back too (unless tab changes are refused right now).
   */
  openConversation: (conversation: SavedConversation) => void;
  /** Forget a saved conversation; deleting the open one starts a new chat. */
  deleteConversation: (id: string) => void;

  // --- Surfaces --------------------------------------------------------------
  /** The floating window reports whether it shows (the session checks the harness while a surface does). */
  setWindowOpen: (open: boolean) => void;
  /** The floating window reports how much of the canvas's right edge it covers (0 while closed). */
  setWindowOcclusion: (pixels: number) => void;
  /**
   * Show the canvas: leaves the chat view, switches to `tabId` when it isn't
   * live, then fits `nodeIds` into view. False (with a toast saying why) when
   * the tab can't be shown: it was closed, a run or save holds the tabs, or a
   * turn is running.
   */
  showOnCanvas: (target?: AgentCanvasTarget) => boolean;
}

/** The slice the canvas chrome reads (the pill, the tab strip): it changes once per turn, not per streamed token. */
export interface AgentPresenceValue {
  busy: boolean;
  presence: AgentPresence;
}

/**
 * What the transcript's cards do with the session (an offer's Run, "Show on
 * canvas", "Ask the agent to fix it"). It changes once per turn, not with
 * every streamed token, so a card reading it stays still while a reply streams.
 */
export interface AgentTranscriptActions {
  /** The conversation runs started from the transcript belong to. */
  chatId: string;
  /** Message the agent; queued while a turn runs. */
  send: (text: string) => boolean;
  showOnCanvas: (target?: AgentCanvasTarget) => boolean;
  /** A turn runs: a run in another tab waits, since switching tabs would stop the turn. */
  busy: boolean;
}

const AgentSessionContext = createContext<AgentSessionValue | null>(null);
const AgentPresenceContext = createContext<AgentPresenceValue | null>(null);
const AgentTranscriptContext = createContext<AgentTranscriptActions | null>(null);

/** The session provides it; a transcript rendered on its own (a test) may provide its own. */
export const AgentTranscriptActionsProvider = AgentTranscriptContext.Provider;

/** Notices that mean the harness status is stale. */
const STATUS_NOTICE_CODES = new Set<AgentDataParts["agent-notice"]["code"]>([
  "not_signed_in",
  "wrong_billing",
  "not_installed",
]);

/** Readiness states the button flags: blocked, and not merely still being checked. */
function needsAttention(readiness: AgentReadiness): boolean {
  return readiness.kind !== "ready" && readiness.kind !== "loading" && readiness.kind !== "signing_in";
}

/**
 * One agent session for the page, mounted inside ReactFlowProvider. The
 * conversation lives here rather than in a surface, so the floating window and
 * the chat view show the same one, and a running turn outlives either.
 * Harness status is checked only while a surface shows the agent.
 */
export function AgentSessionProvider({ children }: { children: ReactNode }) {
  // --- Surfaces ----------------------------------------------------------------
  const [windowOpen, setWindowOpen] = useState(false);
  const [windowOcclusion, setWindowOcclusion] = useState(0);
  const chatViewShown = useAssetStore((state) => state.appView === "chat");
  const active = windowOpen || chatViewShown;

  // --- Harness, model, status and sign-in ---------------------------------
  const { settings, setHarness, markOpened, setModel, setEffort } = useAgentSettings();
  const harness = settings.harness;
  // Once a surface has shown the agent, the button knows which harness will
  // answer and stops offering both. Whether the person picked it is a separate flag.
  useEffect(() => {
    if (active) markOpened();
  }, [active, markOpened]);
  const signIn = useAgentSignIn();
  const [pollHarness, setPollHarness] = useState<AgentHarnessId | null>(null);
  const status = useAgentStatus({ active, pollHarness });

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
  const harnessChosen = settings.harnessChosen === true || settings.opened === true;
  const attention = needsAttention(current);
  const presence = useMemo<AgentPresence>(
    () => ({ harness, harnessChosen, attention }),
    [harness, harnessChosen, attention],
  );

  // First open: nobody has picked a harness yet. One with a paid subscription
  // wins (the saved one when both have one); with none, the chooser.
  const firstOpen = !settings.harnessChosen;
  const firstOpenDecision = firstOpen ? decideFirstOpen(readiness, harness) : null;
  useEffect(() => {
    if (firstOpenDecision?.kind === "open" && firstOpenDecision.harness !== harness) {
      setHarness(firstOpenDecision.harness, { chosen: false });
    }
  }, [firstOpenDecision, harness, setHarness]);
  const mode: AgentSessionMode =
    firstOpenDecision?.kind === "checking" ? "checking" : firstOpenDecision?.kind === "choose" ? "chooser" : "harness";

  // Once, right after a sign-in lands: who is in, on what.
  const [signedInBanner, setSignedInBanner] = useState<AgentHarnessId | null>(null);
  const previousKinds = useRef<Partial<Record<AgentHarnessId, AgentReadiness["kind"]>>>({});
  useEffect(() => {
    for (const id of AGENT_HARNESS_IDS) {
      const was = previousKinds.current[id];
      const now = readiness[id].kind;
      if (now === "ready" && (was === "signing_in" || was === "sign_in_failed")) setSignedInBanner(id);
      previousKinds.current[id] = now;
    }
  }, [readiness]);
  const dismissSignedInBanner = useCallback(() => setSignedInBanner(null), []);

  // Poll only the harness the user is signing in to, only while it is pending.
  const pollTarget = shouldPollReadiness(current) ? harness : null;
  useEffect(() => setPollHarness(pollTarget), [pollTarget]);

  const refreshStatus = status.refresh;
  const [checking, setChecking] = useState(false);
  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      // On the chooser, both harnesses are on the table.
      await refreshStatus(mode === "harness" ? harness : undefined);
    } finally {
      setChecking(false);
    }
  }, [refreshStatus, harness, mode]);
  const cancelSignIn = useCallback(async () => {
    await signIn.cancel(harness);
    await refreshStatus(harness);
  }, [signIn, harness, refreshStatus]);
  // When the running flow started: the user's own request, else when the status first said so.
  const signingSince = useRef<Partial<Record<AgentHarnessId, number>>>({});
  for (const id of AGENT_HARNESS_IDS) {
    if (readiness[id].kind === "signing_in") signingSince.current[id] ??= Date.now();
    else delete signingSince.current[id];
  }
  const signInStartedAt = signIn.attempts[harness]?.startedAt ?? signingSince.current[harness];

  const harnessStatus = status.statuses[harness];
  const models = useMemo(() => harnessStatus?.models ?? [], [harnessStatus]);
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
  const canvasView = useAgentCanvasView(windowOcclusion);
  const shimmer = useAgentShimmer();
  const { focusBatch, focusNodes } = canvasView;
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
  const { busy, messages, send, chatId, newChat, openConversation: openSavedChat } = chat;
  // Kept here, not in a composer: a composer unmounts whenever the harness
  // isn't ready (switching harness, a re-check), and the unsent text must survive.
  const [draft, setDraft] = useState("");

  // --- History ---------------------------------------------------------------
  const history = useAgentHistory();
  const recordConversation = history.record;
  // Saved once each turn has finished (and on reopening, which changes nothing),
  // with the workflow the turn ended on.
  useEffect(() => {
    if (busy || messages.length === 0) return;
    const { workflowName, workflowId, activeTabId } = useWorkflowStore.getState();
    recordConversation({
      id: chatId,
      messages,
      workflowName: workflowName ?? undefined,
      tabId: activeTabId,
      workflowId: workflowId ?? undefined,
      harness: findLatestAgentSession(messages)?.harness ?? harness,
    });
    // harness is read, not watched: switching harness is not a change to the conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages, chatId, recordConversation]);

  const openConversation = useCallback(
    (conversation: SavedConversation) => {
      if (busy || conversation.id === chatId) return;
      // Its workflow first, when that tab is still open: the conversation carries on against it.
      const store = useWorkflowStore.getState();
      const { tabId } = conversation;
      if (tabId && tabId !== store.activeTabId && store.tabs.some((tab) => tab.id === tabId) && !store.tabsBusyReason()) {
        store.switchTab(tabId);
      }
      openSavedChat(conversation);
    },
    [busy, chatId, openSavedChat],
  );
  const removeConversation = history.remove;
  const deleteConversation = useCallback(
    (id: string) => {
      removeConversation(id);
      // Deleting the open conversation leaves an empty chat, not a conversation that no longer exists.
      if (id === chatId) newChat();
    },
    [removeConversation, chatId, newChat],
  );

  // --- Sign-in actions ---------------------------------------------------------
  // "Sign in" answered already_signed_in: say so, with the terminal command, instead of doing nothing.
  const [alreadySignedIn, setAlreadySignedIn] = useState<{ harness: AgentHarnessId; message?: string } | null>(null);
  // A new turn makes it moot.
  useEffect(() => {
    if (busy) setAlreadySignedIn(null);
  }, [busy]);
  const dismissAlreadySignedIn = useCallback(() => setAlreadySignedIn(null), []);

  const startSignIn = useCallback(
    async (target: AgentHarnessId, noticeCode?: AgentErrorCode) => {
      // A notice's "Sign in" may name the other harness: switch to it first.
      if (target !== harness && !busy) setHarness(target);
      setSignedInBanner(null);
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
  const pickHarness = useCallback(
    (target: AgentHarnessId, action: AgentChooserAction) => {
      setHarness(target, { chosen: true });
      if (action === "sign_in") void startSignIn(target);
    },
    [setHarness, startSignIn],
  );

  // --- Composer notes ------------------------------------------------------------
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

  // One selected generator with a model: offer to look up how to prompt it.
  const researchKey = useWorkflowStore((state) => {
    const target = researchTargetForSelection(state.nodes);
    return target ? JSON.stringify(target) : "";
  });
  const researchTarget = useMemo<AgentResearchTarget | null>(() => (researchKey ? JSON.parse(researchKey) : null), [researchKey]);
  const [savedTips, setSavedTips] = useState<{ key: string; savedAt: string } | null>(null);
  // Read while a surface shows the chip, and again after every turn: a research turn is what saves them.
  useEffect(() => {
    if (!active || !researchTarget || busy) return;
    const controller = new AbortController();
    void fetchPromptNotes(researchTarget.provider, researchTarget.modelId, controller.signal).then((found) => {
      if (!controller.signal.aborted) setSavedTips(found ? { key: researchKey, savedAt: found.savedAt } : null);
    });
    return () => controller.abort();
  }, [active, researchKey, researchTarget, busy]);
  const tipsSavedAt = savedTips?.key === researchKey ? savedTips.savedAt : undefined;

  const notes = useMemo(() => {
    const list: AgentComposerNote[] = [];
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
    if (researchTarget) {
      const name = researchTarget.name ?? researchTarget.modelId;
      const saved = tipsSavedAt
        ? new Date(tipsSavedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })
        : undefined;
      list.push({
        key: "research",
        kind: "action",
        text: saved ? `Refresh prompting tips for ${name}` : `Look up prompting tips for ${name}`,
        title: saved
          ? `Tips saved ${saved}. Searches the web again and replaces them.`
          : "Searches the web for this model's prompting advice and saves it for every chat.",
        onClick: () => send(researchMessage(researchTarget), { research: researchTarget }),
        ...(saved
          ? {
              onDismiss: () => {
                void deletePromptNotes(researchTarget.provider, researchTarget.modelId).then(() => setSavedTips(null));
              },
              dismissLabel: `Forget the saved prompting tips for ${name}`,
            }
          : {}),
      });
    }
    return list;
  }, [selectionCount, messages, harness, clearSelection, researchTarget, tipsSavedAt, send]);

  // --- Showing the canvas ------------------------------------------------------
  const showOnCanvas = useCallback(
    ({ tabId, nodeIds }: AgentCanvasTarget = {}) => {
      const store = useWorkflowStore.getState();
      if (tabId && tabId !== store.activeTabId) {
        // A tab change mid-turn would stop the turn, as any other workflow switch does.
        const refusal = !store.tabs.some((tab) => tab.id === tabId)
          ? "That workflow is no longer open"
          : busy
            ? "Wait for the agent to finish"
            : store.tabsBusyReason();
        if (refusal) {
          useToast.getState().show(refusal, "warning");
          return false;
        }
        if (!store.switchTab(tabId)) return false;
      }
      useAssetStore.getState().setAppView("canvas");
      if (nodeIds && nodeIds.length > 0) focusNodes(nodeIds);
      return true;
    },
    [busy, focusNodes],
  );

  const presenceValue = useMemo<AgentPresenceValue>(() => ({ busy, presence }), [busy, presence]);
  const transcriptActions = useMemo<AgentTranscriptActions>(
    () => ({ chatId, send, showOnCanvas, busy }),
    [chatId, send, showOnCanvas, busy],
  );
  const value: AgentSessionValue = {
    harness,
    setHarness,
    readiness,
    ready,
    mode,
    harnessStatus,
    presence,
    refreshStatus,
    models,
    model,
    modelOption,
    effort,
    chooseModel,
    chooseEffort,
    signInStarting: signIn.starting,
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
    conversations: history.conversations,
    newChat,
    openConversation,
    deleteConversation,
    setWindowOpen,
    setWindowOcclusion,
    showOnCanvas,
  };

  return (
    <AgentPresenceContext.Provider value={presenceValue}>
      <AgentSessionContext.Provider value={value}>
        <AgentTranscriptContext.Provider value={transcriptActions}>{children}</AgentTranscriptContext.Provider>
      </AgentSessionContext.Provider>
    </AgentPresenceContext.Provider>
  );
}

/** The page's agent session. Throws outside AgentSessionProvider. */
export function useAgentSession(): AgentSessionValue {
  const session = useContext(AgentSessionContext);
  if (!session) throw new Error("useAgentSession must be used inside <AgentSessionProvider> (mounted by src/app/page.tsx)");
  return session;
}

/** The transcript cards' session actions, or null outside AgentSessionProvider (the cards then leave them out). */
export function useAgentTranscriptActions(): AgentTranscriptActions | null {
  return useContext(AgentTranscriptContext);
}

/**
 * Whether a turn runs and what the agent button shows, for chrome that must not
 * re-render with every streamed token. Throws outside AgentSessionProvider.
 */
export function useAgentPresence(): AgentPresenceValue {
  const presence = useContext(AgentPresenceContext);
  if (!presence) throw new Error("useAgentPresence must be used inside <AgentSessionProvider> (mounted by src/app/page.tsx)");
  return presence;
}
