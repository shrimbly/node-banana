"use client";

/**
 * Standalone SPZ Viewer
 *
 * Loads and displays 3D Gaussian Splatting (.spz) files.
 * Two modes:
 *   1. URL mode: ?url=https://...scene.spz → loads SPZ directly
 *   2. Upload mode: no URL → shows file upload / drag-and-drop
 *
 * Features:
 *   - Cinematic camera presets (sensor/lens/aspect)
 *   - Screenshot capture → sends to parent window or downloads
 *   - Quality-agnostic (single URL, no quality switching)
 *   - Fly mode (WASD + mouse look) and Orbit mode (OrbitControls)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  SENSOR_PRESETS,
  LENS_FOCAL_LENGTHS,
  ASPECT_RATIO_PRESETS,
  DEFAULT_SENSOR_INDEX,
  DEFAULT_LENS_INDEX,
  DEFAULT_ASPECT_RATIO_INDEX,
  calculateCameraFOV,
  getCameraFilenameSegment,
} from "@/utils/cinemaCameraPresets";

// ─── Page Component ─────────────────────────────────────────────

export default function StandaloneViewerPage() {
  // Parse URL params on client
  const [spzUrl, setSpzUrl] = useState<string | null>(null);
  const [worldName, setWorldName] = useState("SPZ Viewer");
  const [worldId, setWorldId] = useState<string | null>(null);

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensorIndex, setSensorIndex] = useState(DEFAULT_SENSOR_INDEX);
  const [lensIndex, setLensIndex] = useState(DEFAULT_LENS_INDEX);
  const [aspectIndex, setAspectIndex] = useState(DEFAULT_ASPECT_RATIO_INDEX);
  const [splatLoaded, setSplatLoaded] = useState(false);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [navMode, setNavMode] = useState<"orbit" | "fly">("fly");

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationIdRef = useRef<number>(0);
  const splatMeshRef = useRef<unknown>(null);
  const initRef = useRef(false);

  // Fly mode refs
  const keysPressedRef = useRef<Set<string>>(new Set());
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const isMouseDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const navModeRef = useRef<"orbit" | "fly">("fly");

  // Keep navModeRef in sync
  useEffect(() => {
    navModeRef.current = navMode;

    if (controlsRef.current) {
      controlsRef.current.enabled = navMode === "orbit";
    }

    if (navMode === "fly" && cameraRef.current) {
      // Extract yaw/pitch from current camera quaternion
      const euler = new THREE.Euler();
      euler.setFromQuaternion(cameraRef.current.quaternion, "YXZ");
      yawRef.current = euler.y;
      pitchRef.current = euler.x;
    } else if (navMode === "orbit" && cameraRef.current && controlsRef.current) {
      // Set orbit target 1 unit in front of camera
      const dir = new THREE.Vector3();
      cameraRef.current.getWorldDirection(dir);
      controlsRef.current.target.copy(
        cameraRef.current.position.clone().add(dir)
      );
      controlsRef.current.update();
    }
  }, [navMode]);

  // Camera settings
  const sensor = SENSOR_PRESETS[sensorIndex];
  const focalLength = LENS_FOCAL_LENGTHS[lensIndex];
  const aspectRatio = ASPECT_RATIO_PRESETS[aspectIndex];
  const vFov = calculateCameraFOV(sensor.widthMm, focalLength, aspectRatio.ratio);

  // ─── Parse URL params on mount ──────────────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    const name = params.get("name");
    const wId = params.get("worldId");

    if (url) setSpzUrl(url);
    if (name) setWorldName(name);
    if (wId) setWorldId(wId);
  }, []);

  // ─── Center camera helper ────────────────────────────────────────

  const centerCamera = useCallback(() => {
    if (!cameraRef.current) return;

    if (navModeRef.current === "fly") {
      cameraRef.current.position.set(0, 1.5, 0);
      yawRef.current = 0;
      pitchRef.current = 0;
      cameraRef.current.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, "YXZ"));
    } else if (controlsRef.current) {
      cameraRef.current.position.set(0, 1.5, 0.01);
      controlsRef.current.target.set(0, 1.5, -1);
      controlsRef.current.update();
    }
  }, []);

  // ─── Initialize Three.js scene ─────────────────────────────────

  const initScene = useCallback(() => {
    if (!containerRef.current || initRef.current) return;
    initRef.current = true;

    const container = containerRef.current;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x111111);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(
      vFov,
      container.clientWidth / container.clientHeight,
      0.01,
      1000
    );
    camera.position.set(0, 1.5, 0);
    cameraRef.current = camera;

    // OrbitControls (disabled in fly mode)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.5;
    controls.enabled = navModeRef.current === "orbit";
    controlsRef.current = controls;

    // Ambient light
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // ─── Fly mode mouse listeners ────────────────────────────
    const canvas = renderer.domElement;

    const onMouseDown = (e: MouseEvent) => {
      if (navModeRef.current !== "fly") return;
      isMouseDraggingRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isMouseDraggingRef.current || navModeRef.current !== "fly") return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const sensitivity = 0.003;
      yawRef.current -= dx * sensitivity;
      pitchRef.current -= dy * sensitivity;
      pitchRef.current = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, pitchRef.current)
      );
    };
    const onMouseUp = () => {
      isMouseDraggingRef.current = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (navModeRef.current !== "fly") return;
      e.preventDefault();
      if (!cameraRef.current) return;
      const dir = new THREE.Vector3();
      cameraRef.current.getWorldDirection(dir);
      cameraRef.current.position.addScaledVector(dir, -e.deltaY * 0.01);
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Animation loop
    function animate() {
      animationIdRef.current = requestAnimationFrame(animate);

      if (navModeRef.current === "fly") {
        // Apply yaw/pitch
        const euler = new THREE.Euler(
          pitchRef.current,
          yawRef.current,
          0,
          "YXZ"
        );
        camera.quaternion.setFromEuler(euler);

        // WASD translation
        const keys = keysPressedRef.current;
        if (keys.size > 0) {
          const speed = keys.has("shift") ? 0.15 : 0.05;
          const dir = new THREE.Vector3();
          camera.getWorldDirection(dir);
          const right = new THREE.Vector3()
            .crossVectors(dir, camera.up)
            .normalize();
          const move = new THREE.Vector3();

          if (keys.has("w")) move.add(dir);
          if (keys.has("s")) move.sub(dir);
          if (keys.has("a")) move.sub(right);
          if (keys.has("d")) move.add(right);
          if (keys.has("e")) move.y += 1;
          if (keys.has("q")) move.y -= 1;

          if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed);
            camera.position.add(move);
          }
        }
      } else {
        controls.update();
      }

      renderer.render(scene, camera);
    }
    animate();

    // Resize handler
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationIdRef.current);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Load SPZ from URL ──────────────────────────────────────────

  const loadSplatFromUrl = useCallback(async (url: string) => {
    if (!sceneRef.current) {
      initScene();
      // Wait for scene to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const scene = sceneRef.current;
    if (!scene) return;

    setLoading(true);
    setError(null);
    setSplatLoaded(false);

    try {
      const { SplatMesh } = await import("@sparkjsdev/spark");

      // Remove old splat if any
      if (splatMeshRef.current) {
        scene.remove(splatMeshRef.current as THREE.Object3D);
        (splatMeshRef.current as { dispose?: () => void })?.dispose?.();
      }

      const splatMesh = new SplatMesh({
        url,
        onLoad: () => {
          setSplatLoaded(true);
          setLoading(false);

          // Center camera at origin
          centerCamera();
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;
    } catch (err) {
      console.error("Failed to load splat:", err);
      setError(`Failed to load 3D scene: ${err instanceof Error ? err.message : "Unknown error"}`);
      setLoading(false);
    }
  }, [initScene, centerCamera]);

  // ─── Load SPZ from file (drag-and-drop or file picker) ─────────

  const loadSplatFromFile = useCallback(async (file: File) => {
    if (!sceneRef.current) {
      initScene();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const scene = sceneRef.current;
    if (!scene) return;

    setLoading(true);
    setError(null);
    setSplatLoaded(false);
    setWorldName(file.name.replace(/\.spz$/i, ""));

    try {
      const { SplatMesh } = await import("@sparkjsdev/spark");

      // Remove old splat if any
      if (splatMeshRef.current) {
        scene.remove(splatMeshRef.current as THREE.Object3D);
        (splatMeshRef.current as { dispose?: () => void })?.dispose?.();
      }

      // Create object URL from file
      const objectUrl = URL.createObjectURL(file);

      const splatMesh = new SplatMesh({
        url: objectUrl,
        onLoad: () => {
          setSplatLoaded(true);
          setLoading(false);
          URL.revokeObjectURL(objectUrl);

          // Center camera at origin
          centerCamera();
        },
      });

      await splatMesh.initialized;
      scene.add(splatMesh);
      splatMeshRef.current = splatMesh;
    } catch (err) {
      console.error("Failed to load splat file:", err);
      setError(`Failed to load file: ${err instanceof Error ? err.message : "Unknown error"}`);
      setLoading(false);
    }
  }, [initScene, centerCamera]);

  // ─── Auto-load if URL param present ─────────────────────────────

  useEffect(() => {
    if (spzUrl) {
      initScene();
      // Small delay to ensure scene is ready
      const timer = setTimeout(() => loadSplatFromUrl(spzUrl), 150);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spzUrl]);

  // ─── Update camera FOV when settings change ────────────────────

  useEffect(() => {
    if (!cameraRef.current) return;
    cameraRef.current.fov = vFov;
    cameraRef.current.updateProjectionMatrix();
  }, [vFov]);

  // ─── Capture screenshot ────────────────────────────────────────

  const handleCapture = useCallback(() => {
    if (!rendererRef.current || !cameraRef.current || !sceneRef.current) return;

    rendererRef.current.render(sceneRef.current, cameraRef.current);

    const canvas = rendererRef.current.domElement;
    const selectedAspect = aspectRatio.ratio;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const canvasAspect = canvasW / canvasH;

    // Crop to selected aspect ratio
    let cropX = 0, cropY = 0, cropW = canvasW, cropH = canvasH;
    if (selectedAspect > canvasAspect) {
      // Letterbox: crop top/bottom
      cropH = Math.round(canvasW / selectedAspect);
      cropY = Math.round((canvasH - cropH) / 2);
    } else if (selectedAspect < canvasAspect) {
      // Pillarbox: crop left/right
      cropW = Math.round(canvasH * selectedAspect);
      cropX = Math.round((canvasW - cropW) / 2);
    }

    // Create offscreen canvas at cropped dimensions
    const offscreen = document.createElement("canvas");
    offscreen.width = cropW;
    offscreen.height = cropH;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;
    offCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const image = offscreen.toDataURL("image/png");
    const captureId = Math.random().toString(36).substring(2, 6);
    const cameraSegment = getCameraFilenameSegment(sensor, focalLength);
    const nameSlug = worldName.replace(/[^a-zA-Z0-9]/g, "");
    const filename = `${nameSlug}_${cameraSegment}_${captureId}`;

    // Flash effect
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 200);

    // Send to parent window if opened from Node Banana
    if (window.opener && worldId) {
      window.opener.postMessage(
        {
          type: "worldlabs-capture",
          worldId,
          image,
          filename,
          width: cropW,
          height: cropH,
        },
        window.location.origin
      );
    } else {
      // Download directly if no parent window
      const link = document.createElement("a");
      link.download = `${filename}.png`;
      link.href = image;
      link.click();
    }
  }, [worldId, worldName, sensor, focalLength, aspectRatio.ratio]);

  // ─── Keyboard shortcuts + WASD navigation ──────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Capture
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleCapture();
      }
      // Toggle controls visibility
      if (e.key === "h" || e.key === "H") {
        setShowControls((s) => !s);
      }
      // Toggle nav mode
      if (e.key === "f" || e.key === "F") {
        setNavMode((m) => (m === "fly" ? "orbit" : "fly"));
      }
      // WASD + QE navigation keys
      const navKeys = ["w", "a", "s", "d", "q", "e"];
      const lower = e.key.toLowerCase();
      if (navKeys.includes(lower)) {
        keysPressedRef.current.add(lower);
      }
      if (e.key === "Shift") {
        keysPressedRef.current.add("shift");
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const lower = e.key.toLowerCase();
      keysPressedRef.current.delete(lower);
      if (e.key === "Shift") {
        keysPressedRef.current.delete("shift");
      }
    };
    const handleBlur = () => {
      keysPressedRef.current.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [handleCapture]);

  // ─── Drag and Drop ─────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".spz") || lower.endsWith(".ply")) {
        loadSplatFromFile(file);
      } else {
        setError("Please drop a .spz or .ply file");
      }
    }
  }, [loadSplatFromFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".spz") || lower.endsWith(".ply")) {
        loadSplatFromFile(file);
      } else {
        setError("Please select a .spz or .ply file");
      }
    }
  }, [loadSplatFromFile]);

  // ─── Upload Mode (no URL) ─────────────────────────────────────

  if (!spzUrl && !splatLoaded && !loading) {
    return (
      <div
        className="fixed inset-0 bg-neutral-950 flex items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className={`text-center max-w-md px-8 py-12 rounded-2xl border-2 border-dashed transition-colors ${
            isDragging
              ? "border-indigo-500 bg-indigo-500/10"
              : "border-neutral-700 hover:border-neutral-600"
          }`}
        >
          {/* Globe icon */}
          <svg
            className="w-16 h-16 text-neutral-600 mx-auto mb-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>

          <h1 className="text-neutral-200 text-lg font-medium mb-2">
            SPZ Viewer
          </h1>
          <p className="text-neutral-500 text-sm mb-6">
            Drag and drop a <code className="text-indigo-400">.spz</code> or{" "}
            <code className="text-indigo-400">.ply</code> file here
            <br />
            or click to browse
          </p>

          <label className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium py-2.5 px-5 rounded-lg cursor-pointer transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Choose File
            <input
              type="file"
              accept=".spz,.ply"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>

          {error && (
            <p className="text-red-400 text-xs mt-4">{error}</p>
          )}

          <p className="text-neutral-700 text-[10px] mt-6">
            Or use: /viewer?url=https://example.com/scene.spz
          </p>
        </div>
      </div>
    );
  }

  // ─── Viewer Mode ───────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 bg-neutral-950 overflow-hidden select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Three.js canvas container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Framing overlay — letterbox/pillarbox bars for selected aspect ratio */}
      {splatLoaded && (() => {
        const viewW = containerRef.current?.clientWidth ?? 16;
        const viewH = containerRef.current?.clientHeight ?? 9;
        const viewportAspect = viewW / viewH;
        const selectedAspect = aspectRatio.ratio;
        if (Math.abs(viewportAspect - selectedAspect) < 0.01) return null;

        if (selectedAspect > viewportAspect) {
          // Letterbox: bars on top and bottom
          const activeH = viewW / selectedAspect;
          const barH = Math.max(0, (viewH - activeH) / 2);
          return (
            <>
              <div className="absolute left-0 right-0 top-0 pointer-events-none z-[4]" style={{ height: barH, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute bottom-0 left-0 right-0 h-px bg-neutral-500/40" />
              </div>
              <div className="absolute left-0 right-0 bottom-0 pointer-events-none z-[4]" style={{ height: barH, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute top-0 left-0 right-0 h-px bg-neutral-500/40" />
              </div>
            </>
          );
        } else {
          // Pillarbox: bars on left and right
          const activeW = viewH * selectedAspect;
          const barW = Math.max(0, (viewW - activeW) / 2);
          return (
            <>
              <div className="absolute top-0 bottom-0 left-0 pointer-events-none z-[4]" style={{ width: barW, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute right-0 top-0 bottom-0 w-px bg-neutral-500/40" />
              </div>
              <div className="absolute top-0 bottom-0 right-0 pointer-events-none z-[4]" style={{ width: barW, background: "rgba(0,0,0,0.55)" }}>
                <div className="absolute left-0 top-0 bottom-0 w-px bg-neutral-500/40" />
              </div>
            </>
          );
        }
      })()}

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 bg-neutral-950/80 flex items-center justify-center z-10">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-neutral-400 text-sm">Loading scene...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 bg-neutral-950/80 flex items-center justify-center z-10">
          <div className="text-center max-w-md px-6">
            <p className="text-red-400 text-sm mb-2">Failed to load scene</p>
            <p className="text-neutral-500 text-xs">{error}</p>
          </div>
        </div>
      )}

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-indigo-500/20 border-2 border-dashed border-indigo-500 flex items-center justify-center z-20">
          <p className="text-indigo-300 text-lg font-medium">Drop .spz or .ply file here</p>
        </div>
      )}

      {/* Capture flash overlay */}
      {captureFlash && (
        <div className="absolute inset-0 bg-white/30 pointer-events-none transition-opacity duration-200 z-10" />
      )}

      {/* Top bar — world info */}
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/60 to-transparent p-4 pointer-events-none z-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-sm font-medium">{worldName}</h1>
            <p className="text-neutral-400 text-[10px]">
              {sensor.name} · {focalLength}mm · {aspectRatio.name} · {vFov.toFixed(1)}° vFOV
            </p>
          </div>
          {loading && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-indigo-400 text-xs">Loading scene...</span>
            </div>
          )}
        </div>
      </div>

      {/* Controls Panel */}
      {showControls && splatLoaded && (
        <div className="absolute bottom-4 left-4 right-4 pointer-events-none z-5">
          <div className="flex items-end justify-between gap-4">
            {/* Camera Settings */}
            <div className="bg-black/70 backdrop-blur-md rounded-lg p-3 pointer-events-auto max-w-md">
              <div className="grid grid-cols-3 gap-3">
                {/* Sensor */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Sensor</label>
                  <select
                    value={sensorIndex}
                    onChange={(e) => setSensorIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {SENSOR_PRESETS.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Lens */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Lens</label>
                  <select
                    value={lensIndex}
                    onChange={(e) => setLensIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {LENS_FOCAL_LENGTHS.map((fl, i) => (
                      <option key={fl} value={i}>
                        {fl}mm
                      </option>
                    ))}
                  </select>
                </div>

                {/* Aspect Ratio */}
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-1">Aspect</label>
                  <select
                    value={aspectIndex}
                    onChange={(e) => setAspectIndex(Number(e.target.value))}
                    className="w-full bg-neutral-800 text-neutral-200 text-[11px] rounded px-2 py-1 border border-neutral-700 focus:border-indigo-500 focus:outline-none appearance-none"
                  >
                    {ASPECT_RATIO_PRESETS.map((ar, i) => (
                      <option key={ar.name} value={i}>
                        {ar.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Nav mode toggle */}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[9px] text-neutral-500">Nav</label>
                <div className="flex gap-1">
                  {(["fly", "orbit"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setNavMode(mode)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        navMode === mode
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                      } transition-colors`}
                    >
                      {mode === "fly" ? "Fly" : "Orbit"}
                    </button>
                  ))}
                  <span className="text-[9px] text-neutral-600 ml-1 self-center">F</span>
                </div>
              </div>
            </div>

            {/* Capture Button */}
            <button
              onClick={handleCapture}
              disabled={!splatLoaded}
              className="bg-red-600 hover:bg-red-500 disabled:bg-neutral-700 disabled:cursor-not-allowed text-white rounded-full w-14 h-14 flex items-center justify-center pointer-events-auto shadow-lg transition-all active:scale-95"
              title="Capture frame (Space / Enter)"
            >
              <div className="w-10 h-10 border-2 border-white rounded-full flex items-center justify-center">
                <div className="w-6 h-6 bg-white rounded-full" />
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Toggle controls hint */}
      <div className="absolute top-4 right-4 pointer-events-none z-5">
        <p className="text-neutral-600 text-[9px]">
          {navMode === "fly" ? "WASD to move · Drag to look" : "Drag to orbit"} · F toggle · H {showControls ? "hide" : "show"} · Space capture
          {!worldId && " · Drop .spz/.ply to load"}
        </p>
      </div>
    </div>
  );
}
