import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMFY_HEADERS } from "../../settings";
import { connectionFromRequest, engineAuthHeaders, orgKeyFromRequest } from "../connection";

function request(baseUrl?: string, extra: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/comfy/run", {
    headers: { ...(baseUrl ? { [COMFY_HEADERS.baseUrl]: baseUrl } : {}), ...extra },
  });
}

describe("Comfy server credential destinations", () => {
  beforeEach(() => {
    vi.stubEnv("COMFY_MODE", "remote");
    vi.stubEnv("COMFY_REMOTE_URL", "https://trusted.example/comfy");
    vi.stubEnv("COMFY_LOCAL_URL", "");
    vi.stubEnv("COMFY_CLOUD_URL", "");
    vi.stubEnv("COMFY_CLOUD_API_KEY", "cloud-secret");
    vi.stubEnv("COMFY_API_KEY", "engine-secret");
    vi.stubEnv("COMFY_ORG_API_KEY", "partner-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "https://attacker.example",
    "https://trusted.example/other-tenant",
    "http://trusted.example/comfy",
    "https://trusted.example:8443/comfy",
    "http://127.0.0.1:8188",
  ])("does not forward environment credentials to request-selected %s", (baseUrl) => {
    const req = request(baseUrl);
    const connection = connectionFromRequest(req);
    expect(connection.baseUrl).toBe(baseUrl);
    expect(connection.apiKey).toBeNull();
    expect(engineAuthHeaders(connection)).toEqual({});
    expect(orgKeyFromRequest(req, connection)).toBeNull();
  });

  it("retains headless environment configuration", () => {
    const req = request();
    const connection = connectionFromRequest(req);
    expect(connection.apiKey).toBe("engine-secret");
    expect(orgKeyFromRequest(req, connection)).toBe("partner-secret");
  });

  it("retains environment fallbacks for the same configured endpoint", () => {
    const req = request("https://TRUSTED.example:443/comfy/");
    const connection = connectionFromRequest(req);
    expect(connection.apiKey).toBe("engine-secret");
    expect(orgKeyFromRequest(req, connection)).toBe("partner-secret");
  });

  it("permits explicit browser keys and arbitrary local engines", () => {
    const req = request("http://127.0.0.1:8188", {
      [COMFY_HEADERS.mode]: "local",
      [COMFY_HEADERS.apiKey]: "browser-engine-key",
      [COMFY_HEADERS.orgKey]: "browser-partner-key",
    });
    const connection = connectionFromRequest(req);
    expect(connection.mode).toBe("local");
    expect(connection.apiKey).toBe("browser-engine-key");
    expect(orgKeyFromRequest(req, connection)).toBe("browser-partner-key");
  });

  it("uses an explicit browser key for partner nodes when targeting another engine", () => {
    const req = request("https://another.example", { [COMFY_HEADERS.apiKey]: "browser-key" });
    expect(orgKeyFromRequest(req, connectionFromRequest(req))).toBe("browser-key");
  });

  it("uses the cloud environment key only for the configured cloud endpoint", () => {
    vi.stubEnv("COMFY_MODE", "cloud");
    const req = request("https://cloud.comfy.org");
    expect(connectionFromRequest(req).apiKey).toBe("cloud-secret");
    const other = request("https://attacker.example");
    expect(connectionFromRequest(other).apiKey).toBeNull();
    expect(orgKeyFromRequest(other, connectionFromRequest(other))).toBeNull();
  });

  it("does not disclose environment keys when no local endpoint is configured", () => {
    vi.stubEnv("COMFY_MODE", "local");
    const req = request("http://127.0.0.1:8188");
    const connection = connectionFromRequest(req);
    expect(connection.apiKey).toBeNull();
    expect(orgKeyFromRequest(req, connection)).toBeNull();
  });
});
