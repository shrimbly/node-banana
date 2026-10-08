"use client";

import { useCallback, useState, type KeyboardEvent, type Ref } from "react";
import type { ChatStatus } from "ai";
import {
  ArrowLeftRightIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  GlobeIcon,
  PencilIcon,
  SquareDashedMousePointerIcon,
  XIcon,
} from "lucide-react";
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
import { useAgentSurface } from "./AgentSurface";
import type { AgentQueuedMessage } from "./hooks/useAgentChat";

export interface AgentComposerNote {
  key: string;
  kind: "selection" | "switch" | "action";
  text: string;
  /** Tooltip; the text itself when absent. */
  title?: string;
  /** An "action" chip is a button that does this (disabled while a turn runs). */
  onClick?: () => void;
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
  /** Sends, or queues while a turn runs. Returns false when the message was not taken (empty). */
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
  /** Messages waiting for the running turn, shown above the box. */
  queued?: AgentQueuedMessage[];
  /** The queue waits for the user (the last turn was stopped or failed): offer "Send now". */
  queueHeld?: boolean;
  onEditQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  onSendQueuedNow?: () => void;
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
  page,
  onChange,
}: {
  efforts: string[];
  effort: string;
  defaultEffort?: string;
  disabled: boolean;
  /** Sized for the chat view's composer: as tall as its send button. */
  page: boolean;
  onChange: (effort: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Thinking effort: ${effortLabel(effort)}`}
        className={cn(
          "flex shrink-0 items-center gap-1 self-end rounded-lg squircle text-neutral-400 outline-none",
          // Size and leading together: in the class merge a later font size drops an earlier leading.
          page ? "h-8 px-2.5 text-[13px] leading-4" : "h-7 px-2 text-[12px] leading-4",
          "transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-neutral-200 data-[state=open]:bg-white/[0.08] data-[state=open]:text-neutral-200",
          "focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent",
        )}
      >
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

const queuedIconButtonClass =
  "flex size-6 shrink-0 items-center justify-center rounded-md squircle text-neutral-500 transition-colors duration-[120ms] " +
  "hover:bg-white/10 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection";

/**
 * Messages typed while a turn ran, on a flap tucked behind the top of the well:
 * one line each, editable (back into the box) or removable until they go.
 * A clock marks each at rest; hover or focus swaps it for edit and remove.
 */
function QueuedMessages({
  queued,
  held,
  page,
  onEdit,
  onRemove,
  onSendNow,
}: {
  queued: AgentQueuedMessage[];
  held: boolean;
  page: boolean;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
  onSendNow?: () => void;
}) {
  return (
    <section
      aria-label={`Queued messages (${queued.length})`}
      // The well overlaps the flap by its own corner radius, so its rounded top corners sit on the flap.
      className={cn(
        "relative z-0 squircle border border-b-0 border-white/6 bg-black/15",
        page ? "-mb-6 rounded-t-[20px] pb-7 pt-1.5 text-[13px] leading-5" : "-mb-2.5 rounded-t-[10px] pb-3.5 pt-1 text-[12px] leading-4",
      )}
    >
      {held && onSendNow && (
        <div className={cn("flex items-center gap-2 text-neutral-400", page ? "h-8 pl-4 pr-2" : "h-7 pl-3 pr-1.5")}>
          <span className="flex-1">Paused · these wait for you</span>
          <button
            type="button"
            onClick={onSendNow}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md squircle bg-white/[0.08] px-2 text-neutral-200 transition-colors duration-[120ms] hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            <ArrowUpIcon className="size-3" strokeWidth={2} aria-hidden="true" />
            Send now
          </button>
        </div>
      )}
      <ul>
        {queued.map((entry) => (
          <li
            key={entry.id}
            className={cn(
              "group/queued flex items-center gap-1 rounded-md squircle text-neutral-400 transition-colors duration-[120ms] hover:bg-white/5 focus-within:bg-white/5",
              page ? "mx-2 h-8 pl-2 pr-1" : "mx-1 h-7 pl-2 pr-0.5",
            )}
          >
            <span className="min-w-0 flex-1 truncate" title={entry.text}>
              {entry.text}
            </span>
            {/* At rest a clock; on hover or focus (and always on touch) the actions. */}
            <span
              aria-hidden="true"
              className="flex w-6 shrink-0 justify-center text-neutral-600 group-hover/queued:hidden group-focus-within/queued:hidden pointer-coarse:hidden"
            >
              <ClockIcon className="size-3" strokeWidth={1.75} />
            </span>
            <span className="hidden shrink-0 group-hover/queued:flex group-focus-within/queued:flex pointer-coarse:flex">
              {onEdit && (
                <button
                  type="button"
                  aria-label={`Edit queued message: ${entry.text}`}
                  onClick={() => onEdit(entry.id)}
                  className={queuedIconButtonClass}
                >
                  <PencilIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  aria-label={`Remove queued message: ${entry.text}`}
                  onClick={() => onRemove(entry.id)}
                  className={queuedIconButtonClass}
                >
                  <XIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The agent takes no attachments: let the browser paste the text part of a mixed clipboard. */
const pasteTextOnly = () => {};

/**
 * The message box: a real <textarea> (Enter sends, or queues while a turn runs;
 * Shift+Enter breaks the line), context chips, send/stop and the queued messages.
 */
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
  queued = [],
  queueHeld = false,
  onEditQueued,
  onRemoveQueued,
  onSendQueuedNow,
}: AgentComposerProps) {
  // The chat view's composer is the page's one control: larger type, a roomier box, the same behaviour.
  const page = useAgentSurface() === "page";
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
      }
      // Otherwise Enter submits, also while a turn runs: the button is then
      // "Stop" (not a submit button), and onSend queues the message.
    },
    [],
  );

  return (
    // The minimal well, 8px inside the window's edge; on the page, the column places it.
    <div className={page ? "shrink-0" : "shrink-0 p-2"}>
      {queued.length > 0 && (
        <QueuedMessages
          queued={queued}
          held={queueHeld && !busy}
          page={page}
          onEdit={onEditQueued}
          onRemove={onRemoveQueued}
          onSendNow={onSendQueuedNow}
        />
      )}
      <PromptInput
        onSubmit={handleSubmit}
        // Focus lifts the well's edge instead of drawing a ring: the box has focus whenever the window is open.
        // shadcn fades the whole group when anything in it is disabled (the empty-draft send
        // button): the well stays put and only that control dims.
        // relative z-[1]: it sits over the queue's flap.
        // On the page the box is raised off the canvas colour instead (card-coloured, a hairline):
        // a recess would vanish into a page that dark.
        groupClassName={
          page
            ? "relative z-[1] rounded-[24px] squircle border border-white/[0.06] bg-card dark:bg-card " +
              "shadow-[0_1px_2px_rgba(0,0,0,0.25),0_12px_32px_-12px_rgba(0,0,0,0.5)] " +
              "has-disabled:bg-card has-disabled:opacity-100 dark:has-disabled:bg-card " +
              "transition-[border-color] duration-[120ms] has-[[data-slot=input-group-control]:focus-visible]:border-white/[0.12]"
            : "relative z-[1] rounded-[10px] squircle border-0 bg-well shadow-well dark:bg-well " +
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
            placeholder={busy ? "Queue a message…" : "Describe a workflow, or a change to this one…"}
            aria-label="Message the agent"
            className={
              page
                ? "max-h-[min(40vh,320px)] min-h-[52px] px-4 pb-1 pt-3.5 text-[15px] leading-6 text-neutral-100 placeholder:text-neutral-500 md:text-[15px]"
                : "max-h-40 min-h-11 px-3 pb-1 pt-2.5 text-[13px] leading-5 text-neutral-100 placeholder:text-neutral-500 md:text-[13px]"
            }
          />
        </PromptInputBody>
        <PromptInputFooter className={page ? "gap-2 pb-2.5 pl-4 pr-2.5 pt-1" : "gap-2 pb-2 pl-3 pr-2 pt-0"}>
          {/* Context chips (selection, harness switch) share the row with send. */}
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {notes.map((note) => (
              <span
                key={note.key}
                data-note={note.kind}
                title={note.title ?? note.text}
                className={cn(
                  "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md squircle bg-white/[0.07] pl-[7px] pr-2 text-neutral-300 has-[button[aria-label]]:pr-1",
                  page ? "h-6 text-[12px] leading-4" : "h-[22px] text-[11px] leading-4",
                )}
              >
                {note.kind === "selection" ? (
                  <SquareDashedMousePointerIcon className="size-3 shrink-0 text-neutral-400" aria-hidden="true" strokeWidth={1.75} />
                ) : note.kind === "action" ? (
                  <GlobeIcon className="size-3 shrink-0 text-neutral-400" aria-hidden="true" strokeWidth={1.75} />
                ) : (
                  <ArrowLeftRightIcon className="size-3 shrink-0 text-neutral-400" aria-hidden="true" strokeWidth={1.75} />
                )}
                {note.onClick ? (
                  <button
                    type="button"
                    onClick={note.onClick}
                    disabled={busy}
                    className="truncate rounded-sm text-left transition-colors hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:text-neutral-500"
                  >
                    {note.text}
                  </button>
                ) : (
                  <span className="truncate">{note.text}</span>
                )}
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
              page={page}
              onChange={onEffortChange}
            />
          )}
          {/* Ink circle: the window's one primary action. */}
          <PromptInputSubmit
            status={busy ? status : "ready"}
            onStop={onStop}
            disabled={!busy && !draft.trim()}
            className={
              "shrink-0 self-end rounded-full bg-neutral-200 text-neutral-900 transition-[background-color,color,transform] duration-[120ms] " +
              "hover:bg-white active:not-aria-[haspopup]:translate-y-0 active:scale-[0.96] " +
              "focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 " +
              (page ? "size-8 focus-visible:ring-offset-card " : "size-[30px] focus-visible:ring-offset-well ") +
              "disabled:bg-white/8 disabled:text-neutral-500 disabled:opacity-100"
            }
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
