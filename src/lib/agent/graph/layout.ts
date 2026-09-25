/**
 * Where new nodes go.
 *
 * New nodes are laid out as left→right DAG columns (depth = longest path,
 * loop edges ignored), per connected cluster. A cluster is anchored to what it
 * connects to: right of its upstream nodes, left of its downstream nodes, or —
 * when it touches nothing — right of the existing canvas (or in the visible
 * area when the canvas is empty or being replaced). A cluster that would
 * overlap existing nodes slides down until it is clear.
 */

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  isLoop?: boolean;
}

export interface LayoutViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom?: number;
}

export const COLUMN_GAP = 100;
export const ROW_GAP = 40;
const CLUSTER_GAP = 200;
const COLLISION_MARGIN = 30;
const CLUSTER_STACK_GAP = 80;

export interface PlaceRequest {
  /** Nodes to place, in creation order. */
  place: Array<{ id: string; width: number; height: number }>;
  /** Nodes already positioned (they do not move). */
  fixed: LayoutBox[];
  edges: LayoutEdge[];
  viewport?: LayoutViewport;
}

interface ClusterShape {
  ids: string[];
  sizes: Map<string, { width: number; height: number }>;
  /** Offsets relative to the cluster's top-left. */
  offsets: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  /** Column index of every node, and each column's x offset and width. */
  depth: Map<string, number>;
  columnX: number[];
  columnWidth: number[];
}

/** Positions for `place`, keyed by id. */
export function placeNewNodes(request: PlaceRequest): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (request.place.length === 0) return result;

  const sizes = new Map(request.place.map((n) => [n.id, n]));
  const fixedById = new Map(request.fixed.map((b) => [b.id, b]));
  const edges = request.edges.filter((e) => !e.isLoop);
  const obstacles: LayoutBox[] = [...request.fixed];
  const bbox = boundingBox(request.fixed);

  for (const component of components(request.place.map((n) => n.id), edges)) {
    const shape = shapeCluster(component, sizes, edges);

    const upstream = edges.filter((e) => fixedById.has(e.source) && shape.depth.has(e.target));
    const downstream = edges.filter((e) => shape.depth.has(e.source) && fixedById.has(e.target));

    let origin: { x: number; y: number };
    if (upstream.length > 0) {
      // Each node that an existing node feeds must sit right of that node.
      const x = Math.max(
        ...upstream.map((e) => {
          const from = fixedById.get(e.source)!;
          return from.x + from.width + COLUMN_GAP - shape.columnX[shape.depth.get(e.target)!];
        }),
      );
      const first = fixedById.get(upstream[0].source)!;
      const firstTarget = shape.offsets.get(upstream[0].target)!;
      origin = { x, y: first.y - firstTarget.y };
    } else if (downstream.length > 0) {
      // A new node feeding an existing one (e.g. a prompt): left of it.
      const x = Math.min(
        ...downstream.map((e) => {
          const to = fixedById.get(e.target)!;
          const column = shape.depth.get(e.source)!;
          return to.x - COLUMN_GAP - (shape.columnX[column] + shape.columnWidth[column]);
        }),
      );
      const first = fixedById.get(downstream[0].target)!;
      const firstSource = shape.offsets.get(downstream[0].source)!;
      origin = { x, y: first.y - firstSource.y };
    } else if (!bbox) {
      origin = viewportOrigin(shape, request.viewport);
    } else {
      origin = { x: bbox.maxX + CLUSTER_GAP, y: bbox.minY };
    }

    const placed = slideClear(shape, origin, obstacles);
    for (const box of placed) {
      result.set(box.id, { x: box.x, y: box.y });
      obstacles.push(box);
    }
  }
  return result;
}

/**
 * Tidy existing nodes: each connected cluster is re-laid out as columns, the
 * clusters stacked top to bottom from the set's current top-left corner.
 */
export function arrangeNodes(
  nodes: LayoutBox[],
  edges: LayoutEdge[],
  others: LayoutBox[] = [],
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;
  const bbox = boundingBox(nodes)!;
  const sizes = new Map(nodes.map((n) => [n.id, n]));
  const live = edges.filter((e) => !e.isLoop);
  // Clusters keep their current top-to-bottom order.
  const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id);
  const obstacles: LayoutBox[] = [...others];
  let y = bbox.minY;
  for (const component of components(ordered, live)) {
    const shape = shapeCluster(component, sizes, live);
    const placed = slideClear(shape, { x: bbox.minX, y }, obstacles);
    for (const box of placed) {
      result.set(box.id, { x: box.x, y: box.y });
      obstacles.push(box);
    }
    y = Math.max(...placed.map((b) => b.y + b.height)) + CLUSTER_STACK_GAP;
  }
  return result;
}

function viewportOrigin(shape: ClusterShape, viewport: LayoutViewport | undefined): { x: number; y: number } {
  if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) return { x: 100, y: 100 };
  const x = shape.width < viewport.width * 0.84
    ? viewport.x + (viewport.width - shape.width) / 2
    : viewport.x + viewport.width * 0.08;
  const y = viewport.y + Math.max(viewport.height - shape.height, 0) / 2;
  return { x, y };
}

