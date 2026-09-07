import { NextRequest, NextResponse } from "next/server";

/**
 * API routes can write local files and spend provider credits. CORS alone does
 * not stop another website sending a text/plain POST containing JSON, and some
 * GET routes (the directory picker) also have side effects.
 *
 * Headerless CLI/provider requests remain supported. This is a browser-origin
 * boundary, not authentication for deployments exposed to other users.
 */
export function proxy(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    return forbidden();
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      // Next may construct nextUrl using its internal listening hostname. The
      // incoming Host is the browser's authority, including its public port.
      const authority = request.headers.get("host") || request.nextUrl.host;
      const expected = new URL(`${request.nextUrl.protocol}//${authority}`).origin;
      if (origin === "null" || new URL(origin).origin !== expected) {
        return forbidden();
      }
    } catch {
      return forbidden();
    }
  }

  return NextResponse.next();
}

function forbidden() {
  return NextResponse.json(
    { success: false, error: "Cross-origin API requests are not allowed" },
    { status: 403 }
  );
}

export const config = { matcher: "/api/:path*" };
