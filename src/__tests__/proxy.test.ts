import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

function request(headers: Record<string, string> = {}, method = "POST", url = "http://localhost:3000/api/workflow") {
  return new NextRequest(url, { method, headers });
}

describe("API browser origin boundary", () => {
  it("blocks a simple cross-origin JSON POST before the file-writing route runs", () => {
    const req = new NextRequest("http://localhost:3000/api/workflow", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: JSON.stringify({ directoryPath: "/Users/test/project", filename: "workflow", workflow: {} }),
    });
    expect(proxy(req).status).toBe(403);
  });

  it.each(["null", "invalid origin", "http://localhost:4000", "https://localhost:3000"])(
    "rejects untrusted Origin %s even without Fetch Metadata", (origin) => {
      expect(proxy(request({ origin })).status).toBe(403);
    }
  );

  it.each(["cross-site", "same-site"])("blocks %s GET requests to the native picker", (site) => {
    expect(proxy(request({ "sec-fetch-site": site }, "GET", "http://localhost:3000/api/browse-directory")).status).toBe(403);
  });

  it("allows same-origin UI requests", () => {
    expect(proxy(request({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("uses the browser Host when Next's internal listening hostname differs", () => {
    expect(proxy(request({ host: "localhost:3000", origin: "http://localhost:3000" }, "POST", "http://127.0.0.1:3000/api/workflow")).status).toBe(200);
  });

  it("allows same-origin HTTPS deployments behind a proxy", () => {
    expect(proxy(request({ host: "banana.example", origin: "https://banana.example" }, "POST", "https://internal:3000/api/generate")).status).toBe(200);
  });

  it("does not trust X-Forwarded-Host to excuse a foreign Origin", () => {
    expect(proxy(request({ host: "localhost:3000", "x-forwarded-host": "attacker.example", origin: "http://attacker.example" })).status).toBe(403);
  });

  it("allows CLI requests without browser headers", () => {
    expect(proxy(request()).status).toBe(200);
  });

  it("allows provider image downloads without browser headers", () => {
    expect(proxy(request({}, "GET", "http://localhost:3000/api/images/random-id")).status).toBe(200);
  });
});