/** Connected components (edges within the set, either direction), in first-seen order. */
function components(ids: string[], edges: LayoutEdge[]): string[][] {
  const inSet = new Set(ids);
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (inSet.has(edge.source) && inSet.has(edge.target)) {
      neighbours.get(edge.source)!.push(edge.target);
      neighbours.get(edge.target)!.push(edge.source);
    }
  }
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const component: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of neighbours.get(current)!) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    // Keep creation order inside the component.
    const order = new Map(ids.map((value, index) => [value, index]));
    result.push(component.sort((a, b) => order.get(a)! - order.get(b)!));
  }
  return result;
}

/** Column layout of one cluster, relative to its own top-left. */
function shapeCluster(
  ids: string[],
  sizes: Map<string, { width: number; height: number }>,
  edges: LayoutEdge[],
): ClusterShape {
  const inSet = new Set(ids);
  const internal = edges.filter((e) => inSet.has(e.source) && inSet.has(e.target) && e.source !== e.target);
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of internal) {
    predecessors.get(edge.target)!.push(edge.source);
    successors.get(edge.source)!.push(edge.target);
  }

  // Longest-path depth via Kahn's order; nodes stuck in a cycle stay at 0.
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const remaining = new Map<string, number>(ids.map((id) => [id, predecessors.get(id)!.length]));
  const queue = ids.filter((id) => remaining.get(id) === 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of successors.get(current)!) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(current)! + 1));
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }

  const columnCount = Math.max(...ids.map((id) => depth.get(id)!)) + 1;
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const id of ids) columns[depth.get(id)!].push(id);

  // Order each column by the average row of its predecessors (fewer crossings),
  // then pull the first column into the order of what it feeds.
  const rowOf = new Map<string, number>();
  columns[0].forEach((id, index) => rowOf.set(id, index));
  for (let c = 1; c < columnCount; c++) {
    columns[c] = sortByBarycentre(columns[c], predecessors, rowOf);
    columns[c].forEach((id, index) => rowOf.set(id, index));
  }
  if (columnCount > 1) {
    columns[0] = sortByBarycentre(columns[0], successors, rowOf);
    columns[0].forEach((id, index) => rowOf.set(id, index));
  }

  const columnWidth = columns.map((column) => Math.max(...column.map((id) => sizes.get(id)!.width)));
  const columnHeight = columns.map(
    (column) => column.reduce((sum, id) => sum + sizes.get(id)!.height, 0) + ROW_GAP * (column.length - 1),
  );
  const height = Math.max(...columnHeight);
  const columnX: number[] = [];
  let x = 0;
  for (let c = 0; c < columnCount; c++) {
    columnX.push(x);
    x += columnWidth[c] + COLUMN_GAP;
  }
  const width = x - COLUMN_GAP;

  const offsets = new Map<string, { x: number; y: number }>();
  columns.forEach((column, c) => {
    let y = (height - columnHeight[c]) / 2;
    for (const id of column) {
      offsets.set(id, { x: columnX[c], y });
      y += sizes.get(id)!.height + ROW_GAP;
    }
  });
  const clusterSizes = new Map(ids.map((id) => [id, { width: sizes.get(id)!.width, height: sizes.get(id)!.height }]));
  return { ids, sizes: clusterSizes, offsets, width, height, depth, columnX, columnWidth };
}

function sortByBarycentre(column: string[], neighbours: Map<string, string[]>, rowOf: Map<string, number>): string[] {
  const score = (id: string, index: number) => {
    const rows = neighbours.get(id)!.map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
    return rows.length > 0 ? rows.reduce((a, b) => a + b, 0) / rows.length : index;
  };
  return column
    .map((id, index) => ({ id, index, score: score(id, index) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.id);
}

/** Boxes for the cluster at `origin`, moved down until they overlap nothing. */
function slideClear(shape: ClusterShape, origin: { x: number; y: number }, obstacles: LayoutBox[]): LayoutBox[] {
  const boxesAt = (dy: number): LayoutBox[] =>
    shape.ids.map((id) => {
      const offset = shape.offsets.get(id)!;
      const size = shape.sizes.get(id)!;
      return {
        id,
        x: Math.round(origin.x + offset.x),
        y: Math.round(origin.y + offset.y + dy),
        width: size.width,
        height: size.height,
      };
    });

  let dy = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const boxes = boxesAt(dy);
    let push = 0;
    for (const box of boxes) {
      for (const obstacle of obstacles) {
        if (overlaps(box, obstacle)) {
          push = Math.max(push, obstacle.y + obstacle.height + COLLISION_MARGIN - box.y);
        }
      }
    }
    if (push <= 0) return boxes;
    dy += push;
  }
  return boxesAt(dy);
}

function overlaps(a: LayoutBox, b: LayoutBox): boolean {
  return (
    a.x < b.x + b.width + COLLISION_MARGIN &&
    a.x + a.width + COLLISION_MARGIN > b.x &&
    a.y < b.y + b.height + COLLISION_MARGIN &&
    a.y + a.height + COLLISION_MARGIN > b.y
  );
}

export function boundingBox(boxes: readonly LayoutBox[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((b) => b.x)),
    minY: Math.min(...boxes.map((b) => b.y)),
    maxX: Math.max(...boxes.map((b) => b.x + b.width)),
    maxY: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}
