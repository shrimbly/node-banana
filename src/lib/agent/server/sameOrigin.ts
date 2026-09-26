/**
 * Request guard for the agent routes.
 *
 * `/api/agent/*` starts the Claude Code and Codex CLIs on the user's own
 * subscription, so only the person at this machine, through Node Banana's own
 * page, may use it: not another website open in their browser (a hidden form
 * post or a no-cors `fetch` would open a vendor sign-in or spend their quota),
 * and not another device on their network.
 *
 * What a header check can and cannot do: `next dev`, `next start` and
 * server.js listen on every network interface unless told otherwise, and every
 * header read here is written by the caller. Against a browser the checks are
 * sound, because a page cannot forge `Origin`, `Sec-Fetch-Site` or `Referer`.
 * A program on another machine can forge all of them, and only the connection
 * itself (which a route handler never sees) tells it apart. So the server
 * must vouch for loopback connections: server.js (`npm run dev`, `npm start`)
 * deletes any client copy of `x-nb-agent-local`, then stamps it with the
 * per-process secret in `NB_AGENT_LOCAL_SECRET` when the peer is 127.0.0.0/8
 * or ::1. A server that does not vouch (plain `next dev` / `next start`)
 * cannot tell this machine from another, so on it the agent answers only on
 * the hosts listed in `NB_AGENT_ALLOWED_HOSTS`, never on localhost. (Next.js
 * keeps an `X-Forwarded-For` the client sent, so that header proves nothing.)
 *
 * The checks, each closing a different door:
 *
 * 1. `Sec-Fetch-Site`, when the browser sends it, must be `same-origin` or
 *    `none` (typed into the address bar). `same-site` is refused too: another
 *    port on localhost is another app.
 * 2. `Origin`, when present, must name the same host and port as `Host`.
 *    Browsers without Fetch Metadata still send `Origin` on every POST.
 * 3. The host must be a loopback name: `localhost`, `*.localhost`,
 *    127.0.0.0/8 or `[::1]`. A DNS-rebinding page (evil.example re-pointed at
 *    127.0.0.1) passes checks 1 and 2, because its origin and the Host header
 *    agree; it cannot pass this one. Any other name or address (a LAN address,
 *    a tunnel) opens the agent to other machines, so it must be listed in
 *    `NB_AGENT_ALLOWED_HOSTS`.
 * 4. For a loopback host, the request must carry the server's stamp: it came
 *    over a loopback connection. So a request from the network that only
 *    claims `Host: localhost` is refused.
 * 5. The request must show that it came from Node Banana's page: an `Origin`
 *    that passed check 2, or `Sec-Fetch-Site: same-origin`. A GET may show it
 *    with `Sec-Fetch-Site: none` or a same-host `Referer` instead, because a
 *    browser sends neither `Origin` on a same-origin GET nor Fetch Metadata
 *    over plain http to a LAN name. The stamp does not replace this: the
 *    app's own server-side fetches to 127.0.0.1 (a route that downloads a URL
 *    it was given, say) arrive over loopback too, stamped, and would
 *    otherwise let another machine reach the agent through them. Node's
 *    fetch sends none of these headers. A script on this machine sends
 *    `Origin: http://localhost:<port>` like the page does.
 */

import { timingSafeEqual } from "node:crypto";

export type SameOriginResult = { ok: true } | { ok: false; reason: string };

export interface SameOriginOptions {
  /**
   * Host names or addresses (no port; IPv6 in brackets) that may serve the
   * agent besides loopback. Defaults to `NB_AGENT_ALLOWED_HOSTS`
   * (comma-separated).
   */
  allowedHosts?: readonly string[];
  /** The server's loopback stamp. Defaults to `NB_AGENT_LOCAL_SECRET`. */
  localSecret?: string;
}

/** Environment variable that lists extra host names the agent may be used from. */
export const AGENT_ALLOWED_HOSTS_ENV = "NB_AGENT_ALLOWED_HOSTS";

/** Header the server stamps on requests that arrived over a loopback connection. */
export const AGENT_LOCAL_HEADER = "x-nb-agent-local";

/** Environment variable holding the per-process secret the server stamps with. */
export const AGENT_LOCAL_SECRET_ENV = "NB_AGENT_LOCAL_SECRET";

