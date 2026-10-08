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
  /** The result or error, after the title on the same line. */
  summary?: ReactNode;
  /**
   * Small buttons at the row's right edge, outside the toggle (a click on one
   * never opens the row). They show on hover or focus, always on touch.
   */
  actions?: ReactNode;
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

/**
 * The status only where it says something: a pulsing dot while the call
 * runs, a red one when it failed. A finished call shows nothing; screen
 * readers hear the word either way.
 */
export const ToolStatus = ({ state, className }: { state: ToolPart["state"]; className?: string }) => {
  const running = state === "input-available" || state === "input-streaming";
  const failed = state === "output-error" || state === "output-denied";
  return (
    <span data-agent-tool-status={state} className={cn("inline-flex shrink-0 items-center", className)}>
      {running && (
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-neutral-300 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-neutral-300" />
        </span>
      )}
      {failed && <span aria-hidden="true" className="size-1.5 rounded-full bg-error" />}
      <span className="sr-only">{statusLabels[state]}</span>
    </span>
  );
};

export const getStatusBadge = (status: ToolPart["state"]) => <ToolStatus state={status} />;

/**
 * One line per call: its name, then what came of it (an error in red), then
 * its status mark while it runs or after it failed. Marks sit at the end, so
 * nothing moves when a call finishes; the chevron shows on hover and while open.
 */
export const ToolHeader = ({
  className,
  title,
  summary,
  actions,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const failed = state === "output-error" || state === "output-denied";

  const trigger = (
    <CollapsibleTrigger
      className={cn(
        // Text sits on the message's edge; the hover wash reaches 6px past it.
        "-mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-1.5 rounded-md squircle px-1.5 py-1 text-left text-[13px] leading-[18px] transition-colors duration-[120ms] hover:bg-white/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        // Room for the actions at the end, and the wash stays while the pointer is on one.
        actions ? "pr-9 group-hover/tool-row:bg-white/5" : undefined,
        className
      )}
      {...props}
    >
      <span className="max-w-full shrink-0 truncate font-medium text-neutral-300">{title ?? derivedName}</span>
      {summary && <span className={cn("min-w-0 truncate", failed ? "text-red-400" : "text-ink-3")}>{summary}</span>}
      <ToolStatus state={state} className="ml-0.5" />
      <ChevronRightIcon
        aria-hidden="true"
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-neutral-500 opacity-0 transition-[opacity,transform] duration-150 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 group-data-[state=open]/tool:rotate-90 group-data-[state=open]/tool:opacity-100 motion-reduce:transition-none"
      />
    </CollapsibleTrigger>
  );
  if (!actions) return trigger;

  return (
    <div className="group/tool-row relative">
      {trigger}
      {/* Centred on the line, at its right edge. Nothing hovers on a touch screen: there they always show. */}
      <div
        data-tool-actions=""
        className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover/tool-row:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      >
        {actions}
      </div>
    </div>
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
