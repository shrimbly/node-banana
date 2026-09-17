import type { NextRequest } from "next/server";

/**
 * Whether a request appears to originate from the machine running the server.
 *
 * The routes that shell out to the desktop (`open-file`, `open-directory`) act
 * on the *server's* filesystem, so they are only meaningful — and only safe —
 * in the single-user, localhost deployment this app is built for.
 *
 * Note the limits: `x-forwarded-for` and `host` are ordinary request headers,
 * so this check assumes the app is reached directly rather than through a
 * reverse proxy that forwards a rewritten `Host`. It is a guard against
 * casual exposure, not a substitute for authentication.
 */
export function isLocalhostRequest(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp !== "127.0.0.1" && firstIp !== "::1" && firstIp !== "::ffff:127.0.0.1") {
      return false;
    }
  }

  const host = req.headers.get("host") || "";
  const hostname = host.split(":")[0];
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    return false;
  }

  return true;
}
