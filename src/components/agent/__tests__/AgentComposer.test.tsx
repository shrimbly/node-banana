import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/agent/ui/tooltip";
import { AgentComposer, type AgentComposerProps } from "@/components/agent/AgentComposer";

function renderComposer(props: Partial<AgentComposerProps> = {}) {
  const onSend = props.onSend ?? vi.fn(() => true);
  const onStop = props.onStop ?? vi.fn();
  const onModelChange = props.onModelChange ?? vi.fn();
  const utils = render(
    <TooltipProvider>
      <AgentComposer
        status="ready"
        busy={false}
        models={[]}
        onModelChange={onModelChange}
        onSend={onSend}
        onStop={onStop}
        {...props}
      />
    </TooltipProvider>,
  );
  const textarea = screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement;
  return { ...utils, textarea, onSend, onStop, onModelChange };
}

describe("AgentComposer", () => {
  it("is a real textarea (so canvas shortcuts ignore typing)", () => {
    const { textarea } = renderComposer();
    expect(textarea.tagName).toBe("TEXTAREA");
  });

  it("sends on Enter and clears the box", async () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: "Make a text-to-image workflow" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Make a text-to-image workflow"));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("keeps Shift+Enter for a new line", async () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: "line one" } });
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    // Not prevented: the browser inserts the newline.
    expect(event).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send an empty message", async () => {
    const { textarea, onSend } = renderComposer();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft when the message was not sent", async () => {
    const onSend = vi.fn(() => false);
    const { textarea } = renderComposer({ onSend });
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea.value).toBe("hello");
  });

  it("while a turn runs, Enter does nothing and the button stops it", async () => {
    const { textarea, onSend, onStop } = renderComposer({ busy: true, status: "streaming" });
    fireEvent.change(textarea, { target: { value: "next question" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("next question");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows the model picker only when the harness lists models", () => {
    const { unmount } = renderComposer();
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    unmount();

    renderComposer({
      models: [
        { id: "sonnet", label: "Sonnet", isDefault: true },
        { id: "opus", label: "Opus" },
      ],
      model: "opus",
    });
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Opus");
  });

  it("locks the model while a turn runs", () => {
    renderComposer({ busy: true, status: "submitted", models: [{ id: "sonnet", label: "Sonnet" }], model: "sonnet" });
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  });

  it("shows context notes above the input", () => {
    renderComposer({
      notes: [
        { key: "selection", kind: "selection", text: "3 nodes selected — the agent will focus on them" },
        { key: "switch", kind: "switch", text: "Codex picks up from here with the conversation so far" },
      ],
    });
    expect(screen.getByText("3 nodes selected — the agent will focus on them")).toBeInTheDocument();
    expect(screen.getByText("Codex picks up from here with the conversation so far")).toBeInTheDocument();
  });

  // Safari ends the composition before the keydown of the Enter that commits it
  // (keyCode 229, isComposing false): that Enter used to send the half-typed message.
  it("never sends on the Enter that commits an IME conversion (Safari order)", async () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "日本語" } });
    fireEvent.compositionEnd(textarea);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent(
      textarea,
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: false, bubbles: true, cancelable: true }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("日本語");

    // The next, plain Enter sends.
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("日本語"));
  });

  it("never sends on an Enter inside a composition (Chrome order)", async () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "日本語" } });
    fireEvent(
      textarea,
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true }),
    );
    fireEvent.compositionEnd(textarea);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(onSend).not.toHaveBeenCalled();
  });

  // Spreadsheet cells and Office selections put the text and a rendered image on the
  // clipboard. The agent takes no attachments, so the text must paste as usual.
  it("lets the browser paste the text of a clipboard that also holds an image", () => {
    const { textarea } = renderComposer();
    const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => file },
      ],
      types: ["text/plain", "Files"],
      files: [file],
      getData: (type: string) => (type === "text/plain" ? "A1\tB1" : ""),
    };
    fireEvent(textarea, paste);
    expect(paste.defaultPrevented).toBe(false);
  });

  it("uses the parent's draft when given one", async () => {
    const onDraftChange = vi.fn();
    const { textarea, onSend } = renderComposer({ draft: "kept by the panel", onDraftChange });
    expect(textarea.value).toBe("kept by the panel");
    fireEvent.change(textarea, { target: { value: "kept by the panel!" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("kept by the panel!");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("kept by the panel"));
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });
});
