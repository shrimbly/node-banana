"use client";

import { useCallback, useRef, useState, useEffect, Suspense } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { useToast } from "@/components/Toast";
import { GLBViewerNodeData } from "@/types";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type GLBViewerNodeType = Node<GLBViewerNodeData, "glbViewer">;

/**
 * Renders a loaded GLB model using the raw GLTFLoader (avoids drei caching issues with blob URLs).
 */
function Model({ url, onError }: { url: string; onError?: () => void }) {
  const groupRef = useRef<THREE.Group>(null);
  const sceneRef = useRef<THREE.Group | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { camera } = useThree();

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    const loader = new GLTFLoader();
    try {
      loader.load(
        url,
        (gltf) => {
          if (cancelled) return;

          const loadedScene = gltf.scene;

          // Compute bounding box and normalize
          const box = new THREE.Box3().setFromObject(loadedScene);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);

          if (maxDim > 0) {
            // Scale to fit in a ~2 unit box
            const scale = 2 / maxDim;
            loadedScene.scale.setScalar(scale);

            // Re-center the model at origin
            loadedScene.position.set(
              -center.x * scale,
              -center.y * scale,
              -center.z * scale
            );
          }

          sceneRef.current = loadedScene;
          setLoaded(true);

          // Fit camera to model
          const dist = 3.5;
          camera.position.set(dist, dist * 0.6, dist);
          camera.lookAt(0, 0, 0);
        },
        undefined,
        (error) => {
          if (cancelled) return;
          console.warn("GLB load failed (file may need re-upload):", error);
          onError?.();
        }
      );
    } catch {
      if (!cancelled) onError?.();
    }

    return () => {
      cancelled = true;
      // Cleanup previous scene
      if (sceneRef.current) {
        sceneRef.current.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            try { obj.geometry?.dispose(); } catch (e) { console.warn("GLB geometry dispose failed:", e); }
            try {
              if (Array.isArray(obj.material)) {
                obj.material.forEach((m) => m.dispose());
              } else {
                obj.material?.dispose();
              }
            } catch (e) { console.warn("GLB material dispose failed:", e); }
          }
        });
        sceneRef.current = null;
      }
    };
  }, [url, camera, onError]);

  if (!loaded || !sceneRef.current) return null;

  return (
    <group ref={groupRef}>
      <primitive object={sceneRef.current} />
    </group>
  );
}

/**
 * 3D grid floor and subtle environment — hidden during capture via ref.
 */
function SceneEnvironment({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group ref={groupRef}>
      <spotLight
        position={[5, 8, 5]}
        angle={0.4}
        penumbra={0.8}
        intensity={1.5}
        castShadow
      />
    </group>
  );
}

/**
 * Helper component inside Canvas to expose the gl context for capture.
 * Directly hides grid objects (via ref) before rendering the capture frame.
 * Uses a ref-based approach so the capture function always has fresh references.
 */
function CaptureHelper({
  captureRef,
  envGroupRef,
}: {
  captureRef: React.MutableRefObject<(() => string | null) | null>;
  envGroupRef: React.RefObject<THREE.Group | null>;
}) {
  const { gl, scene, camera } = useThree();

  // Update the capture function every frame so it always has current gl/scene/camera
  useFrame(() => {
    captureRef.current = () => {
      try {
        // Directly hide environment objects in the Three.js scene graph (synchronous)
        if (envGroupRef.current) {
          envGroupRef.current.visible = false;
        }

        // Render without the grid
        gl.render(scene, camera);
        const dataUrl = gl.domElement.toDataURL("image/png");

        // Restore environment objects
        if (envGroupRef.current) {
          envGroupRef.current.visible = true;
        }

        return dataUrl;
      } catch (err) {
        console.warn("GLB capture failed:", err);
        // Restore environment objects on failure
        if (envGroupRef.current) {
          envGroupRef.current.visible = true;
        }
        return null;
      }
    };
  });

  return null;
}

/**
 * Auto-rotate the model slowly when not interacting.
 */
