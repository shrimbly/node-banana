// @vitest-environment node
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("local API isolation from the Next image optimizer", () => {
  it("disables internal image proxying, including requests to non-image APIs", () => {
    // Next checks this before fetching the requested local URL. Merely omitting
    // next/image components does not disable the /_next/image HTTP endpoint.
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
