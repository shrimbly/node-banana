/**
 * Community workflow metadata configurations
 *
 * This file provides rich metadata for community workflows that can't be
 * derived from the JSON file itself (descriptions, tags, thumbnails, etc.)
 */

export interface CommunityWorkflowConfig {
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  previewImage?: string;
  hoverImage?: string;
  sortOrder: number;
}

/**
 * Metadata configurations for community workflows.
 * Workflows not listed here will get default values derived from their filename.
 */
export const COMMUNITY_WORKFLOW_CONFIGS: CommunityWorkflowConfig[] = [
  {
    id: "Fashion-image-to-video",
    name: "Fashion Image to Video",
    description: "Image to video workflow for fashion style videos.",
    author: "@ReflctWillie",
    tags: ["Gemini", "Fal"],
    previewImage: "/template-thumbnails/community/fashion-image-to-video.jpg",
    sortOrder: 1,
  },
  {
    id: "contact-sheet-billsSupra",
    name: "Bills Supra",
    description: "Contact sheet prompt chaining with embedded text.",
    author: "@ReflctWillie",
    tags: ["Gemini"],
    previewImage: "/template-thumbnails/community/bills-supra.jpg",
    sortOrder: 2,
  },
  {
    id: "contact-sheet-ChrisWalkman",
    name: "Chris Walkman",
    description: "Multi subject contact sheet prompt chaining experiment.",
    author: "@ReflctWillie",
    tags: ["Gemini"],
    previewImage: "/template-thumbnails/community/chris-walkman.jpg",
    sortOrder: 3,
  },
];

/**
 * Get the configuration for a specific community workflow by ID
 */
export function getCommunityWorkflowConfig(id: string): CommunityWorkflowConfig | undefined {
  return COMMUNITY_WORKFLOW_CONFIGS.find((config) => config.id === id);
}

/**
 * Generate default configuration for a workflow not in COMMUNITY_WORKFLOW_CONFIGS
 */
export function getDefaultCommunityConfig(id: string, filename: string): CommunityWorkflowConfig {
  // Derive a readable name from the filename
  const nameWithoutExt = filename.replace(/\.json$/, "");

  let name: string;
  if (nameWithoutExt.startsWith("contact-sheet-")) {
    const namePart = nameWithoutExt.replace("contact-sheet-", "");
    name = namePart
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (s) => s.toUpperCase());
  } else if (nameWithoutExt.startsWith("workflow-")) {
    name = nameWithoutExt
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } else {
    name = nameWithoutExt
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return {
    id,
    name,
    description: "Community workflow",
    author: "Community",
    tags: [],
    sortOrder: 999, // Default to end of list
  };
}
