import { describe, expect, it } from "vitest";
import { rewriteSelector } from "../domSnapshot";

describe("rewriteSelector", () => {
  it("points :root, html and body at the snapshot's stand-in wrappers", () => {
    expect(rewriteSelector(":root, :host")).toBe("[data-nb-snapshot-root], :host");
    expect(rewriteSelector("html.dark .card")).toBe("[data-nb-snapshot-root].dark .card");
    expect(rewriteSelector("html,body")).toBe("[data-nb-snapshot-root],[data-nb-snapshot-body]");
    expect(rewriteSelector("body > div")).toBe("[data-nb-snapshot-body] > div");
    expect(rewriteSelector(":where(html) a")).toBe(":where([data-nb-snapshot-root]) a");
  });

  it("leaves class names and other words that contain them alone", () => {
    expect(rewriteSelector(".html-preview .tbody")).toBe(".html-preview .tbody");
    expect(rewriteSelector("[data-body] .htmlish")).toBe("[data-body] .htmlish");
    expect(rewriteSelector("tbody tr")).toBe("tbody tr");
  });
});
