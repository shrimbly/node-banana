// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { COMFY_HEADERS } from "@/lib/comfy/settings";
import { connectionFromRequest, orgKeyFromRequest } from "../connection";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://test.local/api/comfy/run", { headers });
}

const ENV_KEYS = [
  "COMFY_MODE",
  "COMFY_API_KEY",
  "COMFY_API_V2",
  "COMFY_ORG_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "COMFY_CLOUD_URL",
  "COMFY_LOCAL_URL",
  "COMFY_REMOTE_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("connectionFromRequest", () => {
  it("does not attach the server's key to a caller-supplied engine URL", () => {
    process.env.COMFY_API_KEY = "server-side-secret";

    const connection = connectionFromRequest(
      requestWith({
        [COMFY_HEADERS.mode]: "remote",
        [COMFY_HEADERS.baseUrl]: "http://169.254.169.254",
      })
    );

    expect(connection.baseUrl).toBe("http://169.254.169.254");
    expect(connection.apiKey).toBeNull();
  });

  it("uses the caller's own key when the caller supplies one", () => {
    process.env.COMFY_API_KEY = "server-side-secret";

    const connection = connectionFromRequest(
      requestWith({
        [COMFY_HEADERS.baseUrl]: "http://127.0.0.1:8188",
        [COMFY_HEADERS.apiKey]: "callers-own-key",
      })
    );

    expect(connection.apiKey).toBe("callers-own-key");
  });

  it("still uses the environment when no engine URL is supplied", () => {
    process.env.COMFY_MODE = "remote";
    process.env.COMFY_REMOTE_URL = "http://comfy.internal:8188";
    process.env.COMFY_API_KEY = "server-side-secret";

    const connection = connectionFromRequest(requestWith({}));

    expect(connection.baseUrl).toBe("http://comfy.internal:8188");
    expect(connection.apiKey).toBe("server-side-secret");
  });
});

describe("orgKeyFromRequest", () => {
  it("does not fall back to the server's org key for a caller-supplied engine", () => {
    process.env.COMFY_API_KEY = "server-side-secret";
    process.env.COMFY_ORG_API_KEY = "server-side-org-secret";

    const request = requestWith({
      [COMFY_HEADERS.baseUrl]: "http://169.254.169.254",
    });
    const connection = connectionFromRequest(request);

    expect(orgKeyFromRequest(request, connection)).toBeNull();
  });

  it("uses the caller's org key when supplied", () => {
    process.env.COMFY_ORG_API_KEY = "server-side-org-secret";

    const request = requestWith({
      [COMFY_HEADERS.baseUrl]: "http://127.0.0.1:8188",
      [COMFY_HEADERS.orgKey]: "callers-org-key",
    });
    const connection = connectionFromRequest(request);

    expect(orgKeyFromRequest(request, connection)).toBe("callers-org-key");
  });

  it("still uses the environment org key for an env-configured engine", () => {
    process.env.COMFY_MODE = "remote";
    process.env.COMFY_REMOTE_URL = "http://comfy.internal:8188";
    process.env.COMFY_ORG_API_KEY = "server-side-org-secret";

    const request = requestWith({});
    const connection = connectionFromRequest(request);

    expect(orgKeyFromRequest(request, connection)).toBe("server-side-org-secret");
  });
});
