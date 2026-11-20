import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MagnificInput } from "../bindings";
import { INLINE_IMAGE_BYTES, chooseEncoding, clearMagnificUploads, encodeMagnificMedia, normaliseType, uploadToMagnific } from "../media";

const PNG_B64 = "iVBORw0KGgo=";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

const handle = (overrides: Partial<MagnificInput>): MagnificInput => ({ name: "image", type: "image", required: true, label: "Image", ...overrides });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SLOT = {
  files: [
    {
      upload_url: "https://storage.example.com/put/abc?sig=1",
      headers: { "Content-Type": "image/png", "x-goog-content-length-range": "0,1073741824" },
      file_id: "upl_abc",
      asset_url: "https://cdn.example.com/uploads/abc?token=1",
      expires_in: 120,
      asset_url_expires_in: 86400,
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearMagnificUploads();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chooseEncoding", () => {
  it("keeps a field's one way in", () => {
    expect(chooseEncoding(handle({ encoding: "base64" }), ["https://example.com/a.png"])).toBe("base64");
    expect(chooseEncoding(handle({ encoding: "url" }), [PNG_URL])).toBe("url");
  });

  it("sends a small image inline where the field takes either", () => {
    expect(chooseEncoding(handle({ encoding: "either" }), [PNG_URL])).toBe("base64");
  });

  it("sends by URL anything already at one, anything large, and any video or audio", () => {
    expect(chooseEncoding(handle({ encoding: "either" }), [PNG_URL, "https://example.com/a.png"])).toBe("url");
    const large = `data:image/png;base64,${"A".repeat(Math.ceil((INLINE_IMAGE_BYTES * 4) / 3) + 8)}`;
    expect(chooseEncoding(handle({ encoding: "either" }), [large])).toBe("url");
    expect(chooseEncoding(handle({ type: "video", encoding: "either" }), ["data:video/mp4;base64,AAAA"])).toBe("url");
  });
});

describe("normaliseType", () => {
  it("spells a type the way the upload step lists it", () => {
    expect(normaliseType("image/jpg")).toBe("image/jpeg");
    expect(normaliseType("audio/mp3")).toBe("audio/mpeg");
    expect(normaliseType("audio/x-wav; charset=binary")).toBe("audio/wav");
    expect(normaliseType("image/png")).toBe("image/png");
  });
});

describe("uploadToMagnific", () => {
  it("asks for a slot, PUTs the bytes with every header it named, and returns the asset URL", async () => {
    fetchMock.mockResolvedValueOnce(json(SLOT)).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const url = await uploadToMagnific("key", { bytes: Buffer.from(PNG_B64, "base64"), mime: "image/png" });
    expect(url).toBe("https://cdn.example.com/uploads/abc?token=1");

    const [slotUrl, slotInit] = fetchMock.mock.calls[0]!;
    expect(slotUrl).toBe("https://api.magnific.com/v1/ai/uploads/request-url");
    expect(slotInit.method).toBe("POST");
    expect(slotInit.headers["x-magnific-api-key"]).toBe("key");
    expect(JSON.parse(slotInit.body)).toEqual({ files: [{ content_type: "image/png" }] });

    const [putUrl, putInit] = fetchMock.mock.calls[1]!;
    expect(putUrl).toBe("https://storage.example.com/put/abc?sig=1");
    expect(putInit.method).toBe("PUT");
    expect(putInit.headers).toEqual({ "Content-Type": "image/png", "x-goog-content-length-range": "0,1073741824" });
    expect(Buffer.from(putInit.body).toString("base64")).toBe(PNG_B64);
    // The key goes to Magnific only, never to the storage host.
    expect(putInit.headers["x-magnific-api-key"]).toBeUndefined();
  });

  it("reuses the first upload of the same bytes", async () => {
    fetchMock.mockResolvedValueOnce(json(SLOT)).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const media = { bytes: Buffer.from(PNG_B64, "base64"), mime: "image/png" };
    await uploadToMagnific("key", media);
    await uploadToMagnific("key", media);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a type the upload step does not take, before any request", async () => {
    await expect(uploadToMagnific("key", { bytes: Buffer.from("x"), mime: "image/gif" })).rejects.toThrow(/cannot take a image\/gif/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refused slot and a failed PUT", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "nope" }, 401));
    await expect(uploadToMagnific("key", { bytes: Buffer.from("a"), mime: "image/png" })).rejects.toThrow(/refused the upload.*401/);
    fetchMock.mockResolvedValueOnce(json(SLOT)).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(uploadToMagnific("key", { bytes: Buffer.from("b"), mime: "image/png" })).rejects.toThrow(/failed \(403\)/);
  });

  it("will not PUT to a URL that is not public https", async () => {
    fetchMock.mockResolvedValueOnce(json({ files: [{ ...SLOT.files[0], upload_url: "http://127.0.0.1/put" }] }));
    await expect(uploadToMagnific("key", { bytes: Buffer.from("c"), mime: "image/png" })).rejects.toThrow(/will not use/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("encodeMagnificMedia", () => {
  it("base64: a data URL's own bytes, no request", async () => {
    const value = await encodeMagnificMedia(PNG_URL, "base64", "key");
    expect(value).toMatchObject({ base64: PNG_B64, mime: "image/png" });
    expect(value.url).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("url: a data URL is uploaded", async () => {
    fetchMock.mockResolvedValueOnce(json(SLOT)).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const value = await encodeMagnificMedia(PNG_URL, "url", "key");
    expect(value.url).toBe("https://cdn.example.com/uploads/abc?token=1");
  });

  it("url: a value already at a URL passes through, its type read from the name", async () => {
    const value = await encodeMagnificMedia("https://example.com/out/frame.JPG?x=1", "url", "key", { needsMime: true });
    expect(value).toEqual({ url: "https://example.com/out/frame.JPG?x=1", mime: "image/jpeg" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("url: a type the name does not give is asked of the file, when the request must name it", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "image/webp" } }));
    const value = await encodeMagnificMedia("https://example.com/out/123", "url", "key", { needsMime: true });
    expect(value).toEqual({ url: "https://example.com/out/123", mime: "image/webp" });
  });

  it("base64: a value at a URL is downloaded", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/png" } }));
    const value = await encodeMagnificMedia("https://example.com/a.png", "base64", "key");
    expect(value.base64).toBe(PNG_B64);
  });

  it("refuses a value that is neither", async () => {
    await expect(encodeMagnificMedia("blob:whatever", "base64", "key")).rejects.toThrow(/neither a data URL nor an http URL/);
  });
});
