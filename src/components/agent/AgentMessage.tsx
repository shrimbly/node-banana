"use client";

import { memo, type ReactNode } from "react";
import type { DynamicToolUIPart } from "ai";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput } from "@/components/ai-elements/tool";
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
  if (isStreaming || duration === 0) {
    return (
      <Shimmer as="span" duration={1}>
        Thinking…
      </Shimmer>
    );
  }
  if (duration === undefined) return <span>Thought for a few seconds</span>;
  return <span>Thought for {duration === 1 ? "1 second" : `${duration} seconds`}</span>;
}

function AgentToolRow({ part }: { part: DynamicToolUIPart }) {
  const state = toolDisplayState(part);
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={state}
        toolName={part.toolName}
        title={toolDisplayTitle(part)}
        summary={toolSummaryLine(part)}
      />
      <ToolContent>
        {/* Height-capped: tool inputs (whole workflows) can be long. */}
        <ToolInput input={part.input} />
      </ToolContent>
    </Tool>
  );
}

/** Consecutive tool calls read as one ruled list, like a settings page's rows. */
function ToolRows({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-white/[0.06] border-y border-white/[0.06]">{children}</div>
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
      <Message from="user" className="max-w-[85%]">
        <MessageContent className="whitespace-pre-wrap break-words">
          {text}
        </MessageContent>
      </Message>
    );
  }

  // Runs of tool calls are drawn together; everything else in order, one per part.
  const blocks: ReactNode[] = [];
  let toolRun: ReactNode[] = [];
  const flushTools = () => {
    if (toolRun.length) blocks.push(<ToolRows key={`tools-${blocks.length}`}>{toolRun}</ToolRows>);
    toolRun = [];
  };
  message.parts.forEach((part, index) => {
    if (!isRenderedPart(part)) return;
    const key = `${message.id}-${index}`;
    if (part.type === "dynamic-tool") {
      toolRun.push(<AgentToolRow key={key} part={part} />);
      return;
    }
    flushTools();
    switch (part.type) {
      case "text":
        blocks.push(
          <MessageResponse key={key} isAnimating={streaming && part.state === "streaming"}>
            {part.text}
          </MessageResponse>,
        );
        break;
      case "reasoning":
        // Closed unless opened: the model's working notes are a click away, not the default view.
        blocks.push(
          <Reasoning key={key} isStreaming={streaming && part.state === "streaming"} defaultOpen={false} className="mb-0">
            <ReasoningTrigger getThinkingMessage={thinkingLabel} />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>,
        );
        break;
      case "data-agent-notice":
        blocks.push(<AgentNotice key={key} notice={part.data} onSignIn={onSignIn} />);
        break;
    }
  });
  flushTools();

  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3">{blocks}</MessageContent>
    </Message>
  );
});
