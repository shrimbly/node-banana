"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import { EditOperation } from "@/lib/chat/editOperations";

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onBuildWorkflow?: (description: string) => Promise<void>;
  isBuildingWorkflow?: boolean;
  onApplyEdits?: (operations: EditOperation[]) => { applied: number; skipped: string[] };
  workflowState?: {
    nodes: { id: string; type: string; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }[]
  };
  selectedNodeIds?: string[];
}

export function ChatPanel({ isOpen, onClose, onBuildWorkflow, isBuildingWorkflow = false, onApplyEdits, workflowState, selectedNodeIds }: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [chipDismissed, setChipDismissed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Use a ref so the fetch closure always reads the latest workflowState and selectedNodeIds
  // without needing to re-create the transport
  const workflowStateRef = useRef(workflowState);
  workflowStateRef.current = workflowState;
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  selectedNodeIdsRef.current = selectedNodeIds;

  // Stable fetch function that reads workflowState and selectedNodeIds from ref
  const customFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) {
      return fetch(input, init);
    }

    const body = JSON.parse(init.body as string);
    const bodyWithWorkflow = {
      ...body,
      workflowState: workflowStateRef.current,
      selectedNodeIds: selectedNodeIdsRef.current,
    };

    return fetch(input, {
      ...init,
      body: JSON.stringify(bodyWithWorkflow),
    });
  }, []);

  const [transport] = useState(() => new DefaultChatTransport({ api: "/api/chat", fetch: customFetch }));

  const { messages, sendMessage, setMessages, status } = useChat({
    transport,
    onError: (error) => {
      // Check if this is an oversized payload error (413 or token limit)
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes("413") || errorMsg.includes("too large") || errorMsg.includes("token limit") || errorMsg.includes("payload")) {
        setErrorMessage("This workflow is too large for the AI to process. Try selecting fewer nodes.");
      } else {
        setErrorMessage(error.message);
      }
    },
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Track processed tool calls to avoid re-applying
  const processedToolCalls = useRef<Set<string>>(new Set());

  // Process tool invocations from AI responses
  useEffect(() => {
    messages.forEach((msg) => {
      msg.parts?.forEach((part) => {
        if (!part.type.startsWith("tool-")) return;
        if (!("state" in part) || !("toolCallId" in part) || !("input" in part)) return;
        if (part.state !== "output-available") return;

        const callId = (part as Record<string, unknown>).toolCallId as string;
        if (processedToolCalls.current.has(callId)) return;
        processedToolCalls.current.add(callId);

        const toolName = part.type.replace("tool-", "");
        if (toolName === "createWorkflow" && onBuildWorkflow) {
          const description = ((part as Record<string, unknown>).input as { description?: string }).description;
          if (description) {
            onBuildWorkflow(description);
          }
        }

        if (toolName === "editWorkflow" && onApplyEdits) {
          const operations = ((part as Record<string, unknown>).input as { operations?: EditOperation[] }).operations;
          if (operations) {
            onApplyEdits(operations);
          }
        }
      });
    });
  }, [messages, onBuildWorkflow, onApplyEdits]);

  // Extract conversation description from user messages
  const getConversationDescription = () => {
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => {
        const textContent = m.parts
          ?.filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("") || "";
        return textContent;
      })
      .filter((text) => text.trim().length > 0);

    return userMessages.join("\n");
  };

  const handleBuildWorkflow = async () => {
    if (!onBuildWorkflow) return;

    const description = getConversationDescription();
    if (!description.trim()) return;

    await onBuildWorkflow(description);
  };

  // Check if conversation has started (has assistant messages)
  const hasConversation = messages.some((m) => m.role === "assistant");

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset chip dismissed state when selection changes
  useEffect(() => {
    setChipDismissed(false);
  }, [selectedNodeIds]);

  if (!isOpen) return null;

  return (
    <div className="fixed top-14 bottom-[220px] right-5 w-[380px] bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl flex flex-col overflow-hidden z-40">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
        <h3 className="text-sm font-medium text-neutral-200">Workflow Assistant <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded px-1.5 py-0.5">Beta</span></h3>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-neutral-400 hover:text-neutral-200 transition-colors p-1"
              aria-label="Clear chat"
              title="Clear chat history"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200 transition-colors p-1"
            aria-label="Close chat"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages area - nowheel class prevents React Flow from intercepting scroll */}
      <div
        className="nowheel flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
        style={{ touchAction: 'pan-y' }}
        onWheelCapture={(e) => e.stopPropagation()}
      >
        {/* Error message display */}
        {errorMessage && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-200">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <p>{errorMessage}</p>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-xs text-red-300 hover:text-red-100 underline mt-2"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {messages.length === 0 && !errorMessage && (
          <div className="text-center text-neutral-500 text-sm py-8">
            <p>Ask me anything about creating workflows!</p>
            <p className="text-xs mt-2">e.g., &quot;How do I create product photos with different backgrounds?&quot;</p>
          </div>
        )}

        {messages.map((message) => {
          // Extract text from message parts
          const textContent = message.parts
            ?.filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("") || "";

          // Extract tool invocations for display
          const toolInvocations = message.parts
            ?.filter((part) => {
              if (!part.type.startsWith("tool-")) return false;
              if (!("state" in part)) return false;
              return part.state === "output-available";
            }) || [];

          return (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-700 text-neutral-200"
                }`}
              >
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap">{textContent}</p>
                ) : (
                  <>
                    {/* Display tool invocation explanations */}
                    {toolInvocations.map((tool, idx) => {
                      if (!("input" in tool)) return null;
                      const toolName = tool.type.replace("tool-", "");
                      if (toolName === "editWorkflow") {
                        const explanation = (tool.input as { explanation?: string }).explanation;
                        if (explanation) {
                          return (
                            <div key={idx} className="mb-2 text-green-300 text-xs italic">
                              {explanation}
                            </div>
                          );
                        }
                      }
                      if (toolName === "createWorkflow") {
                        return (
                          <div key={idx} className="mb-2 text-blue-300 text-xs italic">
                            Building workflow...
                          </div>
                        );
                      }
                      return null;
                    })}

                    {/* Display text content */}
                    {textContent && (
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold text-neutral-100">{children}</strong>,
                          em: ({ children }) => <em className="italic">{children}</em>,
                          ul: ({ children }) => <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-1">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-1">{children}</ol>,
                          li: ({ children }) => <li>{children}</li>,
                          blockquote: ({ children }) => <blockquote className="border-l-2 border-neutral-500 pl-2 my-2 text-neutral-300 italic">{children}</blockquote>,
                          code: ({ children }) => <code className="bg-neutral-600 px-1 rounded text-xs">{children}</code>,
                        }}
                      >
                        {textContent}
                      </ReactMarkdown>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-neutral-700 rounded-lg px-3 py-2">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-neutral-700">
        {/* Selection focus chip */}
        {selectedNodeIds && selectedNodeIds.length > 0 && !chipDismissed && (
          <div className="px-3 pt-3">
            <div className="flex items-center gap-2 bg-neutral-700/50 border border-neutral-600 rounded-lg px-3 py-1.5 text-xs text-neutral-300">
              <span>Focused on {selectedNodeIds.length} selected node{selectedNodeIds.length !== 1 ? 's' : ''}</span>
              <button
                onClick={() => setChipDismissed(true)}
                className="text-neutral-400 hover:text-neutral-200 transition-colors"
                aria-label="Dismiss"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !isLoading) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
          className="p-3"
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-blue-500"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </form>

        {/* Build Workflow button */}
        {hasConversation && onBuildWorkflow && (
          <div className="px-3 pb-3">
            <button
              onClick={handleBuildWorkflow}
              disabled={isBuildingWorkflow || isLoading}
              className="w-full bg-green-600 hover:bg-green-500 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isBuildingWorkflow ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Building...</span>
                </>
              ) : (
                <span>Build Workflow</span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