function AutoRotate({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();

  useFrame((_, delta) => {
    if (!enabled) return;
    const angle = delta * 0.3;
    const pos = camera.position.clone();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    camera.position.x = pos.x * cos - pos.z * sin;
    camera.position.z = pos.x * sin + pos.z * cos;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/**
 * Loading indicator (wireframe sphere) shown while GLB is parsing.
 */
function LoadingIndicator() {
  return (
    <mesh>
      <sphereGeometry args={[0.2, 16, 16]} />
      <meshBasicMaterial color="#666" wireframe />
    </mesh>
  );
}

export function GLBViewerNode({ id, data, selected }: NodeProps<GLBViewerNodeType>) {
  const nodeData = data as GLBViewerNodeData;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { setNodes, getNodes } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<(() => string | null) | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const envGroupRef = useRef<THREE.Group>(null);

  // Auto-resize node when capture image appears/disappears
  const prevCapturedRef = useRef<string | null>(null);
  useEffect(() => {
    const hadCapture = prevCapturedRef.current != null;
    const hasCapture = nodeData.capturedImage != null;
    prevCapturedRef.current = nodeData.capturedImage ?? null;

    // Only resize when capture state changes
    if (hadCapture === hasCapture) return;

    requestAnimationFrame(() => {
      const thisNode = getNodes().find((n) => n.id === id);
      if (!thisNode) return;

      const currentHeight = typeof thisNode.style?.height === "number"
        ? thisNode.style.height
        : 380; // default node height

      const currentWidth = typeof thisNode.style?.width === "number"
        ? thisNode.style.width
        : 360;

      // Get the viewport height to size the captured image area proportionally
      const viewportH = viewportRef.current?.offsetHeight ?? 200;
      // Extra space: controls bar (~30px) + label row (~20px) + captured image (~viewport height) + padding (~20px)
      const captureExtraHeight = viewportH + 70;

      const newHeight = hasCapture
        ? currentHeight + captureExtraHeight
        : Math.max(380, currentHeight - captureExtraHeight);

      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id !== id) return node;
          return {
            ...node,
            style: { ...node.style, width: currentWidth, height: newHeight },
          };
        })
      );
    });
  }, [id, nodeData.capturedImage, getNodes, setNodes]);

  // Revoke blob URL when it changes or when node is unmounted
  const glbUrlRef = useRef<string | null>(nodeData.glbUrl);
  useEffect(() => {
    glbUrlRef.current = nodeData.glbUrl;
    return () => {
      if (glbUrlRef.current) {
        URL.revokeObjectURL(glbUrlRef.current);
      }
    };
  }, [nodeData.glbUrl]);

  // Prevent wheel events from reaching React Flow (stop graph zoom/pan while scrolling to zoom 3D)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const stopWheel = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stopWheel, { passive: false });
    return () => el.removeEventListener("wheel", stopWheel);
  }, [nodeData.glbUrl]);

  // Shared file processing logic for both click-to-upload and drag-and-drop
  const processFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith(".glb")) {
        useToast.getState().show("Please upload a .GLB file", "warning");
        return;
      }

      if (file.size > 100 * 1024 * 1024) {
        useToast.getState().show("File too large. Maximum size is 100MB", "warning");
        return;
      }

      // Revoke previous URL if exists
      if (nodeData.glbUrl) {
        URL.revokeObjectURL(nodeData.glbUrl);
      }

      const url = URL.createObjectURL(file);
      updateNodeData(id, {
        glbUrl: url,
        filename: file.name,
        capturedImage: null,
      });
    },
    [id, nodeData.glbUrl, updateNodeData]
  );

  // If the blob URL becomes stale (e.g. after page reload), clear it so user can re-upload
  const handleLoadError = useCallback(() => {
    updateNodeData(id, { glbUrl: null, filename: null, capturedImage: null });
  }, [id, updateNodeData]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      processFile(file);
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    if (nodeData.glbUrl) {
      URL.revokeObjectURL(nodeData.glbUrl);
    }
    updateNodeData(id, {
      glbUrl: null,
      filename: null,
      capturedImage: null,
    });
  }, [id, nodeData.glbUrl, updateNodeData]);

  const handleCapture = useCallback(() => {
    if (captureRef.current) {
      const base64 = captureRef.current();
      if (base64) {
        updateNodeData(id, { capturedImage: base64 });
      } else {
        useToast.getState().show("Failed to capture 3D view", "error");
      }
    }
  }, [id, updateNodeData]);

  return (
    <BaseNode
      id={id}
      title="3D"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
      contentClassName={nodeData.glbUrl ? "flex-1 min-h-0 overflow-hidden flex flex-col" : undefined}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.glbUrl ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* 3D Viewport — fills node edge-to-edge */}
          <div
            ref={viewportRef}
            className={`nodrag nopan nowheel relative w-full flex-1 min-h-[200px] overflow-hidden bg-neutral-900 ${nodeData.capturedImage ? "" : "rounded-b-[5px]"}`}
            onPointerDown={() => setIsInteracting(true)}
            onPointerUp={() => setIsInteracting(false)}
          >
            <Canvas
              resize={{ offsetSize: true }}
              gl={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}
              camera={{ position: [3.5, 2.1, 3.5], fov: 45, near: 0.01, far: 100 }}
              onCreated={({ gl }) => {
                gl.setClearColor(new THREE.Color("#1a1a1a"));
                gl.toneMapping = THREE.ACESFilmicToneMapping;
                gl.toneMappingExposure = 1.2;
              }}
            >
              {/* Lighting */}
              <ambientLight intensity={0.5} />
              <directionalLight position={[5, 8, 5]} intensity={1} castShadow />
              <directionalLight position={[-3, 2, -2]} intensity={0.3} />
              <hemisphereLight args={["#b1e1ff", "#444444", 0.4]} />

              {/* Environment grid (hidden during capture via ref) */}
              <SceneEnvironment groupRef={envGroupRef} />

              {/* Model */}
              <Suspense fallback={<LoadingIndicator />}>
                <Model url={nodeData.glbUrl} onError={handleLoadError} />
              </Suspense>

              {/* Controls */}
              <OrbitControls
                makeDefault
                enableDamping
                dampingFactor={0.1}
                enablePan
                enableZoom
                target={[0, 0, 0]}
              />
              <AutoRotate enabled={autoRotate && !isInteracting} />
              <CaptureHelper captureRef={captureRef} envGroupRef={envGroupRef} />
            </Canvas>

            {/* Controls bar — overlaid on viewport */}
            <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-1.5 flex items-center justify-between gap-1 pointer-events-none bg-gradient-to-t from-black/60 to-transparent">
              <div className="flex items-center gap-1.5 min-w-0 pointer-events-auto">
                <span className="text-[10px] text-neutral-400 truncate max-w-[100px]">
                  {nodeData.filename}
                </span>
                <button
                  onClick={() => setAutoRotate(!autoRotate)}
                  title={autoRotate ? "Stop auto-rotate" : "Auto-rotate"}
                  className={`p-0.5 rounded transition-colors ${
                    autoRotate
                      ? "text-cyan-400 bg-cyan-400/10"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                  </svg>
                </button>
              </div>

              <div className="flex items-center gap-1 shrink-0 pointer-events-auto">
                <button
                  onClick={handleCapture}
                  title="Capture current view as image"
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300 hover:text-neutral-100 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                  </svg>
                  Capture
                </button>
                <button
                  onClick={handleRemove}
                  title="Remove model"
                  className="p-0.5 text-neutral-500 hover:text-red-400 rounded transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Captured image preview */}
          {nodeData.capturedImage && (
            <div className="px-3 py-1.5 shrink-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-green-400 flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Captured
                </span>
                <button
                  onClick={() => updateNodeData(id, { capturedImage: null })}
                  className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Clear
                </button>
              </div>
              <img
                src={nodeData.capturedImage}
                alt="Captured 3D render"
                className="w-full rounded border border-neutral-700 bg-neutral-900"
              />
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full flex-1 min-h-[150px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors"
        >
          <svg className="w-8 h-8 text-neutral-500 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
          </svg>
          <span className="text-[10px] text-neutral-400">
            Drop .GLB or click
          </span>
        </div>
      )}

      {/* 3D input handle - accepts generated 3D models */}
      <Handle
        type="target"
        position={Position.Left}
        id="3d"
        style={{ top: "50%" }}
        data-handletype="3d"
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-3d)",
        }}
      >
        3D
      </div>

      {/* Output handle - image (captured viewport) */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%" }}
        data-handletype="image"
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-image)",
        }}
      >
        Image
      </div>
    </BaseNode>
  );
}
