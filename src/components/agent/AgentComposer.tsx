"use client";

import { useCallback, useState, type KeyboardEvent, type Ref } from "react";
import type { ChatStatus } from "ai";
import { ArrowLeftRightIcon, SquareDashedMousePointerIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { SelectGroup, SelectLabel } from "@/components/agent/ui/select";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import type { AgentModelOption } from "@/lib/agent/types";
import { AGENT_POPOVER_LAYER } from "./AgentChrome";

export interface AgentComposerProps {
  status: ChatStatus;
  busy: boolean;
  models: AgentModelOption[];
  model?: string;
  onModelChange: (model: string) => void;
  /** Returns false when the message was not sent (empty, or a turn is running). */
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** Context chips above the input (selection, harness switch). */
  notes?: Array<{ key: string; kind: "selection" | "switch"; text: string }>;
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

/** The message box: a real <textarea> (Enter sends, Shift+Enter breaks the line), the model picker and send/stop. */
export function AgentComposer({
  status,
  busy,
  models,
  model,
  onModelChange,
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
    <div className="shrink-0 px-4 pb-4 pt-1">
      {notes.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {notes.map((note) => (
            // Neutral chips, shaped like the dialogs' DialogChip: hairline, small radius, quiet text.
            <span
              key={note.key}
              data-note={note.kind}
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md squircle border border-white/10 px-2 text-[11px] leading-4 text-neutral-400"
            >
              {note.kind === "selection" ? (
                <SquareDashedMousePointerIcon className="size-3 shrink-0 text-neutral-500" aria-hidden="true" strokeWidth={1.75} />
              ) : (
                <ArrowLeftRightIcon className="size-3 shrink-0 text-neutral-500" aria-hidden="true" strokeWidth={1.75} />
              )}
              <span className="truncate">{note.text}</span>
            </span>
          ))}
        </div>
      )}
      <PromptInput
        onSubmit={handleSubmit}
        // The message box is a well, like the dialogs' inputs and the navigator's minimap.
        // Focus lifts its edge instead of drawing a ring: the box has focus whenever the window is open.
        // shadcn fades the whole group when anything in it is disabled (the empty-draft send
        // button, the model picker during a turn): the well stays put and only that control dims.
        groupClassName={
          "rounded-controls squircle border-0 bg-well shadow-well dark:bg-well " +
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
        <PromptInputFooter className="px-1.5 pb-1.5 pt-0">
          <PromptInputTools>
            {models.length > 0 && (
              <PromptInputSelect value={model} onValueChange={onModelChange} disabled={busy}>
                <PromptInputSelectTrigger size="sm" aria-label="Model">
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent className={AGENT_POPOVER_LAYER} position="popper" side="top" align="start" sideOffset={6}>
                  <SelectGroup className="p-0">
                    <SelectLabel className="px-2.5 pb-1 pt-1 font-mono text-[10px] uppercase leading-[14px] tracking-eyebrow text-ink-3">
                      Model
                    </SelectLabel>
                    {models.map((option) => (
                      <PromptInputSelectItem key={option.id} value={option.id}>
                        {option.label}
                      </PromptInputSelectItem>
                    ))}
                  </SelectGroup>
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          {/* Ink square: the dialogs' primary action, at the chrome's control size. */}
          <PromptInputSubmit
            status={busy ? status : "ready"}
            onStop={onStop}
            disabled={!busy && !draft.trim()}
            className={
              "size-7 rounded-lg squircle bg-neutral-200 text-neutral-900 transition-[background-color,color,transform] duration-[120ms] " +
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
