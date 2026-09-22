import type { ProviderSettings } from "@/types";
import { getComfySettings } from "@/lib/comfy/settings";

/**
 * The key Comfy Router calls go out with. A key entered for the provider
 * wins; otherwise the Comfy Cloud key from the ComfyUI settings serves,
 * because both are workspace keys from platform.comfy.org and Router
 * accepts either. Safe to call on the server: without a window there is
 * no stored Comfy Cloud key and only the provider key counts.
 */
export function getComfyRouterKey(providerSettings: ProviderSettings): string | null {
  const own = providerSettings.providers.comfy?.apiKey;
  if (own) return own;
  if (typeof window === "undefined") return null;
  try {
    return getComfySettings().cloudApiKey || null;
  } catch {
    return null;
  }
}
