"use client";

import { useState, useCallback, useEffect, useId, useRef } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import {
  DialogButton,
  DialogChip,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageFooter,
  DialogPageHead,
  DialogPageTitle,
  DialogPane,
  DialogStatus,
  DialogTextButton,
  DialogWordmark,
} from "@/components/ui/Dialog";
import { inputClass } from "@/components/ui/Controls";
import { cn } from "@/components/nodes/ui/cn";
import { APP_VERSION } from "@/lib/appVersion";
import { QuickstartBackButton } from "./QuickstartBackButton";

interface PromptWorkflowViewProps {
  onBack: () => void;
  onWorkflowGenerated: (workflow: WorkflowFile) => void;
}

/**
 * "Prompt a workflow": the identity pane (mark, version, wordmark and the
 * three mono points) beside a page with the description well and one
 * primary action.
 */
export function PromptWorkflowView({
  onBack,
  onWorkflowGenerated,
}: PromptWorkflowViewProps) {
  const [description, setDescription] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  // Track mount status and the in-flight request so that closing/unmounting
  // the modal cancels the generation and never clobbers the current canvas.
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!description || description.trim().length < 3) {
      setError("Please describe your workflow (at least 3 characters)");
      return;
    }

    setError(null);
    setIsGenerating(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/quickstart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          contentLevel: "full",
        }),
        signal: abortController.signal,
      });

      const result = await response.json();

      // Bail out if the component unmounted or the request was aborted while
      // awaiting — never load a stale workflow over the user's canvas.
      if (!isMountedRef.current || abortController.signal.aborted) {
        return;
      }

      if (!result.success) {
        throw new Error(result.error || "Failed to generate workflow");
      }

      if (result.workflow) {
        onWorkflowGenerated(result.workflow);
      }
    } catch (err) {
      // Ignore abort errors and any error after unmount.
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        !isMountedRef.current ||
        abortController.signal.aborted
      ) {
        return;
      }
      console.error("Prompt workflow error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to generate workflow"
      );
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      if (isMountedRef.current) {
        setIsGenerating(false);
      }
    }
  }, [description, onWorkflowGenerated]);

  const canGenerate = description.trim().length >= 3 && !isGenerating;

  return (
    <>
      <DialogPane width={300}>
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center justify-between">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/banana_icon.png" alt="" className="w-8 h-8 rounded-lg" />
            {APP_VERSION && <DialogEyebrow className="text-neutral-500">{APP_VERSION}</DialogEyebrow>}
          </div>
          <QuickstartBackButton onClick={onBack} disabled={isGenerating} />
        </div>
        <div>
          <DialogWordmark />
          <ul className="mt-[18px] flex flex-col gap-1">
            <li><DialogEyebrow>Free</DialogEyebrow></li>
            <li><DialogEyebrow>Open source</DialogEyebrow></li>
            <li><DialogEyebrow>Bring your own key</DialogEyebrow></li>
          </ul>
        </div>
      </DialogPane>

      <DialogPage>
        <DialogPageHead eyebrow="Prompt a Workflow" />
        <DialogPageTitle
          size="md"
          heading={
            <>
              <span id={headingId}>Describe your workflow</span>
              <DialogChip>Beta</DialogChip>
            </>
          }
          lead="Say what it should accomplish. Be specific about inputs, outputs and any transformations."
        />

        <DialogPageBody className="flex flex-col gap-2.5 pb-0">
          <textarea
            aria-labelledby={headingId}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setError(null);
            }}
            placeholder="e.g., Create product photography with consistent lighting and style from reference images..."
            disabled={isGenerating}
            rows={5}
            className={cn(inputClass, "h-[132px] p-3 resize-none leading-[19px] disabled:cursor-not-allowed")}
          />
          <DialogStatus tone="neutral" className="text-neutral-500">
            Gemini models only, for now
          </DialogStatus>

          {error && (
            <div className="flex items-center justify-between gap-3">
              <DialogStatus tone="error" className="normal-case tracking-normal text-neutral-300 min-w-0">
                <span className="truncate">{error}</span>
              </DialogStatus>
              <DialogTextButton onClick={() => setError(null)}>Dismiss</DialogTextButton>
            </div>
          )}
        </DialogPageBody>

        <DialogPageFooter>
          <DialogButton variant="primary" size="md" onClick={handleGenerate} disabled={!canGenerate}>
            {isGenerating ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Generating...</span>
              </>
            ) : (
              <span>Generate workflow</span>
            )}
          </DialogButton>
        </DialogPageFooter>
      </DialogPage>
    </>
  );
}