/** A shorter secret is treated as unset: it could be guessed. */
const MIN_LOCAL_SECRET_LENGTH = 32;

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

const PAGE_ONLY = "Only Node Banana's own page can use it.";

export function checkSameOrigin(request: Request, options: SameOriginOptions = {}): SameOriginResult {
  const headers = request.headers;
  const readOnly = request.method === "GET" || request.method === "HEAD";

  const fetchSite = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return { ok: false, reason: `Blocked a ${fetchSite} request to the agent. ${PAGE_ONLY}` };
  }

  const host = requestHost(request);
  if (!host) {
    return { ok: false, reason: "Blocked a request to the agent with no Host header." };
  }

  const origin = headers.get("origin");
  if (origin !== null) {
    const originHost = parseUrlHost(origin);
    if (originHost === null) {
      return { ok: false, reason: `Blocked a request to the agent from an opaque origin (${origin}).` };
    }
    if (originHost !== host) {
      return { ok: false, reason: `Blocked a request to the agent from ${origin}. ${PAGE_ONLY}` };
    }
  }

  const hostname = hostnameOf(host);
  const listed = (options.allowedHosts ?? allowedHostsFromEnv()).includes(hostname);
  if (!listed) {
    if (!isLoopbackHost(hostname)) {
      return {
        ok: false,
        reason:
          `The agent only answers on localhost, not ${hostname}. ` +
          `To use it at this address, add ${hostname} to ${AGENT_ALLOWED_HOSTS_ENV}.`,
      };
    }
    if (!localSecret(options.localSecret)) {
      return {
        ok: false,
        reason:
          "The agent needs Node Banana's own server, which can tell this machine from another: " +
          "start Node Banana with `npm run dev` or `npm start`, not `next dev` or `next start`.",
      };
    }
    if (!isVouchedLocal(request, options.localSecret)) {
      return {
        ok: false,
        reason:
          "Blocked a request to the agent from another machine. The agent only answers on this one " +
          `unless this machine's address is listed in ${AGENT_ALLOWED_HOSTS_ENV}.`,
      };
    }
  }

  // An Origin that got this far matched the host.
  const fromPage =
    origin !== null ||
    fetchSite === "same-origin" ||
    (readOnly && (fetchSite === "none" || parseUrlHost(headers.get("referer")) === host));
  if (!fromPage) {
    return { ok: false, reason: `Blocked a request to the agent that did not come from a browser page. ${PAGE_ONLY}` };
  }

  return { ok: true };
}

/**
 * Whether the server vouched that this request arrived over a loopback
 * connection: `x-nb-agent-local` carries the per-process secret. Never true
 * when no secret is configured, so a client-sent header alone proves nothing.
 */
export function isVouchedLocal(request: Request, secret?: string): boolean {
  const expected = localSecret(secret);
  if (!expected) return false;
  const stamp = request.headers.get(AGENT_LOCAL_HEADER);
  if (!stamp) return false;
  const given = Buffer.from(stamp);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The server's stamp secret, or null when it does not vouch (unset, or too short to trust). */
function localSecret(secret: string | undefined): string | null {
  const value = secret ?? process.env[AGENT_LOCAL_SECRET_ENV];
  return value && value.length >= MIN_LOCAL_SECRET_LENGTH ? value : null;
}

/** `host[:port]`, lower-cased, from the Host header (or the URL when a test builds a bare Request). */
function requestHost(request: Request): string | null {
  const header = request.headers.get("host")?.trim();
  if (header) return header.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The `host[:port]` an Origin or Referer header names, normalised the way a
 * Host header is written (default ports dropped). Null for `null`, non-http(s)
 * URLs and anything unparsable.
 */
function parseUrlHost(value: string | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host name without its port; IPv6 literals keep their brackets. */
function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host;
  }
}

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Names that can only reach this machine. `localhost` and `*.localhost` are
 * resolved to loopback by the browser itself, never through DNS, so a
 * rebinding page cannot stand behind them. The host has been through URL
 * parsing, so `127.1` arrives as `127.0.0.1` and `::ffff:127.0.0.1` as
 * `::ffff:7f00:1`.
 */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (LOOPBACK_IPV4.test(hostname)) return true;
  return hostname === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
}

function allowedHostsFromEnv(): string[] {
  const raw = process.env[AGENT_ALLOWED_HOSTS_ENV];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}
