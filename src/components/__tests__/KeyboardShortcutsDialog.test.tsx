import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { KeyboardShortcutsDialog } from "../KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog", () => {
  it("renders nothing when closed", () => {
    render(<KeyboardShortcutsDialog isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the shortcut groups in a labelled dialog", () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Run workflow")).toBeInTheDocument();
    expect(screen.getByText("Add Prompt node")).toBeInTheDocument();
  });

  it("closes from the header button and on Escape", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsDialog isOpen onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
