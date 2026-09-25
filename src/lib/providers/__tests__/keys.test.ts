import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { providerKeysFromHeaders } from "../keys";

const ENV_KEYS = [
  "REPLICATE_API_KEY",
  "FAL_API_KEY",
  "KIE_API_KEY",
  "WAVESPEED_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
];

const originalEnv = { ...process.env };

describe("providerKeysFromHeaders", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns an empty object when no header or env key is set", () => {
    expect(providerKeysFromHeaders(new Headers())).toEqual({});
  });

  it("reads every provider's header", () => {
    const keys = providerKeysFromHeaders(
      new Headers({
        "X-Replicate-Key": "rep",
        "X-Fal-Key": "fal",
        "X-Kie-Key": "kie",
        "X-WaveSpeed-Key": "ws",
        "X-OpenAI-API-Key": "oai",
        "X-Gemini-API-Key": "gem",
        "X-Comfy-Router-Key": "comfy",
      })
    );
    expect(keys).toEqual({
      replicate: "rep",
      fal: "fal",
      kie: "kie",
      wavespeed: "ws",
      openai: "oai",
      gemini: "gem",
      comfy: "comfy",
    });
  });

  it("falls back to env variables", () => {
    process.env.REPLICATE_API_KEY = "env-rep";
    process.env.FAL_API_KEY = "env-fal";
    process.env.KIE_API_KEY = "env-kie";
    process.env.WAVESPEED_API_KEY = "env-ws";
    process.env.OPENAI_API_KEY = "env-oai";
    process.env.GEMINI_API_KEY = "env-gem";
    process.env.COMFY_API_KEY = "env-comfy";
    expect(providerKeysFromHeaders(new Headers())).toEqual({
      replicate: "env-rep",
      fal: "env-fal",
      kie: "env-kie",
      wavespeed: "env-ws",
      openai: "env-oai",
      gemini: "env-gem",
      comfy: "env-comfy",
    });
  });

  it("prefers the header over the env variable", () => {
    process.env.REPLICATE_API_KEY = "env-rep";
    process.env.GEMINI_API_KEY = "env-gem";
    process.env.COMFY_API_KEY = "env-comfy";
    const keys = providerKeysFromHeaders(
      new Headers({ "X-Replicate-Key": "hdr-rep", "X-Gemini-API-Key": "hdr-gem", "X-Comfy-Router-Key": "hdr-comfy" })
    );
    expect(keys.replicate).toBe("hdr-rep");
    expect(keys.gemini).toBe("hdr-gem");
    expect(keys.comfy).toBe("hdr-comfy");
  });

  it("accepts the generate route's spellings for Replicate and fal.ai", () => {
    const keys = providerKeysFromHeaders(
      new Headers({ "X-Replicate-API-Key": "rep-api", "X-Fal-API-Key": "fal-api" })
    );
    expect(keys.replicate).toBe("rep-api");
    expect(keys.fal).toBe("fal-api");
  });

  it("prefers the models route's spelling when both are sent", () => {
    const keys = providerKeysFromHeaders(
      new Headers({
        "X-Replicate-Key": "rep",
        "X-Replicate-API-Key": "rep-api",
        "X-Fal-Key": "fal",
        "X-Fal-API-Key": "fal-api",
      })
    );
    expect(keys.replicate).toBe("rep");
    expect(keys.fal).toBe("fal");
  });

  it("treats an empty header as absent and falls back to env", () => {
    process.env.KIE_API_KEY = "env-kie";
    expect(providerKeysFromHeaders(new Headers({ "X-Kie-Key": "" })).kie).toBe("env-kie");
  });

  it("resolves the Comfy key from COMFY_API_KEY, then COMFY_CLOUD_API_KEY", () => {
    process.env.COMFY_CLOUD_API_KEY = "cloud";
    expect(providerKeysFromHeaders(new Headers()).comfy).toBe("cloud");
    process.env.COMFY_API_KEY = "router";
    expect(providerKeysFromHeaders(new Headers()).comfy).toBe("router");
  });
});
