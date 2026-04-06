import { create } from "zustand";

export interface TutorialStep {
  id: string;
  message: string;
  highlightSelector?: string;
  requiredAction?: "add-image-node" | "add-output-node" | "connect-nodes" | "run-workflow";
  completed: boolean;
}

export interface FTUXState {
  tutorialActive: boolean;
  currentTutorialStep: number;
  tutorialSteps: TutorialStep[];
  lockedFeatures: boolean;

  // Actions
  startTutorial: () => void;
  skipTutorial: () => void;
  completeCurrentStep: () => void;
  nextTutorialStep: () => void;
  resetTutorial: () => void;
}

const FTUX_COMPLETED_KEY = "node-banana-ftux-completed";

/**
 * Marks FTUX as completed in localStorage.
 */
export function setFTUXCompleted(completed: boolean): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(FTUX_COMPLETED_KEY, JSON.stringify(completed));
  }
}

/**
 * Checks if FTUX has been completed.
 */
export function getFTUXCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem(FTUX_COMPLETED_KEY);
    return stored ? JSON.parse(stored) : false;
  } catch {
    return false;
  }
}

/**
 * Tutorial steps for FTUX onboarding.
 */
const initialTutorialSteps: TutorialStep[] = [
  {
    id: "welcome",
    message: "Let's cook.",
    completed: false,
  },
  {
    id: "add-image",
    message: "Click the Image button to add an image node.",
    highlightSelector: '[data-tutorial="image-button"]',
    requiredAction: "add-image-node",
    completed: false,
  },
  {
    id: "add-output",
    message: "Now add an Output node to see your results.",
    highlightSelector: '[data-tutorial="output-button"]',
    requiredAction: "add-output-node",
    completed: false,
  },
  {
    id: "complete",
    message: "You're all set! Connect nodes to build workflows, or press Cmd+Enter to run.",
    completed: false,
  },
];

/**
 * FTUX tutorial state management using Zustand.
 * Manages tutorial progression, step completion, and UI locking.
 */
export const useFTUXStore = create<FTUXState>((set, get) => ({
  tutorialActive: false,
  currentTutorialStep: 0,
  tutorialSteps: [],
  lockedFeatures: false,

  startTutorial: () => {
    set({
      tutorialActive: true,
      currentTutorialStep: 0,
      tutorialSteps: initialTutorialSteps.map((step) => ({ ...step, completed: false })),
      lockedFeatures: true,
    });
  },

  skipTutorial: () => {
    setFTUXCompleted(true);
    set({
      tutorialActive: false,
      lockedFeatures: false,
    });
  },

  completeCurrentStep: () => {
    const { currentTutorialStep, tutorialSteps } = get();
    if (currentTutorialStep >= 0 && currentTutorialStep < tutorialSteps.length) {
      const updatedSteps = [...tutorialSteps];
      updatedSteps[currentTutorialStep] = {
        ...updatedSteps[currentTutorialStep],
        completed: true,
      };
      set({ tutorialSteps: updatedSteps });
    }
  },

  nextTutorialStep: () => {
    const { currentTutorialStep, tutorialSteps } = get();
    const nextStep = currentTutorialStep + 1;

    if (nextStep >= tutorialSteps.length) {
      // Tutorial complete
      setFTUXCompleted(true);
      set({
        tutorialActive: false,
        lockedFeatures: false,
      });
    } else {
      set({ currentTutorialStep: nextStep });
    }
  },

  resetTutorial: () => {
    set({
      tutorialActive: false,
      currentTutorialStep: 0,
      tutorialSteps: [],
      lockedFeatures: false,
    });
  },
}));
