import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

describe("GET /api/env-status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports whether METASO_API_KEY is configured", async () => {
    vi.stubEnv("METASO_API_KEY", "test-metaso-key");

    const response = await GET();
    const status = await response.json();

    expect(status.metaso).toBe(true);
  });

  it("reports Metaso as unconfigured when the key is absent", async () => {
    vi.stubEnv("METASO_API_KEY", "");

    const response = await GET();
    const status = await response.json();

    expect(status.metaso).toBe(false);
  });
});
