import { NextRequest, NextResponse } from "next/server";
import type { ProviderModel } from "@/lib/providers/types";
import { createHash } from "node:crypto";

const FAL_PRICING_URL = "https://api.fal.ai/v1/models/pricing";
const FAL_BATCH_SIZE = 50;
const FAL_BATCH_CONCURRENCY = 4;
const MAX_ENDPOINTS = 750;
const CACHE_TTL = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1500;

type ModelPricing = NonNullable<ProviderModel["pricing"]>;

interface CachedPricing {
  pricing: ModelPricing | null;
  timestamp: number;
}

interface FalPricingItem {
  endpoint_id?: unknown;
  unit_price?: unknown;
  unit?: unknown;
  currency?: unknown;
}

interface PricingResult {
  endpointId: string;
  pricing: ModelPricing | null;
}

interface PricingSuccessResponse {
  success: true;
  prices: PricingResult[];
}

interface PricingErrorResponse {
  success: false;
  error: string;
}

type PricingResponse = PricingSuccessResponse | PricingErrorResponse;

// Server-memory cache: it survives page reloads but naturally resets when the
// local app server restarts. The browser also keeps a session cache so a reload
// normally does not need to hit this route at all.
const pricingCache = new Map<string, CachedPricing>();

function getCredentialScope(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
}

function pruneCache(now: number): void {
  for (const [endpointId, entry] of pricingCache) {
    if (now - entry.timestamp >= CACHE_TTL) {
      pricingCache.delete(endpointId);
    }
  }

  while (pricingCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = pricingCache.keys().next().value;
    if (oldestKey === undefined) break;
    pricingCache.delete(oldestKey);
  }
}

function parsePricing(item: FalPricingItem): PricingResult | null {
  if (typeof item.endpoint_id !== "string" || !item.endpoint_id) return null;
  if (
    typeof item.unit_price !== "number" ||
    !Number.isFinite(item.unit_price) ||
    item.unit_price < 0 ||
    typeof item.unit !== "string" ||
    !item.unit ||
    typeof item.currency !== "string" ||
    !item.currency
  ) {
    return { endpointId: item.endpoint_id, pricing: null };
  }

  const normalizedUnit = item.unit.toLowerCase().replace(/[_-]+/g, " ");
  return {
    endpointId: item.endpoint_id,
    pricing: {
      type: normalizedUnit.includes("second") ? "per-second" : "per-run",
      amount: item.unit_price,
      currency: item.currency.toUpperCase(),
      unit: item.unit,
    },
  };
}

async function fetchPricingBatch(
  endpointIds: string[],
  apiKey: string
): Promise<{ status: number; results: PricingResult[] }> {
  const url = new URL(FAL_PRICING_URL);
  for (const endpointId of endpointIds) {
    url.searchParams.append("endpoint_id", endpointId);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Key ${apiKey}` },
  });

  if (!response.ok) {
    return { status: response.status, results: [] };
  }

  const data = (await response.json()) as { prices?: FalPricingItem[] };
  const byId = new Map<string, PricingResult>();
  for (const item of Array.isArray(data.prices) ? data.prices : []) {
    const parsed = parsePricing(item);
    if (parsed) byId.set(parsed.endpointId, parsed);
  }

  // A missing entry is a supported, honest result: some fal endpoints do not
  // expose fixed output pricing and fall back to compute billing.
  return {
    status: response.status,
    results: endpointIds.map(
      (endpointId) => byId.get(endpointId) ?? { endpointId, pricing: null }
    ),
  };
}

/**
 * POST /api/providers/fal/pricing
 * Body: { endpointIds: string[] }
 *
 * fal accepts at most 50 endpoint IDs per pricing request, so the proxy batches
 * larger Browse Models catalogues and keeps API credentials server-side.
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<PricingResponse>> {
  const apiKey =
    request.headers.get("X-Fal-Key") ||
    request.headers.get("X-API-Key") ||
    process.env.FAL_API_KEY;

  if (!apiKey) {
    return NextResponse.json<PricingErrorResponse>(
      { success: false, error: "fal.ai API key not configured" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<PricingErrorResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const rawEndpointIds = (body as { endpointIds?: unknown })?.endpointIds;
  if (!Array.isArray(rawEndpointIds)) {
    return NextResponse.json<PricingErrorResponse>(
      { success: false, error: "endpointIds must be an array" },
      { status: 400 }
    );
  }

  const endpointIds = Array.from(
    new Set(
      rawEndpointIds.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= 300
      )
    )
  );

  if (endpointIds.length === 0 || endpointIds.length > MAX_ENDPOINTS) {
    return NextResponse.json<PricingErrorResponse>(
      {
        success: false,
        error: `endpointIds must contain between 1 and ${MAX_ENDPOINTS} valid IDs`,
      },
      { status: 400 }
    );
  }

  const now = Date.now();
  pruneCache(now);
  const credentialScope = getCredentialScope(apiKey);

  const results = new Map<string, PricingResult>();
  const missing: string[] = [];
  for (const endpointId of endpointIds) {
    // fal may return account-specific discounts, so never share cached prices
    // between two different API keys.
    const cached = pricingCache.get(`${credentialScope}:${endpointId}`);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      results.set(endpointId, { endpointId, pricing: cached.pricing });
    } else {
      missing.push(endpointId);
    }
  }

  let firstFailureStatus: number | null = null;
  const waveSize = FAL_BATCH_SIZE * FAL_BATCH_CONCURRENCY;
  for (let index = 0; index < missing.length; index += waveSize) {
    const wave: string[][] = [];
    for (
      let batchIndex = index;
      batchIndex < Math.min(index + waveSize, missing.length);
      batchIndex += FAL_BATCH_SIZE
    ) {
      wave.push(missing.slice(batchIndex, batchIndex + FAL_BATCH_SIZE));
    }

    const fetchedBatches = await Promise.all(
      wave.map(async (batch) => {
        try {
          return await fetchPricingBatch(batch, apiKey);
        } catch {
          return { status: 502, results: [] as PricingResult[] };
        }
      })
    );

    for (const fetched of fetchedBatches) {
      if (fetched.status < 200 || fetched.status >= 300) {
        firstFailureStatus ??= fetched.status;
        continue;
      }

      for (const result of fetched.results) {
        results.set(result.endpointId, result);
        pricingCache.set(`${credentialScope}:${result.endpointId}`, {
          pricing: result.pricing,
          timestamp: now,
        });
      }
    }
  }

  pruneCache(now);

  if (results.size === 0 && firstFailureStatus !== null) {
    const status = firstFailureStatus === 401 ? 401 : 502;
    return NextResponse.json<PricingErrorResponse>(
      { success: false, error: "Failed to fetch fal.ai pricing" },
      { status }
    );
  }

  return NextResponse.json<PricingSuccessResponse>({
    success: true,
    prices: endpointIds.flatMap((endpointId) => {
      const result = results.get(endpointId);
      return result ? [result] : [];
    }),
  });
}
