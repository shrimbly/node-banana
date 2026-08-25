import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateThumbnail } = vi.hoisted(() => ({
  mockGenerateThumbnail: vi.fn(),
}));

vi.mock("@xyflow/react", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      transform: [0, 0, 1],
      nodeLookup: new Map([["node-1", { measured: { width: 100 } }]]),
    }),
}));

vi.mock("@/utils/imageThumbnail", () => ({
  generateThumbnail: mockGenerateThumbnail,
}));

import { useAdaptiveImageSrc } from "../useAdaptiveImageSrc";

describe("useAdaptiveImageSrc", () => {
  beforeEach(() => {
    mockGenerateThumbnail.mockReset();
  });

  it("never reuses the previous image thumbnail after the full source changes", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    mockGenerateThumbnail
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveSecond = resolve; }));

    const first = "data:image/png;base64,first-unique-source";
    const second = "data:image/png;base64,second-unique-source";
    const { result, rerender } = renderHook(
      ({ src }) => useAdaptiveImageSrc(src, "node-1"),
      { initialProps: { src: first } }
    );

    await act(async () => resolveFirst("data:image/jpeg;base64,first-thumbnail"));
    await waitFor(() => {
      expect(result.current).toBe("data:image/jpeg;base64,first-thumbnail");
    });

    rerender({ src: second });

    expect(result.current).toBe(second);

    await act(async () => resolveSecond("data:image/jpeg;base64,second-thumbnail"));
    await waitFor(() => {
      expect(result.current).toBe("data:image/jpeg;base64,second-thumbnail");
    });
  });
});
