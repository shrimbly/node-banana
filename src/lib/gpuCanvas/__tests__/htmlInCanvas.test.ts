import { describe, expect, it, vi } from "vitest";
import { paintElement } from "../htmlInCanvas";

const TEXTURE_2D = 0x0de1, TEXTURE_BINDING_2D = 0x8069, RGBA8 = 0x8058, RGBA = 0x1908, UNSIGNED_BYTE = 0x1401;

function gl155(bound: object) {
  return {
    TEXTURE_2D, TEXTURE_BINDING_2D, RGBA8, RGBA, UNSIGNED_BYTE,
    getParameter: vi.fn(() => bound),
    texImage2D: vi.fn(),
    texElementSubImage2D: vi.fn(),
  } as unknown as WebGL2RenderingContext & { texImage2D: ReturnType<typeof vi.fn>; texElementSubImage2D: ReturnType<typeof vi.fn> };
}

describe("paintElement", () => {
  it("on Chromium 155 makes the texture's storage first, once per size, then paints into it", () => {
    const texture = {}, element = {} as Element, gl = gl155(texture);
    paintElement(gl, element, 200, 100);
    paintElement(gl, element, 200, 100);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledWith(TEXTURE_2D, 0, RGBA8, 200, 100, 0, RGBA, UNSIGNED_BYTE, null);
    paintElement(gl, element, 400, 100);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    expect(gl.texElementSubImage2D).toHaveBeenCalledTimes(3);
    expect(gl.texElementSubImage2D).toHaveBeenLastCalledWith(TEXTURE_2D, 0, 0, 0, element);
  });

  it("on Chromium 152 paints with texElementImage2D, which sizes the texture itself", () => {
    const gl = { TEXTURE_2D, RGBA8, texElementImage2D: vi.fn() } as unknown as WebGL2RenderingContext & { texElementImage2D: ReturnType<typeof vi.fn> };
    const element = {} as Element;
    paintElement(gl, element, 200, 100);
    expect(gl.texElementImage2D).toHaveBeenCalledWith(TEXTURE_2D, RGBA8, element);
  });
});
