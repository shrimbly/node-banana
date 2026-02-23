"use client";

/**
 * Panorama Viewer — Equirectangular Image Viewer with Crop Capture
 *
 * Renders an equirectangular panorama on the inside of a Three.js sphere.
 * Provides a draggable/resizable rectangle overlay for selecting a crop region.
 * On capture, extracts a perspective view at the rectangle's position using
 * equirectangular projection math, and sends the result + metadata back to
 * the parent window (Node Banana) via postMessage.
 *
 * URL params:
 *   - url: equirectangular image URL or base64
 *   - name: display name
 *   - nodeId: for postMessage routing
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import {
  extractPerspectiveView,
  type PanoCropMetadata,
} from "@/utils/equirectProjection";

// ─── Constants ──────────────────────────────────────────────────

const SPHERE_RADIUS = 500;
const MIN_FOV = 20;
const MAX_FOV = 120;
const DEFAULT_FOV = 75;
const MOUSE_SENSITIVITY = 0.003;
const MIN_RECT_SIZE = 40; // Minimum rectangle size in pixels
const MAX_CAPTURE_DIM = 2048; // Max output dimension for captures

// ─── Page Component ─────────────────────────────────────────────

export default function PanoViewerPage() {
  // URL params
  const [panoUrl, setPanoUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("Panorama Viewer");
  const [nodeId, setNodeId] = useState<string | null>(null);

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [rectInfo, setRectInfo] = useState({ aspectRatio: "16:9", hFov: 0, vFov: 0 });
  const [sceneReady, setSceneReady] = useState(false);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const animationIdRef = useRef<number>(0);
  const initRef = useRef(false);
  const textureRef = useRef<THREE.Texture | null>(null);

  // Camera navigation refs
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const fovRef = useRef(DEFAULT_FOV);
  const isDraggingBgRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Rectangle overlay refs
  const rectRef = useRef<HTMLDivElement>(null);
  const rectStateRef = useRef({ x: 0, y: 0, width: 320, height: 180 });
  const rectDragRef = useRef<{
    type: "move" | "resize";
    handle?: string;
    startX: number;
    startY: number;
    startRect: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // Equirect source canvas for capture
  const equirectCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ─── Parse URL params ─────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    const storageKey = params.get("storageKey");
    const name = params.get("name");
    const nid = params.get("nodeId");

    // Load panorama from URL param (HTTP) or sessionStorage (base64 data URL)
    if (url) {
      setPanoUrl(url);
    } else if (storageKey) {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        sessionStorage.removeItem(storageKey); // Clean up after reading
        setPanoUrl(stored);
      } else {
        setError("Panorama data expired — please reopen the viewer");
      }
    }

    if (name) setDisplayName(name);
    if (nid) setNodeId(nid);
  }, []);

  // ─── Initialize Three.js scene ──────────────────────────────
  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    const container = containerRef.current;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      container.clientWidth / container.clientHeight,
      0.1,
      2000
    );
    camera.position.set(0, 0, 0);
    cameraRef.current = camera;

    // Signal that Three.js scene is ready for texture loading
    setSceneReady(true);

    // Center rectangle on screen
    rectStateRef.current = {
      x: (container.clientWidth - 320) / 2,
      y: (container.clientHeight - 180) / 2,
      width: 320,
      height: 180,
    };

    // Animation loop
    function animate() {
      animationIdRef.current = requestAnimationFrame(animate);

      // Update camera orientation from yaw/pitch
      if (cameraRef.current) {
        const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, "YXZ");
        cameraRef.current.quaternion.setFromEuler(euler);
        cameraRef.current.fov = fovRef.current;
        cameraRef.current.updateProjectionMatrix();
      }

      renderer.render(scene, camera);
    }
    animate();

    // Resize handler
    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationIdRef.current);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ─── Load panorama texture ────────────────────────────────────
  useEffect(() => {
    if (!panoUrl || !sceneReady || !sceneRef.current) return;

    setLoading(true);
    setError(null);

    /**
     * Apply a loaded image as a sphere texture for the panorama viewer.
     */
    const applyTexture = (img: HTMLImageElement) => {
      const texture = new THREE.Texture(img);
      texture.needsUpdate = true;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      textureRef.current = texture;

      // Create sphere with texture mapped on inside
      const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 60, 40);
      geometry.scale(-1, 1, 1); // flip normals to inside
      const material = new THREE.MeshBasicMaterial({ map: texture });
      const mesh = new THREE.Mesh(geometry, material);
      sceneRef.current!.add(mesh);

      // Also draw texture to a canvas for capture
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      equirectCanvasRef.current = canvas;

      setLoading(false);
    };

    // For data URLs (from PanoEditor), load via Image element directly
    // to avoid TextureLoader/FileLoader issues with large base64 strings
    if (panoUrl.startsWith("data:")) {
      const img = new Image();
      img.onload = () => applyTexture(img);
      img.onerror = () => {
        console.error("Failed to load panorama from data URL");
        setError("Failed to load panorama image");
        setLoading(false);
      };
      img.src = panoUrl;
    } else {
      // For HTTP URLs, use TextureLoader as normal
      const loader = new THREE.TextureLoader();
      loader.load(
        panoUrl,
        (texture) => {
          const img = texture.image as HTMLImageElement;
          applyTexture(img);
        },
        undefined,
        (err) => {
          console.error("Failed to load panorama:", err);
          setError("Failed to load panorama image");
          setLoading(false);
        }
      );
    }
  }, [panoUrl, sceneReady]);

  // ─── Camera navigation (drag to look, scroll to zoom) ────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      // Only start camera drag if clicking on the background (not the rect)
      const target = e.target as HTMLElement;
      if (target.closest(".crop-rect")) return;

      isDraggingBgRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      container.style.cursor = "grabbing";
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingBgRef.current) {
        const dx = e.clientX - lastMouseRef.current.x;
        const dy = e.clientY - lastMouseRef.current.y;
        yawRef.current -= dx * MOUSE_SENSITIVITY;
        pitchRef.current -= dy * MOUSE_SENSITIVITY;
        pitchRef.current = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitchRef.current));
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      isDraggingBgRef.current = false;
      container.style.cursor = "grab";
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      fovRef.current += e.deltaY * 0.05;
      fovRef.current = Math.max(MIN_FOV, Math.min(MAX_FOV, fovRef.current));
      updateRectInfo();
    };

    container.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // ─── Rectangle drag/resize handlers ──────────────────────────
  const handleRectMouseDown = useCallback((e: React.MouseEvent, type: "move" | "resize", handle?: string) => {
    e.preventDefault();
    e.stopPropagation();
    rectDragRef.current = {
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...rectStateRef.current },
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = rectDragRef.current;
      if (!drag) return;

      const container = containerRef.current;
      if (!container) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const containerW = container.clientWidth;
      const containerH = container.clientHeight;

      if (drag.type === "move") {
        let newX = drag.startRect.x + dx;
        let newY = drag.startRect.y + dy;
        // Clamp to container bounds
        newX = Math.max(0, Math.min(containerW - rectStateRef.current.width, newX));
        newY = Math.max(0, Math.min(containerH - rectStateRef.current.height, newY));
        rectStateRef.current.x = newX;
        rectStateRef.current.y = newY;
      } else if (drag.type === "resize") {
        const h = drag.handle;
        let { x, y, width, height } = drag.startRect;

        if (h?.includes("right") || h === "r") {
          width = Math.max(MIN_RECT_SIZE, width + dx);
        }
        if (h?.includes("left") || h === "l") {
          const newW = Math.max(MIN_RECT_SIZE, width - dx);
          x = x + width - newW;
          width = newW;
        }
        if (h?.includes("bottom") || h === "b") {
          height = Math.max(MIN_RECT_SIZE, height + dy);
        }
        if (h?.includes("top") || h === "t") {
          const newH = Math.max(MIN_RECT_SIZE, height - dy);
          y = y + height - newH;
          height = newH;
        }

        // Clamp to container
        x = Math.max(0, x);
        y = Math.max(0, y);
        width = Math.min(width, containerW - x);
        height = Math.min(height, containerH - y);

        rectStateRef.current = { x, y, width, height };
      }

      // Update DOM directly for performance
      if (rectRef.current) {
        const r = rectStateRef.current;
        rectRef.current.style.left = `${r.x}px`;
        rectRef.current.style.top = `${r.y}px`;
        rectRef.current.style.width = `${r.width}px`;
        rectRef.current.style.height = `${r.height}px`;
      }

      updateRectInfo();
    };

    const handleMouseUp = () => {
      rectDragRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // ─── Compute rectangle FOV/metadata ──────────────────────────
  const updateRectInfo = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const r = rectStateRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // The rectangle spans a fraction of the viewport
    const hFraction = r.width / containerW;
    const vFraction = r.height / containerH;

    // Convert viewport FOV to the rectangle's FOV
    const viewportVFov = fovRef.current * Math.PI / 180;
    const viewportHFov = 2 * Math.atan(Math.tan(viewportVFov / 2) * (containerW / containerH));

    const rectHFov = 2 * Math.atan(Math.tan(viewportHFov / 2) * hFraction);
    const rectVFov = 2 * Math.atan(Math.tan(viewportVFov / 2) * vFraction);

    // Aspect ratio
    const ar = r.width / r.height;
    let arLabel: string;
    const ratios = [
      [1, 1], [4, 3], [3, 2], [16, 9], [16, 10], [21, 9], [2, 1], [3, 4], [2, 3], [9, 16],
    ];
    let closest = "";
    let minDiff = Infinity;
    for (const [w, h] of ratios) {
      const diff = Math.abs(ar - w / h);
      if (diff < minDiff) {
        minDiff = diff;
        closest = `${w}:${h}`;
      }
    }
    arLabel = minDiff < 0.1 ? closest : `${ar.toFixed(2)}:1`;

    setRectInfo({
      aspectRatio: arLabel,
      hFov: Math.round(rectHFov * 180 / Math.PI),
      vFov: Math.round(rectVFov * 180 / Math.PI),
    });
  }, []);

  // Update rect info on initial render
  useEffect(() => {
    updateRectInfo();
  }, [updateRectInfo]);

  // ─── Capture handler ──────────────────────────────────────────
  const handleCapture = useCallback(() => {
    const container = containerRef.current;
    const equirectCanvas = equirectCanvasRef.current;
    if (!container || !equirectCanvas || !nodeId) return;

    const r = rectStateRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Compute the yaw/pitch for the center of the rectangle
    // Rectangle center in NDC
    const rectCenterX = (r.x + r.width / 2) / containerW;
    const rectCenterY = (r.y + r.height / 2) / containerH;

    // Convert rectangle center to offset from viewport center
    const ndcX = (rectCenterX - 0.5) * 2;
    const ndcY = (0.5 - rectCenterY) * 2; // flip Y

    // Viewport FOV
    const viewportVFov = fovRef.current * Math.PI / 180;
    const aspect = containerW / containerH;
    const viewportHFov = 2 * Math.atan(Math.tan(viewportVFov / 2) * aspect);

    // Angular offset of rectangle center from viewport center
    const yawOffset = Math.atan(ndcX * Math.tan(viewportHFov / 2));
    const pitchOffset = Math.atan(ndcY * Math.tan(viewportVFov / 2));

    // Absolute yaw/pitch of rectangle center
    // Negate yaw (Three.js left-handed yaw vs buildRotationMatrix right-handed)
    // and offset by π/2 for SphereGeometry UV alignment.
    // Negate pitch (Three.js positive = UP vs buildRotationMatrix positive = DOWN).
    const rectYaw = -(yawRef.current + yawOffset) + Math.PI / 2;
    const rectPitch = -(pitchRef.current + pitchOffset);

    // Compute rectangle FOV
    const hFraction = r.width / containerW;
    const vFraction = r.height / containerH;
    const rectHFov = 2 * Math.atan(Math.tan(viewportHFov / 2) * hFraction);
    const rectVFov = 2 * Math.atan(Math.tan(viewportVFov / 2) * vFraction);

    const metadata: PanoCropMetadata = {
      yaw: rectYaw,
      pitch: rectPitch,
      roll: 0,
      hFov: rectHFov,
      vFov: rectVFov,
      aspectRatio: r.width / r.height,
    };

    // Determine output resolution
    const scale = Math.min(MAX_CAPTURE_DIM / Math.max(r.width, r.height), 2);
    const outWidth = Math.round(r.width * scale);
    const outHeight = Math.round(r.height * scale);

    // Extract perspective view
    const resultCanvas = extractPerspectiveView(equirectCanvas, outWidth, outHeight, metadata);
    const image = resultCanvas.toDataURL("image/png");

    // Send to parent window
    if (window.opener) {
      window.opener.postMessage(
        {
          type: "pano-crop-capture",
          nodeId,
          image,
          metadata,
          width: outWidth,
          height: outHeight,
        },
        window.location.origin
      );
    }

    // Flash feedback
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 200);
  }, [nodeId]);

  // ─── Render ───────────────────────────────────────────────────

  const r = rectStateRef.current;

  return (
    <div className="w-screen h-screen bg-black text-white overflow-hidden relative select-none">
      {/* Three.js canvas container */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: "grab" }}
      />

      {/* Rectangle crop overlay */}
      {!loading && !error && (
        <div
          ref={rectRef}
          className="crop-rect absolute pointer-events-auto"
          style={{
            left: `${r.x}px`,
            top: `${r.y}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            border: "2px dashed rgba(255, 255, 255, 0.7)",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.3)",
            zIndex: 10,
          }}
        >
          {/* Move handle (center area) */}
          <div
            className="absolute inset-3 cursor-move"
            onMouseDown={(e) => handleRectMouseDown(e, "move")}
          />

          {/* Corner resize handles */}
          {["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) => {
            const isTop = corner.includes("top");
            const isLeft = corner.includes("left");
            return (
              <div
                key={corner}
                className="absolute w-4 h-4 bg-white rounded-full border-2 border-neutral-800"
                style={{
                  top: isTop ? "-8px" : "auto",
                  bottom: !isTop ? "-8px" : "auto",
                  left: isLeft ? "-8px" : "auto",
                  right: !isLeft ? "-8px" : "auto",
                  cursor:
                    corner === "top-left" || corner === "bottom-right"
                      ? "nwse-resize"
                      : "nesw-resize",
                  zIndex: 20,
                }}
                onMouseDown={(e) => {
                  const handle = corner
                    .replace("top", "t")
                    .replace("bottom", "b")
                    .replace("left", "l")
                    .replace("right", "r")
                    .replace("-", "");
                  // Map: top-left -> tl, top-right -> tr, etc.
                  handleRectMouseDown(e, "resize", handle.replace("t", "top-").replace("b", "bottom-").replace("l", "left").replace("r", "right"));
                }}
              />
            );
          })}

          {/* Edge resize handles */}
          <div
            className="absolute top-0 left-4 right-4 h-2 cursor-ns-resize"
            style={{ top: "-4px", zIndex: 15 }}
            onMouseDown={(e) => handleRectMouseDown(e, "resize", "top")}
          />
          <div
            className="absolute bottom-0 left-4 right-4 h-2 cursor-ns-resize"
            style={{ bottom: "-4px", zIndex: 15 }}
            onMouseDown={(e) => handleRectMouseDown(e, "resize", "bottom")}
          />
          <div
            className="absolute left-0 top-4 bottom-4 w-2 cursor-ew-resize"
            style={{ left: "-4px", zIndex: 15 }}
            onMouseDown={(e) => handleRectMouseDown(e, "resize", "left")}
          />
          <div
            className="absolute right-0 top-4 bottom-4 w-2 cursor-ew-resize"
            style={{ right: "-4px", zIndex: 15 }}
            onMouseDown={(e) => handleRectMouseDown(e, "resize", "right")}
          />

          {/* Dimension label */}
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-white/60 whitespace-nowrap">
            {rectInfo.aspectRatio} · {rectInfo.hFov}° × {rectInfo.vFov}°
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/60 to-transparent p-4 z-30 pointer-events-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-pink-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span className="text-sm font-medium">{displayName}</span>
          </div>
          <div className="text-xs text-white/40">
            Drag to look · Drag rectangle to position · Scroll to zoom
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-4 z-30">
        <div className="flex items-center justify-between">
          {/* Info */}
          <div className="text-xs text-white/60 space-y-0.5">
            <div>FOV: {Math.round(fovRef.current)}° (viewport)</div>
            <div>Crop: {rectInfo.hFov}° × {rectInfo.vFov}° ({rectInfo.aspectRatio})</div>
          </div>

          {/* Capture button */}
          <button
            onClick={handleCapture}
            disabled={!equirectCanvasRef.current || !nodeId}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-neutral-700 disabled:cursor-not-allowed text-white text-sm font-medium py-2 px-6 rounded-full transition-colors"
          >
            <div className="w-4 h-4 rounded-full border-2 border-white" />
            Capture
          </button>

          {/* Spacer */}
          <div className="w-32" />
        </div>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-pink-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/60">Loading panorama...</span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
          <div className="text-center">
            <p className="text-red-400 mb-2">{error}</p>
          </div>
        </div>
      )}

      {/* Capture flash */}
      {captureFlash && (
        <div className="absolute inset-0 bg-white/30 z-40 pointer-events-none" />
      )}
    </div>
  );
}
