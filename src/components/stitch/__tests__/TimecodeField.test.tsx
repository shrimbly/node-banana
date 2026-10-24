import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { formatSeconds, parseSeconds } from "@/lib/stitch/timecode";
import { TIMECODE_WELL } from "../editorStyles";

/** A caller's own well: the class it passes is the field's whole class. */
const OWN_WELL = "h-8 w-16 rounded-md bg-edit-field";
import { TimecodeField } from "../TimecodeField";

function setup(value = 0.8) {
  const onCommit = vi.fn();
  render(<TimecodeField label="In" value={value} onCommit={onCommit} />);
  const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
  return { field, onCommit };
}

describe("TimecodeField", () => {
  it("shows the value as m:ss.cc", () => {
    expect(setup(4.6).field.value).toBe("0:04.60");
  });

  it("commits a typed time on Enter", () => {
    const { field, onCommit } = setup();
    field.focus();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "0:01.00" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it("commits on blur", () => {
    const { field, onCommit } = setup();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "2.5" } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith(2.5);
  });

  it("reverts on Escape without committing, and keeps the key from the editor", () => {
    const { field, onCommit } = setup();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    field.focus();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.blur(field);
    window.removeEventListener("keydown", outer);
    expect(onCommit).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(field.value).toBe("0:00.80");
  });

  it("reverts text that is not a time", () => {
    const { field, onCommit } = setup();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "soon" } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.value).toBe("0:00.80");
  });

  it("commits nothing when focused and left, or given Enter, without typing", () => {
    const { field, onCommit } = setup(1.23456);
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.value).toBe("0:01.23");
  });

  it("hands focus to the dialog panel on Enter and Escape, not to <body>", () => {
    const onCommit = vi.fn();
    render(
      <div role="dialog" tabIndex={-1} aria-label="Panel">
        <TimecodeField label="In" value={1} onCommit={onCommit} />
      </div>,
    );
    const panel = screen.getByRole("dialog", { name: "Panel" });
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(panel);
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(panel);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps the timecode well's look, format and parsing by default, and ↑/↓ type nothing special", () => {
    const { field, onCommit } = setup(1);
    expect(field.className).toBe(TIMECODE_WELL);
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("0:01.00");
    fireEvent.change(field, { target: { value: "2 s" } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
  });

  describe("as a seconds well", () => {
    function seconds(value = 1, onNudge?: (direction: 1 | -1, big: boolean) => number | null) {
      const onCommit = vi.fn();
      render(
        <TimecodeField
          label="Overlap"
          value={value}
          format={(s) => formatSeconds(s, 1)}
          parse={parseSeconds}
          className={OWN_WELL}
          onCommit={onCommit}
          onNudge={onNudge}
        />,
      );
      return { field: screen.getByRole("textbox", { name: "Overlap" }) as HTMLInputElement, onCommit };
    }

    it("shows and parses seconds in its own well", () => {
      const { field, onCommit } = seconds(1);
      expect(field.value).toBe("1.0 s");
      expect(field.className).toBe(OWN_WELL);
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "2s" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onCommit).toHaveBeenCalledWith(2);
    });

    it("nudges with ↑ and ↓ (⇧ for a big step), shows the stored value, and commits nothing more on leaving", () => {
      let stored = 1;
      const onNudge = vi.fn((direction: 1 | -1, big: boolean) => {
        stored = Math.round((stored + direction * (big ? 1 : 0.1)) * 10) / 10;
        return stored;
      });
      const { field, onCommit } = seconds(1, onNudge);
      fireEvent.focus(field);
      fireEvent.keyDown(field, { key: "ArrowUp" });
      expect(onNudge).toHaveBeenLastCalledWith(1, false);
      expect(field.value).toBe("1.1 s");
      fireEvent.keyDown(field, { key: "ArrowDown", shiftKey: true });
      expect(onNudge).toHaveBeenLastCalledWith(-1, true);
      expect(field.value).toBe("0.1 s");
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.blur(field);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("steps from a value typed and not yet committed, committing it first", () => {
      let stored = 1;
      const onNudge = vi.fn((direction: 1 | -1) => {
        stored = Math.round((stored + direction * 0.1) * 10) / 10;
        return stored;
      });
      const { field, onCommit } = seconds(1, onNudge);
      onCommit.mockImplementation((value: number) => {
        stored = value;
      });
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "2.5" } });
      fireEvent.keyDown(field, { key: "ArrowUp" });
      expect(onCommit).toHaveBeenCalledWith(2.5);
      expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(onNudge.mock.invocationCallOrder[0]);
      expect(field.value).toBe("2.6 s");
      fireEvent.blur(field);
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it("leaves ⌘, Ctrl and ⌥ arrows to the caret", () => {
      const onNudge = vi.fn(() => 2);
      const { field } = seconds(1, onNudge);
      fireEvent.focus(field);
      for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
        const notCancelled = fireEvent.keyDown(field, { key: "ArrowUp", [modifier]: true });
        expect(notCancelled).toBe(true);
      }
      expect(onNudge).not.toHaveBeenCalled();
      expect(field.value).toBe("1.0 s");
    });

    it("keeps its text when a nudge changes nothing", () => {
      const onNudge = vi.fn(() => null);
      const { field } = seconds(0, onNudge);
      fireEvent.focus(field);
      fireEvent.keyDown(field, { key: "ArrowDown" });
      expect(onNudge).toHaveBeenCalledTimes(1);
      expect(field.value).toBe("0.0 s");
    });
  });
});
