import { describe, expect, it } from "vitest";
import {
  assetEyebrow,
  assetTitle,
  daySectionLabel,
  formatBytes,
  formatCost,
  formatCount,
  formatDateTime,
  formatDuration,
  formatRelativeDate,
  operationLabel,
  projectLabel,
  revealLabel,
  shortLibraryPath,
  workflowLabel,
} from "../assetFormat";

const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 9, 27, 14, 30);

describe("day sections", () => {
  it("says Today and Yesterday, then the day, and the year only when it differs", () => {
    expect(daySectionLabel(local(2026, 9, 27, 0, 5), NOW)).toBe("Today");
    expect(daySectionLabel(local(2026, 9, 26, 23, 59), NOW)).toBe("Yesterday");
    expect(daySectionLabel(local(2026, 9, 22), NOW)).toBe("Tue 22 Sep");
    expect(daySectionLabel(local(2025, 9, 22), NOW)).toBe("Mon 22 Sep 2025");
  });
});

describe("dates", () => {
  it("writes relative times for today and days beyond", () => {
    expect(formatRelativeDate(NOW - 10_000, NOW)).toBe("Just now");
    expect(formatRelativeDate(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelativeDate(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
    expect(formatRelativeDate(local(2026, 9, 26, 20), NOW)).toBe("Yesterday");
    expect(formatRelativeDate(local(2026, 9, 1), NOW)).toBe("Tue 1 Sep");
  });

  it("writes the Created row day first with a 24-hour time", () => {
    expect(formatDateTime(local(2026, 9, 27, 9, 5))).toBe("27 Sep 2026, 09:05");
  });
});

describe("sizes and durations", () => {
  it("formats bytes in decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_234)).toBe("1.2 KB");
    expect(formatBytes(34_500_000)).toBe("34.5 MB");
    expect(formatBytes(1_250_000_000)).toBe("1.25 GB");
  });

  it("formats durations as m:ss or h:mm:ss", () => {
    expect(formatDuration(7.4)).toBe("0:07");
    expect(formatDuration(725)).toBe("12:05");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("counts with grouping and the right plural", () => {
    expect(formatCount(1)).toBe("1 asset");
    expect(formatCount(1240)).toBe("1,240 assets");
  });

  it("marks estimated costs", () => {
    expect(formatCost({ amount: 0.0325, currency: "USD", estimated: true })).toBe("Est. $0.0325");
    expect(formatCost({ amount: 1.5, currency: "USD", estimated: false })).toBe("$1.50");
  });
});

describe("labels", () => {
  it("names unnamed workflows by when they ran", () => {
    expect(workflowLabel("Cat ads", NOW)).toBe("Cat ads");
    expect(workflowLabel(null, local(2026, 9, 27, 14, 2))).toBe("Untitled · 27 Sep 14:02");
    expect(workflowLabel("  ", local(2026, 9, 27, 14, 2))).toBe("Untitled · 27 Sep 14:02");
  });

  it("labels projects by folder, on either platform", () => {
    expect(projectLabel("/Users/me/Projects/Cat ads")).toBe("Cat ads");
    expect(projectLabel("C:\\Users\\me\\Cat ads\\")).toBe("Cat ads");
    expect(projectLabel(null)).toBe("Not in a project");
  });

  it("names the file manager by platform", () => {
    expect(revealLabel("darwin")).toBe("Show in Finder");
    expect(revealLabel("win32")).toBe("Show in Explorer");
    expect(revealLabel("linux")).toBe("Show in folder");
  });

  it("shortens the library path to its last two folders", () => {
    expect(shortLibraryPath("/Users/me/Pictures/Node Banana")).toBe("Pictures › Node Banana");
    expect(shortLibraryPath("C:\\Users\\me\\Node Banana")).toBe("me › Node Banana");
  });

  it("titles an asset by its prompt's first line, else its file", () => {
    expect(assetTitle({ prompt: "\n  A cat astronaut\nwith a helmet", filename: "x.png" })).toBe("A cat astronaut");
    expect(assetTitle({ prompt: undefined, filename: "143205_cat_3f2a9c1b.png" })).toBe("143205_cat_3f2a9c1b.png");
    // Without a prompt, a record says what made it and in which workflow.
    expect(
      assetTitle({
        prompt: undefined,
        filename: "095620_splittonodes_f8ade09.png",
        kind: "image",
        origin: "edited",
        producer: { nodeId: "nanoBanana-2", nodeType: "nanoBanana", operation: "splitToNodes", batchIndex: 2 },
        workflowName: "QA Split",
        workflow: { id: "wf_1", name: "Product shots", projectPath: null },
      }),
    ).toBe("Split to nodes · cell 3 · Product shots");
    expect(
      assetTitle({ prompt: "", filename: "v.mp4", kind: "video", origin: "generated", producer: { nodeId: "v", nodeType: "generateVideo" }, workflowName: null }),
    ).toBe("Video");
  });

  it("titles an asset by the name it was given, before its prompt", () => {
    expect(assetTitle({ name: "Sunset", prompt: "A cat astronaut", filename: "x.png" })).toBe("Sunset");
    expect(
      assetTitle({ name: "Opening shot", prompt: undefined, filename: "v.mp4", kind: "video", origin: "generated", producer: { nodeId: "v", nodeType: "generateVideo" }, workflowName: "Trip" }),
    ).toBe("Opening shot");
    expect(assetTitle({ name: undefined, prompt: "A cat astronaut", filename: "x.png" })).toBe("A cat astronaut");
  });

  it("writes the detail eyebrow from kind, origin or operation, and date", () => {
    expect(assetEyebrow({ kind: "image", origin: "generated", createdAt: NOW, producer: { nodeId: "n", nodeType: "nanoBanana" } })).toBe(
      "Image · Generated · 27 Sep 2026",
    );
    expect(
      assetEyebrow({ kind: "video", origin: "edited", createdAt: NOW, producer: { nodeId: "n", nodeType: "videoTrim", operation: "trim" } }),
    ).toBe("Video · Trimmed · 27 Sep 2026");
    expect(
      assetEyebrow({ kind: "audio", origin: "uploaded", createdAt: NOW, producer: { nodeId: "upload", nodeType: "upload", operation: "upload" } }),
    ).toBe("Audio · Uploaded · 27 Sep 2026");
  });

  it("titles an upload by the name it came with, else by its kind and where it came in", () => {
    const upload = { prompt: undefined, filename: "143205_upload_ab12cd34.mp4", kind: "video" as const, origin: "uploaded" as const, producer: { nodeId: "upload", nodeType: "upload", operation: "upload" }, workflowName: "Uploads" };
    expect(assetTitle({ ...upload, name: "sunset.mp4" })).toBe("sunset.mp4");
    expect(assetTitle(upload)).toBe("Video · Uploads");
    // The Edit video view's rail names an upload by how it came in
    expect(operationLabel("upload")).toBe("Upload");
  });
});
