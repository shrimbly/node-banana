/**
 * Where new nodes go.
 *
 * New nodes are laid out as left→right DAG columns (depth = longest path,
 * loop edges ignored), per connected cluster. A cluster is anchored to what it
 * connects to: right of its upstream nodes, left of its downstream nodes, or —
 * when it touches nothing — right of the existing canvas (or in the visible
 * area when the canvas is empty or being replaced). A cluster that would
 * overlap existing nodes slides down until it is clear.
 *
 * Groups: the columns are made of *units*, a lone node or a whole group. A
 * group's members are first laid out as their own block (columns, separate
 * chains stacked), which the group's box wraps with padding; the unit is that
 * box plus the band above it where the canvas draws the group's title. Units
 * are then laid out like nodes: groups that feed each other read left→right,
 * groups that do not stack top to bottom, and nothing overlaps a box or the
 * title above it.
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
/** Space between a group's box and the nodes inside it (the canvas's createGroup uses 20 around measured nodes). */
export const GROUP_PADDING = 30;
/**
 * The group's title pill sits on top of its box, outside it, and is scaled
 * by 1/zoom (about 24px tall at 100%): the band kept clear above every box
 * covers it down to roughly 50% zoom.
 */
export const GROUP_HEADER_ROOM = 50;

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

/** A block laid out as one piece: a lone node, or a group's box (with its title band) and its members. */
interface Unit {
  id: string;
  width: number;
  height: number;
  /** Member nodes and their offsets from the unit's top-left. */
  members: Map<string, { x: number; y: number }>;
  /** Set for a group unit: its box is the unit minus the title band on top. */
  groupId?: string;
}

export interface GroupedPlaceRequest extends PlaceRequest {
  /**
   * Groups whose members are all in `place`, in order: each is laid out as
   * its own block and positioned as one unit. A node listed in several groups
   * belongs to the first.
   */
  groups: Array<{ id: string; members: string[] }>;
}

export interface GroupedPlacement {
  /** Node positions, keyed by id. */
  positions: Map<string, { x: number; y: number }>;
  /** Each group's box (without the title band above it), keyed by group id. */
  groupBoxes: Map<string, LayoutBox>;
}

/** Positions for `place`, keyed by id. */
export function placeNewNodes(request: PlaceRequest): Map<string, { x: number; y: number }> {
  return placeNewNodesInGroups({ ...request, groups: [] }).positions;
}

/** As placeNewNodes, with each group in `groups` laid out as a block inside its box. */
export function placeNewNodesInGroups(request: GroupedPlaceRequest): GroupedPlacement {
  const sizes = new Map(request.place.map((n) => [n.id, n]));
  const edges = request.edges.filter((e) => !e.isLoop);
  const groupOf = new Map<string, { id: string; members: string[] }>();
  for (const group of request.groups) {
    for (const id of group.members) if (sizes.has(id) && !groupOf.has(id)) groupOf.set(id, group);
  }
  // Units in creation order: a group where its first member was created.
  const units: Unit[] = [];
  const built = new Set<string>();
  for (const node of request.place) {
    const group = groupOf.get(node.id);
    if (!group) {
      units.push(nodeUnit(node));
    } else if (!built.has(group.id)) {
      built.add(group.id);
      units.push(groupUnit(group.id, group.members.filter((id) => groupOf.get(id) === group), sizes, edges));
    }
  }
  return expandUnits(units, placeUnits(units, request.fixed, edges, request.viewport));
}

