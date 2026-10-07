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
import { AGENT_OPENING_STATUS } from "@/lib/agent/types";
import type {
  AgentDataParts,
  AgentGraphOpBatch,
  AgentHarnessId,
  AgentMessageMetadata,
  AgentUIMessage,
  AgentWorkflowSnapshot,
} from "@/lib/agent/types";

type AgentDataPart = DataUIPart<AgentDataParts>;

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
 * applying them would silently rewrite the new one.
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
  // The store's canvasGeneration the current turn was sent from.
  const turnGenerationRef = useRef(useWorkflowStore.getState().canvasGeneration);

  const callbacksRef = useRef<ChatCallbacks | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<AgentUIMessage>({
        api: AGENT_CHAT_API,
        prepareSendMessagesRequest: async ({ id, messages, headers }) => {
          const {
            harness: currentHarness,
            model: currentModel,
            effort: currentEffort,
            getViewport: readViewport,
          } = requestRef.current;
          const { nodes, edges, groups, workflowName, canvasGeneration, isRunning, batch } = useWorkflowStore.getState();
          // The snapshot below is this generation's canvas: the turn's edits only fit it.
          turnGenerationRef.current = canvasGeneration;
          const body = buildAgentChatRequestBody({
            chatId: id,
            messages,
            harness: currentHarness,
            model: currentModel,
            effort: currentEffort,
            // Between the runs of a batch isRunning is briefly false; the batch is still going.
            canvas: { nodes, edges, groups, workflowName, running: isRunning || batch !== null },
            viewport: readViewport(),
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

  const applyBatch = useCallback((batch: AgentGraphOpBatch) => {
    // Planned against a canvas that has since been replaced (checked per batch:
    // chunks already buffered still arrive after the turn is stopped).
    if (useWorkflowStore.getState().canvasGeneration !== turnGenerationRef.current) return;
    let result: { applied: number; skipped: string[] };
    try {
      result = useWorkflowStore.getState().applyAgentGraphOps(batch);
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
    if (result.applied > 0) handlersRef.current.onBatchApplied?.(batch);
  }, []);

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
    setStatusLine(null);
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
  const queueGenerationRef = useRef(canvasGeneration);
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
    if (busy) void chat.stop();
    clearQueue();
    beginTurn();
    setStoppedMessageIds(new Set());
    setChat(createChat());
  }, [busy, beginTurn, chat, createChat, clearQueue]);

  /** Carry on a past conversation: its messages, and its chat id (the harness session resumes from them). */
  const openConversation = useCallback(
    (saved: { id: string; messages: AgentUIMessage[] }) => {
      if (busy) return;
      clearQueue();
      beginTurn();
      setStoppedMessageIds(new Set());
      setChat(createChat(saved));
    },
    [busy, beginTurn, createChat, clearQueue],
  );

  // Leaving the canvas (unmount) must not leave a CLI turn running on the server.
  useEffect(() => () => void activeChatRef.current?.stop(), []);

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
    stop: () => void stop(),
    retry,
    clearError,
    newChat,
    chatId: chat.id,
    openConversation,
  };
}
