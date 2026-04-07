import { WorkflowNodeData, ImageInputNodeData, PromptNodeData } from "@/types";

/**
 * Returns tutorial-specific default data for newly created nodes.
 * Returns undefined if not in tutorial mode or node type doesn't need defaults.
 */
export function getTutorialNodeData(
  nodeType: string,
  tutorialActive: boolean,
  tutorialSampleImage?: string | null
): Partial<WorkflowNodeData> | undefined {
  if (!tutorialActive) return undefined;

  switch (nodeType) {
    case "prompt":
      return {
        prompt: "wearing a red dress in Paris",
      } as Partial<PromptNodeData>;

    case "imageInput":
      if (!tutorialSampleImage) return undefined; // Image not loaded yet

      return {
        image: tutorialSampleImage,
        filename: "sample-model.png",
        dimensions: { width: 1024, height: 1024 }, // Approximate, will update on render
      } as Partial<ImageInputNodeData>;

    default:
      return undefined;
  }
}
