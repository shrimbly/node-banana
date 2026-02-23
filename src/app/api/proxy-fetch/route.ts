/**
 * Server-side URL proxy for fetching binary content.
 *
 * Used by client-side executors (e.g. GLB Viewer) to fetch remote URLs
 * that may be blocked by CORS when fetched directly from the browser.
 * Streams the binary response back with the original content-type.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateMediaUrl } from "@/utils/urlValidation";

const MAX_CONTENT_SIZE = 100 * 1024 * 1024; // 100MB
const FETCH_TIMEOUT_MS = 60000; // 60 seconds

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { url } = body;

        if (!url || typeof url !== "string") {
            return NextResponse.json(
                { error: "URL is required" },
                { status: 400 }
            );
        }

        // SSRF protection
        const urlCheck = validateMediaUrl(url);
        if (!urlCheck.valid) {
            return NextResponse.json(
                { error: `Invalid URL: ${urlCheck.error}` },
                { status: 400 }
            );
        }

        // Must be HTTPS
        if (!url.startsWith("https://")) {
            return NextResponse.json(
                { error: "Only HTTPS URLs are allowed" },
                { status: 400 }
            );
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                return NextResponse.json(
                    { error: `Upstream fetch failed: ${response.status}` },
                    { status: 502 }
                );
            }

            // Check content-length before downloading
            const contentLength = response.headers.get("content-length");
            if (contentLength) {
                const size = parseInt(contentLength, 10);
                if (size > MAX_CONTENT_SIZE) {
                    return NextResponse.json(
                        { error: `Content too large: ${size} bytes` },
                        { status: 413 }
                    );
                }
            }

            const arrayBuffer = await response.arrayBuffer();

            if (arrayBuffer.byteLength > MAX_CONTENT_SIZE) {
                return NextResponse.json(
                    { error: `Content too large: ${arrayBuffer.byteLength} bytes` },
                    { status: 413 }
                );
            }

            const contentType = response.headers.get("content-type") || "application/octet-stream";

            return new NextResponse(arrayBuffer, {
                status: 200,
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": String(arrayBuffer.byteLength),
                },
            });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError instanceof Error && fetchError.name === "AbortError") {
                return NextResponse.json(
                    { error: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms` },
                    { status: 504 }
                );
            }
            throw fetchError;
        }
    } catch (error) {
        console.error("Proxy fetch failed:", error);
        return NextResponse.json(
            { error: "Proxy fetch failed" },
            { status: 500 }
        );
    }
}
