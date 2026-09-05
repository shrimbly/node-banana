import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogButton } from "../Dialog";
import { useWorkflowStore } from "@/store/workflowStore";

function Basic({ onClose, open = true }: { onClose?: () => void; open?: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader>
        <DialogTitle>Example</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <input aria-label="First" />
        <input aria-label="Second" />
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary">Save</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

describe("Dialog", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ openModalCount: 0, isModalOpen: false });
  });

  it("renders a labelled modal dialog", () => {
    render(<Basic onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", screen.getByText("Example").id);
  });

  it("renders nothing when closed", () => {
    render(<Basic open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape from anywhere in the document", () => {
    const onClose = vi.fn();
    render(<Basic onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape from a focused input inside it", () => {
    const onClose = vi.fn();
    render(<Basic onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("Second"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click but not on a click inside the panel", () => {
    const onClose = vi.fn();
    render(<Basic onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector("[data-dialog-overlay]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape and the backdrop when it has no onClose", () => {
    render(<Basic />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector("[data-dialog-overlay]")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("only the topmost dialog answers Escape", () => {
    const closeOuter = vi.fn();
    function Outer() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog open onClose={closeOuter} label="Outer">
          <button onClick={() => setInner(true)}>Pick</button>
          <Dialog open={inner} onClose={() => setInner(false)} label="Inner">
            <p>inner</p>
          </Dialog>
        </Dialog>
      );
    }
    render(<Outer />);
    fireEvent.click(screen.getByText("Pick"));
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(closeOuter).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeOuter).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the panel", () => {
    render(<Basic onClose={() => {}} />);
    const first = screen.getByLabelText("First");
    const save = screen.getByText("Save");
    save.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    // The close button in the header is the first focusable element.
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
    screen.getByLabelText("Close").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    first.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    // A Tab from the middle is left to the browser.
    expect(document.activeElement).toBe(first);
  });

  it("moves focus into the panel on open and back to the opener on close", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Basic open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    vi.useFakeTimers();
    try {
      render(<Host />);
      const opener = screen.getByText("Open");
      opener.focus();
      fireEvent.click(opener);
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the store's modal count while open", () => {
    const { unmount } = render(<Basic onClose={() => {}} />);
    expect(useWorkflowStore.getState().isModalOpen).toBe(true);
    unmount();
    expect(useWorkflowStore.getState().isModalOpen).toBe(false);
  });

  it("locks body scroll while open", () => {
    const { unmount } = render(<Basic onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("renders inline when asked not to portal", () => {
    const { container } = render(<Basic onClose={() => {}} />);
    expect(container.querySelector("[role=dialog]")).toBeNull();
    const inline = render(
      <Dialog open portal={false} label="Inline">
        <p>x</p>
      </Dialog>
    );
    expect(inline.container.querySelector("[role=dialog]")).not.toBeNull();
  });
});
