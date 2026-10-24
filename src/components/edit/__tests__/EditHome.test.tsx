import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import type { LibraryStatus } from "@/lib/assets/types";
import type { EditListProblem, EditSummary } from "@/lib/edits/types";
import { __resetEditProjectForTests, useEditProjectStore } from "@/store/editProjectStore";
import { EditHome } from "../EditHome";
import { editCardMeta } from "../editMeta";

const T0 = Date.UTC(2026, 9, 16, 12);

function summary(id: string, name: string, overrides: Partial<EditSummary> = {}): EditSummary {
  return {
    id,
    name,
    createdAt: T0 - 86_400_000,
    updatedAt: T0,
    clipCount: 3,
    audioClipCount: 0,
    durationSec: 30,
    posterAssetId: null,
    renderCount: 0,
    fileName: `${name}.nbedit`,
    poster: null,
    ...overrides,
  };
}

const VESPER = summary("ed1", "Vesper opening", { clipCount: 4, durationSec: 67.3, poster: { sha256: "a".repeat(64), hasPoster: true } });
const MUSEUM = summary("ed2", "Museum teaser", { clipCount: 1, durationSec: 12, updatedAt: T0 - 3_600_000 });
const SALT = summary("ed3", "Salt flats", { updatedAt: T0 - 7_200_000, poster: { sha256: "c".repeat(64), hasPoster: false } });
const EDITS = [VESPER, MUSEUM, SALT];

const actions = {
  openEditById: vi.fn(async () => {}),
  newEdit: vi.fn(async () => {}),
  duplicate: vi.fn(async () => {}),
  reveal: vi.fn(async () => {}),
  revealFolder: vi.fn(async () => {}),
  requestDelete: vi.fn(),
  rename: vi.fn(async () => true),
  refreshList: vi.fn(async () => {}),
  separateDuplicate: vi.fn(async () => {}),
};

function renderHome(edits = EDITS, problems: EditListProblem[] = []) {
  useEditProjectStore.setState({ list: { status: "ready", edits, problems, folder: "/Users/me/Node Banana/Edits", error: null }, ...actions });
  return render(<EditHome />);
}

/** The list read again with the home showing: its status stays "ready". */
function readAgain(edits: EditSummary[]) {
  act(() => useEditProjectStore.setState({ list: { ...useEditProjectStore.getState().list, status: "ready", edits } }));
}

