"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatStatus, type DataUIPart } from "ai";
import { useWorkflowStore } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";
import { AGENT_CHAT_API } from "@/lib/agent/client/api";
import { countRenderedParts } from "@/lib/agent/client/messages";
import { HARNESS_LABELS } from "@/lib/agent/client/readiness";
import { agentProviderHeaders, buildAgentChatRequestBody, whenProviderKeysReady } from "@/lib/agent/client/request";
import { plannedRunNodeIds, trackStartedRun } from "@/lib/agent/client/runs";
import { saveLiveWorkflow } from "@/lib/agent/client/save";
import { AGENT_OPENING_STATUS } from "@/lib/agent/types";
import type {
  AgentDataParts,
  AgentGraphOpBatch,
  AgentHarnessId,
  AgentMessageMetadata,
  AgentUIMessage,
  AgentWorkflowSnapshot,
  AgentWorkspaceOp,
} from "@/lib/agent/types";

type AgentDataPart = DataUIPart<AgentDataParts>;

/** How long a tab step waits for a save or a media write to finish before it gives up. */
const TAB_WAIT_MS = 10_000;
const TAB_POLL_MS = 100;

export interface AgentStatusLine {
  text: string;
  /** Rendered parts of the reply when the line arrived; it hides once more appear. */
  renderedParts: number;
}

/** A message typed while a turn ran, waiting to go as the next turn. */
export interface AgentQueuedMessage {
  id: string;
  text: string;
  /** Sent with the message when its turn starts (a research turn's target). */
  metadata?: AgentMessageMetadata;
}

export interface UseAgentChatOptions {
  harness: AgentHarnessId;
  model?: string;
  effort?: string;
  /** The visible canvas area in flow coordinates, read at send time. */
  getViewport: () => AgentWorkflowSnapshot["viewport"];
  /** Called after a batch of canvas changes landed, to bring it into view. */
  onBatchApplied?: (batch: AgentGraphOpBatch) => void;
  /** A persisted notice arrived (sign-in needed, usage limit, ...). */
  onNotice?: (notice: AgentDataParts["agent-notice"]) => void;
}

export interface UseAgentChatResult {
  messages: AgentUIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  /** A turn is being submitted or streamed. */
  busy: boolean;
  statusLine: AgentStatusLine | null;
  /** Messages after which the user pressed stop. */
  stoppedMessageIds: ReadonlySet<string>;
  /**
   * Sends the message, or queues it while a turn runs. False only for an empty
   * message. `metadata` rides on the user's message (a research turn's target).
   */
  send: (text: string, metadata?: AgentMessageMetadata) => boolean;
  /** Messages waiting for the running turn to end, oldest first. Never persisted. */
  queued: AgentQueuedMessage[];
  /**
   * The last turn was stopped or failed with messages still queued: they wait
   * for the user (sendQueuedNow) instead of going on their own.
   */
  queueHeld: boolean;
  removeQueued: (id: string) => void;
  /** Removes a queued message and returns its text (to edit it in the composer). */
  takeQueued: (id: string) => string | undefined;
  /** Sends the first queued message now, and lets the rest follow it. */
  sendQueuedNow: () => void;
  stop: () => void;
  retry: () => void;
  clearError: () => void;
  newChat: () => void;
  /** The current conversation's id (its key in the history). */
  chatId: string;
  openConversation: (saved: { id: string; messages: AgentUIMessage[] }) => void;
  /** The tab the latest turn worked on: the one it was sent from, or where its own tab steps took it. */
  turnTabId?: () => string;
  /** Settles once every step the turns so far queued has landed (a tab switch waiting on a save, say). */
  stepsSettled?: () => Promise<void>;
}

interface ChatCallbacks {
  onData: (part: AgentDataPart) => void;
  onFinish: (event: { message: AgentUIMessage; messages: AgentUIMessage[]; isAbort: boolean; isError: boolean }) => void;
  onError: (error: Error) => void;
}

