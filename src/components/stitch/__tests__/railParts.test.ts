import { describe, expect, it } from "vitest";
import { railDetail } from "../railParts";

// The line under the rail's title, from the media view's source parts and the clip's lengths

describe("railDetail", () => {
  const node = { kind: "Generate video", detail: "Veo 3.1" };
  const library = { kind: "Library", detail: "Veo 3.1" };

  it("names the source, then the file's length when the clip is untrimmed", () => {
    expect(railDetail(node, 12.06, 12.06, false)).toBe("Generate video · Veo 3.1 · 12.06 s");
    expect(railDetail(library, 5, 5, false)).toBe("Library · Veo 3.1 · 5.00 s");
  });

  it("says how much of the file a trim keeps", () => {
    expect(railDetail(node, 12.06, 4.2, false)).toBe("Generate video · Veo 3.1 · 4.20 s of 12.06 s");
  });

  it("leaves the length out while it is unknown", () => {
    expect(railDetail(node, null, null, false)).toBe("Generate video · Veo 3.1");
  });

  it("leaves Library out in an edit, where every clip is the library's, and the model too when there is none", () => {
    expect(railDetail(library, 5, 5, true)).toBe("Veo 3.1 · 5.00 s");
    expect(railDetail({ kind: "Library", detail: null }, 5, 5, true)).toBe("5.00 s");
    // The node's dialog keeps it
    expect(railDetail({ kind: "Library", detail: null }, 5, 5, false)).toBe("Library · 5.00 s");
  });

  it("names a clip the library lost by its file, in an edit too", () => {
    const lost = { kind: "Not in the library", detail: "sunset.mp4" };
    expect(railDetail(lost, null, null, true)).toBe("Not in the library · sunset.mp4");
  });

  it("is only the length while the clip has no view yet", () => {
    expect(railDetail(undefined, 5, 3, false)).toBe("3.00 s of 5.00 s");
    expect(railDetail(undefined, null, null, true)).toBe("");
  });
});
