import { describe, expect, it } from "vitest";
import type { AssetView } from "@/lib/assets/types";
import { groupByProject } from "../library/LibraryResults";

const LAUNCH = { id: "wf_1", name: "Launch", projectPath: "/Users/me/Node Banana/Launch film" };
const DESERT = { id: "wf_2", name: "Desert", projectPath: "/Users/me/Node Banana/Desert spots" };

/** Only what the grouping reads. `null`: a record with no workflow joined, which the grouping also allows for. */
function file(id: string, kind: "video" | "audio", workflow: AssetView["workflow"] | null): AssetView {
  return { id, kind, filename: `${id}.${kind === "audio" ? "m4a" : "mp4"}`, workflow } as unknown as AssetView;
}

const ids = (list: AssetView[]) => list.map((a) => a.id);

describe("groupByProject", () => {
  it("puts each project where its first file comes in the list, its files in the list's order", () => {
    const groups = groupByProject([
      file("d1", "video", DESERT),
      file("l1", "video", LAUNCH),
      file("d2", "video", DESERT),
      file("l2", "video", LAUNCH),
    ]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ["/Users/me/Node Banana/Desert spots", "Desert spots"],
      ["/Users/me/Node Banana/Launch film", "Launch film"],
    ]);
    expect(ids(groups[0].videos)).toEqual(["d1", "d2"]);
    expect(ids(groups[1].videos)).toEqual(["l1", "l2"]);
  });

  it("keeps a group's sounds apart from its videos, each in the list's order, whichever comes first", () => {
    const [group] = groupByProject([
      file("s1", "audio", LAUNCH),
      file("v1", "video", LAUNCH),
      file("s2", "audio", LAUNCH),
      file("v2", "video", LAUNCH),
    ]);
    expect(ids(group.videos)).toEqual(["v1", "v2"]);
    expect(ids(group.audio)).toEqual(["s1", "s2"]);
  });

  it("gathers files in no project, with or without a workflow, under “Not in a project”, keyed by the empty path", () => {
    const groups = groupByProject([
      file("n1", "video", null),
      file("l1", "video", LAUNCH),
      file("n2", "audio", { id: "wf_3", name: "Loose", projectPath: null }),
    ]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ["", "Not in a project"],
      ["/Users/me/Node Banana/Launch film", "Launch film"],
    ]);
    expect(ids(groups[0].videos)).toEqual(["n1"]);
    expect(ids(groups[0].audio)).toEqual(["n2"]);
  });

  it("has no groups for an empty list", () => {
    expect(groupByProject([])).toEqual([]);
  });
});
