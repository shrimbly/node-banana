import type { ModelInputDef } from "@/types";
import type { SocketSpec } from "./Socket";

/**
 * Turns a model's input schema into the node's input sockets.
 *
 * Ids are `image-0`, `video-0`, `audio-0`, `text-0`… in the order image,
 * video, audio, text, so a saved edge keeps pointing at the same slot when
 * the model changes. Types the schema does not mention still get a dimmed
 * placeholder socket ("Not used by this model") so a wire attached before
 * the model was chosen has somewhere to stay, and the un-indexed ids
 * (`image`, `text`) are kept as hidden sockets for edges saved before the
 * indexed scheme existed.
 */
export interface SchemaSocketOptions {
  /** Offer a video placeholder when the schema has no video input (video models). */
  videoPlaceholder?: boolean;
  /** Types this node can take at all; others in the schema are ignored. */
  types?: ReadonlyArray<"image" | "video" | "audio" | "text">;
}

const ORDER = ["image", "video", "audio", "text"] as const;
type SocketKind = (typeof ORDER)[number];

const PLACEHOLDER_LABEL: Record<SocketKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Prompt",
};

export function schemaSockets(
  schema: ReadonlyArray<ModelInputDef> | undefined,
  { videoPlaceholder = false, types = ORDER }: SchemaSocketOptions = {}
): SocketSpec[] {
  if (!schema || schema.length === 0) {
    const defaults: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];
    if (videoPlaceholder && types.includes("video")) defaults.push({ id: "video", type: "video", label: "Video" });
    defaults.push({ id: "text", type: "text", label: "Prompt" });
    return defaults.filter((s) => types.includes(s.type as SocketKind));
  }

  const sockets: SocketSpec[] = [];
  const hidden: SocketSpec[] = [];

  for (const kind of ORDER) {
    if (!types.includes(kind)) continue;
    const inputs = schema.filter((i) => i.type === kind);
    if (inputs.length > 0) {
      inputs.forEach((input, index) => {
        sockets.push({
          id: `${kind}-${index}`,
          type: kind,
          label: input.label,
          schemaName: input.name,
          title: input.description || input.label,
        });
      });
      // Un-indexed id from before the indexed scheme: still resolvable, not shown.
      hidden.push({ id: kind, type: kind, hidden: true });
    } else if (kind === "image" || kind === "text" || (kind === "video" && videoPlaceholder)) {
      sockets.push({
        id: kind,
        type: kind,
        label: PLACEHOLDER_LABEL[kind],
        placeholder: true,
        title: "Not used by this model",
      });
    }
  }

  return [...sockets, ...hidden];
}

/**
 * Whether two input schemas describe the same sockets. A missing schema
 * counts as empty. Used to skip writing a schema the node already has:
 * ModelParameters reports its inputs on every mount, and a culled node
 * remounts on every pan, so an unguarded write would dirty the workflow
 * and push a no-op undo step each time.
 */
export function sameInputSchema(
  a: ReadonlyArray<ModelInputDef> | undefined,
  b: ReadonlyArray<ModelInputDef> | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((x, i) => {
    const y = right[i];
    return (
      x.name === y.name &&
      x.type === y.type &&
      x.required === y.required &&
      x.label === y.label &&
      x.description === y.description
    );
  });
}
