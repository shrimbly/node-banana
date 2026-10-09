import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { KeyboardShortcutsDialog } from "../KeyboardShortcutsDialog";
import { useAssetStore } from "@/store/assetStore";

describe("KeyboardShortcutsDialog", () => {
  it("renders nothing when closed", () => {
    render(<KeyboardShortcutsDialog isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the shortcut groups in a labelled dialog", () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Run workflow")).toBeInTheDocument();
    expect(screen.getByText("Save workflow")).toBeInTheDocument();
    expect(screen.getByText("Add Prompt node")).toBeInTheDocument();
  });

  it("lists the view switch and the Assets keys", () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText("Views")).toBeInTheDocument();
    expect(screen.getByText("Show or hide the chat")).toBeInTheDocument();
    expect(screen.getByText("Show or hide Assets")).toBeInTheDocument();
    expect(screen.getByText("Undo the last asset action")).toBeInTheDocument();
    // Views and Assets follow the canvas groups from the canvas
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf("Views")).toBeGreaterThan(headings.indexOf("General"));
  });

  it("puts the Assets keys first when opened from the Assets view", () => {
    useAssetStore.setState({ appView: "assets" });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["Views", "Assets"]);
    useAssetStore.setState({ appView: "canvas" });
  });

  it("puts the view switches first when opened from the chat, and Assets' own keys last", () => {
    useAssetStore.setState({ appView: "chat" });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe("Views");
    expect(headings.at(-1)).toBe("Assets");
    useAssetStore.setState({ appView: "canvas" });
  });

  it("closes from the header button and on Escape", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsDialog isOpen onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
