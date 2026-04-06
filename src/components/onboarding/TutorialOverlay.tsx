"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useFTUXStore } from "@/store/ftuxStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { ElementHighlight } from "./ElementHighlight";
import { TutorialMessage } from "./TutorialMessage";

/**
 * Main tutorial coordination component.
 * Manages tutorial progression, action detection, and UI rendering.
 */
export function TutorialOverlay() {
  const [mounted, setMounted] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);

  const tutorialActive = useFTUXStore((state) => state.tutorialActive);
  const currentTutorialStep = useFTUXStore((state) => state.currentTutorialStep);
  const tutorialSteps = useFTUXStore((state) => state.tutorialSteps);
  const completeCurrentStep = useFTUXStore((state) => state.completeCurrentStep);
  const nextTutorialStep = useFTUXStore((state) => state.nextTutorialStep);
  const skipTutorial = useFTUXStore((state) => state.skipTutorial);

  const nodes = useWorkflowStore((state) => state.nodes);

  // Ensure portal rendering only happens client-side
  useEffect(() => {
    setMounted(true);
  }, []);

  // Action detection: monitor workflow state for required actions
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];
    if (currentStep.completed) {
      return;
    }

    // Steps with waitForClick require manual progression
    if (currentStep.waitForClick) {
      return;
    }

    // Steps without requiredAction auto-advance after 3 seconds
    if (!currentStep.requiredAction) {
      const timer = setTimeout(() => {
        completeCurrentStep();
        nextTutorialStep();
      }, 3000);
      return () => clearTimeout(timer);
    }

    let actionCompleted = false;

    // Detect specific actions based on requiredAction type
    switch (currentStep.requiredAction) {
      case "add-image-node":
        actionCompleted = nodes.some((node) => node.type === "imageInput");
        break;

      case "add-output-node":
        actionCompleted = nodes.some((node) => node.type === "output");
        break;

      case "connect-nodes":
        // Check if any edges exist in workflow store
        const edges = useWorkflowStore.getState().edges;
        actionCompleted = edges.length > 0;
        break;

      case "run-workflow":
        // Check if any node has been executed (has output)
        actionCompleted = nodes.some((node) => {
          const data = node.data as Record<string, unknown>;
          return data.outputImage || data.outputText || data.outputAudio;
        });
        break;

      case "add-nanoBanana-from-menu":
        actionCompleted = useFTUXStore.getState().nanoBananaAddedFromMenu;
        break;
    }

    if (actionCompleted) {
      completeCurrentStep();
      // Advance to next step after short delay
      setTimeout(() => {
        nextTutorialStep();
      }, 1000);
    }
  }, [
    tutorialActive,
    currentTutorialStep,
    tutorialSteps,
    nodes,
    completeCurrentStep,
    nextTutorialStep,
  ]);

  // Handle highlight delay
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    if (currentStep.highlightSelector && currentStep.highlightDelay) {
      // Start with highlight hidden
      setShowHighlight(false);
      // Show highlight after delay
      const timer = setTimeout(() => {
        setShowHighlight(true);
      }, currentStep.highlightDelay);
      return () => clearTimeout(timer);
    } else {
      // No delay, show highlight immediately
      setShowHighlight(true);
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps]);

  // Don't render during SSR or when tutorial is inactive
  if (!mounted || !tutorialActive || currentTutorialStep >= tutorialSteps.length) {
    return null;
  }

  const currentStep = tutorialSteps[currentTutorialStep];

  const handleContinue = () => {
    completeCurrentStep();
    nextTutorialStep();
  };

  return createPortal(
    <>
      {/* Click-to-continue overlay (when waitForClick is true) */}
      {currentStep.waitForClick && (
        <div
          onClick={handleContinue}
          className="fixed inset-0 cursor-pointer"
          style={{ zIndex: 92 }}
        />
      )}

      {/* Element highlight (if specified and delay has passed) */}
      {currentStep.highlightSelector && showHighlight && (
        <ElementHighlight selector={currentStep.highlightSelector} />
      )}

      {/* Tutorial message */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 93 }}>
        <TutorialMessage
          message={currentStep.message}
          position={currentStep.position}
          waitForClick={currentStep.waitForClick}
        />
      </div>

      {/* Skip tutorial button */}
      <button
        onClick={skipTutorial}
        className="fixed top-4 right-4 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors pointer-events-auto"
        style={{ zIndex: 94 }}
      >
        Skip tutorial
      </button>
    </>,
    document.body
  );
}
