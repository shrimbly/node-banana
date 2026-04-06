"use client";

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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div className={`relative bg-neutral-800 rounded-xl w-full ${currentStep === 4 ? 'max-w-[420px]' : 'max-w-[640px]'} mx-4 border border-neutral-700 shadow-2xl overflow-clip flex flex-col ${currentStep === 4 ? '' : 'max-h-[80vh]'}`}>
        {/* Header */}
        {currentStep !== 4 && (
          <div className="px-8 pt-8 pb-4 border-b border-neutral-700/50 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src="/banana_icon.png" alt="" className="w-6 h-6" />
                <h2 className="text-xl font-medium text-neutral-100">
                  Welcome to Node Banana
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowSkipConfirm(true)}
                className="text-neutral-400 hover:text-neutral-100 transition-colors"
                aria-label="Close"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Step indicators */}
            <div className="flex gap-2 mt-4">
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
          <div className="flex justify-between gap-2 px-8 py-5 border-t border-neutral-700/50 shrink-0">
            <button
              type="button"
              onClick={handleBack}
              disabled={currentStep === 1}
              className={`px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 transition-all ${
                currentStep === 1 ? "opacity-0 pointer-events-none" : ""
              }`}
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="px-4 py-2 text-sm bg-white text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors font-medium"
            >
              {getButtonText()}
            </button>
          </div>
        )}

        {/* Skip confirmation dialog */}
        {showSkipConfirm && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
            <div className="bg-neutral-800 rounded-xl p-6 border border-neutral-700 shadow-2xl max-w-sm mx-4">
              <h3 className="text-lg font-semibold text-neutral-100 mb-2">
                Skip setup?
              </h3>
              <p className="text-sm text-neutral-400 mb-4">
                You can configure API keys and model defaults later in settings.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowSkipConfirm(false)}
                  className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  className="px-4 py-2 text-sm bg-white text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
