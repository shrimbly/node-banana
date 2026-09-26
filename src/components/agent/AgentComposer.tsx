"use client";

import { useCallback, useState, type KeyboardEvent, type Ref } from "react";
import type { ChatStatus } from "ai";
import { ArrowLeftRightIcon, SquareDashedMousePointerIcon, XIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";

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

/** The agent takes no attachments: let the browser paste the text part of a mixed clipboard. */
const pasteTextOnly = () => {};

/** The message box: a real <textarea> (Enter sends, Shift+Enter breaks the line), context chips and send/stop. */
export function AgentComposer({
  status,
  busy,
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
    // The minimal well, 4px inside the window's edge (its 10px corners run concentric with the window's 12px).
    <div className="shrink-0 p-1">
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
