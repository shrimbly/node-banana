/**
 * Model id checks for ids that end up inside a provider URL.
 *
 * Replicate ids are interpolated into `/v1/models/{owner}/{name}` without
 * encoding, so anything beyond `owner/name` made of word characters, dots
 * and dashes is refused before a request is built.
 */

export const REPLICATE_MODEL_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** True for a Replicate `owner/name` id that is safe to put in a URL path. */
export function isValidReplicateModelId(modelId: string): boolean {
  return REPLICATE_MODEL_ID_PATTERN.test(modelId);
}
