/**
 * FTUX (First-Time User Experience) Types
 *
 * Type definitions for the onboarding modal flow.
 */

export type FTUXStep = 1 | 2 | 3 | 4;

export interface FTUXModalProps {
  onComplete: () => void;
  onStartTutorial: () => void;
}

export interface FTUXStepProps {
  onNext?: () => void;
  onStartTutorial?: () => void;
  onComplete?: () => void;
}
