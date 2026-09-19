"use client";

import { Dialog, DialogButton, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useState } from "react";
import { FTUXModalProps, FTUXStep } from "@/types/ftux";
import { setFTUXCompleted } from "@/store/utils/localStorage";
import { FTUXWelcomeStep } from "./FTUXWelcomeStep";
import { FTUXApiKeysStep } from "./FTUXApiKeysStep";
import { FTUXModelDefaultsStep } from "./FTUXModelDefaultsStep";
import { FTUXReadyStep } from "./FTUXReadyStep";

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

  const getStepTitle = () => {
    switch (currentStep) {
      case 1:
        return "Welcome";
      case 2:
        return "API Keys";
      case 3:
        return "Model Defaults";
      case 4:
        return "Ready";
      default:
        return "";
    }
  };

  const getButtonText = () => {
    if (currentStep === 4) return "Get Started";
    return "Next";
  };

  return (
    <Dialog
      open
      label={currentStep === 4 ? "Ready" : undefined}
      className={`w-full ${currentStep === 4 ? "max-w-[420px]" : "max-w-[640px] max-h-[80vh]"}`}
    >
        {/* Header */}
        {currentStep !== 4 && (
          <div className="shrink-0 border-b border-chrome-border/50">
            <DialogHeader
              icon={<img src="/banana_icon.png" alt="" className="w-5 h-5" />}
              actions={
                <button
                  type="button"
                  onClick={() => setShowSkipConfirm(true)}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50 transition-colors"
                  aria-label="Close"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              }
              className="pb-3"
            >
              <DialogTitle>Welcome to Node Banana</DialogTitle>
            </DialogHeader>

            {/* Step indicators */}
            <div className="flex gap-2 px-5 pb-4">
              {([1, 2, 3, 4] as const).map((step) => (
                <div
                  key={step}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    step <= currentStep ? "bg-white" : "bg-neutral-700"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {currentStep === 1 && <FTUXWelcomeStep />}
          {currentStep === 2 && <FTUXApiKeysStep />}
          {currentStep === 3 && <FTUXModelDefaultsStep />}
          {currentStep === 4 && (
            <FTUXReadyStep
              onStartTutorial={handleStartTutorial}
              onComplete={handleSkip}
            />
          )}
        </div>

        {/* Footer */}
        {currentStep !== 4 && (
          <DialogFooter className="justify-between">
            <DialogButton
              variant="ghost"
              onClick={handleBack}
              disabled={currentStep === 1}
              className={currentStep === 1 ? "opacity-0 pointer-events-none" : ""}
            >
              Back
            </DialogButton>
            <DialogButton variant="primary" onClick={handleNext}>
              {getButtonText()}
            </DialogButton>
          </DialogFooter>
        )}

        {/* Skip confirmation dialog */}
        {showSkipConfirm && (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim z-10">
            <div className="bg-card rounded-card p-5 border border-chrome-border shadow-dialog max-w-sm mx-4">
              <h3 className="text-base font-semibold text-neutral-100 mb-1">
                Skip setup?
              </h3>
              <p className="text-[13px] text-neutral-400 mb-4">
                You can configure API keys and model defaults later in settings.
              </p>
              <div className="flex gap-2 justify-end">
                <DialogButton variant="ghost" onClick={() => setShowSkipConfirm(false)}>
                  Cancel
                </DialogButton>
                <DialogButton variant="primary" onClick={handleSkip}>
                  Skip
                </DialogButton>
              </div>
            </div>
          </div>
        )}
    </Dialog>
  );
}
