import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { KeyboardShortcutsDialog } from "../KeyboardShortcutsDialog";
import { useAssetStore } from "@/store/assetStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import type { StitchDraft } from "@/lib/stitch/draft";

const emptyDraft = (): StitchDraft => ({
  timeline: [],
  audioClips: [],
  legacyAudio: { curve: [], muted: false },
  loopCount: 1,
  sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
});

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

  it("lists E with the view switches, and the open edit's keys only from the Edit video view", () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText("Show or hide Edit video")).toBeInTheDocument();
    expect(screen.queryByText("Save the edit")).toBeNull();
  });

  it("puts the view switches and the open edit's keys first in the Edit video view, the canvas's said to be its", () => {
    useAssetStore.setState({ appView: "edit" });
    useStitchEditorStore.getState().openEdit({ editId: "ed0000000000a1", draft: emptyDraft() });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 3)).toEqual(["Views", "Edit video", "On the canvas"]);
    expect(headings).not.toContain("General");
    expect(headings.at(-1)).toBe("Assets");
    expect(screen.getByText("Save the edit")).toBeInTheDocument();
    // Every clip key the editor handles is listed
    for (const row of ["Copy the selected clips", "Cut the selected clips", "Paste clips", "Select every clip"]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
    expect(screen.getByText("Move the selected clips a row")).toBeInTheDocument();
    useStitchEditorStore.getState().close();
    useAssetStore.setState({ appView: "canvas" });
  });

  it("lists the editor's zoom keys and mouse modifiers, which no rail or menu shows", () => {
    useAssetStore.setState({ appView: "edit" });
    useStitchEditorStore.getState().openEdit({ editId: "ed0000000000a1", draft: emptyDraft() });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    for (const row of [
      "Zoom the timeline out / in",
      "Fit the timeline",
      "Nudge the selected clips a frame",
      "Select a range of clips",
      "Move or trim without snapping",
      "Move a whole volume line",
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
    useStitchEditorStore.getState().close();
    useAssetStore.setState({ appView: "canvas" });
  });

  it("puts the editor's keys first over the Edit Video node's dialog, where ⌘S saves and keeps it open", () => {
    useStitchEditorStore.getState().open({ nodeId: "stitch", draft: emptyDraft(), canvasGeneration: 1 });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["Edit video", "On the canvas"]);
    expect(screen.getByText("Save, keeping the editor open")).toBeInTheDocument();
    expect(screen.queryByText("Save the edit")).toBeNull();
    expect(screen.getByText("Select a range of clips")).toBeInTheDocument();
    useStitchEditorStore.getState().close();
  });

  it("lists no edit keys on the Edit video home screen, where none of them works", () => {
    useAssetStore.setState({ appView: "edit" });
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["Views", "On the canvas"]);
    expect(screen.queryByText("Save the edit")).toBeNull();
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
