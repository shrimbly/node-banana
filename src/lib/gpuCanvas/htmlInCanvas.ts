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
 * Chromium 155 renames the call texElementSubImage2D and the attribute
 * becomes content="drawable". Electron 44 does not have them, so they are
 * detected and reported but not wired up: a build on 155 reports the canvas
 * as unavailable rather than calling a signature nobody has measured.
 */

type Gl152 = WebGL2RenderingContext & {
  texElementImage2D(target: GLenum, internalformat: GLenum, element: Element): void;
};

export interface HtmlInCanvasSupport {
  /** The 152 names exist: the painter can run. */
  available: boolean;
  texElementImage2D: boolean;
  layoutSubtree: boolean;
  /** Chromium 155+ names, seen but not used yet. */
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
  return { available: support.texElementImage2D && support.layoutSubtree, ...support };
}

/** Marks a canvas so its children are laid out (and can be painted) but not shown. */
export function enableLayoutSubtree(canvas: HTMLCanvasElement) {
  canvas.setAttribute("layoutsubtree", "");
}

/** Paints `element` into the texture bound to TEXTURE_2D, replacing level 0. */
export function paintElement(gl: WebGL2RenderingContext, element: Element) {
  if (!("texElementImage2D" in gl)) throw new Error("HTML-in-Canvas is not available: start with --enable-blink-features=CanvasDrawElement");
  (gl as Gl152).texElementImage2D(gl.TEXTURE_2D, gl.RGBA8, element);
}
