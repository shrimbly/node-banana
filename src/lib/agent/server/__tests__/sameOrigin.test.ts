// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_ALLOWED_HOSTS_ENV,
  AGENT_LOCAL_HEADER,
  AGENT_LOCAL_SECRET_ENV,
  checkSameOrigin,
  isVouchedLocal,
} from "../sameOrigin";

function request(
  headers: Record<string, string>,
  url = "http://localhost:3000/api/agent/chat",
  method = "POST"
): Request {
  return new Request(url, { method, headers });
}

/** What server.js stamps on a loopback connection. */
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
/** The stamp server.js adds to a request that came over a loopback connection. */
const STAMP = { [AGENT_LOCAL_HEADER]: SECRET };

const get = (headers: Record<string, string>, url = "http://localhost:3000/api/agent/status") =>
  request(headers, url, "GET");

/** The page's own fetch, over a loopback connection that server.js stamped. */
const fromPage = (host: string, extra: Record<string, string> = {}) =>
  request({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin", ...STAMP, ...extra });

// server.js sets the secret; tests that need a server that doesn't vouch delete it.
beforeEach(() => {
  process.env[AGENT_LOCAL_SECRET_ENV] = SECRET;
});

afterEach(() => {
  delete process.env[AGENT_ALLOWED_HOSTS_ENV];
  delete process.env[AGENT_LOCAL_SECRET_ENV];
});

describe("checkSameOrigin: accepts", () => {
  it("a fetch from Node Banana's own page", () => {
    expect(checkSameOrigin(fromPage("localhost:3000"))).toEqual({ ok: true });
  });

  it("the page served on 127.0.0.1, another 127/8 address, [::1] or a *.localhost name", () => {
    for (const host of ["127.0.0.1:3000", "127.0.1.1:3000", "[::1]:3000", "banana.localhost:3000"]) {
      expect(checkSameOrigin(fromPage(host)), host).toEqual({ ok: true });
    }
  });

  it("the page's own requests as Next.js hands them over, with the loopback peer it recorded", () => {
    for (const peer of ["::1", "127.0.0.1", "::ffff:127.0.0.1", "[::1]:52011", "127.0.0.1, ::1"]) {
      expect(checkSameOrigin(fromPage("localhost:3000", { "x-forwarded-for": peer })), peer).toEqual({ ok: true });
    }
  });

  it("the panel's status poll: a same-origin GET carries Sec-Fetch-Site but no Origin", () => {
    expect(checkSameOrigin(get({ host: "localhost:3000", "sec-fetch-site": "same-origin", ...STAMP }))).toEqual({
      ok: true,
    });
  });

  it("a status URL the user typed into the address bar (Sec-Fetch-Site: none)", () => {
    expect(checkSameOrigin(get({ host: "localhost:3000", "sec-fetch-site": "none", ...STAMP }))).toEqual({ ok: true });
  });

  it("a GET whose only browser signal is a same-host Referer (a browser without Fetch Metadata)", () => {
    expect(checkSameOrigin(get({ host: "localhost:3000", referer: "http://localhost:3000/", ...STAMP }))).toEqual({
      ok: true,
    });
  });

  it("a same-origin GET over plain http to an allowed LAN name, which only has a Referer to show", () => {
    process.env[AGENT_ALLOWED_HOSTS_ENV] = "studio.lan";
    const req = get(
      { host: "studio.lan:3000", referer: "http://studio.lan:3000/", "x-forwarded-for": "192.168.1.30" },
      "http://studio.lan:3000/api/agent/status"
    );
    expect(checkSameOrigin(req)).toEqual({ ok: true });
  });

  it("a script on this machine that sends the page's Origin, with the secret passed in the options", () => {
    delete process.env[AGENT_LOCAL_SECRET_ENV];
    expect(
      checkSameOrigin(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", ...STAMP }), {
        localSecret: SECRET,
      })
    ).toEqual({ ok: true });
  });

  it("an older browser that sends Origin but no Fetch Metadata", () => {
    expect(checkSameOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000", ...STAMP }))).toEqual({
      ok: true,
    });
  });

  it("host names that differ only in case", () => {
    expect(checkSameOrigin(request({ host: "LocalHost:3000", origin: "http://localhost:3000", ...STAMP }))).toEqual({
      ok: true,
    });
  });

  it("the default port written out in the Host header but not in the Origin", () => {
    // Browsers drop :80 from Origin; Host normally drops it too, and URL parsing
    // of the Origin normalises it away either way.
    expect(checkSameOrigin(request({ host: "localhost", origin: "http://localhost:80", ...STAMP }))).toEqual({
      ok: true,
    });
  });

  it("the Host from the URL when a bare Request carries no Host header", () => {
    expect(checkSameOrigin(request({ origin: "http://localhost:3000", ...STAMP }))).toEqual({ ok: true });
  });

  it("an extra host listed in NB_AGENT_ALLOWED_HOSTS, from another machine", () => {
    process.env[AGENT_ALLOWED_HOSTS_ENV] = "studio.lan, other.lan, 192.168.1.20";
    // No stamp: the server saw another machine.
    const lan = (host: string) =>
      request({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin", "x-forwarded-for": "192.168.1.30" });
    expect(checkSameOrigin(lan("studio.lan:3000"))).toEqual({ ok: true });
    expect(checkSameOrigin(lan("192.168.1.20:3000"))).toEqual({ ok: true });
  });

  it("an extra host listed on a server that doesn't vouch (plain next start): the owner opted in", () => {
    delete process.env[AGENT_LOCAL_SECRET_ENV];
    const req = request({ host: "studio.lan:3000", origin: "http://studio.lan:3000", "sec-fetch-site": "same-origin" });
    expect(checkSameOrigin(req, { allowedHosts: ["studio.lan"] })).toEqual({ ok: true });
  });

  it("an extra host passed in the options", () => {
    expect(checkSameOrigin(fromPage("studio.lan:3000"), { allowedHosts: ["studio.lan"] })).toEqual({ ok: true });
  });
});

describe("checkSameOrigin: rejects", () => {
  const rejected = (req: Request, options?: Parameters<typeof checkSameOrigin>[1]) => {
    const result = checkSameOrigin(req, options);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("a cross-site request", () => {
    const reason = rejected(
      request({ host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" })
    );
    expect(reason).toContain("cross-site");
  });

  it("another app on the same site (another localhost port)", () => {
    const reason = rejected(
      request({ host: "localhost:3000", origin: "http://localhost:5173", "sec-fetch-site": "same-site" })
    );
    expect(reason).toContain("same-site");
  });

  it("an Origin for another host, even without Fetch Metadata", () => {
    expect(rejected(request({ host: "localhost:3000", origin: "https://evil.example" }))).toContain(
      "https://evil.example"
    );
  });

  it("an Origin on another port of the same host", () => {
    expect(rejected(request({ host: "localhost:3000", origin: "http://localhost:3001" }))).toContain(
      "http://localhost:3001"
    );
  });

  it("an opaque origin (sandboxed iframe, file:// page)", () => {
    expect(rejected(request({ host: "localhost:3000", origin: "null" }))).toContain("opaque origin");
    expect(rejected(request({ host: "localhost:3000", origin: "file:///Users/me/page.html" }))).toContain(
      "opaque origin"
    );
  });

  it("an Origin that is not a URL", () => {
    expect(rejected(request({ host: "localhost:3000", origin: "not a url" }))).toContain("opaque origin");
  });

  it("a DNS-rebinding page whose origin and Host agree on a foreign name", () => {
    const reason = rejected(fromPage("rebind.evil.example:3000"));
    expect(reason).toContain("rebind.evil.example");
    expect(reason).toContain(AGENT_ALLOWED_HOSTS_ENV);
  });

  it("a foreign name even when no browser headers are sent", () => {
    rejected(request({ host: "rebind.evil.example:3000" }, "http://rebind.evil.example:3000/api/agent/chat"));
  });

  it("a name that is only allowed with a different spelling", () => {
    rejected(fromPage("studio.lan.evil.example:3000"), { allowedHosts: ["studio.lan"] });
  });

  it("the machine's LAN address unless it is listed, even from a browser page", () => {
    for (const host of ["192.168.1.5:3000", "10.0.0.8:3000", "[fe80::1]:3000", "0.0.0.0:3000"]) {
      const reason = rejected(fromPage(host));
      expect(reason, host).toContain(AGENT_ALLOWED_HOSTS_ENV);
    }
  });

  it("curl from the LAN: the LAN address as Host and no browser headers", () => {
    const reason = rejected(request({ host: "192.168.1.5:3000" }, "http://192.168.1.5:3000/api/agent/chat"));
    expect(reason).toContain("192.168.1.5");
  });

  it("a request from another machine that claims Host: localhost (no stamp), whatever X-Forwarded-For says", () => {
    const forged = { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
    for (const peer of ["192.168.4.30", "::ffff:192.168.4.30", "127.0.0.1, 192.168.4.30", "fe80::1", "127.0.0.1", "::1"]) {
      const reason = rejected(request({ ...forged, "x-forwarded-for": peer }));
      expect(reason, peer).toContain("another machine");
    }
  });

  it("every localhost request on a server that doesn't vouch (plain next dev / next start): X-Forwarded-For can be forged", () => {
    delete process.env[AGENT_LOCAL_SECRET_ENV];
    // What a LAN client sends to `next start` to pass as local.
    const forged = {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "127.0.0.1",
    };
    const reason = rejected(request(forged));
    expect(reason).toContain("npm run dev");
    // A client-sent stamp proves nothing without a secret.
    rejected(request({ ...forged, [AGENT_LOCAL_HEADER]: SECRET }));
    rejected(get({ host: "localhost:3000", "sec-fetch-site": "same-origin" }));
  });

  it("a stamped request with no browser signal: the app's own server-side fetch to 127.0.0.1, or curl", () => {
    // Node's fetch sends neither Origin, Sec-Fetch-Site nor Referer.
    const serverSide = { host: "127.0.0.1:3000", accept: "*/*", "sec-fetch-mode": "cors", "user-agent": "node", ...STAMP };
    expect(rejected(get(serverSide, "http://127.0.0.1:3000/api/agent/status"))).toContain(
      "did not come from a browser page"
    );
    expect(rejected(request(serverSide, "http://127.0.0.1:3000/api/agent/chat"))).toContain(
      "did not come from a browser page"
    );
    rejected(request({ host: "localhost:3000", "content-type": "application/json", ...STAMP }));
  });

  it("a POST whose only browser signal is Sec-Fetch-Site: none or a Referer", () => {
    rejected(request({ host: "localhost:3000", "sec-fetch-site": "none", ...STAMP }));
    rejected(request({ host: "localhost:3000", referer: "http://localhost:3000/", ...STAMP }));
  });

  it("a GET with no browser signal, or a Referer from another site", () => {
    rejected(get({ host: "localhost:3000", ...STAMP }));
    rejected(get({ host: "localhost:3000", referer: "https://evil.example/", ...STAMP }));
    rejected(get({ host: "localhost:3000", referer: "http://localhost:5173/", ...STAMP }));
  });

  it("a wrong or empty copy of the server's stamp", () => {
    rejected(fromPage("localhost:3000", { [AGENT_LOCAL_HEADER]: "1" }));
    rejected(fromPage("localhost:3000", { [AGENT_LOCAL_HEADER]: `${SECRET.slice(0, -1)}0` }));
    rejected(fromPage("localhost:3000", { [AGENT_LOCAL_HEADER]: "" }));
  });

  it("a browser page without the server's stamp (another machine)", () => {
    const reason = rejected(
      request({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })
    );
    expect(reason).toContain("another machine");
    expect(checkSameOrigin(fromPage("localhost:3000"))).toEqual({ ok: true });
  });

  it("a stamp checked against a secret too short to trust", () => {
    process.env[AGENT_LOCAL_SECRET_ENV] = "short";
    rejected(fromPage("localhost:3000", { [AGENT_LOCAL_HEADER]: "short" }));
  });

  it("a stamped request that still fails a browser check (a rebinding page on this machine)", () => {
    rejected(fromPage("rebind.evil.example:3000"));
    rejected(request({ host: "localhost:3000", origin: "https://evil.example", ...STAMP }));
  });
});

describe("isVouchedLocal", () => {
  it("is true only for the configured secret", () => {
    const stamped = (value: string) => request({ host: "localhost:3000", [AGENT_LOCAL_HEADER]: value });

    delete process.env[AGENT_LOCAL_SECRET_ENV];
    expect(isVouchedLocal(stamped(SECRET))).toBe(false);
    expect(isVouchedLocal(stamped(SECRET), SECRET)).toBe(true);
    expect(isVouchedLocal(stamped("nope"), SECRET)).toBe(false);
    expect(isVouchedLocal(request({ host: "localhost:3000" }), SECRET)).toBe(false);

    process.env[AGENT_LOCAL_SECRET_ENV] = SECRET;
    expect(isVouchedLocal(stamped(SECRET))).toBe(true);
  });
});
