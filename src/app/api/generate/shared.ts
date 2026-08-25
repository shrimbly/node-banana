/**
 * Shared helpers for the generate routes.
 *
 * This is a NON-route module (no HTTP handler exports) so that both
 * `route.ts` and `poll/route.ts` — and tests — can import shared logic
 * without shipping non-handler exports through a Next.js route file.
 */
import { NextResponse } from "next/server";
import type { GenerateResponse, GenerationCostReceipt } from "@/types";
import { clearFalInputMappingCache as _clearFalInputMappingCache } from "./providers/fal";

/**
 * Re-exported so tests (and any caller) can reset fal's input-mapping cache
 * without importing from a route module.
 */
export const clearFalInputMappingCache = _clearFalInputMappingCache;

/**
 * Build the final NextResponse for a completed generation output.
 * Shared by the synchronous generate route and the async poll route.
 */
export function buildMediaResponse(
  output: { type: string; data: string; url?: string },
  generationCost?: GenerationCostReceipt
): NextResponse {
  if (output.type === "3d") {
    return NextResponse.json<GenerateResponse>({
      success: true,
      model3dUrl: output.url,
      contentType: "3d",
      generationCost,
    });
  }

  if (output.type === "video") {
    const isLarge = !output.data && output.url;
    return NextResponse.json<GenerateResponse>({
      success: true,
      video: isLarge ? undefined : output.data,
      videoUrl: isLarge ? output.url : undefined,
      contentType: "video",
      generationCost,
    });
  }

  if (output.type === "audio") {
    const isLarge = !output.data && output.url;
    return NextResponse.json<GenerateResponse>({
      success: true,
      audio: isLarge ? undefined : output.data,
      audioUrl: isLarge ? output.url : undefined,
      contentType: "audio",
      generationCost,
    });
  }

  return NextResponse.json<GenerateResponse>({
    success: true,
    image: output.data,
    contentType: "image",
    generationCost,
  });
}
