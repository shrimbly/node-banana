import { describe, expect, it } from "vitest";

import type { ImageInputNodeData } from "@/types";
import { MAX_BATCH_IMAGES, addToBatch, batchItems, batchNodesFor, compareFilenames, removeFromBatch, showBatchItem, type ImageBatchItem } from "../imageBatch";

const item = (name: string): ImageBatchItem => ({ image: `data:image/png;base64,${name}`, filename: `${name}.png`, dimensions: { width: 1, height: 1 } });
const empty: Partial<ImageInputNodeData> = { image: null, filename: null, dimensions: null };

describe("image batches", () => {
  it("one image is a plain node, two or more a batch showing the first added", () => {
    const one = addToBatch(empty, [item("a")]).data;
    expect(one.image).toBe(item("a").image);
    expect(one.batchImages).toBeUndefined();

    const three = addToBatch(one, [item("b"), item("c")]).data;
    expect(three.batchImages).toEqual([item("a").image, item("b").image, item("c").image]);
    expect(three.batchFilenames).toEqual(["a.png", "b.png", "c.png"]);
    expect(three.batchIndex).toBe(1);
    expect(three.image).toBe(item("b").image);
  });

  it("keeps a saved image's file id with it", () => {
    const data = addToBatch({ ...empty, image: item("a").image, imageRef: "img-a", filename: "a.png" }, [item("b")]).data;
    expect(data.batchImageRefs).toEqual(["img-a", ""]);
    expect(showBatchItem(data, 0)).toMatchObject({ imageRef: "img-a", batchIndex: 0 });
    expect(showBatchItem(data, 1)).toMatchObject({ imageRef: undefined, batchIndex: 1 });
  });

  it("steps through the images, wrapping at either end", () => {
    const data = addToBatch(empty, [item("a"), item("b"), item("c")]).data;
    expect(showBatchItem(data, 3)).toMatchObject({ image: item("a").image, filename: "a.png", batchIndex: 0 });
    expect(showBatchItem(data, -1)).toMatchObject({ image: item("c").image, batchIndex: 2 });
    expect(showBatchItem(addToBatch(empty, [item("a")]).data, 1)).toBeNull();
  });

  it("removes the shown image, back to a plain node at one and empty at none", () => {
    let data: Partial<ImageInputNodeData> = addToBatch(empty, [item("a"), item("b"), item("c")]).data;
    data = removeFromBatch(data, 2);
    expect(data.batchImages).toHaveLength(2);
    expect(data.image).toBe(item("b").image);
    data = removeFromBatch(data, 0);
    expect(data.batchImages).toBeUndefined();
    expect(data.image).toBe(item("b").image);
    data = removeFromBatch(data, 0);
    expect(data.image).toBeNull();
    expect(batchItems(data)).toEqual([]);
  });

  it("holds at most MAX_BATCH_IMAGES and says how many it left out", () => {
    const many = Array.from({ length: MAX_BATCH_IMAGES + 5 }, (_, i) => item(`i${i}`));
    const { data, dropped } = addToBatch(empty, many);
    expect(data.batchImages).toHaveLength(MAX_BATCH_IMAGES);
    expect(dropped).toBe(5);
  });

  it("orders file names as a person reads them", () => {
    expect(["img10.png", "img2.png", "Img1.png"].sort(compareFilenames)).toEqual(["Img1.png", "img2.png", "img10.png"]);
  });

  it("finds the batches a scope reads", () => {
    const batch = addToBatch(empty, [item("a"), item("b")]).data;
    const nodes = [
      { id: "i", type: "imageInput", data: batch },
      { id: "single", type: "imageInput", data: addToBatch(empty, [item("a")]).data },
      { id: "g", type: "nanoBanana", data: {} },
      { id: "x", type: "prompt", data: {} },
    ] as never[];
    const edges = [{ source: "i", target: "g" }];
    expect(batchNodesFor(nodes, edges, { kind: "all" }).map((node) => node.id)).toEqual(["i"]);
    expect(batchNodesFor(nodes, edges, { kind: "nodes", nodeIds: ["g"] }).map((node) => node.id)).toEqual(["i"]);
    expect(batchNodesFor(nodes, edges, { kind: "nodes", nodeIds: ["x"] })).toEqual([]);
  });
});