function placeUnits(
  units: Unit[],
  fixed: LayoutBox[],
  edges: LayoutEdge[],
  viewport: LayoutViewport | undefined,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (units.length === 0) return result;

  const unitOf = unitIndex(units);
  const sizes = new Map(units.map((u) => [u.id, u]));
  const unitEdges = edgesBetweenUnits(edges, unitOf);
  const fixedById = new Map(fixed.map((b) => [b.id, b]));
  const obstacles: LayoutBox[] = [...fixed];
  const bbox = boundingBox(fixed);

  for (const component of components(units.map((u) => u.id), unitEdges)) {
    const shape = shapeCluster(component, sizes, unitEdges);
    const inShape = (nodeId: string) => {
      const unit = unitOf.get(nodeId);
      return !!unit && shape.depth.has(unit.id);
    };
    const column = (nodeId: string) => shape.depth.get(unitOf.get(nodeId)!.id)!;
    // Where a member node sits relative to the cluster's top-left.
    const offsetOf = (nodeId: string) => {
      const unit = unitOf.get(nodeId)!;
      const at = shape.offsets.get(unit.id)!;
      const inside = unit.members.get(nodeId)!;
      return { x: at.x + inside.x, y: at.y + inside.y };
    };

    const upstream = edges.filter((e) => fixedById.has(e.source) && inShape(e.target));
    const downstream = edges.filter((e) => inShape(e.source) && fixedById.has(e.target));

    let origin: { x: number; y: number };
    if (upstream.length > 0) {
      // Each unit that an existing node feeds must sit right of that node.
      const x = Math.max(
        ...upstream.map((e) => {
          const from = fixedById.get(e.source)!;
          return from.x + from.width + COLUMN_GAP - shape.columnX[column(e.target)];
        }),
      );
      const first = fixedById.get(upstream[0].source)!;
      origin = { x, y: first.y - offsetOf(upstream[0].target).y };
    } else if (downstream.length > 0) {
      // A new node feeding an existing one (e.g. a prompt): left of it.
      const x = Math.min(
        ...downstream.map((e) => {
          const to = fixedById.get(e.target)!;
          const c = column(e.source);
          return to.x - COLUMN_GAP - (shape.columnX[c] + shape.columnWidth[c]);
        }),
      );
      const first = fixedById.get(downstream[0].target)!;
      origin = { x, y: first.y - offsetOf(downstream[0].source).y };
    } else if (!bbox) {
      origin = viewportOrigin(shape, viewport);
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
  return arrangeWithGroups(nodes, edges, others, []).positions;
}

export interface ArrangeGroup {
  id: string;
  /** Its members among the nodes being arranged. */
  members: string[];
  /** Its box now, when it has one: the arrangement starts from where the group is. */
  box?: LayoutBox;
}

/**
 * As arrangeNodes, with each group tidied inside a box refit around its
 * members and moved as one unit.
 */
export function arrangeWithGroups(
  nodes: LayoutBox[],
  edges: LayoutEdge[],
  others: LayoutBox[],
  groups: ArrangeGroup[],
): GroupedPlacement {
  if (nodes.length === 0) return { positions: new Map(), groupBoxes: new Map() };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const live = edges.filter((e) => !e.isLoop);
  const placed: Array<{ unit: Unit; x: number; y: number }> = [];
  const grouped = new Set<string>();
  for (const group of groups) {
    const members = group.members.filter((id) => byId.has(id) && !grouped.has(id));
    if (members.length === 0) continue;
    for (const id of members) grouped.add(id);
    const unit = groupUnit(group.id, members, byId, live);
    const fitted = fitGroupBox(group.id, members.map((id) => byId.get(id)!));
    const box = group.box ?? fitted;
    placed.push({ unit, x: box.x, y: box.y - GROUP_HEADER_ROOM });
  }
  for (const node of nodes) if (!grouped.has(node.id)) placed.push({ unit: nodeUnit(node), x: node.x, y: node.y });

  const units = placed.map((p) => p.unit);
  const unitOf = unitIndex(units);
  const sizes = new Map(units.map((u) => [u.id, u]));
  const unitEdges = edgesBetweenUnits(live, unitOf);
  // Clusters keep their current top-to-bottom order.
  const ordered = [...placed].sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.unit.id);
  const x = Math.min(...placed.map((p) => p.x));
  let y = Math.min(...placed.map((p) => p.y));
  const obstacles: LayoutBox[] = [...others];
  const positions = new Map<string, { x: number; y: number }>();
  for (const component of components(ordered, unitEdges)) {
    const shape = shapeCluster(component, sizes, unitEdges);
    const boxes = slideClear(shape, { x, y }, obstacles);
    for (const box of boxes) {
      positions.set(box.id, { x: box.x, y: box.y });
      obstacles.push(box);
    }
    y = Math.max(...boxes.map((b) => b.y + b.height)) + CLUSTER_STACK_GAP;
  }
  return expandUnits(units, positions);
}

/**
 * One group's members laid out as a block inside a fitted box whose top-left
 * is at `boxOrigin`, moved down until the box and its title band overlap none
 * of `obstacles`.
 */
export function layoutGroupAt(
  groupId: string,
  members: LayoutBox[],
  edges: LayoutEdge[],
  boxOrigin: { x: number; y: number },
  obstacles: LayoutBox[],
): GroupedPlacement {
  const sizes = new Map(members.map((m) => [m.id, m]));
  const unit = groupUnit(groupId, members.map((m) => m.id), sizes, edges.filter((e) => !e.isLoop));
  const shape = shapeCluster([unit.id], new Map([[unit.id, unit]]), []);
  const [box] = slideClear(shape, { x: boxOrigin.x, y: boxOrigin.y - GROUP_HEADER_ROOM }, obstacles);
  return expandUnits([unit], new Map([[unit.id, { x: box.x, y: box.y }]]));
}

/** The box the canvas would draw around these nodes: their bounding box plus the group padding. */
export function fitGroupBox(groupId: string, members: readonly LayoutBox[]): LayoutBox {
  const b = boundingBox(members)!;
  return {
    id: `group:${groupId}`,
    x: Math.round(b.minX - GROUP_PADDING),
    y: Math.round(b.minY - GROUP_PADDING),
    width: Math.round(b.maxX - b.minX + 2 * GROUP_PADDING),
    height: Math.round(b.maxY - b.minY + 2 * GROUP_PADDING),
  };
}

/** A group's box with the title band above it: what must stay clear of other nodes and groups. */
export function groupFootprint(box: LayoutBox): LayoutBox {
  return { ...box, y: box.y - GROUP_HEADER_ROOM, height: box.height + GROUP_HEADER_ROOM };
}

/** Whether two boxes share any area (touching edges do not count). */
export function boxesOverlap(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function nodeUnit(node: { id: string; width: number; height: number }): Unit {
  return { id: node.id, width: node.width, height: node.height, members: new Map([[node.id, { x: 0, y: 0 }]]) };
}

/** A group's members as their own block (columns; separate chains stacked), wrapped in its box and title band. */
function groupUnit(
  groupId: string,
  memberIds: string[],
  sizes: Map<string, { width: number; height: number }>,
  edges: LayoutEdge[],
): Unit {
  const members = new Map<string, { x: number; y: number }>();
  let y = 0;
  let width = 0;
  for (const component of components(memberIds, edges)) {
    const shape = shapeCluster(component, sizes, edges);
    for (const id of component) {
      const offset = shape.offsets.get(id)!;
      members.set(id, { x: GROUP_PADDING + offset.x, y: GROUP_HEADER_ROOM + GROUP_PADDING + y + offset.y });
    }
    width = Math.max(width, shape.width);
    y += shape.height + CLUSTER_STACK_GAP;
  }
  const height = y - CLUSTER_STACK_GAP;
  return {
    id: `unit:${groupId}`,
    width: width + 2 * GROUP_PADDING,
    height: GROUP_HEADER_ROOM + height + 2 * GROUP_PADDING,
    members,
    groupId,
  };
}

function unitIndex(units: Unit[]): Map<string, Unit> {
  const unitOf = new Map<string, Unit>();
  for (const unit of units) for (const id of unit.members.keys()) unitOf.set(id, unit);
  return unitOf;
}

/** Node edges as edges between the units holding their ends (edges inside one unit dropped). */
function edgesBetweenUnits(edges: LayoutEdge[], unitOf: Map<string, Unit>): LayoutEdge[] {
  const result: LayoutEdge[] = [];
  for (const edge of edges) {
    if (edge.isLoop) continue;
    const source = unitOf.get(edge.source);
    const target = unitOf.get(edge.target);
    if (source && target && source !== target) result.push({ source: source.id, target: target.id });
  }
  return result;
}

/** Member positions and group boxes from unit positions (unit top-lefts are already whole numbers). */
function expandUnits(units: Unit[], at: Map<string, { x: number; y: number }>): GroupedPlacement {
  const positions = new Map<string, { x: number; y: number }>();
  const groupBoxes = new Map<string, LayoutBox>();
  for (const unit of units) {
    const origin = at.get(unit.id);
    if (!origin) continue;
    for (const [id, offset] of unit.members) {
      positions.set(id, { x: Math.round(origin.x + offset.x), y: Math.round(origin.y + offset.y) });
    }
    if (unit.groupId) {
      groupBoxes.set(unit.groupId, {
        id: `group:${unit.groupId}`,
        x: origin.x,
        y: origin.y + GROUP_HEADER_ROOM,
        width: unit.width,
        height: unit.height - GROUP_HEADER_ROOM,
      });
    }
  }
  return { positions, groupBoxes };
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
