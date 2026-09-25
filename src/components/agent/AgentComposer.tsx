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
    <div className="shrink-0 border-t border-neutral-700 bg-neutral-800 p-3 pt-2.5">
      {notes.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {notes.map((note) => (
            <span
              key={note.key}
              className={
                note.kind === "selection"
                  ? "inline-flex max-w-full items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] leading-4 text-blue-200"
                  : "inline-flex max-w-full items-center gap-1.5 rounded-full border border-neutral-600 bg-neutral-900/60 px-2 py-0.5 text-[11px] leading-4 text-neutral-300"
              }
            >
              {note.kind === "selection" ? (
                <SquareDashedMousePointerIcon className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <ArrowLeftRightIcon className="size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{note.text}</span>
            </span>
          ))}
        </div>
      )}
      <PromptInput onSubmit={handleSubmit} className="[&_[data-slot=input-group]]:bg-neutral-900/50">
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
            className="max-h-40 min-h-12 px-3 text-sm placeholder:text-neutral-500"
          />
        </PromptInputBody>
        <PromptInputFooter className="px-1.5 pb-1.5">
          <PromptInputTools>
            {models.length > 0 && (
              <PromptInputSelect value={model} onValueChange={onModelChange} disabled={busy}>
                <PromptInputSelectTrigger size="sm" aria-label="Model" className="h-7 px-2 text-xs">
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent className={AGENT_POPOVER_LAYER} position="popper" side="top" align="start">
                  {models.map((option) => (
                    <PromptInputSelectItem key={option.id} value={option.id} className="text-xs">
                      {option.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <PromptInputSubmit
            status={busy ? status : "ready"}
            onStop={onStop}
            disabled={!busy && !draft.trim()}
            className="size-7 rounded-md"
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
