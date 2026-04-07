import { create } from "zustand";

export interface TutorialStep {
  id: string;
  message: string;
  highlightSelector?: string | string[]; // Single selector or array of selectors
  highlightDelay?: number; // Delay in ms before showing highlight
  advanceDelay?: number; // Delay in ms before advancing to next step after action completes (default: 1000)
  requiredAction?:
    | "add-image-node"
    | "add-output-node"
    | "connect-nodes"
    | "run-workflow"
    | "show-connection-menu"
    | "add-nanoBanana-from-menu"
    | "add-prompt-node"
    | "connect-prompt-node";
  position?: "left" | "right" | "center" | "top-center";
  waitForClick?: boolean;
  completed: boolean;
}

export interface FTUXState {
  tutorialActive: boolean;
  currentTutorialStep: number;
  tutorialSteps: TutorialStep[];
  lockedFeatures: boolean;
  tutorialSampleImage: string | null; // Base64 data URL for tutorial sample image

  // Tutorial progress flags
  connectionMenuShown: boolean;
  nanoBananaAddedFromMenu: boolean;

  // Actions
  startTutorial: () => void;
  skipTutorial: () => void;
  completeCurrentStep: () => void;
  nextTutorialStep: () => void;
  resetTutorial: () => void;
  setConnectionMenuShown: (shown: boolean) => void;
  setNanoBananaAddedFromMenu: (added: boolean) => void;
  loadTutorialSampleImage: () => Promise<void>;
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
    message: "Let's go over the basics.",
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
    id: "explain-node",
    message: "This is a node. Each node has a specific function.\n\nThis node adds images.",
    position: "top-center",
    waitForClick: true,
    completed: false,
  },
  {
    id: "explain-node-inputs",
    message: "Inputs always go in on the left side of the node.",
    highlightSelector: '[data-tutorial="node-input-handle"]',
    highlightDelay: 1000,
    position: "left",
    waitForClick: true,
    completed: false,
  },
  {
    id: "explain-node-outputs",
    message: "Outputs always come from the right side of the node.",
    highlightSelector: '[data-tutorial="node-output-handle"]',
    highlightDelay: 1000,
    position: "right",
    waitForClick: true,
    completed: false,
  },
  {
    id: "drag-and-drop",
    message: "Drag from the output handle and drop into empty space.",
    highlightSelector: '[data-tutorial="node-output-handle"]',
    position: "right",
    requiredAction: "show-connection-menu",
    advanceDelay: 0,
    completed: false,
  },
  {
    id: "select-generate-image",
    message: "Select 'Generate Image' to add an AI image generation node.",
    highlightSelector: '[data-tutorial="generate-image-option"]',
    position: "top-center",
    requiredAction: "add-nanoBanana-from-menu",
    completed: false,
  },
  {
    id: "add-prompt-node",
    message: "Click the Prompt button to add a prompt node.",
    highlightSelector: '[data-tutorial="prompt-button"]',
    position: "top-center",
    requiredAction: "add-prompt-node",
    completed: false,
  },
  {
    id: "connect-prompt-to-generate",
    message: "Drag from the Prompt's output handle to the Generate Image's input handle.",
    highlightSelector: ['[data-tutorial="prompt-output-handle"]', '[data-tutorial="generate-text-input-handle"]'],
    position: "left",
    requiredAction: "connect-prompt-node",
    completed: false,
  },
  {
    id: "run-workflow",
    message: "Perfect! Now press Cmd+Enter (or Ctrl+Enter on Windows) to run your workflow and generate an image.",
    position: "top-center",
    waitForClick: true,
    completed: false,
  },
  {
    id: "save-and-resources",
    message: "Save your project (Cmd+S) to keep all generations locally.\n\nCheck out Templates for ready-made workflows.\n\nJoin our Discord for help and inspiration.",
    position: "top-center",
    waitForClick: true,
    completed: false,
  },
  {
    id: "complete",
    message: "You're all set! Happy creating.",
    position: "top-center",
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
  tutorialSampleImage: null,
  connectionMenuShown: false,
  nanoBananaAddedFromMenu: false,

  loadTutorialSampleImage: async () => {
    try {
      const response = await fetch("/sample-images/owl.jpg");
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        set({ tutorialSampleImage: base64 });
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error("Failed to load tutorial sample image:", error);
    }
  },

  startTutorial: () => {
    set({
      tutorialActive: true,
      currentTutorialStep: 0,
      tutorialSteps: initialTutorialSteps.map((step) => ({ ...step, completed: false })),
      lockedFeatures: true,
      connectionMenuShown: false,
      nanoBananaAddedFromMenu: false,
    });

    // Pre-load sample image for tutorial
    get().loadTutorialSampleImage();
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

  setConnectionMenuShown: (shown: boolean) => set({ connectionMenuShown: shown }),
  setNanoBananaAddedFromMenu: (added: boolean) => set({ nanoBananaAddedFromMenu: added }),
}));
