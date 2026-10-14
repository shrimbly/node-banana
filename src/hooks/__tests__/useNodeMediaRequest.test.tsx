import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNodeMediaRequest } from "../useNodeMediaRequest";

describe("useNodeMediaRequest", () => {
  it("a Remove on a remounted node supersedes the read its earlier instance started", () => {
    const first = renderHook(() => useNodeMediaRequest("media-a"));
    const isCurrent = first.result.current.beginRequest();
    first.unmount();
    // Unmounting does not cancel: the read belongs to the node.
    expect(isCurrent()).toBe(true);
    const second = renderHook(() => useNodeMediaRequest("media-a"));
    second.result.current.cancelRequest();
    expect(isCurrent()).toBe(false);
  });

  it("a later upload supersedes an earlier one, and other nodes are untouched", () => {
    const { result } = renderHook(() => useNodeMediaRequest("media-b"));
    const other = renderHook(() => useNodeMediaRequest("media-c"));
    const elsewhere = other.result.current.beginRequest();
    const earlier = result.current.beginRequest();
    const later = result.current.beginRequest();
    expect(earlier()).toBe(false);
    expect(later()).toBe(true);
    expect(elsewhere()).toBe(true);
  });
});
