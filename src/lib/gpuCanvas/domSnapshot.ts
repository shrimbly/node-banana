/**
 * The painter's other way of turning its sheet into pixels, for pages without
 * HTML-in-Canvas (a browser): the sheet is copied into an SVG <foreignObject>
 * with the page's styles, drawn as an image, and that image uploaded.
 *
 * An SVG drawn as an image loads nothing, so everything it shows is carried in
 * it: the page's style rules (with `:root`, `html` and `body` pointed at
 * stand-in wrappers that carry those elements' attributes), the fonts and
 * other files those rules name (as data URLs), each image, canvas and video
 * frame (as a data URL at the size it shows), and form fields' current values.
 * It must be a data URL: Chromium taints an SVG with a foreignObject loaded
 * from a blob URL, and a WebGL upload of it then throws.
 */

const ROOT = "data-nb-snapshot-root";
const BODY = "data-nb-snapshot-body";
/** Images drawn at more than this many device pixels a side are drawn smaller (a sheet's image never needs more). */
const MAX_IMAGE_SIDE = 2048;
/**
 * Pictures up to this many pixels that show at half their size or more go in as their file; others are drawn at
 * twice the size they show. A large file (a generator's 2048 px PNG is several MB) costs far more to read, carry and
 * decode in every snapshot than drawing it smaller does, while a small one keeps its exact pixels.
 */
const FILE_IMAGE_PIXELS = 1024 * 1024;
/** Data URLs kept for images and frames, by source and drawn size; the oldest go first. */
const MAX_CACHED_IMAGES = 400;
/** Files kept as data URLs (fonts, pictures put in as they are); the least recently used go first. */
const MAX_CACHED_FILES = 300;

const fileCache = new Map<string, Promise<string>>();
const imageCache = new Map<string, string>();
let cssCache: { key: string; text: Promise<string> } | null = null;

/** A same-origin (or CORS) file as a data URL; empty if it cannot be read. */
function fileAsDataUrl(url: string): Promise<string> {
  let found = fileCache.get(url);
  if (found) {
    fileCache.delete(url);
    fileCache.set(url, found);
  } else {
    found = fetch(url)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }))
      .catch(() => "");
    fileCache.set(url, found);
    while (fileCache.size > MAX_CACHED_FILES) fileCache.delete(fileCache.keys().next().value!);
  }
  return found;
}