const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^Open ${name},`) });
const item = (name: string) => row(name).closest("li")!;
const lit = () => Array.from(document.querySelectorAll("li[data-active]")).map((li) => li.querySelector("[data-edit-row]")?.getAttribute("data-edit-row"));
const previewOf = () => document.querySelector("[data-edit-preview]")?.getAttribute("data-edit-preview");
const caption = () => document.querySelector("[data-edit-preview] figcaption")?.textContent;
const previewImage = () => document.querySelector<HTMLImageElement>("[data-edit-preview] img");
// The preview's frame: the poster's, or the empty frame's
const previewFrame = () => {
  const preview = document.querySelector<HTMLElement>("[data-edit-preview]")!;
  return preview.tagName === "FIGURE" ? (preview.firstElementChild as HTMLElement) : preview;
};
/** The empty frame's look: the editor's well inside a hairline, a faint film glyph, nothing tinted. */
function expectBlankFrame(frame: HTMLElement) {
  const classes = frame.className.split(" ");
  expect(classes).toEqual(expect.arrayContaining(["bg-editor-well", "border", "border-edit-line"]));
  expect(frame.className).not.toMatch(/neutral-900|sky|violet|purple|amber|emerald|rose/);
  expect(frame.querySelector("img")).toBeNull();
  const glyph = frame.querySelector("svg.lucide-film")!;
  expect(glyph.getAttribute("class")).toContain("text-neutral-600");
}
const newEdit = () => screen.getByRole("button", { name: "New edit" });
const moreButtons = () => screen.queryAllByRole("button", { name: /^More for / }).map((b) => b.getAttribute("aria-label"));
const more = (name: string) => screen.getByRole("button", { name: `More for ${name}` });
// The caption under the list, for a view with no room for the preview
const listCaption = () => document.querySelector("[data-edit-caption]")?.textContent;
const box = (bottom: number) => ({ x: 0, y: bottom - 28, top: bottom - 28, left: 0, right: 28, bottom, width: 28, height: 28, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.clearAllMocks();
  __resetEditProjectForTests();
  applyLibraryStatus({ available: true, root: null, source: "default", defaultRoot: "/x", cacheDir: "/x", platform: "darwin" } as LibraryStatus);
});

describe("editCardMeta", () => {
  it("says what the edit holds and when it was edited, for the caption and for a screen reader", () => {
    expect(editCardMeta({ clipCount: 4, durationSec: 67.3, updatedAt: T0 - 12 * 60_000 }, T0)).toEqual({
      text: "4 clips · 1:07 · edited 12m ago",
      label: "4 clips, 1:07, edited 12m ago",
    });
    expect(editCardMeta({ clipCount: 1, durationSec: 12, updatedAt: T0 - 1000 }, T0).text).toBe("1 clip · 0:12 · edited just now");
    expect(editCardMeta({ clipCount: 0, durationSec: 0, updatedAt: T0 - 86_400_000 }, T0).text).toBe("0 clips · 0:00 · edited yesterday");
  });
});

describe("the Index", () => {
  it("starts on the newest edit: its row is lit, carries ⋯ and is the tab stop, and the preview shows it", () => {
    renderHome();
    const list = screen.getByRole("list", { name: "Edits" });
    expect(within(list).getAllByRole("button", { name: /^Open / }).map((b) => b.dataset.editRow)).toEqual(["ed1", "ed2", "ed3"]);
    expect(lit()).toEqual(["ed1"]);
    expect(moreButtons()).toEqual(["More for Vesper opening"]);
    expect([row("Vesper opening"), row("Museum teaser"), row("Salt flats")].map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    expect(within(item("Vesper opening")).getByText("1:07")).toBeInTheDocument();
    expect(previewOf()).toBe("ed1");
    expect(previewImage()?.getAttribute("src")).toBe(tileThumbUrl(VESPER.poster!, 640));
    // The poster sits on the field ground
    expect(previewFrame().className.split(" ")).toContain("bg-edit-field");
    expect(caption()).toBe(editCardMeta(VESPER).text);
    expect(caption()).toMatch(/^4 clips · 1:07 · edited /);
    expect(listCaption()).toBe(editCardMeta(VESPER).text);
  });

  it("takes focus as it shows on the newest edit's row, so Enter opens it; the focus is unmarked", () => {
    renderHome();
    expect(row("Vesper opening")).toHaveFocus();
    expect(row("Vesper opening").tagName).toBe("BUTTON");
    expect(lit()).toEqual(["ed1"]);
    expect(document.querySelector("[data-keyed]")).toBeNull();
    fireEvent.click(row("Vesper opening"));
    expect(actions.openEditById).toHaveBeenCalledWith("ed1");
  });

  it("while the list is read, focus waits on New edit, then goes to the newest row once it is", () => {
    useEditProjectStore.setState({ list: { status: "loading", edits: [], problems: [], folder: null, error: null }, ...actions });
    render(<EditHome />);
    expect(newEdit()).toHaveFocus();
    act(() => useEditProjectStore.setState({ list: { status: "ready", edits: EDITS, problems: [], folder: null, error: null } }));
    expect(row("Vesper opening")).toHaveFocus();
  });

  it("never takes focus back from where it was moved in the home", () => {
    renderHome();
    const folder = screen.getByRole("button", { name: "Show in Finder" });
    act(() => folder.focus());
    // A read again that fails, then one that works: focus stays on the folder button
    act(() => useEditProjectStore.setState({ list: { ...useEditProjectStore.getState().list, status: "error", error: "x" } }));
    act(() => useEditProjectStore.setState({ list: { ...useEditProjectStore.getState().list, status: "ready", error: null } }));
    expect(folder).toHaveFocus();
  });

  it("follows the newest through a read again until a row is chosen: an edit saved since the last read takes the light, the preview and focus", () => {
    // Back home from Museum: the list shown is the one read before it was saved
    renderHome([VESPER, MUSEUM]);
    expect(row("Vesper opening")).toHaveFocus();
    readAgain([{ ...MUSEUM, updatedAt: T0 + 60_000 }, VESPER]);
    expect(row("Museum teaser")).toHaveFocus();
    expect(lit()).toEqual(["ed2"]);
    expect(previewOf()).toBe("ed2");
    expect([row("Museum teaser"), row("Vesper opening")].map((b) => b.tabIndex)).toEqual([0, -1]);
    expect(document.querySelector("[data-keyed]")).toBeNull();
  });

  it("a row chosen with the keys, the pointer or its ⋯ stays active through a read again", () => {
    // The keys
    const keys = renderHome();
    fireEvent.keyDown(row("Vesper opening"), { key: "ArrowDown" });
    readAgain([SALT, VESPER, MUSEUM]);
    expect(row("Museum teaser")).toHaveFocus();
    expect(lit()).toEqual(["ed2"]);
    expect(previewOf()).toBe("ed2");
    keys.unmount();

    // The pointer
    const pointer = renderHome();
    fireEvent.pointerEnter(item("Salt flats"), { clientX: 40, clientY: 110 });
    readAgain([MUSEUM, SALT, VESPER]);
    expect(row("Salt flats")).toHaveFocus();
    expect(lit()).toEqual(["ed3"]);
    pointer.unmount();

    // Its ⋯, reached with Tab: it stays, with focus on it
    renderHome();
    act(() => more("Vesper opening").focus());
    readAgain([MUSEUM, VESPER, SALT]);
    expect(more("Vesper opening")).toHaveFocus();
    expect(lit()).toEqual(["ed1"]);
    expect(previewOf()).toBe("ed1");
  });

  it("the row under the pointer becomes the active one, and stays so when the pointer leaves", () => {
    renderHome();
    fireEvent.pointerEnter(item("Museum teaser"));
    expect(lit()).toEqual(["ed2"]);
    expect(moreButtons()).toEqual(["More for Museum teaser"]);
    expect(row("Museum teaser").tabIndex).toBe(0);
    expect(previewOf()).toBe("ed2");
    // No poster: the empty frame, grey
    expectBlankFrame(previewFrame());
    expect(caption()).toBe(editCardMeta(MUSEUM).text);
    expect(listCaption()).toBe(editCardMeta(MUSEUM).text);
    fireEvent.pointerLeave(item("Museum teaser"));
    expect(lit()).toEqual(["ed2"]);
    fireEvent.pointerEnter(item("Salt flats"));
    expect(previewImage()?.getAttribute("src")).toBe(tileThumbUrl(SALT.poster!, 640));
  });

  it("↑ ↓ Home End move focus and the preview along the rows, ↓ from New edit goes to the active row, and a press opens", () => {
    renderHome();
    act(() => newEdit().focus());
    fireEvent.keyDown(newEdit(), { key: "ArrowDown" });
    expect(row("Vesper opening")).toHaveFocus();

    fireEvent.keyDown(row("Vesper opening"), { key: "ArrowUp" });
    expect(row("Vesper opening")).toHaveFocus();
    fireEvent.keyDown(row("Vesper opening"), { key: "ArrowDown" });
    expect(row("Museum teaser")).toHaveFocus();
    expect(lit()).toEqual(["ed2"]);
    expect(previewOf()).toBe("ed2");
    fireEvent.keyDown(row("Museum teaser"), { key: "End" });
    expect(row("Salt flats")).toHaveFocus();
    fireEvent.keyDown(row("Salt flats"), { key: "ArrowDown" });
    expect(row("Salt flats")).toHaveFocus();
    expect(previewOf()).toBe("ed3");
    fireEvent.keyDown(row("Salt flats"), { key: "Home" });
    expect(row("Vesper opening")).toHaveFocus();
    expect(lit()).toEqual(["ed1"]);

    // Tab lands on the active row: focus moved there makes it the active one
    act(() => row("Salt flats").focus());
    expect(lit()).toEqual(["ed3"]);

    fireEvent.click(row("Museum teaser"));
    expect(actions.openEditById).toHaveBeenCalledWith("ed2");
  });

  it("↑ and ↓ on a row's ⋯ stay there rather than going to the active row", () => {
    renderHome();
    act(() => more("Vesper opening").focus());
    fireEvent.keyDown(more("Vesper opening"), { key: "ArrowDown" });
    expect(more("Vesper opening")).toHaveFocus();
  });

  it("keyboard focus goes with the row the pointer takes, so it is never left on a ⋯ that went away", () => {
    renderHome();
    // On ⋯, then the pointer takes Museum: Vesper's ⋯ goes, and focus is on Museum's row, the one lit and previewed
    act(() => more("Vesper opening").focus());
    fireEvent.pointerEnter(item("Museum teaser"), { clientX: 40, clientY: 60 });
    expect(lit()).toEqual(["ed2"]);
    expect(previewOf()).toBe("ed2");
    expect(row("Museum teaser")).toHaveFocus();
    expect([row("Vesper opening"), row("Museum teaser")].map((b) => b.tabIndex)).toEqual([-1, 0]);

    // Escape gives focus back to ⋯; the pointer moving onto Salt takes it along, and the keys go on from there
    fireEvent.click(more("Museum teaser"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(more("Museum teaser")).toHaveFocus();
    fireEvent.pointerMove(item("Salt flats"), { clientX: 40, clientY: 110 });
    expect(lit()).toEqual(["ed3"]);
    expect(row("Salt flats")).toHaveFocus();
    fireEvent.keyDown(row("Salt flats"), { key: "ArrowUp" });
    expect(row("Museum teaser")).toHaveFocus();

    // Focus outside the list stays where it is
    const newEdit = screen.getByRole("button", { name: "New edit" });
    act(() => newEdit.focus());
    fireEvent.pointerEnter(item("Vesper opening"), { clientX: 40, clientY: 12 });
    expect(lit()).toEqual(["ed1"]);
    expect(newEdit).toHaveFocus();
  });

  it("a row the list scrolls under a pointer that has not moved does not take over from the keys; a wheel's does", () => {
    renderHome();
    fireEvent.pointerMove(item("Vesper opening"), { clientX: 40, clientY: 20 });
    act(() => row("Vesper opening").focus());
    fireEvent.keyDown(row("Vesper opening"), { key: "ArrowDown" });
    expect(row("Museum teaser")).toHaveFocus();
    // The list scrolled to Museum and Salt came under the still pointer
    fireEvent.pointerEnter(item("Salt flats"), { clientX: 40, clientY: 20 });
    expect(lit()).toEqual(["ed2"]);
    expect(row("Museum teaser")).toHaveFocus();
    // The pointer moves: its row takes over
    fireEvent.pointerMove(item("Salt flats"), { clientX: 41, clientY: 20 });
    expect(lit()).toEqual(["ed3"]);
    expect(row("Salt flats")).toHaveFocus();

    fireEvent.keyDown(row("Salt flats"), { key: "Home" });
    expect(row("Vesper opening")).toHaveFocus();
    fireEvent.wheel(screen.getByRole("list", { name: "Edits" }));
    fireEvent.pointerEnter(item("Museum teaser"), { clientX: 41, clientY: 20 });
    expect(lit()).toEqual(["ed2"]);
    expect(row("Museum teaser")).toHaveFocus();
  });

  it("marks keyboard focus only once a key is pressed, not the focus the home gives as it shows", () => {
    renderHome();
    // The fills and the ring wait for the home's data-keyed
    expect(row("Vesper opening")).toHaveFocus();
    expect(document.querySelector("[data-keyed]")).toBeNull();
    expect(newEdit().className.split(" ")).not.toContain("focus-visible:ring-2");
    expect(newEdit().className.split(" ")).toContain("in-data-[keyed]:focus-visible:ring-2");
    // One fill and one white ring for the whole row, ⋯ included, and only on keyboard focus
    expect(item("Vesper opening").className.split(" ")).toEqual(
      expect.arrayContaining([
        "in-data-[keyed]:has-[[data-edit-row]:focus-visible]:bg-white/6",
        "in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-2",
        "in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-white/40",
      ]),
    );
    // The row's edges are the list scroller's (the row's -mx-2 against its px-2, the first row at its top), which
    // clips: the ring is drawn inside the row, or only its bottom would show
    const scroller = item("Vesper opening").closest<HTMLElement>("[data-edit-index-scroller]")!;
    expect(scroller.className.split(" ")).toEqual(expect.arrayContaining(["overflow-y-auto", "px-2"]));
    expect(item("Vesper opening").className.split(" ")).toEqual(
      expect.arrayContaining(["-mx-2", "in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-inset"]),
    );
    expect(row("Vesper opening").className).not.toMatch(/bg-white/);
    fireEvent.keyDown(row("Vesper opening"), { key: "s", metaKey: true });
    expect(document.querySelector("[data-keyed]")).toBeNull();
    fireEvent.keyDown(row("Vesper opening"), { key: "ArrowDown" });
    expect(document.querySelector("[data-keyed]")).toContainElement(row("Museum teaser"));
  });

  it("⋯ opens its menu under the row while the list has room there, else over it", () => {
    renderHome();
    const scroller = document.querySelector<HTMLElement>("[data-edit-index-scroller]")!;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(box(600));
    vi.spyOn(more("Vesper opening"), "getBoundingClientRect").mockReturnValue(box(250));
    fireEvent.click(more("Vesper opening"));
    // Placed by its surface, which holds the menu (and, in a header, the line under it)
    const surface = () => screen.getByRole("menu").parentElement!.className.split(" ");
    expect(surface()).not.toContain("bottom-full");
    fireEvent.click(more("Vesper opening"));
    expect(screen.queryByRole("menu")).toBeNull();

    // 40 px under the last row: over it
    fireEvent.pointerEnter(item("Salt flats"));
    vi.spyOn(more("Salt flats"), "getBoundingClientRect").mockReturnValue(box(560));
    fireEvent.click(more("Salt flats"));
    expect(surface()).toContain("bottom-full");
  });

  it("⋯ renames in place, duplicates, shows the file and deletes; while it is open the preview stays", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "More for Vesper opening" }));
    let menu = screen.getByRole("menu", { name: "Vesper opening" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Rename", "Duplicate", "Show in Finder", "Delete…"]);
    fireEvent.pointerEnter(item("Salt flats"));
    expect(lit()).toEqual(["ed1"]);
    expect(previewOf()).toBe("ed1");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Duplicate" }));
    expect(actions.duplicate).toHaveBeenCalledWith("ed1");
    expect(screen.queryByRole("menu")).toBeNull();
    // Focus goes back to ⋯ rather than to <body>
    expect(screen.getByRole("button", { name: "More for Vesper opening" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "More for Vesper opening" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Show in Finder" }));
    expect(actions.reveal).toHaveBeenCalledWith("ed1");

    fireEvent.click(screen.getByRole("button", { name: "More for Vesper opening" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete…" }));
    expect(actions.requestDelete).toHaveBeenCalledWith("ed1");

    // Rename: the field takes the row's place; Escape puts the name back, Enter commits
    fireEvent.click(screen.getByRole("button", { name: "More for Vesper opening" }));
    menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    let field = screen.getByRole("textbox", { name: "Edit name" });
    expect(field).toHaveValue("Vesper opening");
    // On the editor's field ground, with its white focus ring
    expect(field.className).not.toMatch(/ring-selection/);
    expect(field.className.split(" ")).toContain("focus-visible:ring-white/40");
    expect(field.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["[&_input]:bg-edit-field", "[&_input]:border-0"]));
    // The field takes focus a frame later, from ⋯, which had it back from the closed menu
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.pointerEnter(item("Salt flats"));
    expect(previewOf()).toBe("ed1");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(actions.rename).not.toHaveBeenCalled();
    await waitFor(() => expect(row("Vesper opening")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "More for Vesper opening" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    field = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(field, { target: { value: "Vesper, cut 2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(actions.rename).toHaveBeenCalledWith("Vesper, cut 2", "ed1");
  });

  it("a poster that fails to load gives way to the empty frame, grey", () => {
    renderHome();
    fireEvent.error(previewImage()!);
    expectBlankFrame(previewFrame());
    expect(caption()).toBe(editCardMeta(VESPER).text);
  });

  it("lists the files it cannot open under the edits; the top row's folder button shows them", () => {
    renderHome(EDITS, [
      { fileName: "Vesper copy.nbedit", problem: "duplicate", name: "Vesper opening" },
      { fileName: "Broken.nbedit", problem: "unreadable", name: null },
    ]);
    const others = screen.getByRole("list", { name: "Other files in the Edits folder" });
    expect(others).toHaveTextContent("Vesper copy.nbedit is a copy of “Vesper opening”");
    expect(others).toHaveTextContent("Couldn't read Broken.nbedit");
    // A Finder copy's one action; no row repeats the folder button
    expect(within(others).getAllByRole("button").map((b) => b.textContent)).toEqual(["Make it a separate edit"]);
    fireEvent.click(within(others).getByRole("button", { name: "Make it a separate edit" }));
    expect(actions.separateDuplicate).toHaveBeenCalledWith("Vesper copy.nbedit");
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(actions.revealFolder).toHaveBeenCalledTimes(1);
  });

  it("says where the Edits folder is on the heading", () => {
    renderHome();
    expect(screen.getByRole("heading", { name: "Edits" })).toHaveAttribute("title", "/Users/me/Node Banana/Edits");
  });

  it("a failed read again keeps the other files it found, under the error", () => {
    useEditProjectStore.setState({
      list: {
        status: "error",
        edits: [],
        problems: [{ fileName: "Broken.nbedit", problem: "unreadable", name: null }],
        folder: "/Users/me/Node Banana/Edits",
        error: "The Edits folder could not be read.",
      },
      ...actions,
    });
    render(<EditHome />);
    expect(screen.getByText("The Edits folder could not be read.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(actions.refreshList).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Other files in the Edits folder" })).toHaveTextContent("Couldn't read Broken.nbedit");
  });
});

describe("the empty Index", () => {
  it("holds New edit as its one entry, with the blurb, an empty frame and the Edits folder", () => {
    renderHome([]);
    expect(screen.queryByRole("list", { name: "Edits" })).toBeNull();
    const entries = screen.getAllByRole("button", { name: "New edit" });
    expect(entries).toHaveLength(1);
    // Focus starts on it, so Enter starts an edit; once a key is pressed its focus is a fill and a white ring, drawn
    // inside its edge (it sits on the list scroller's edges, which would cut an outer ring off)
    expect(entries[0]).toHaveFocus();
    expect(entries[0].className.split(" ")).toEqual(
      expect.arrayContaining([
        "in-data-[keyed]:focus-visible:bg-white/6",
        "in-data-[keyed]:focus-visible:ring-2",
        "in-data-[keyed]:focus-visible:ring-inset",
        "in-data-[keyed]:focus-visible:ring-white/40",
      ]),
    );
    expect(entries[0].closest("[data-edit-index-scroller]")).not.toBeNull();
    expect(screen.getByText("An edit puts videos and audio from any project on one timeline.")).toBeInTheDocument();
    expect(previewOf()).toBe("");
    expectBlankFrame(previewFrame());
    fireEvent.click(entries[0]);
    expect(actions.newEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(actions.revealFolder).toHaveBeenCalledTimes(1);
  });

  it("says Creating… while the new edit is made", () => {
    renderHome([]);
    act(() => useEditProjectStore.setState({ creating: true }));
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });
});
