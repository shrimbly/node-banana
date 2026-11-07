import { describe, it, expect } from "vitest";
import { formatSeconds, formatTileSeconds, formatTimecode, parseSeconds, parseTimecode } from "../timecode";

describe("formatTimecode", () => {
  it("writes m:ss.cc", () => {
    expect(formatTimecode(4.6)).toBe("0:04.60");
    expect(formatTimecode(18.4)).toBe("0:18.40");
    expect(formatTimecode(62.3)).toBe("1:02.30");
  });

  it("rounds once on the total", () => {
    expect(formatTimecode(59.999)).toBe("1:00.00");
  });

  it("takes 0 or 1 decimals", () => {
    expect(formatTimecode(18.4, 0)).toBe("0:18");
    expect(formatTimecode(5, 1)).toBe("0:05.0");
  });

  it("clamps negatives to zero", () => {
    expect(formatTimecode(-3)).toBe("0:00.00");
  });
});

describe("parseTimecode", () => {
  it("reads seconds and m:ss forms", () => {
    expect(parseTimecode("4.6")).toBe(4.6);
    expect(parseTimecode("4,6")).toBe(4.6);
    expect(parseTimecode("04.60")).toBe(4.6);
    expect(parseTimecode("0:04.6")).toBe(4.6);
    expect(parseTimecode("1:02.30")).toBeCloseTo(62.3, 10);
    expect(parseTimecode(" 5 ")).toBe(5);
  });

  it("refuses what is not a time", () => {
    expect(parseTimecode("abc")).toBeNull();
    expect(parseTimecode("-1")).toBeNull();
    expect(parseTimecode("0:75")).toBeNull();
    expect(parseTimecode("")).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("writes lengths with a unit", () => {
    expect(formatSeconds(4.2)).toBe("4.20 s");
    expect(formatSeconds(5, 1)).toBe("5.0 s");
  });

  it("signs deltas with a true minus", () => {
    expect(formatSeconds(-0.8, 2, { signed: true })).toBe("−0.80 s");
    expect(formatSeconds(0.8, 2, { signed: true })).toBe("+0.80 s");
    expect(formatSeconds(-0.001, 2, { signed: true })).toBe("0.00 s");
  });
});

describe("formatTileSeconds", () => {
  it("rounds to whole seconds", () => {
    expect(formatTileSeconds(4.6)).toBe("5s");
    expect(formatTileSeconds(4.2)).toBe("4s");
  });
});

describe("parseSeconds", () => {
  it("reads seconds with or without a unit", () => {
    expect(parseSeconds("1")).toBe(1);
    expect(parseSeconds("1.0 s")).toBe(1);
    expect(parseSeconds("2s")).toBe(2);
    expect(parseSeconds("1,5")).toBe(1.5);
    expect(parseSeconds("1.5 sec.")).toBe(1.5);
    expect(parseSeconds(" 3 Seconds ")).toBe(3);
    expect(parseSeconds("0:01.5")).toBe(1.5);
  });

  it("refuses anything else", () => {
    expect(parseSeconds("abc")).toBeNull();
    expect(parseSeconds("s")).toBeNull();
    expect(parseSeconds("-1 s")).toBeNull();
  });
});