/** `:root`, `html` and `body` in a selector, pointed at the wrappers that stand in for them. */
export function rewriteSelector(selector: string): string {
  return selector
    .replace(/:root\b/g, `[${ROOT}]`)
    .replace(/(^|[\s>+~,(])html(?=$|[\s.#:[>+~,)])/g, `$1[${ROOT}]`)
    .replace(/(^|[\s>+~,(])body(?=$|[\s.#:[>+~,)])/g, `$1[${BODY}]`);
}

function ruleText(rule: CSSRule): string {
  if (rule instanceof CSSImportRule) return rule.styleSheet ? rulesText(rule.styleSheet) : "";
  if (rule instanceof CSSStyleRule) {
    const nested = rule.cssRules?.length ? [...rule.cssRules].map(ruleText).join("") : "";
    return `${rewriteSelector(rule.selectorText)}{${rule.style.cssText}${nested}}`;
  }
  if (typeof CSSGroupingRule !== "undefined" && rule instanceof CSSGroupingRule) {
    const text = rule.cssText;
    return `${text.slice(0, text.indexOf("{"))}{${[...rule.cssRules].map(ruleText).join("")}}`;
  }
  return rule.cssText;
}

function rulesText(sheet: CSSStyleSheet): string {
  try {
    return [...sheet.cssRules].map(ruleText).join("\n");
  } catch {
    // A cross-origin sheet's rules cannot be read.
    return "";
  }
}

/** The files a sheet's rules name (fonts, images), carried as data URLs. */
async function inlineUrls(text: string, base: string): Promise<string> {
  const pattern = /url\((['"]?)([^'")]+)\1\)/g;
  const urls = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const url = match[2].trim();
    if (!url.startsWith("data:") && !url.startsWith("#")) urls.add(url);
  }
  if (!urls.size) return text;
  const resolved = new Map<string, string>();
  await Promise.all([...urls].map(async (url) => {
    try {
      resolved.set(url, await fileAsDataUrl(new URL(url, base).href));
    } catch {
      resolved.set(url, "");
    }
  }));
  return text.replace(pattern, (whole, _quote, url: string) => {
    const data = resolved.get(url.trim());
    return data ? `url("${data}")` : data === "" ? "none" : whole;
  });
}

/** What changes when the page's styles do: the sheets, their rule counts, and the inline <style>s' text. */
function stylesKey(): string {
  let key = String(document.styleSheets.length);
  for (const sheet of document.styleSheets) {
    let count = -1;
    try {
      count = sheet.cssRules.length;
    } catch {
      // cross-origin
    }
    const owner = sheet.ownerNode as HTMLStyleElement | null;
    key += `|${sheet.href ?? ""}:${count}:${owner?.tagName === "STYLE" ? owner.textContent?.length ?? 0 : ""}`;
  }
  return key;
}

/** The page's style rules, as one stylesheet the snapshot carries. */
export function pageCss(): Promise<string> {
  const key = stylesKey();
  if (cssCache?.key !== key) {
    const sheets = [...document.styleSheets];
    cssCache = {
      key,
      text: Promise.all(sheets.map((sheet) => inlineUrls(rulesText(sheet), sheet.href ?? document.baseURI))).then((parts) => parts.join("\n")),
    };
  }
  return cssCache.text;
}

function remember(key: string, data: string) {
  imageCache.delete(key);
  imageCache.set(key, data);
  while (imageCache.size > MAX_CACHED_IMAGES) imageCache.delete(imageCache.keys().next().value!);
}

/** Device-pixel size an element shows at, capped. */
function drawnSize(element: Element, naturalWidth: number, naturalHeight: number, scale: number) {
  const rect = element.getBoundingClientRect();
  const fit = Math.min(1, (rect.width * scale) / naturalWidth || 1, (rect.height * scale) / naturalHeight || 1, MAX_IMAGE_SIDE / Math.max(naturalWidth, naturalHeight));
  return { width: Math.max(1, Math.round(naturalWidth * fit)), height: Math.max(1, Math.round(naturalHeight * fit)) };
}

function drawToDataUrl(source: CanvasImageSource, width: number, height: number, type = "image/webp"): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  try {
    return canvas.toDataURL(type, 0.92);
  } catch {
    // A cross-origin image taints the canvas.
    return "";
  }
}

const opaqueCache = new Map<string, boolean>();

/** Whether a picture has no transparency, judged on a 16 px copy: such a one is drawn as a JPEG, which encodes fastest. */
function opaque(image: HTMLImageElement, src: string): boolean {
  let found = opaqueCache.get(src);
  if (found === undefined) {
    found = false;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    try {
      if (context) {
        context.drawImage(image, 0, 0, 16, 16);
        const pixels = context.getImageData(0, 0, 16, 16).data;
        found = true;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { found = false; break; }
      }
    } catch {
      // tainted
    }
    opaqueCache.set(src, found);
    if (opaqueCache.size > MAX_CACHED_FILES) opaqueCache.delete(opaqueCache.keys().next().value!);
  }
  return found;
}

/** An <img> as a data URL: its file when that is small, else drawn at twice the size it shows. */
async function imageData(image: HTMLImageElement, scale: number): Promise<string> {
  const src = image.currentSrc || image.src;
  if (!src || src.startsWith("data:")) return src;
  // Not loaded (yet), or broken: left out. The painter paints a node with an image still loading again once it has
  // (settleNodes reports it unloaded); reading the whole file in instead could hold the snapshot for seconds.
  if (!image.complete || !image.naturalWidth) return "";
  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  const shown = drawnSize(image, natural.width, natural.height, scale);
  const drawn = { width: Math.min(natural.width, shown.width * 2), height: Math.min(natural.height, shown.height * 2) };
  // Drawn smaller only when that halves it at least: once it is resampled twice, fine detail blurs a little.
  if (/\.svg(\?|$)/i.test(src) || (natural.width * natural.height <= FILE_IMAGE_PIXELS && drawn.width * 2 > natural.width)) return fileAsDataUrl(src);
  const key = `${src}|${drawn.width}x${drawn.height}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const data = drawToDataUrl(image, drawn.width, drawn.height, opaque(image, src) ? "image/jpeg" : "image/webp") || (await fileAsDataUrl(src));
  if (data) remember(key, data);
  return data;
}

/** A replacement <img> for a canvas or video: same attributes, its current picture. */
function pictureOf(original: HTMLElement, copy: HTMLElement, data: string): HTMLImageElement {
  const image = document.createElement("img");
  for (const { name, value } of copy.attributes) if (name !== "src" && name !== "poster") image.setAttribute(name, value);
  const rect = original.getBoundingClientRect();
  if (!original.style.width && !copy.getAttribute("width")) image.style.width = `${original.offsetWidth || rect.width}px`;
  if (!original.style.height && !copy.getAttribute("height")) image.style.height = `${original.offsetHeight || rect.height}px`;
  if (data) image.setAttribute("src", data);
  return image;
}

/** The copy of `element`, with what the DOM keeps outside attributes written into it. */
async function copyOf(element: HTMLElement, scale: number): Promise<HTMLElement> {
  const copy = element.cloneNode(true) as HTMLElement;
  const originals = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  const pending: Promise<void>[] = [];
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i], target = copies[i];
    if (!target) continue;
    if (original instanceof HTMLInputElement) {
      if (original.type === "checkbox" || original.type === "radio") target.toggleAttribute("checked", original.checked);
      else target.setAttribute("value", original.value);
    } else if (original instanceof HTMLTextAreaElement) {
      target.textContent = original.value;
    } else if (original instanceof HTMLSelectElement) {
      const options = target.querySelectorAll("option");
      [...original.options].forEach((option, k) => options[k]?.toggleAttribute("selected", option.selected));
    } else if (original instanceof HTMLImageElement) {
      target.removeAttribute("srcset");
      target.removeAttribute("loading");
      pending.push(imageData(original, scale).then((data) => {
        if (data) target.setAttribute("src", data);
        else target.removeAttribute("src");
      }));
    } else if (original instanceof HTMLCanvasElement) {
      let data = "";
      try {
        data = original.width && original.height ? original.toDataURL() : "";
      } catch {
        // tainted
      }
      target.replaceWith(pictureOf(original, target, data));
    } else if (original instanceof HTMLVideoElement) {
      const width = original.videoWidth, height = original.videoHeight;
      if (original.readyState >= 2 && width && height) {
        const size = drawnSize(original, width, height, scale);
        target.replaceWith(pictureOf(original, target, drawToDataUrl(original, Math.min(width, size.width * 2), Math.min(height, size.height * 2), "image/jpeg")));
      } else {
        const poster = original.poster;
        const image = pictureOf(original, target, "");
        target.replaceWith(image);
        if (poster) pending.push(fileAsDataUrl(poster).then((data) => { if (data) image.setAttribute("src", data); }));
      }
    } else if (original instanceof HTMLIFrameElement || original instanceof HTMLScriptElement || original instanceof HTMLStyleElement) {
      // The page's own <style>s are in its sheets already.
      target.remove();
    }
  }
  await Promise.all(pending);
  return copy;
}

function copyAttributes(from: Element, to: Element, marker: string) {
  for (const { name, value } of from.attributes) if (name !== "id") to.setAttribute(name, value);
  to.setAttribute(marker, "");
}

/**
 * `element` (its css box `width` × `height`, at the page's layout) as an image `scale` times that size in device
 * pixels, row 0 at its top, as HTML-in-Canvas paints it. Rejects if the image does not decode.
 */
export async function snapshotElement(element: HTMLElement, width: number, height: number, scale: number): Promise<HTMLImageElement> {
  const [css, copy] = await Promise.all([pageCss(), copyOf(element, scale)]);
  const root = document.createElement("div"), body = document.createElement("div"), style = document.createElement("style");
  copyAttributes(document.documentElement, root, ROOT);
  copyAttributes(document.body, body, BODY);
  // The page's root and body never paint the sheet's margins: they stay transparent. The root is zoomed rather
  // than the SVG scaled: Chromium lays a zoomed page out as it does at that device pixel ratio, snapping boxes and
  // glyphs to device pixels, where a scaled one snaps them to css pixels first and lands up to a pixel off.
  style.textContent = `${css}\n[${ROOT}],[${BODY}]{margin:0!important;padding:0!important;border:0!important;background:transparent!important;`
    + `width:${width}px!important;height:${height}px!important;overflow:hidden!important;position:relative!important;min-height:0!important}`
    + `[${ROOT}]{zoom:${scale}!important}`;
  copy.style.left = "0px";
  copy.style.top = "0px";
  root.append(style, body);
  body.append(copy);
  const markup = new XMLSerializer().serializeToString(root);
  const deviceWidth = Math.ceil(width * scale), deviceHeight = Math.ceil(height * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${deviceWidth}" height="${deviceHeight}">`
    + `<foreignObject x="0" y="0" width="${deviceWidth}" height="${deviceHeight}">${markup}</foreignObject></svg>`;
  const image = new Image();
  image.decoding = "async";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}
