"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/agent/ui/collapsible";
import { cn } from "@/components/agent/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

/**
 * A tool call as a ruled row, in the split dialogs' language: the title, a
 * mono status eyebrow at the right, the one-line result under it, and the
 * call's input in a mono well when opened. Restyled from AI Elements' card.
 */

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    data-agent-tool=""
    className={cn("group/tool not-prose w-full", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  /** The result or error, one line under the title. */
  summary?: ReactNode;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Waiting",
  "approval-responded": "Approved",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Done",
  "output-denied": "Denied",
  "output-error": "Failed",
};

/** Mono status eyebrow. A dot only where it says something: running (pulsing ink), failed (red). */
export const ToolStatus = ({ state }: { state: ToolPart["state"] }) => {
  const running = state === "input-available" || state === "input-streaming";
  const failed = state === "output-error" || state === "output-denied";
  return (
    <span
      data-agent-tool-status={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase leading-4 tracking-eyebrow",
        running || failed ? "text-neutral-300" : "text-ink-3"
      )}
    >
      {running && (
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-neutral-300 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-neutral-300" />
        </span>
      )}
      {failed && <span aria-hidden="true" className="size-1.5 rounded-full bg-error" />}
      {statusLabels[state]}
    </span>
  );
};

export const getStatusBadge = (status: ToolPart["state"]) => <ToolStatus state={status} />;

export const ToolHeader = ({
  className,
  title,
  summary,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        // Text sits 8px in from the message column; the hover wash reaches 6px past it.
        "-mx-1.5 flex w-[calc(100%+12px)] flex-col rounded-md squircle py-2 pr-1.5 pl-3.5 text-left transition-colors duration-[120ms] hover:bg-white/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        className
      )}
      {...props}
    >
      <span className="flex w-full items-center gap-3">
        {/* The chevron follows the title: open/closed reads where the eye already is. */}
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate font-medium text-[13px] text-neutral-100 leading-5">
            {title ?? derivedName}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-3.5 shrink-0 text-neutral-500 transition-transform duration-150 group-data-[state=open]/tool:rotate-90"
          />
        </span>
        <ToolStatus state={state} />
      </span>
      {summary && <span className="text-neutral-400 text-xs leading-[18px]">{summary}</span>}
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "space-y-3 pb-3 pl-2 outline-none",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none",
      className
    )}
    {...props}
  />
);

/** Mono text in a well: a tool's input or output. */
const ToolWell = ({ label, children, className }: { label: string; children: ReactNode; className?: string }) => (
  <div className={cn("space-y-1.5", className)}>
    <div className="font-mono text-[10px] text-ink-3 uppercase leading-4 tracking-eyebrow">{label}</div>
    <pre className="max-h-56 overflow-auto whitespace-pre rounded-well bg-well p-3 font-mono text-[11px] text-neutral-300 leading-4 shadow-well">
      {children}
    </pre>
  </div>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) =>
  input === undefined ? null : (
    <div className={cn("overflow-hidden", className)} {...props}>
      <ToolWell label="Input">{JSON.stringify(input, null, 2)}</ToolWell>
    </div>
  );

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let text: ReactNode = errorText;
  if (!errorText) {
    if (isValidElement(output)) text = output;
    else if (typeof output === "string") text = output;
    else text = JSON.stringify(output, null, 2);
  }

  return (
    <div className={cn("overflow-hidden", className)} {...props}>
      <ToolWell label={errorText ? "Error" : "Result"}>{text}</ToolWell>
    </div>
  );
};
