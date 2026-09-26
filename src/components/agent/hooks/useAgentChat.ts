"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatStatus, type DataUIPart } from "ai";
import { useWorkflowStore } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";
import { AGENT_CHAT_API } from "@/lib/agent/client/api";
import { countRenderedParts } from "@/lib/agent/client/messages";
import { agentProviderHeaders, buildAgentChatRequestBody, whenProviderKeysReady } from "@/lib/agent/client/request";
import type {
  AgentDataParts,
  AgentGraphOpBatch,
  AgentHarnessId,
  AgentUIMessage,
  AgentWorkflowSnapshot,
} from "@/lib/agent/types";

type AgentDataPart = DataUIPart<AgentDataParts>;

export interface AgentStatusLine {
  text: string;
  /** Rendered parts of the reply when the line arrived; it hides once more appear. */
  renderedParts: number;
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
  send: (text: string) => boolean;
  stop: () => void;
  retry: () => void;
  clearError: () => void;
  newChat: () => void;
}

interface ChatCallbacks {
  onData: (part: AgentDataPart) => void;
  onFinish: (event: { message: AgentUIMessage; messages: AgentUIMessage[]; isAbort: boolean }) => void;
  onError: (error: Error) => void;
}

/**
 * The agent conversation: an AI SDK chat against /api/agent/chat whose request
 * carries the live canvas, and whose `data-graph-ops` parts are applied to the
 * workflow store as they stream in (one undo step per batch; the first batch
 * of a turn is also the "Revert AI Changes" point).
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
  // Whether this turn already captured the revert snapshot.
  const revertCapturedRef = useRef(false);
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
          const { nodes, edges, groups, workflowName, canvasGeneration } = useWorkflowStore.getState();
          // The snapshot below is this generation's canvas: the turn's edits only fit it.
          turnGenerationRef.current = canvasGeneration;
          const body = buildAgentChatRequestBody({
            chatId: id,
            messages,
            harness: currentHarness,
            model: currentModel,
            effort: currentEffort,
            canvas: { nodes, edges, groups, workflowName },
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
  const createChat = useCallback(() => {
    const instance: Chat<AgentUIMessage> = new Chat<AgentUIMessage>({
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
  const [chat, setChat] = useState(createChat);
  activeChatRef.current = chat;
  const { messages, status, error, sendMessage, stop, regenerate, clearError } = useChat<AgentUIMessage>({ chat });

  const applyBatch = useCallback((batch: AgentGraphOpBatch) => {
    // Planned against a canvas that has since been replaced (checked per batch:
    // chunks already buffered still arrive after the turn is stopped).
    if (useWorkflowStore.getState().canvasGeneration !== turnGenerationRef.current) return;
    let result: { applied: number; skipped: string[] };
    try {
      result = useWorkflowStore
        .getState()
        .applyAgentGraphOps(batch, { revertPoint: !revertCapturedRef.current });
    } catch (applyError) {
      const detail = applyError instanceof Error ? applyError.message : String(applyError);
      console.error("[agent] applying canvas changes failed", applyError);
      useToast.getState().show("Couldn't apply the agent's changes to the canvas", "error", false, detail);
      return;
    }
    if (result.applied > 0) revertCapturedRef.current = true;
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
    onFinish: ({ message, messages: finished, isAbort }) => {
      setStatusLine(null);
      if (!isAbort) return;
      // Stopped before any reply arrived: mark the user's message instead.
      const anchor = finished.some((m) => m.id === message.id) ? message.id : finished.at(-1)?.id;
      if (anchor) setStoppedMessageIds((previous) => new Set(previous).add(anchor));
    },
    onError: () => setStatusLine(null),
  };

  const busy = status === "submitted" || status === "streaming";

  const beginTurn = useCallback(() => {
    revertCapturedRef.current = false;
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

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return false;
      beginTurn();
      void sendMessage({ text: trimmed });
      return true;
    },
    [busy, beginTurn, sendMessage],
  );

  const retry = useCallback(() => {
    if (busy) return;
    beginTurn();
    void regenerate();
  }, [busy, beginTurn, regenerate]);

  const newChat = useCallback(() => {
    if (busy) void chat.stop();
    beginTurn();
    setStoppedMessageIds(new Set());
    setChat(createChat());
  }, [busy, beginTurn, chat, createChat]);

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
    stop: () => void stop(),
    retry,
    clearError,
    newChat,
  };
}
