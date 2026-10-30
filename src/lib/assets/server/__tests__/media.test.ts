// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { decideMediaType, imageDimensions, imageDimensionsFromFile, probeAudioVideo, sniffFamily } from "../media";
import { loadSharp } from "../thumbs";
import { makePng, makeWav, tempDir, TINY_MP4 } from "./helpers";

const dir = tempDir("nb-assets-media-");

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ftyp(brand: string): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftyp", 4, "latin1");
  box.write(brand, 8, "latin1");
  return box;
}

describe("sniffFamily", () => {
  it("recognises the allowlisted formats by their magic bytes", () => {
    expect(sniffFamily(makePng())).toEqual(["png"]);
    expect(sniffFamily(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual(["jpg"]);
    expect(sniffFamily(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toEqual(["gif"]);
    expect(sniffFamily(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toEqual(["webp"]);
    expect(sniffFamily(makeWav())).toEqual(["wav"]);
    expect(sniffFamily(ftyp("qt  "))).toEqual(["mov"]);
    expect(sniffFamily(ftyp("M4A "))).toEqual(["m4a", "mp4"]);
    expect(sniffFamily(TINY_MP4)).toEqual(["mp4", "m4a"]);
    expect(sniffFamily(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toEqual(["webm"]);
    expect(sniffFamily(Buffer.from("OggS\0\0", "latin1"))).toEqual(["ogg"]);
    expect(sniffFamily(Buffer.from("fLaC\0\0", "latin1"))).toEqual(["flac"]);
    expect(sniffFamily(Buffer.from("ID3\x04\0\0", "latin1"))).toEqual(["mp3"]);
    expect(sniffFamily(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toEqual(["mp3"]);
    expect(sniffFamily(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toEqual(["aac"]);
    expect(sniffFamily(Buffer.from("glTF\x02\0\0\0", "latin1"))).toEqual(["glb"]);
    expect(sniffFamily(Buffer.from('﻿  <?xml version="1.0"?><svg width="10" height="5"></svg>'))).toEqual(["svg"]);
    expect(sniffFamily(Buffer.from("just some text"))).toBeNull();
  });
});

describe("decideMediaType", () => {
  it("trusts bytes over the client's hint", () => {
    expect(decideMediaType({ head: makePng(), kind: "image", hintMime: "image/jpeg" })).toMatchObject({ ext: "png", sniffed: true });
  });

  it("uses the declared kind to pick within a container", () => {
    expect(decideMediaType({ head: TINY_MP4, kind: "audio" })).toMatchObject({ ext: "m4a", mime: "audio/mp4" });
    expect(decideMediaType({ head: TINY_MP4, kind: "video" })).toMatchObject({ ext: "mp4", kind: "video" });
  });

  it("corrects the kind when a video node returned an image", () => {
    expect(decideMediaType({ head: makePng(), kind: "video" })).toMatchObject({ ext: "png", kind: "image" });
  });

  it("falls back to the hint, the URL extension, then the kind's default", () => {
    const text = Buffer.from("v 0 0 0\nv 1 0 0\n");
    expect(decideMediaType({ head: text, kind: "3d", hintMime: "model/obj" })).toMatchObject({ ext: "obj", sniffed: false });
    expect(decideMediaType({ head: text, kind: "3d", hintMime: "model/obj" })).not.toHaveProperty("assumed");
    expect(decideMediaType({ head: text, kind: "3d", hintExt: "stl" })).toMatchObject({ ext: "stl" });
    // Nothing named it: the kind's default, said to be assumed
    expect(decideMediaType({ head: text, kind: "3d" })).toMatchObject({ ext: "glb", assumed: true });
    expect(decideMediaType({ head: text, kind: "video", hintMime: "video/x-msvideo" })).toMatchObject({ ext: "mp4", assumed: true });
  });

  it("stores AVIF and HEIC stills as images, not mp4 video", () => {
    const withCompatible = (major: string, ...compatible: string[]) => {
      const box = Buffer.alloc(16 + compatible.length * 4);
      box.writeUInt32BE(box.length, 0);
      box.write("ftyp", 4, "latin1");
      box.write(major, 8, "latin1");
      compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, "latin1"));
      return box;
    };
    expect(decideMediaType({ head: ftyp("avif"), kind: "image" })).toMatchObject({ ext: "avif", mime: "image/avif", kind: "image" });
    expect(decideMediaType({ head: ftyp("heic"), kind: "image" })).toMatchObject({ ext: "heic", mime: "image/heic", kind: "image" });
    expect(sniffFamily(ftyp("avis"))).toEqual(["avif"]);
    expect(sniffFamily(ftyp("heix"))).toEqual(["heic"]);
    expect(sniffFamily(withCompatible("mif1", "mif1", "miaf", "avif"))).toEqual(["avif"]);
    expect(sniffFamily(withCompatible("msf1", "msf1", "heic"))).toEqual(["heic"]);
    // Even a video node's result: the bytes say image.
    expect(decideMediaType({ head: ftyp("avif"), kind: "video" })).toMatchObject({ ext: "avif", kind: "image" });
    expect(sniffFamily(withCompatible("isom", "isom", "avc1"))).toEqual(["mp4", "m4a"]);
    expect(decideMediaType({ head: Buffer.alloc(0), kind: "image", hintMime: "image/heif" })).toMatchObject({ ext: "heic" });
  });

  it("treats a zip as usdz only for 3D", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(decideMediaType({ head: zip, kind: "3d" })).toMatchObject({ ext: "usdz" });
    expect(decideMediaType({ head: zip, kind: "image" })).toMatchObject({ ext: "png", sniffed: false });
  });
});

describe("image dimensions", () => {
  it("reads PNG and GIF headers", () => {
    expect(imageDimensions(makePng(17, 9), "png")).toEqual({ width: 17, height: 9 });
    const gif = Buffer.from("GIF89a", "latin1");
    const size = Buffer.alloc(4);
    size.writeUInt16LE(31, 0);
    size.writeUInt16LE(7, 2);
    expect(imageDimensions(Buffer.concat([gif, size, Buffer.alloc(4)]), "gif")).toEqual({ width: 31, height: 7 });
  });

  it("reads SVG width/height or viewBox", () => {
    expect(imageDimensions(Buffer.from('<svg width="120px" height="80">'), "svg")).toEqual({ width: 120, height: 80 });
    expect(imageDimensions(Buffer.from('<svg viewBox="0 0 300 150">'), "svg")).toEqual({ width: 300, height: 150 });
  });

  it("returns null for truncated headers instead of throwing", () => {
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "jpg")).toBeNull();
    expect(imageDimensions(Buffer.alloc(3), "png")).toBeNull();
  });

  it("matches sharp for JPEG, WebP (lossy, lossless, extended) and EXIF-rotated JPEG", async () => {
    const sharp = await loadSharp();
    if (!sharp) return;
    const raw = { create: { width: 37, height: 21, channels: 3 as const, background: { r: 200, g: 10, b: 10 } } };
    const jpeg = await sharp(raw).jpeg().toBuffer();
    const lossy = await sharp(raw).webp({ lossless: false }).toBuffer();
    const lossless = await sharp(raw).webp({ lossless: true }).toBuffer();
    const alpha = await sharp({ create: { ...raw.create, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
      .webp()
      .toBuffer();
    const rotated = await sharp(raw).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(imageDimensions(jpeg, "jpg")).toEqual({ width: 37, height: 21 });
    expect(imageDimensions(lossy, "webp")).toEqual({ width: 37, height: 21 });
    expect(imageDimensions(lossless, "webp")).toEqual({ width: 37, height: 21 });
    expect(imageDimensions(alpha, "webp")).toEqual({ width: 37, height: 21 });
    expect(imageDimensions(rotated, "jpg")).toEqual({ width: 21, height: 37 });

    // A JPEG whose frame header sits past the first 64 KB (a big metadata block).
    const bigExif = await sharp(raw).jpeg().withIccProfile("p3").toBuffer();
    const file = path.join(dir, "big.jpg");
    const padding = Buffer.alloc(70_000, 0x20);
    const app15 = Buffer.alloc(4);
    app15[0] = 0xff;
    app15[1] = 0xef;
    // Split the padding into several APP15 segments (each under 64 KB).
    const segments: Buffer[] = [];
    for (let offset = 0; offset < padding.length; offset += 60_000) {
      const body = padding.subarray(offset, offset + 60_000);
      const header = Buffer.from([0xff, 0xef, 0, 0]);
      header.writeUInt16BE(body.length + 2, 2);
      segments.push(header, body);
    }
    fs.writeFileSync(file, Buffer.concat([bigExif.subarray(0, 2), ...segments, bigExif.subarray(2)]));
    expect(imageDimensions(fs.readFileSync(file).subarray(0, 64 * 1024), "jpg")).toBeNull();
    expect(await imageDimensionsFromFile(file, "jpg")).toEqual({ width: 37, height: 21 });
  });
});

describe("probeAudioVideo", () => {
  it("reads video dimensions and duration from a file", async () => {
    const file = path.join(dir, "tiny.mp4");
    fs.writeFileSync(file, TINY_MP4);
    const probe = await probeAudioVideo({ path: file }, "video");
    expect(probe.width).toBe(64);
    expect(probe.height).toBe(48);
    expect(probe.durationSec).toBeGreaterThan(0.4);
    expect(probe.durationSec).toBeLessThan(1);
    // The handle is closed: the file can be removed right away.
    fs.unlinkSync(file);
  });

  it("reads audio duration from a buffer", async () => {
    const probe = await probeAudioVideo({ buffer: makeWav(0.5) }, "audio");
    expect(probe.durationSec).toBeCloseTo(0.5, 2);
    expect(probe.width).toBeUndefined();
  });

  it("returns nothing for garbage or images", async () => {
    expect(await probeAudioVideo({ buffer: Buffer.from("not a video") }, "video")).toEqual({});
    expect(await probeAudioVideo({ buffer: makePng() }, "image")).toEqual({});
  });
});
