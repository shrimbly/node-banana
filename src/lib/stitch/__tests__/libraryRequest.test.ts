import { describe, expect, it } from "vitest";
import { buildLibraryRequest, DEFAULT_LIBRARY_QUERY, libraryKinds, type LibraryVideoQuery } from "../libraryRequest";

const query = (patch: Partial<LibraryVideoQuery> = {}): LibraryVideoQuery => ({ ...DEFAULT_LIBRARY_QUERY, ...patch });

describe("buildLibraryRequest", () => {
  it("asks for videos only, a page of 60, and nothing else by default", () => {
    expect(buildLibraryRequest(query(), "wf_1")).toEqual({ kinds: ["video"], limit: 60 });
  });

  it("asks for another kind when told, the rest unchanged", () => {
    expect(buildLibraryRequest(query({ q: "rain" }), "wf_1", undefined, ["audio"])).toEqual({
      kinds: ["audio"],
      limit: 60,
      q: "rain",
    });
    expect(buildLibraryRequest(query(), null, "c2", ["video", "audio"])).toEqual({
      kinds: ["video", "audio"],
      limit: 60,
      cursor: "c2",
    });
  });

  it("sends a search only when it has something in it, trimmed", () => {
    expect(buildLibraryRequest(query({ q: "  veo sunset " }), null)).toEqual({ kinds: ["video"], limit: 60, q: "veo sunset" });
    expect(buildLibraryRequest(query({ q: "   " }), null)).not.toHaveProperty("q");
  });

  it("sends favourites, a project, not in a project, and the oldest-first sort", () => {
    expect(buildLibraryRequest(query({ favourites: true }), null)).toMatchObject({ favorite: true });
    expect(buildLibraryRequest(query({ project: "/p" }), null)).toMatchObject({ projects: ["/p"] });
    expect(buildLibraryRequest(query({ project: "" }), null)).toMatchObject({ projects: [""] });
    expect(buildLibraryRequest(query({ project: null }), null)).not.toHaveProperty("projects");
    expect(buildLibraryRequest(query({ sort: "oldest" }), null)).toMatchObject({ sort: "oldest" });
    expect(buildLibraryRequest(query({ sort: "newest" }), null)).not.toHaveProperty("sort");
    expect(buildLibraryRequest(query({ favourites: false }), null)).not.toHaveProperty("favorite");
  });

  it("narrows to this workflow only when the canvas has an id", () => {
    expect(buildLibraryRequest(query({ thisWorkflow: true }), "wf_1")).toMatchObject({ workflowIds: ["wf_1"] });
    expect(buildLibraryRequest(query({ thisWorkflow: true }), null)).not.toHaveProperty("workflowIds");
    expect(buildLibraryRequest(query({ thisWorkflow: false }), "wf_1")).not.toHaveProperty("workflowIds");
  });

  it("combines every toggle, and carries the cursor of the next page", () => {
    for (const favourites of [false, true]) {
      for (const thisWorkflow of [false, true]) {
        for (const project of [null, "", "/p"]) {
          for (const sort of ["newest", "oldest"] as const) {
            const request = buildLibraryRequest(query({ q: "cat", favourites, thisWorkflow, project, sort }), "wf_1", "c1");
            expect(request).toEqual({
              kinds: ["video"],
              limit: 60,
              q: "cat",
              cursor: "c1",
              ...(favourites ? { favorite: true } : {}),
              ...(thisWorkflow ? { workflowIds: ["wf_1"] } : {}),
              ...(project !== null ? { projects: [project] } : {}),
              ...(sort === "oldest" ? { sort: "oldest" } : {}),
            });
          }
        }
      }
    }
  });

  it("asks for videos and audio together for the Edit video view's All, or one kind", () => {
    expect(buildLibraryRequest(query(), null, undefined, libraryKinds("all")).kinds).toEqual(["video", "audio"]);
    expect(buildLibraryRequest(query(), null, undefined, libraryKinds("video")).kinds).toEqual(["video"]);
    expect(buildLibraryRequest(query(), null, undefined, libraryKinds("audio")).kinds).toEqual(["audio"]);
    // The default stays videos
    expect(buildLibraryRequest(query(), null).kinds).toEqual(["video"]);
  });
});
