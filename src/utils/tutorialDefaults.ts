import { WorkflowNodeData, ImageInputNodeData, PromptNodeData } from "@/types";

/**
 * Returns tutorial-specific default data for newly created nodes.
 * Returns undefined - nodes should be created empty initially.
 * Content is populated after the prompt node is connected.
 */
export function getTutorialNodeData(
  nodeType: string,
  tutorialActive: boolean,
  tutorialSampleImage?: string | null
): Partial<WorkflowNodeData> | undefined {
  // Nodes are created empty during tutorial
  return undefined;
}

/**
 * Returns the sample content to populate nodes after connection is made.
 */
export function getTutorialSampleContent(
  nodeType: string,
  tutorialSampleImage?: string | null
): Partial<WorkflowNodeData> | undefined {
  switch (nodeType) {
    case "prompt":
      return {
        prompt: "wearing aviator sunglasses and a leather jacket, cool and confident pose",
      } as Partial<PromptNodeData>;

    case "imageInput":
      if (!tutorialSampleImage) return undefined;

      return {
        image: tutorialSampleImage,
        filename: "owl.jpg",
        dimensions: { width: 1024, height: 1024 },
      } as Partial<ImageInputNodeData>;

    default:
      return undefined;
  }
}
