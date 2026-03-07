/**
 * Utility functions for Google Veo models.
 */

/**
 * Checks if a model ID corresponds to a Google Veo model.
 * Supports native Gemini IDs (e.g., "veo-") and Kie IDs (e.g., "veo3/").
 * @param modelId - The model ID to check.
 * @returns True if the model is a Veo model.
 */
export function isVeoModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.startsWith("veo-") || id.startsWith("veo3/") || id.includes("/veo");
}

/**
 * Returns complete metadata for a Veo model.
 * @param modelId - The ID of the model.
 * @returns An object containing Veo status, I2V status, and correct image parameter name.
 */
export function getVeoMetadata(modelId: string | undefined): { isVeo: boolean; isI2V: boolean; imageParamName: string } {
  if (!isVeoModel(modelId)) {
    return { isVeo: false, isI2V: false, imageParamName: "image" };
  }
  
  const id = modelId!.toLowerCase();
  const isI2V = id.includes("image-to-video") || id.includes("i2v") || id.includes("image to video");
  const imageParamName = id.startsWith("veo3") ? "imageUrls" : "image";
  
  return { isVeo: true, isI2V, imageParamName };
}
