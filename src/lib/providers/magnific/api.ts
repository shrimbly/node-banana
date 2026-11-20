/** Magnific's API, as every module that calls it names it. */

/** Every model is a POST below this; its task is read at `{poll route}/{task id}`. */
export const MAGNIFIC_API_BASE = "https://api.magnific.com/v1/ai";

export const MAGNIFIC_DOCS_URL = "https://docs.magnific.com";

export function magnificHeaders(apiKey: string, json = false): Record<string, string> {
  return { "x-magnific-api-key": apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
}