/**
 * The agent conversation: an AI SDK chat against /api/agent/chat whose request
 * carries the live canvas, and whose `data-graph-ops` parts are applied to the
 * workflow store as they stream in (one undo step per batch).
 *
 * A turn belongs to the canvas it was sent from. When another workflow is
 * opened (or the canvas cleared) mid-turn, the turn is stopped and any of its
 * edits still arriving are dropped: their node ids meant the old canvas, and
 * applying them would silently rewrite the new one. The turn's own tab steps
 * (switching to an open workflow, opening a new one) move it along instead;
 * batches apply one after another in stream order, each step (a save
 * included) finished before the next.
 */
export function useAgentChat({
  harness,
  model,
  effort,
  getViewport,
  onBatchApplied,
  onNotice,
}: UseAgentChatOptions): UseAgentChatResult {
  // Read at request time, so the transport can stay the same object across renders.
  const requestRef = useRef({ harness, model, effort, getViewport });
  requestRef.current = { harness, model, effort, getViewport };
  const handlersRef = useRef({ onBatchApplied, onNotice });
  handlersRef.current = { onBatchApplied, onNotice };

  const [statusLine, setStatusLine] = useState<AgentStatusLine | null>(null);
  const [stoppedMessageIds, setStoppedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [queued, setQueued] = useState<AgentQueuedMessage[]>([]);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const [queueHeld, setQueueHeld] = useState(false);
  // Bumped by each turn that ends normally; the queue sends one message per bump.
  // Decided in onFinish, which knows how the turn ended, and sent from an effect:
  // the chat is still closing the turn while onFinish runs.
  const [turnsFinished, setTurnsFinished] = useState(0);
  const releasedTurnRef = useRef(0);
  const queueIdRef = useRef(0);
  // The store's canvasGeneration the current turn was sent from (or its own last tab step moved it to).
  const turnGenerationRef = useRef(useWorkflowStore.getState().canvasGeneration);
  // The tab the current turn was sent from (or its own last tab step moved it to); a user's switch leaves it.
  const turnTabRef = useRef(useWorkflowStore.getState().activeTabId);
  // The canvas the queued messages were written about.
  const queueGenerationRef = useRef(turnGenerationRef.current);
  // Bumped per turn; a turn whose step was refused drops the rest of its batches.
  const turnRef = useRef(0);
  // The canvasGeneration each turn was sent from (or its own last tab step moved it to): a turn's
  // queued steps fit only that canvas, even once a later turn is under way on another.
  const turnGenerationsRef = useRef(new Map<number, number>());
  // Every turn up to this one was stopped (the Stop button, or the conversation left): a run they
  // asked for must not start after that, even when it is still queued behind an earlier step.
  const stoppedThroughRef = useRef(0);
  const haltedTurnRef = useRef(-1);
  const stepsRef = useRef<Promise<void>>(Promise.resolve());
  // Lets a request waiting on the previous turn's steps go at once when the user presses Stop.
  const releaseWaitRef = useRef<(() => void) | null>(null);

  const callbacksRef = useRef<ChatCallbacks | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AgentUIMessage>({
        api: AGENT_CHAT_API,
        prepareSendMessagesRequest: async ({ id, messages, headers }) => {
          // The previous turn's queued steps (a tab switch waiting on a save) land
          // first: the request describes the canvas they leave live. Stop doesn't wait for them.
          await Promise.race([stepsRef.current, new Promise<void>((resolve) => (releaseWaitRef.current = resolve))]);
          releaseWaitRef.current = null;
          const {
            harness: currentHarness,
            model: currentModel,
            effort: currentEffort,
            getViewport: readViewport,
          } = requestRef.current;
          const {
            nodes,
            edges,
            groups,
            workflowName,
            canvasGeneration,
            isRunning,
            batch,
            tabs,
            activeTabId,
            hasUnsavedChanges,
            saveDirectoryPath,
          } = useWorkflowStore.getState();
          // Which workflow this is, so a Run offer the turn makes is never run on another loaded into the tab.
          const workflowId = useWorkflowStore.getState().ensureWorkflowId();
          // The snapshot below is this generation's canvas: the turn's edits only fit it.
          turnGenerationRef.current = canvasGeneration;
          turnGenerationsRef.current.set(turnRef.current, canvasGeneration);
          turnTabRef.current = activeTabId;
          const body = buildAgentChatRequestBody({
            chatId: id,
            messages,
            harness: currentHarness,
            model: currentModel,
            effort: currentEffort,
            // Between the runs of a batch isRunning is briefly false; the batch is still going.
            canvas: { nodes, edges, groups, workflowName, workflowId, running: isRunning || batch !== null },
            viewport: readViewport(),
            strip: { tabs, activeTabId, hasUnsavedChanges, saveDirectoryPath },
          });
          // The user's provider keys, so the agent can search and set models
          // from every provider they have one for (read after any desktop
          // keychain load, like the nodes).
          await whenProviderKeysReady();
          return {
            body,
            // The transport has no headers of its own today (they arrive as a plain record); keep any.
            headers: { ...(headers as Record<string, string> | undefined), ...agentProviderHeaders(useWorkflowStore.getState()) },
          };
        },
      }),
    [],
  );

  // Callbacks of a chat replaced by "New chat" (e.g. its abort) are dropped.
  const activeChatRef = useRef<Chat<AgentUIMessage> | null>(null);
  const createChat = useCallback((saved?: { id: string; messages: AgentUIMessage[] }) => {
    const instance: Chat<AgentUIMessage> = new Chat<AgentUIMessage>({
      ...(saved ? { id: saved.id, messages: saved.messages } : {}),
      transport,
      onData: (part) => {
        if (activeChatRef.current === instance) callbacksRef.current?.onData(part);
      },
      onFinish: (event) => {
        if (activeChatRef.current === instance) callbacksRef.current?.onFinish(event);
      },
      onError: (error) => {
        if (activeChatRef.current === instance) callbacksRef.current?.onError(error);
      },
    });
    return instance;
  }, [transport]);
  const [chat, setChat] = useState(() => createChat());
  activeChatRef.current = chat;
  const { messages, status, error, sendMessage, stop, regenerate, clearError } = useChat<AgentUIMessage>({ chat });

  /** Stops the turn after one of its steps was refused: what follows assumed it had happened. */
  const haltTurn = useCallback((turn: number, chatId: string, message: string) => {
    haltedTurnRef.current = turn;
    useToast.getState().show(message, "warning");
    // A turn that already ended has nothing left to stop; the one running now is another's.
    if (turn === turnRef.current && activeChatRef.current?.id === chatId) void activeChatRef.current.stop();
  }, []);

  /** Canvas edits (and a run) for the live tab. */
  const applyGraphBatch = useCallback(
    (batch: AgentGraphOpBatch, turn: number, chatId: string) => {
      const store = useWorkflowStore.getState();
      if (batch.tabId && batch.tabId !== store.activeTabId) {
        haltTurn(turn, chatId, "Stopped the agent: its changes were for a workflow that isn't the open tab");
        return;
      }
      // Edits buffered before a stop still land; a run would spend the user's credits after they said stop.
      const applying = turn <= stoppedThroughRef.current ? { ...batch, ops: batch.ops.filter((op) => op.op !== "run") } : batch;
      let result: ReturnType<typeof store.applyAgentGraphOps>;
      try {
        result = store.applyAgentGraphOps(applying);
      } catch (applyError) {
        const detail = applyError instanceof Error ? applyError.message : String(applyError);
        console.error("[agent] applying canvas changes failed", applyError);
        useToast.getState().show("Couldn't apply the agent's changes to the canvas", "error", false, detail);
        return;
      }
      if (result.skipped.length > 0) {
        const count = result.skipped.length;
        useToast
          .getState()
          .show(
            `${count} agent change${count === 1 ? "" : "s"} couldn't be applied — the canvas changed meanwhile`,
            "warning",
            false,
            result.skipped.join("\n"),
          );
      }
      if (result.runRefused) useToast.getState().show(`The agent's run didn't start: ${lowerFirst(result.runRefused)}`, "warning");
      if (result.runStarted && result.run) {
        const live = useWorkflowStore.getState();
        trackStartedRun({
          chatId,
          anchor: { toolCallId: batch.toolCallId },
          label: batch.summary,
          scope: result.run.scope,
          runs: result.run.runs,
          tabId: live.activeTabId,
          // run_workflow's batch names the nodes the agent checked.
          plannedNodeIds: plannedRunNodeIds(result.run.scope, live, batch.focusNodeIds),
        });
      }
      if (result.applied > 0) handlersRef.current.onBatchApplied?.(batch);
    },
    [haltTurn],
  );

  /**
   * Waits while only a save or a media write keeps tabs from changing (a run
   * refuses at once). The reason it gave up, or null when tabs may change;
   * "stale" when the canvas was replaced meanwhile.
   */
  const whenTabsFree = useCallback(async (turn: number): Promise<string | null | "stale"> => {
    const generation = generationOf(turnGenerationsRef, turnGenerationRef, turn);
    const deadline = Date.now() + TAB_WAIT_MS;
    for (;;) {
      const state = useWorkflowStore.getState();
      if (state.canvasGeneration !== generation || haltedTurnRef.current === turn || turn <= stoppedThroughRef.current) return "stale";
      if (state.isRunning || state.batch) return "Wait for the run to finish";
      const busy = state.tabsBusyReason();
      if (!busy) return null;
      if (Date.now() >= deadline) return busy;
      await new Promise((resolve) => setTimeout(resolve, TAB_POLL_MS));
    }
  }, []);

  /** A switch, a new tab or a save, as the agent's switch_workflow / new_workflow / save_workflow asked. */
  const applyWorkspaceStep = useCallback(
    async (batch: AgentGraphOpBatch, step: AgentWorkspaceOp, turn: number, chatId: string) => {
      if (step.op === "save") {
        if (batch.tabId && batch.tabId !== useWorkflowStore.getState().activeTabId) {
          haltTurn(turn, chatId, "Stopped the agent: the workflow it meant to save isn't the open tab");
          return;
        }
        const saved = await saveLiveWorkflow(step.name);
        if (saved.ok) useToast.getState().show(`Saved ${saved.name}`, "info");
        else useToast.getState().show(saved.reason, "warning");
        return;
      }
      if (step.op === "switchTab" && useWorkflowStore.getState().activeTabId === step.tabId) return;
      const what = step.op === "switchTab" ? "switch workflows" : "open a new workflow";
      const refusal = await whenTabsFree(turn);
      if (refusal === "stale" || haltedTurnRef.current === turn) return;
      if (refusal) {
        haltTurn(turn, chatId, `Stopped the agent: it couldn't ${what} (${lowerFirst(refusal)})`);
        return;
      }
      const store = useWorkflowStore.getState();
      const done =
        step.op === "switchTab"
          ? store.switchTab(step.tabId)
          : store.newTab({ id: step.tabId, ...(step.name ? { name: step.name } : {}) }) !== null;
      if (!done) {
        const reason =
          store.tabsBusyReason() ?? (step.op === "switchTab" ? "that workflow is no longer open" : "the tab couldn't be opened");
        haltTurn(turn, chatId, `Stopped the agent: it couldn't ${what} (${lowerFirst(reason)})`);
        return;
      }
      // The turn's own tab change: it and the queue carry on, on the canvas it brought in.
      const { canvasGeneration: generation, activeTabId } = useWorkflowStore.getState();
      // A later turn waiting to send builds its request after this step, about this canvas.
      turnGenerationsRef.current.set(turn, generation);
      turnGenerationsRef.current.set(turnRef.current, generation);
      turnGenerationRef.current = generation;
      queueGenerationRef.current = generation;
      turnTabRef.current = activeTabId;
    },
    [haltTurn, whenTabsFree],
  );

  const applyStep = useCallback(
    async (batch: AgentGraphOpBatch, turn: number, chatId: string) => {
      if (haltedTurnRef.current === turn) return;
      // Planned against a canvas that has since been replaced (checked per batch:
      // chunks already buffered still arrive after the turn is stopped, or once a later turn began).
      if (useWorkflowStore.getState().canvasGeneration !== generationOf(turnGenerationsRef, turnGenerationRef, turn)) return;
      if (batch.workspace) await applyWorkspaceStep(batch, batch.workspace, turn, chatId);
      else applyGraphBatch(batch, turn, chatId);
    },
    [applyGraphBatch, applyWorkspaceStep],
  );

  /** Queues a batch behind the ones before it, so a tab or save step finishes before the next batch applies. */
  const applyBatch = useCallback(
    (batch: AgentGraphOpBatch) => {
      const turn = turnRef.current;
      const chatId = activeChatRef.current?.id ?? "";
      stepsRef.current = stepsRef.current
        .then(() => applyStep(batch, turn, chatId))
        .catch((stepError) => console.error("[agent] applying a step failed", stepError));
    },
    [applyStep],
  );

  callbacksRef.current = {
    onData: (part) => {
      switch (part.type) {
        case "data-graph-ops":
          applyBatch(part.data);
          // The edit the status line announced has landed.
          setStatusLine(null);
          break;
        case "data-agent-status":
          setStatusLine(
            part.data.text ? { text: part.data.text, renderedParts: countRenderedParts(chat.messages) } : null,
          );
          break;
        case "data-agent-notice":
          handlersRef.current.onNotice?.(part.data);
          break;
        default:
          break;
      }
    },
    onFinish: ({ message, messages: finished, isAbort, isError }) => {
      setStatusLine(null);
      if (isAbort || isError) {
        // Whatever was queued no longer follows on its own: the user decides.
        if (queuedRef.current.length > 0) setQueueHeld(true);
      } else {
        setTurnsFinished((count) => count + 1);
      }
      if (!isAbort) return;
      // Stopped before any reply arrived: mark the user's message instead.
      const anchor = finished.some((m) => m.id === message.id) ? message.id : finished.at(-1)?.id;
      if (anchor) setStoppedMessageIds((previous) => new Set(previous).add(anchor));
    },
    onError: () => setStatusLine(null),
  };

  const busy = status === "submitted" || status === "streaming";

  const beginTurn = useCallback(() => {
    // Also stamped when the request is built; set now so the check below never
    // compares a new turn against the previous turn's canvas.
    turnGenerationRef.current = useWorkflowStore.getState().canvasGeneration;
    turnRef.current += 1;
    turnGenerationsRef.current.set(turnRef.current, turnGenerationRef.current);
    // Older turns' entries are no longer read once their steps have landed.
    for (const old of turnGenerationsRef.current.keys()) if (old < turnRef.current - 8) turnGenerationsRef.current.delete(old);
    setStatusLine(null);
  }, []);

  /** Every turn so far is over: a run any of them still has queued must not start. */
  const stopAllTurns = useCallback(() => {
    stoppedThroughRef.current = Math.max(stoppedThroughRef.current, turnRef.current);
    releaseWaitRef.current?.();
  }, []);

  // Another workflow was opened (or the canvas cleared) while a turn runs: stop
  // it rather than let it edit, and spend the user's plan on, a canvas it never saw.
  const canvasGeneration = useWorkflowStore((state) => state.canvasGeneration);
  useEffect(() => {
    if (!busy || canvasGeneration === turnGenerationRef.current) return;
    void chat.stop();
    useToast.getState().show("Stopped the agent: a different workflow was opened", "warning");
  }, [busy, canvasGeneration, chat]);

  const clearQueue = useCallback(() => {
    setQueued([]);
    setQueueHeld(false);
  }, []);

  // Queued messages were written about the canvas that was open: a new one drops them.
  useEffect(() => {
    if (canvasGeneration === queueGenerationRef.current) return;
    queueGenerationRef.current = canvasGeneration;
    clearQueue();
  }, [canvasGeneration, clearQueue]);

  // Another harness picks up the conversation: the queue was for the old one.
  const queueHarnessRef = useRef(harness);
  useEffect(() => {
    if (harness === queueHarnessRef.current) return;
    queueHarnessRef.current = harness;
    const count = queuedRef.current.length;
    if (count === 0) return;
    clearQueue();
    useToast
      .getState()
      .show(
        `Cleared ${count === 1 ? "the queued message" : `${count} queued messages`}: switched to ${HARNESS_LABELS[harness]}`,
        "info",
      );
  }, [harness, clearQueue]);

  // The server sends the opening line only once its checks pass; show it from
  // the moment the turn is sent so the panel doesn't say "Thinking…" first.
  const showOpeningLine = useCallback(() => {
    setStatusLine({ text: AGENT_OPENING_STATUS, renderedParts: 0 });
  }, []);

  const startTurn = useCallback(
    (text: string, metadata?: AgentMessageMetadata) => {
      beginTurn();
      showOpeningLine();
      void sendMessage(metadata ? { text, metadata } : { text });
    },
    [beginTurn, showOpeningLine, sendMessage],
  );

  const send = useCallback(
    (text: string, metadata?: AgentMessageMetadata) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (busy) {
        // The server refuses a second turn on a chat that has one running: wait for it.
        // A hold left by an earlier stop belongs to messages that are gone.
        if (queuedRef.current.length === 0) setQueueHeld(false);
        queueIdRef.current += 1;
        const entry: AgentQueuedMessage = { id: `queued-${queueIdRef.current}`, text: trimmed, ...(metadata ? { metadata } : {}) };
        setQueued((previous) => [...previous, entry]);
        return true;
      }
      startTurn(trimmed, metadata);
      return true;
    },
    [busy, startTurn],
  );

  // A turn ended normally: the next queued message goes, one per finished turn.
  useEffect(() => {
    if (busy || queueHeld || turnsFinished === releasedTurnRef.current) return;
    releasedTurnRef.current = turnsFinished;
    const [next, ...rest] = queued;
    if (!next) return;
    setQueued(rest);
    startTurn(next.text, next.metadata);
  }, [busy, queueHeld, turnsFinished, queued, startTurn]);

  const removeQueued = useCallback((id: string) => {
    setQueued((previous) => {
      const rest = previous.filter((entry) => entry.id !== id);
      if (rest.length === 0) setQueueHeld(false);
      return rest;
    });
  }, []);

  const takeQueued = useCallback(
    (id: string) => {
      const entry = queuedRef.current.find((candidate) => candidate.id === id);
      if (entry) removeQueued(id);
      return entry?.text;
    },
    [removeQueued],
  );

  const sendQueuedNow = useCallback(() => {
    const [next, ...rest] = queuedRef.current;
    if (busy || !next) return;
    // A turn that ended while the queue was held must not send a second message beside this one.
    releasedTurnRef.current = turnsFinished;
    setQueueHeld(false);
    setQueued(rest);
    startTurn(next.text, next.metadata);
  }, [busy, turnsFinished, startTurn]);

  const retry = useCallback(() => {
    if (busy) return;
    beginTurn();
    showOpeningLine();
    void regenerate();
  }, [busy, beginTurn, showOpeningLine, regenerate]);

  const newChat = useCallback(() => {
    // What the conversation being left still has queued (a run behind a slow save) is not for the next one.
    stopAllTurns();
    if (busy) {
      haltedTurnRef.current = turnRef.current;
      void chat.stop();
    }
    clearQueue();
    beginTurn();
    setStoppedMessageIds(new Set());
    setChat(createChat());
  }, [busy, beginTurn, chat, createChat, clearQueue, stopAllTurns]);

  /** Carry on a past conversation: its messages, and its chat id (the harness session resumes from them). */
  const openConversation = useCallback(
    (saved: { id: string; messages: AgentUIMessage[] }) => {
      if (busy) return;
      stopAllTurns();
      clearQueue();
      beginTurn();
      setStoppedMessageIds(new Set());
      setChat(createChat(saved));
    },
    [busy, beginTurn, createChat, clearQueue, stopAllTurns],
  );

  // Leaving the canvas (unmount) must not leave a CLI turn running on the server.
  useEffect(() => () => void activeChatRef.current?.stop(), []);

  const turnTabId = useCallback(() => turnTabRef.current, []);
  const stepsSettled = useCallback(() => stepsRef.current, []);

  return {
    messages,
    status,
    error,
    busy,
    statusLine,
    stoppedMessageIds,
    send,
    queued,
    queueHeld: queueHeld && queued.length > 0,
    removeQueued,
    takeQueued,
    sendQueuedNow,
    stop: () => {
      stopAllTurns();
      void stop();
    },
    retry,
    clearError,
    newChat,
    chatId: chat.id,
    openConversation,
    turnTabId,
    stepsSettled,
  };
}

/** The canvas a turn's steps fit: its own, else (a turn begun before this was tracked) the current turn's. */
function generationOf(byTurn: { current: Map<number, number> }, current: { current: number }, turn: number): number {
  return byTurn.current.get(turn) ?? current.current;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
