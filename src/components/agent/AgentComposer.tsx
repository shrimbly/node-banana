"use client";

import { useCallback, useState, type KeyboardEvent, type Ref } from "react";
import type { ChatStatus } from "ai";
import { ArrowLeftRightIcon, BrainIcon, CheckIcon, ChevronDownIcon, SquareDashedMousePointerIcon, XIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/components/agent/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/agent/ui/dropdown-menu";
import { MenuSectionLabel, menuItemClass, menuSurfaceClass } from "@/components/ui/Menu";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import { AGENT_POPOVER_LAYER } from "./AgentChrome";

export interface AgentComposerNote {
  key: string;
  kind: "selection" | "switch";
  text: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export interface AgentComposerProps {
  status: ChatStatus;
  busy: boolean;
  /** The chosen model's thinking-effort levels, lowest first. Empty: no effort control. */
  efforts?: string[];
  effort?: string;
  /** The level the model runs at unless the user picks another (marked in the menu). */
  defaultEffort?: string;
  onEffortChange?: (effort: string) => void;
  /** Returns false when the message was not sent (empty, or a turn is running). */
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** Context chips beside send (selection, harness switch); a chip with onDismiss gets an ×. */
  notes?: AgentComposerNote[];
  textareaRef?: Ref<HTMLTextAreaElement>;
  /**
   * The unsent message, when the parent keeps it: the panel swaps the composer
   * for a sign-in card when the harness isn't ready, and the draft must survive
   * that. Without it the composer keeps its own.
   */
  draft?: string;
  onDraftChange?: (draft: string) => void;
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

/** How hard the model thinks: a quiet button beside send, opening the levels the model offers. */
function EffortPicker({
  efforts,
  effort,
  defaultEffort,
  disabled,
  onChange,
}: {
  efforts: string[];
  effort: string;
  defaultEffort?: string;
  disabled: boolean;
  onChange: (effort: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Thinking effort: ${effortLabel(effort)}`}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 self-end rounded-lg squircle px-2 text-[12px] leading-4 text-neutral-400 outline-none",
          "transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-neutral-200 data-[state=open]:bg-white/[0.08] data-[state=open]:text-neutral-200",
          "focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent",
        )}
      >
        <BrainIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        {effortLabel(effort)}
        <ChevronDownIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className={cn(menuSurfaceClass, AGENT_POPOVER_LAYER, "w-48 bg-card p-1 text-neutral-300 shadow-menu ring-0")}
      >
        <MenuSectionLabel className="px-2.5 pb-1 pt-1.5">Thinking effort</MenuSectionLabel>
        <DropdownMenuRadioGroup value={effort} onValueChange={onChange}>
          {efforts.map((level) => (
            <DropdownMenuRadioItem
              key={level}
              value={level}
              className={cn(
                menuItemClass,
                "relative cursor-default rounded-sm outline-none select-none",
                "focus:bg-neutral-700 focus:text-neutral-100 data-highlighted:bg-neutral-700 data-highlighted:text-neutral-100",
                "[&>span[data-slot=dropdown-menu-radio-item-indicator]]:hidden",
              )}
            >
              <span className="flex-1">{effortLabel(level)}</span>
              {level === defaultEffort && (
                <span className="font-mono text-[10px] uppercase tracking-eyebrow text-ink-3">Default</span>
              )}
              {level === effort ? (
                <CheckIcon className="size-3.5 shrink-0 text-neutral-200" strokeWidth={2} aria-hidden="true" />
              ) : (
                <span className="size-3.5 shrink-0" aria-hidden="true" />
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agent takes no attachments: let the browser paste the text part of a mixed clipboard. */
const pasteTextOnly = () => {};

/** The message box: a real <textarea> (Enter sends, Shift+Enter breaks the line), context chips and send/stop. */
export function AgentComposer({
  status,
  busy,
  efforts = [],
  effort,
  defaultEffort,
  onEffortChange,
  onSend,
  onStop,
  notes = [],
  textareaRef,
  draft: parentDraft,
  onDraftChange,
}: AgentComposerProps) {
  const [ownDraft, setOwnDraft] = useState("");
  const parentKeepsDraft = parentDraft !== undefined && onDraftChange !== undefined;
  const draft = parentKeepsDraft ? parentDraft : ownDraft;
  const setDraft = parentKeepsDraft ? onDraftChange : setOwnDraft;

  const handleSubmit = useCallback(
    ({ text }: { text: string }) => {
      if (onSend(text)) setDraft("");
    },
    [onSend, setDraft],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && isImeKeyEvent(event)) {
        // An Enter that commits an IME conversion never sends. Mid-composition the
        // prompt input already ignores it; Safari ends the composition before this
        // keydown arrives, so claim that one here or it would send a half-typed message.
        if (!event.nativeEvent.isComposing) event.preventDefault();
        return;
      }
      // While a turn runs the submit button is "Stop"; Enter must not queue another message.
      if (busy && event.key === "Enter" && !event.shiftKey) event.preventDefault();
    },
    [busy],
  );

  return (
    // The minimal well, 8px inside the window's edge.
    <div className="shrink-0 p-2">
      <PromptInput
        onSubmit={handleSubmit}
        // Focus lifts the well's edge instead of drawing a ring: the box has focus whenever the window is open.
        // shadcn fades the whole group when anything in it is disabled (the empty-draft send
        // button): the well stays put and only that control dims.
        groupClassName={
          "rounded-[10px] squircle border-0 bg-well shadow-well dark:bg-well " +
          "has-disabled:bg-well has-disabled:opacity-100 dark:has-disabled:bg-well " +
          "has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-white/15"
        }
      >
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            // Replaces the prompt input's handler, which would take any file on the
            // clipboard as a (hidden, never sent) attachment and swallow the text with it.
            onPaste={pasteTextOnly}
            placeholder="Describe a workflow, or a change to this one…"
            aria-label="Message the agent"
            className="max-h-40 min-h-11 px-3 pb-1 pt-2.5 text-[13px] leading-5 text-neutral-100 placeholder:text-neutral-500 md:text-[13px]"
          />
        </PromptInputBody>
        <PromptInputFooter className="gap-2 pb-2 pl-3 pr-2 pt-0">
          {/* Context chips (selection, harness switch) share the row with send. */}
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {notes.map((note) => (
              <span
                key={note.key}
                data-note={note.kind}
                title={note.text}
                className="inline-flex h-[22px] min-w-0 max-w-full items-center gap-1.5 rounded-md squircle bg-white/[0.07] pl-[7px] pr-2 text-[11px] leading-4 text-neutral-300 has-[button]:pr-1"
              >
                {note.kind === "selection" ? (
                  <SquareDashedMousePointerIcon className="size-3 shrink-0 text-neutral-400" aria-hidden="true" strokeWidth={1.75} />
                ) : (
                  <ArrowLeftRightIcon className="size-3 shrink-0 text-neutral-400" aria-hidden="true" strokeWidth={1.75} />
                )}
                <span className="truncate">{note.text}</span>
                {note.onDismiss && (
                  <button
                    type="button"
                    aria-label={note.dismissLabel ?? `Remove ${note.text}`}
                    onClick={note.onDismiss}
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
                  >
                    <XIcon className="size-2.5" strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {efforts.length > 0 && effort && onEffortChange && (
            <EffortPicker
              efforts={efforts}
              effort={effort}
              defaultEffort={defaultEffort}
              disabled={busy}
              onChange={onEffortChange}
            />
          )}
          {/* Ink circle: the window's one primary action. */}
          <PromptInputSubmit
            status={busy ? status : "ready"}
            onStop={onStop}
            disabled={!busy && !draft.trim()}
            className={
              "size-[30px] shrink-0 self-end rounded-full bg-neutral-200 text-neutral-900 transition-[background-color,color,transform] duration-[120ms] " +
              "hover:bg-white active:not-aria-[haspopup]:translate-y-0 active:scale-[0.96] " +
              "focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-well " +
              "disabled:bg-white/8 disabled:text-neutral-500 disabled:opacity-100"
            }
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
