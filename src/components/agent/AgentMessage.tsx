"use client";

import { memo } from "react";
import type { DynamicToolUIPart } from "ai";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput } from "@/components/ai-elements/tool";
import { cn } from "@/components/agent/lib/utils";
import { isRenderedPart, toolDisplayState, toolDisplayTitle, toolSummaryLine } from "@/lib/agent/client/messages";
import type { AgentUIMessage } from "@/lib/agent/types";
import { AgentNotice, type AgentNoticeSignIn } from "./AgentNotice";

export interface AgentMessageProps {
  message: AgentUIMessage;
  /** This message is the reply still streaming in. */
  streaming: boolean;
  onSignIn?: AgentNoticeSignIn;
}

function thinkingLabel(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking…</Shimmer>;
  if (duration === undefined) return <span>Thought for a few seconds</span>;
  return <span>Thought for {duration === 1 ? "1 second" : `${duration} seconds`}</span>;
}

function AgentToolCard({ part }: { part: DynamicToolUIPart }) {
  const state = toolDisplayState(part);
  const summary = toolSummaryLine(part);
  const failed = state === "output-error";
  return (
    <Tool className="mb-0 border-neutral-700 bg-neutral-900/40">
      <ToolHeader
        type="dynamic-tool"
        state={state}
        toolName={part.toolName}
        title={toolDisplayTitle(part)}
        className="gap-2 px-3 py-2"
      />
      {summary && (
        <p className={cn("-mt-0.5 px-3 pb-2 text-xs leading-5", failed ? "text-red-300" : "text-neutral-400")}>
          {summary}
        </p>
      )}
      <ToolContent className="space-y-3 border-t border-neutral-700 p-3">
        {/* Compact, height-capped JSON: tool inputs (whole workflows) can be long. */}
        <ToolInput
          input={part.input}
          className="[&_code]:text-[11px] [&_code]:leading-4 [&_pre]:max-h-56 [&_pre]:overflow-auto [&_pre]:p-3"
        />
      </ToolContent>
    </Tool>
  );
}

/** One chat message: user text in a bubble; for the agent, text, reasoning, tool calls and notices in order. */
export const AgentMessage = memo(function AgentMessage({ message, streaming, onSignIn }: AgentMessageProps) {
  if (message.role === "user") {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return (
      <Message from="user">
        <MessageContent className="whitespace-pre-wrap break-words px-3 py-2 group-[.is-user]:px-3 group-[.is-user]:py-2">
          {text}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3">
        {message.parts.map((part, index) => {
          if (!isRenderedPart(part)) return null;
          const key = `${message.id}-${index}`;
          switch (part.type) {
            case "text":
              return (
                <MessageResponse key={key} isAnimating={streaming && part.state === "streaming"}>
                  {part.text}
                </MessageResponse>
              );
            case "reasoning":
              // Closed unless opened: the model's working notes are a click away, not the default view.
              return (
                <Reasoning
                  key={key}
                  isStreaming={streaming && part.state === "streaming"}
                  defaultOpen={false}
                  className="mb-0"
                >
                  <ReasoningTrigger className="text-xs" getThinkingMessage={thinkingLabel} />
                  <ReasoningContent className="mt-2 text-xs">{part.text}</ReasoningContent>
                </Reasoning>
              );
            case "dynamic-tool":
              return <AgentToolCard key={key} part={part} />;
            case "data-agent-notice":
              return <AgentNotice key={key} notice={part.data} onSignIn={onSignIn} />;
            default:
              return null;
          }
        })}
      </MessageContent>
    </Message>
  );
});
