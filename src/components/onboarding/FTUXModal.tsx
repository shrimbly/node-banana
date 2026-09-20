"use client";

import {
  Dialog,
  DialogButton,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageFooter,
  DialogPageHead,
  DialogPageTitle,
  DialogPane,
  DialogWordmark,
  splitPanelClass,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
import { useState } from "react";
import { FTUXModalProps, FTUXStep } from "@/types/ftux";
import { setFTUXCompleted } from "@/store/utils/localStorage";
import { isDesktop } from "@/lib/desktop/credentials";
import { FTUXWelcomeStep } from "./FTUXWelcomeStep";
import { FTUXApiKeysStep } from "./FTUXApiKeysStep";
import { FTUXModelDefaultsStep } from "./FTUXModelDefaultsStep";
import { FTUXReadyStep } from "./FTUXReadyStep";

const STEPS: readonly FTUXStep[] = [1, 2, 3, 4];

/** Rail label, page heading and lead for each step, as drawn on the design canvas. */
const STEP_COPY: Record<FTUXStep, { rail: string; heading: string; lead: string }> = {
  1: {
    rail: "Welcome",
    heading: "Let's get started.",
    lead: "Connect AI models like building blocks to generate images, videos, and more.",
  },
  2: {
    rail: "API keys",
    heading: "API keys",
    lead: "",
  },
  3: {
    rail: "Model defaults",
    heading: "Choose your models",
    lead: "Pick your default AI models for images and videos. You can change these later.",
  },
  4: {
    rail: "Ready",
    heading: "You're ready!",
    lead: "Want a quick tutorial?",
  },
};

/**
 * First use is a split dialog: the pane carries the mark, the wordmark and
 * the four steps as a static rail; the page carries one step at a time. It
 * cannot be dismissed — the X asks before skipping.
 */
export function FTUXModal({ onComplete, onStartTutorial }: FTUXModalProps) {
  const [currentStep, setCurrentStep] = useState<FTUXStep>(1);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  const handleNext = () => {
    if (currentStep === 4) {
      // Last step - user chose "Skip Tutorial"
      setFTUXCompleted(true);
      onComplete();
    } else {
      setCurrentStep((currentStep + 1) as FTUXStep);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as FTUXStep);
    }
  };

  const handleSkip = () => {
    setFTUXCompleted(true);
    onComplete();
  };

  const handleStartTutorial = () => {
    setFTUXCompleted(true);
    onStartTutorial();
  };

  const copy = STEP_COPY[currentStep];
  const lead =
    currentStep === 2
      ? isDesktop()
        ? "Add keys to use AI providers. Keys are encrypted and saved in your desktop profile."
        : "Add keys here to use AI providers (stored in browser), or configure them in your server environment."
      : copy.lead;

  return (
    <Dialog
      open
      className={cn(splitPanelClass, "w-[760px] h-[540px] max-w-[92vw] max-h-[85vh]")}
    >
      <DialogPane width={240}>
        <div className="flex flex-col gap-[22px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/banana_icon.png" alt="" className="w-8 h-8 rounded-lg" />
          <DialogWordmark size={34} />
        </div>
        <div>
          <DialogEyebrow className="block mb-1.5 text-neutral-500">Setup</DialogEyebrow>
          <ol aria-label="Setup steps">
            {STEPS.map((step) => (
              <StepRailItem
                key={step}
                label={STEP_COPY[step].rail}
                state={step < currentStep ? "done" : step === currentStep ? "current" : "later"}
              />
            ))}
          </ol>
        </div>
      </DialogPane>

      <DialogPage>
        <DialogPageHead
          eyebrow={`Step ${currentStep} of 4`}
          closeButton={false}
          actions={
            currentStep !== 4 ? (
              <button
                type="button"
                onClick={() => setShowSkipConfirm(true)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ) : undefined
          }
        />
        <DialogPageTitle heading={copy.heading} lead={lead} />

        <DialogPageBody className="pt-[18px]">
          {currentStep === 1 && <FTUXWelcomeStep />}
          {currentStep === 2 && <FTUXApiKeysStep />}
          {currentStep === 3 && <FTUXModelDefaultsStep />}
          {currentStep === 4 && (
            <FTUXReadyStep
              onStartTutorial={handleStartTutorial}
              onComplete={handleSkip}
            />
          )}
        </DialogPageBody>

        {currentStep !== 4 && (
          <DialogPageFooter between>
            <DialogButton
              variant="ghost"
              size="md"
              onClick={handleBack}
              disabled={currentStep === 1}
              className={currentStep === 1 ? "opacity-0 pointer-events-none" : ""}
            >
              Back
            </DialogButton>
            <DialogButton variant="primary" size="md" onClick={handleNext}>
              Next
            </DialogButton>
          </DialogPageFooter>
        )}

        {/* Skip confirmation */}
        {showSkipConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-scrim">
            <div
              role="alertdialog"
              aria-labelledby="ftux-skip-title"
              className="w-[360px] max-w-[calc(100%-32px)] bg-[#0f0f0f] border border-white/10 rounded-card shadow-dialog p-6"
            >
              <h3
                id="ftux-skip-title"
                className="font-display text-xl leading-6 font-bold tracking-[-0.02em] text-neutral-100"
              >
                Skip setup?
              </h3>
              <p className="mt-2 text-[13px] leading-[19px] text-neutral-400">
                You can configure API keys and model defaults later in settings.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <DialogButton variant="ghost" size="md" onClick={() => setShowSkipConfirm(false)}>
                  Cancel
                </DialogButton>
                <DialogButton variant="primary" size="md" onClick={handleSkip}>
                  Skip
                </DialogButton>
              </div>
            </div>
          </div>
        )}
      </DialogPage>
    </Dialog>
  );
}

/** One row of the static step rail: a check once done, an ink dot for now, a dim dot for later. */
function StepRailItem({ label, state }: { label: string; state: "done" | "current" | "later" }) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "flex items-center gap-2.5 h-8 font-display text-sm leading-[18px] font-medium tracking-[-0.01em]",
        state === "done" && "text-neutral-400",
        state === "current" && "text-neutral-100",
        state === "later" && "text-neutral-600"
      )}
    >
      {state === "done" ? (
        <span aria-hidden="true" className="flex w-3.5 shrink-0">
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12l5 5L20 7" />
          </svg>
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "w-1.5 h-1.5 mx-1 rounded-full shrink-0",
            state === "current" ? "bg-neutral-200" : "bg-chrome-border"
          )}
        />
      )}
      {label}
    </li>
  );
}
