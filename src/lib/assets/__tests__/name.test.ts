// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ASSET_NAME_MAX, assetName, assetNameProblem, cleanAssetName, oneLineName } from "../name";

describe("assetName", () => {
  it("is the display name when there is one, else the file's name", () => {
    expect(assetName({ name: "Sunset", filename: "143205_video_ab12cd34.mp4" })).toBe("Sunset");
    expect(assetName({ filename: "143205_video_ab12cd34.mp4" })).toBe("143205_video_ab12cd34.mp4");
    expect(assetName({ name: "", filename: "x.mp4" })).toBe("x.mp4");
  });
});

describe("assetNameProblem", () => {
  it("accepts a name of one line up to the limit, judged trimmed, and an empty one", () => {
    expect(assetNameProblem("Sunset over the bay")).toBeNull();
    expect(assetNameProblem("x".repeat(ASSET_NAME_MAX))).toBeNull();
    expect(assetNameProblem(`  ${"x".repeat(ASSET_NAME_MAX)}  `)).toBeNull();
    expect(assetNameProblem("")).toBeNull();
    expect(assetNameProblem("   ")).toBeNull();
    expect(assetNameProblem(" Sunset\n")).toBeNull();
  });

  it("refuses a name that is too long or more than one line, naming the field", () => {
    expect(assetNameProblem("x".repeat(ASSET_NAME_MAX + 1))).toBe("name is longer than 120 characters.");
    expect(assetNameProblem("Sun\nset")).toBe("name must be one line.");
    expect(assetNameProblem("Sun\rset")).toBe("name must be one line.");
    expect(assetNameProblem("Sun\u2028set")).toBe("name must be one line.");
    expect(assetNameProblem("Sun\u2029set")).toBe("name must be one line.");
    expect(assetNameProblem("Sun\nset", "title")).toBe("title must be one line.");
  });
});

describe("oneLineName", () => {
  it("makes each run of line breaks one space, leaving a one-line value as it is", () => {
    expect(oneLineName("Day one\r\nfinal.mov")).toBe("Day one final.mov");
    expect(oneLineName("a b c\rd")).toBe("a b c d");
    expect(oneLineName(" Sunset.mp4 ")).toBe(" Sunset.mp4 ");
    expect(assetNameProblem(oneLineName("Sun\n\nset"))).toBeNull();
  });
});

describe("cleanAssetName", () => {
  it("keeps a stored name a rename could have set, trimmed, and nothing else", () => {
    expect(cleanAssetName("Sunset")).toBe("Sunset");
    expect(cleanAssetName("  Sunset ")).toBe("Sunset");
    expect(cleanAssetName("")).toBeUndefined();
    expect(cleanAssetName("  ")).toBeUndefined();
    expect(cleanAssetName("Sun\nset")).toBeUndefined();
    expect(cleanAssetName("x".repeat(ASSET_NAME_MAX + 1))).toBeUndefined();
    expect(cleanAssetName(42)).toBeUndefined();
    expect(cleanAssetName(null)).toBeUndefined();
  });
});
