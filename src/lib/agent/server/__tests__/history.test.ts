// @vitest-environment node
import { describe, expect, it } from "vitest";
import { withConversationHistory } from "../history";

describe("withConversationHistory", () => {
  it("returns the prompt unchanged without history", () => {
    expect(withConversationHistory([], "<user>hi</user>")).toBe("<user>hi</user>");
    expect(withConversationHistory([{ role: "user", text: "   " }], "p")).toBe("p");
  });

  it("puts the earlier turns before the prompt, labelled by role", () => {
    const text = withConversationHistory(
      [
        { role: "user", text: "Make a portrait workflow" },
        { role: "assistant", text: "Added 3 nodes." },
      ],
      "<user>now make it square</user>",
    );
    expect(text).toBe(
      [
        "<conversation_history>",
        "Earlier messages in this chat, for context. The canvas may have changed since; the canvas in the current message is authoritative.",
        "User: Make a portrait workflow\n\nAssistant: Added 3 nodes.",
        "</conversation_history>",
        "",
        "<user>now make it square</user>",
      ].join("\n"),
    );
  });

  it("keeps the newest turns within the budget and says how many were dropped", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), text: `message ${i} ${"x".repeat(80)}` }));
    const text = withConversationHistory(history, "p", 300);
    expect(text).toContain("message 9");
    expect(text).not.toContain("message 0 ");
    expect(text).toMatch(/\(\d+ earlier messages omitted\.\)/);
  });

  it("truncates a single message longer than the whole budget", () => {
    const text = withConversationHistory([{ role: "user", text: "y".repeat(1000) }], "p", 100);
    expect(text).toContain(`User: ${"y".repeat(94)}…`);
  });
});
