/**
 * The one-function adapter over HTML-in-Canvas. The painter uses a single
 * operation, "paint this element into the bound texture", so a rename in
 * Chromium only touches this file.
 *
 * Chromium 152 (Electron 44), measured in the spike:
 *   gl.texElementImage2D(target, internalformat, element)
 *   - no level, format or type; internalformat must be sized (RGBA8)
 *   - the element must be a child of the WebGL canvas (<canvas layoutsubtree>)
 *   - the texture is the element's css size times the canvas's backing scale
 *     (canvas.width / its css width), with row 0 at the element's top
 *   - only with --enable-blink-features=CanvasDrawElement
 *
 * Chromium 155 renames it, measured on Chromium 158 (Electron 46):
 *   gl.texElementSubImage2D(target, level, xoffset, yoffset, element)
 *   - it allocates nothing: the texture's storage is made first with
 *     texImage2D (INVALID_OPERATION otherwise), at the same size as before
 *     (css size times backing scale), and row 0 is still the element's top
 *   - the canvas carries content="drawable" instead of layoutsubtree, and the
 *     painted element itself the `drawable` attribute (both are required)
 *   - on by default there; the CanvasDrawElement switch does no harm
 * The 155 names win where both exist.
 */

type Gl152 = WebGL2RenderingContext & {
  texElementImage2D(target: GLenum, internalformat: GLenum, element: Element): void;
};
type Gl155 = WebGL2RenderingContext & {
  texElementSubImage2D(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, element: Element): void;
};

export interface HtmlInCanvasSupport {
  /** The painter can run, on one set of names or the other. */
  available: boolean;
  /** Chromium 152-154. */
  texElementImage2D: boolean;
  layoutSubtree: boolean;
  /** Chromium 155+. */
  texElementSubImage2D: boolean;
}

export function detectHtmlInCanvas(): HtmlInCanvasSupport {
  const gl = globalThis.WebGL2RenderingContext?.prototype;
  const canvas = globalThis.HTMLCanvasElement?.prototype;
  const has = (proto: object | undefined, name: string) => !!proto && name in proto;
  const support = {
    texElementImage2D: has(gl, "texElementImage2D"),
    layoutSubtree: has(canvas, "layoutSubtree"),
    texElementSubImage2D: has(gl, "texElementSubImage2D"),
  };
  return { available: support.texElementSubImage2D || (support.texElementImage2D && support.layoutSubtree), ...support };
}

const usesSubImage = () => detectHtmlInCanvas().texElementSubImage2D;

/** Marks a canvas so its children are laid out (and can be painted) but not shown, or (on = false) unmarks it. */
export function enableLayoutSubtree(canvas: HTMLCanvasElement, on = true) {
  if (usesSubImage()) {
    if (on) canvas.setAttribute("content", "drawable");
    else canvas.removeAttribute("content");
  } else canvas.toggleAttribute("layoutsubtree", on);
}

/** Marks a child of that canvas as one that is painted. */
export function markDrawable(element: Element) {
  element.setAttribute("drawable", "");
}

/** The storage made for each texture on 155 (it must exist before the paint), so it is made again only on a resize. */
const allocated = new WeakMap<WebGLTexture, { width: number; height: number }>();

/**
 * Paints `element` into the texture bound to TEXTURE_2D, replacing level 0.
 * `width` and `height` are the texture's size in texels: the element's css
 * size times the canvas's backing scale (152 takes it from the element).
 */
export function paintElement(gl: WebGL2RenderingContext, element: Element, width: number, height: number) {
  if ("texElementSubImage2D" in gl) {
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const size = texture ? allocated.get(texture) : undefined;
    if (!texture || size?.width !== width || size.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (texture) allocated.set(texture, { width, height });
    }
    (gl as Gl155).texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, element);
    return;
  }
  if (!("texElementImage2D" in gl)) throw new Error("HTML-in-Canvas is not available: start with --enable-blink-features=CanvasDrawElement");
  (gl as Gl152).texElementImage2D(gl.TEXTURE_2D, gl.RGBA8, element);
}
