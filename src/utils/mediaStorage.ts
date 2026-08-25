import { WorkflowNode, WorkflowNodeData } from "@/types";
import { WorkflowFile } from "@/store/workflowStore";
import { normalizeGenerationHistoryIndex } from "@/utils/generationCarousel";
import crypto from "crypto";

/**
 * Fetch with timeout support using AbortController
 * @param url - The URL to fetch
 * @param options - Fetch options (RequestInit)
 * @param timeout - Timeout in milliseconds (default: 30000ms / 30 seconds)
 * @returns Promise<Response>
 * @throws Error if the request times out or fails
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Compute MD5 hash of content for deduplication
 * Consistent with save-generation API
 */
function computeContentHash(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

/**
 * Generate a unique media ID for external storage
 */
export function generateMediaId(prefix: "img" | "vid" | "aud" = "img"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate a unique image ID for external storage (backward compat)
 */
export function generateImageId(): string {
  return generateMediaId("img");
}

/**
 * Check if a string is an HTTP/HTTPS URL
 */
function isHttpUrl(str: string | null | undefined): boolean {
  return typeof str === "string" && (str.startsWith("http://") || str.startsWith("https://"));
}

/**
 * Check if a string is a base64 data URL (any type)
 */
function isDataUrl(str: string | null | undefined): str is string {
  return typeof str === "string" && str.startsWith("data:");
}

/**
 * Extract and save all media from a workflow, replacing base64 data with refs
 * Returns a new workflow object with media refs instead of base64 data
 */
export async function externalizeWorkflowMedia(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  const savedImageIds = new Map<string, string>(); // base64 hash -> imageId (for deduplication)
  const savedMediaIds = new Map<string, string>(); // base64 hash -> mediaId (for video/audio deduplication)

  // Process nodes in parallel batches with controlled concurrency
  const BATCH_SIZE = 3;
  const externalizedNodes: WorkflowNode[] = new Array(workflow.nodes.length);

  for (let i = 0; i < workflow.nodes.length; i += BATCH_SIZE) {
    const batch = workflow.nodes.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((node, batchIndex) =>
        externalizeNodeMedia(node, workflowPath, savedImageIds, savedMediaIds)
          .then(result => ({ index: i + batchIndex, result }))
      )
    );

    for (const { index, result } of results) {
      externalizedNodes[index] = result;
    }
  }

  return {
    ...workflow,
    nodes: externalizedNodes,
  };
}

/**
 * Legacy function name for backward compatibility
 */
export async function externalizeWorkflowImages(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  return externalizeWorkflowMedia(workflow, workflowPath);
}

/**
 * Externalize media from a single node
 */
async function externalizeNodeMedia(
  node: WorkflowNode,
  workflowPath: string,
  savedImageIds: Map<string, string>,
  savedMediaIds: Map<string, string>
): Promise<WorkflowNode> {
  const data = node.data as WorkflowNodeData;
  let newData: WorkflowNodeData;

  switch (node.type) {
    case "imageInput": {
      const d = data as import("@/types").ImageInputNodeData;
      // Skip if already has a valid imageRef (prevents duplicates on re-save after hydration)
      if (d.imageRef && isDataUrl(d.image)) {
        newData = { ...d, image: null };
      } else if (isDataUrl(d.image)) {
        const imageId = await saveImageAndGetId(d.image, workflowPath, savedImageIds, "inputs");
        newData = { ...d, image: null, imageRef: imageId };
      } else {
        newData = d;
      }
      break;
    }

    case "audioInput": {
      const d = data as import("@/types").AudioInputNodeData;
      // Externalize base64 audio data
      if (d.audioFileRef && isDataUrl(d.audioFile)) {
        newData = { ...d, audioFile: null };
      } else if (isDataUrl(d.audioFile)) {
        const audioRef = await saveAudioAndGetRef(d.audioFile, workflowPath, savedMediaIds);
        newData = { ...d, audioFile: null, audioFileRef: audioRef || undefined };
      } else {
        newData = d;
      }
      break;
    }

    case "videoInput": {
      const d = data as import("@/types").VideoInputNodeData;
      // Externalize base64 video data
      if (d.videoRef && isDataUrl(d.video)) {
        newData = { ...d, video: null };
      } else if (isDataUrl(d.video)) {
        const videoRef = await saveVideoAndGetRef(d.video, workflowPath, savedMediaIds);
        newData = { ...d, video: null, videoRef: videoRef || undefined };
      } else {
        newData = d;
      }
      break;
    }

    case "annotation": {
      const d = data as import("@/types").AnnotationNodeData;
      let sourceImageRef = d.sourceImageRef;
      let outputImageRef = d.outputImageRef;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      // Annotation images are user-created, save to inputs
      // Skip if already has ref (prevents duplicates on re-save after hydration)
      if (d.sourceImageRef && isDataUrl(d.sourceImage)) {
        sourceImage = null;
      } else if (isDataUrl(d.sourceImage)) {
        sourceImageRef = await saveImageAndGetId(d.sourceImage, workflowPath, savedImageIds, "inputs");
        sourceImage = null;
      }
      if (d.outputImageRef && isDataUrl(d.outputImage)) {
        outputImage = null;
      } else if (isDataUrl(d.outputImage)) {
        outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "inputs");
        outputImage = null;
      }

      newData = {
        ...d,
        sourceImage,
        sourceImageRef,
        outputImage,
        outputImageRef,
      };
      break;
    }

    case "nanoBanana": {
      const d = data as import("@/types").NanoBananaNodeData;
      let outputImageRef = d.outputImageRef;
      let outputImage = d.outputImage;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];

      // Handle output image - AI generated, save to generations
      // Use selectedHistoryIndex to get the correct history entry (not hardcoded 0)
      const selectedIndex = normalizeGenerationHistoryIndex(
        d.selectedHistoryIndex,
        d.imageHistory?.length || 0
      );
      const expectedRef = d.imageHistory?.[selectedIndex]?.id;

      if (d.outputImageRef && isDataUrl(d.outputImage)) {
        // Verify existing ref matches expected history ID
        if (d.outputImageRef === expectedRef) {
          outputImage = null; // Ref is correct, just clear base64
        } else {
          // Ref doesn't match history - re-save with correct ID
          outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "generations", expectedRef);
          outputImage = null;
        }
      } else if (isDataUrl(d.outputImage)) {
        // No existing ref - save with expected history ID for consistency
        outputImageRef = await saveImageAndGetId(d.outputImage, workflowPath, savedImageIds, "generations", expectedRef);
        outputImage = null;
      }

      // Handle input images array (these come from connected nodes, save to inputs if present)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isDataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isDataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      // Strip inline image data from imageHistory items (legacy bloat)
      // Each history item may carry a full base64 `image` field (~4.5MB each)
      // The `image` field isn't in the CarouselImageItem type but exists at runtime
      let cleanedHistory = d.imageHistory;
      if (d.imageHistory?.length) {
        cleanedHistory = [];
        for (const item of d.imageHistory) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const legacyImage = (item as any).image as string | undefined;
          if (legacyImage && isDataUrl(legacyImage)) {
            // Save history image to generations if not already saved
            await saveImageAndGetId(
              legacyImage,
              workflowPath, savedImageIds, "generations", item.id
            );
            // Push clean item with only typed fields (strips legacy `image`)
            cleanedHistory.push({
              id: item.id,
              timestamp: item.timestamp,
              prompt: item.prompt,
              aspectRatio: item.aspectRatio,
              model: item.model,
            });
          } else {
            cleanedHistory.push(item);
          }
        }
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
        outputImage,
        outputImageRef,
        imageHistory: cleanedHistory,
        selectedHistoryIndex: selectedIndex,
      };
      break;
    }

    case "llmGenerate": {
      const d = data as import("@/types").LLMGenerateNodeData;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];

      // Handle input images array (save to inputs)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isDataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isDataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
      };
      break;
    }

    case "generateVideo": {
      const d = data as import("@/types").GenerateVideoNodeData;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];
      let outputVideoRef = d.outputVideoRef;
      let outputVideo = d.outputVideo;

      // Handle input images array (save to inputs)
      // Skip if corresponding inputImageRef already exists
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isDataUrl(img)) {
          inputImages.push(""); // Already has ref, just clear the base64
        } else if (isDataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push(""); // Empty placeholder
        } else {
          inputImages.push(img);
        }
      }

      // Handle output video - KEEP HTTP URLs for compatibility, externalize base64
      if (d.outputVideo) {
        if (isHttpUrl(d.outputVideo)) {
          // KEEP HTTP URLs - small size, preserves CDN references
          outputVideo = d.outputVideo; // Keep as-is
          outputVideoRef = undefined;  // No ref needed
        } else if (d.outputVideoRef && isDataUrl(d.outputVideo)) {
          // Already has ref, just clear base64
          outputVideo = null;
        } else if (isDataUrl(d.outputVideo)) {
          const selectedIndex = d.selectedVideoHistoryIndex || 0;
          const expectedRef = d.videoHistory?.[selectedIndex]?.id;
          const videoRef = await saveVideoAndGetRef(d.outputVideo, workflowPath, savedMediaIds, expectedRef);
          outputVideoRef = videoRef || undefined;
          outputVideo = null;
        }
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
        outputVideo,
        outputVideoRef,
      };
      break;
    }

    case "generate3d": {
      const d = data as import("@/types").Generate3DNodeData;
      let inputImageRefs = d.inputImageRefs ? [...d.inputImageRefs] : [];
      const inputImages: string[] = [];

      // Handle input images array (same pattern as generateVideo)
      for (let i = 0; i < (d.inputImages?.length || 0); i++) {
        const img = d.inputImages[i];
        const existingRef = d.inputImageRefs?.[i];
        if (existingRef && isDataUrl(img)) {
          inputImages.push("");
        } else if (isDataUrl(img)) {
          const ref = await saveImageAndGetId(img, workflowPath, savedImageIds, "inputs");
          inputImageRefs[i] = ref;
          inputImages.push("");
        } else {
          inputImages.push(img);
        }
      }

      newData = {
        ...d,
        inputImages: inputImages.length > 0 && inputImages.every(i => i === "") ? [] : inputImages,
        inputImageRefs: inputImageRefs.length > 0 ? inputImageRefs : undefined,
      };
      break;
    }

    case "generateAudio": {
      const d = data as import("@/types").GenerateAudioNodeData;
      let outputAudioRef = d.outputAudioRef;
      let outputAudio = d.outputAudio;

      // Handle output audio - KEEP HTTP URLs for compatibility, externalize base64
      if (d.outputAudio) {
        if (isHttpUrl(d.outputAudio)) {
          // KEEP HTTP URLs - small size, preserves CDN references
          outputAudio = d.outputAudio; // Keep as-is
          outputAudioRef = undefined;  // No ref needed
        } else if (d.outputAudioRef && isDataUrl(d.outputAudio)) {
          // Already has ref, just clear base64
          outputAudio = null;
        } else if (isDataUrl(d.outputAudio)) {
          const selectedIndex = d.selectedAudioHistoryIndex || 0;
          const expectedRef = d.audioHistory?.[selectedIndex]?.id;
          const audioRef = await saveAudioAndGetRef(d.outputAudio, workflowPath, savedMediaIds, expectedRef);
          outputAudioRef = audioRef || undefined;
          outputAudio = null;
        }
      }

      newData = {
        ...d,
        outputAudio,
        outputAudioRef,
      };
      break;
    }

    case "output": {
      const d = data as import("@/types").OutputNodeData;
      // Output content is saved to /outputs during workflow execution, not here
      // Clear image data to keep workflow file small - outputs are regenerated on each run
      newData = { ...d, image: null, imageRef: undefined, video: null, audio: null };
      break;
    }

    case "outputGallery": {
      const d = data as import("@/types").OutputGalleryNodeData;
      const galleryImageRefs: string[] = d.imageRefs ? [...d.imageRefs] : [];
      const galleryVideoRefs: string[] = d.videoRefs ? [...d.videoRefs] : [];

      // Externalize gallery images
      for (let i = 0; i < (d.images?.length || 0); i++) {
        const img = d.images[i];
        const existingRef = galleryImageRefs[i];
        if (existingRef && isDataUrl(img)) {
          // Already has ref, just keep it
        } else if (isDataUrl(img)) {
          galleryImageRefs[i] = await saveImageAndGetId(img, workflowPath, savedImageIds, "generations");
        } else if (isHttpUrl(img)) {
          // Keep HTTP URLs inline (small, no ref needed)
          galleryImageRefs[i] = ""; // placeholder to keep indices aligned
        }
      }

      // Externalize gallery videos
      for (let i = 0; i < (d.videos?.length || 0); i++) {
        const vid = d.videos![i];
        const existingRef = galleryVideoRefs[i];
        if (existingRef && isDataUrl(vid)) {
          // Already has ref, just keep it
        } else if (isDataUrl(vid)) {
          const ref = await saveVideoAndGetRef(vid, workflowPath, savedMediaIds);
          if (ref) galleryVideoRefs[i] = ref;
        } else if (isHttpUrl(vid)) {
          // Keep HTTP URLs inline (small, no ref needed)
          galleryVideoRefs[i] = ""; // placeholder to keep indices aligned
        }
      }

      // Build cleaned arrays: clear base64 data where refs exist, keep HTTP URLs
      const cleanedImages = (d.images || []).map((img, i) =>
        galleryImageRefs[i] && isDataUrl(img) ? "" : img
      );
      const cleanedVideos = (d.videos || []).map((vid, i) =>
        galleryVideoRefs[i] && isDataUrl(vid) ? "" : vid
      );

      // Filter out empty placeholders from refs
      const hasImageRefs = galleryImageRefs.some(r => r && r !== "");
      const hasVideoRefs = galleryVideoRefs.some(r => r && r !== "");

      // Trim refs to match actual array lengths (stale trailing entries after deletions)
      const trimmedImageRefs = galleryImageRefs.slice(0, d.images?.length || 0);
      const trimmedVideoRefs = galleryVideoRefs.slice(0, d.videos?.length || 0);

      newData = {
        ...d,
        images: cleanedImages,
        imageRefs: hasImageRefs ? trimmedImageRefs : undefined,
        videos: cleanedVideos,
        videoRefs: hasVideoRefs ? trimmedVideoRefs : undefined,
      };
      break;
    }

    case "imageCompare": {
      const d = data as import("@/types").ImageCompareNodeData;
      let imageA = d.imageA;
      let imageB = d.imageB;
      let imageARef = d.imageARef;
      let imageBRef = d.imageBRef;

      if (d.imageARef && isDataUrl(d.imageA)) {
        imageA = null;
      } else if (isDataUrl(d.imageA)) {
        imageARef = await saveImageAndGetId(d.imageA, workflowPath, savedImageIds, "inputs");
        imageA = null;
      }

      if (d.imageBRef && isDataUrl(d.imageB)) {
        imageB = null;
      } else if (isDataUrl(d.imageB)) {
        imageBRef = await saveImageAndGetId(d.imageB, workflowPath, savedImageIds, "inputs");
        imageB = null;
      }

      newData = {
        ...d,
        imageA,
        imageB,
        imageARef,
        imageBRef,
      };
      break;
    }

    case "videoStitch": {
      const d = data as import("@/types").VideoStitchNodeData;
      // Clear output video and all thumbnails (transient/derived content)
      newData = {
        ...d,
        outputVideo: null,
        clips: d.clips.map(clip => ({ ...clip, thumbnail: null })),
      };
      break;
    }

    case "easeCurve": {
      const d = data as import("@/types").EaseCurveNodeData;
      // Clear output video (derived from input video)
      newData = { ...d, outputVideo: null };
      break;
    }

    case "videoTrim": {
      const d = data as import("@/types").VideoTrimNodeData;
      // Clear output video (derived from input video)
      newData = { ...d, outputVideo: null };
      break;
    }

    case "videoFrameGrab": {
      const d = data as import("@/types").VideoFrameGrabNodeData;
      // Clear output image (derived from input video)
      newData = { ...d, outputImage: null };
      break;
    }

    case "removeBackground": {
      const d = data as import("@/types").RemoveBackgroundNodeData;
      // Clear output image (derived from input image)
      newData = { ...d, outputImage: null };
      break;
    }

    case "glbViewer": {
      const d = data as import("@/types").GLBViewerNodeData;
      // Externalize captured viewport image
      if (d.capturedImageRef && isDataUrl(d.capturedImage)) {
        newData = { ...d, capturedImage: null };
      } else if (isDataUrl(d.capturedImage)) {
        const imageId = await saveImageAndGetId(d.capturedImage, workflowPath, savedImageIds, "inputs");
        newData = { ...d, capturedImage: null, capturedImageRef: imageId };
      } else {
        newData = d;
      }
      break;
    }

    case "comfyApp": {
      const d = data as import("@/types").ComfyAppNodeData;
      // A Comfy app can produce several outputs at once, so each is
      // externalized under its own handle id. Text outputs stay inline —
      // they are small, and a text file per run would be wasteful.
      const outputs = d.outputs ?? {};
      const declaredType = new Map((d.app?.outputs ?? []).map((o) => [o.id, o.type]));
      const refs: Record<string, string> = { ...(d.outputRefs ?? {}) };
      const remaining: Record<string, string> = {};
      for (const [handleId, value] of Object.entries(outputs)) {
        const type = declaredType.get(handleId);
        if (type === "text" || !isDataUrl(value)) {
          remaining[handleId] = value;
          continue;
        }
        if (refs[handleId]) continue;
        // Each type into the store hydration reads it back from. Saving a video
        // through the image store and loading it from the video store is how an
        // output survived the save and came back empty.
        const ref =
          type === "video"
            ? await saveVideoAndGetRef(value, workflowPath, savedMediaIds)
            : type === "audio"
              ? await saveAudioAndGetRef(value, workflowPath, savedMediaIds)
              : await saveImageAndGetId(value, workflowPath, savedImageIds, "generations");
        // A store that declined the value leaves it inline rather than losing
        // it to a ref that points at nothing.
        if (ref) refs[handleId] = ref;
        else remaining[handleId] = value;
      }
      newData = {
        ...d,
        outputs: remaining,
        outputRefs: refs,
        // The typed mirrors are rebuilt from `outputs` on hydration.
        outputImage: null,
        outputVideo: null,
        outputAudio: null,
        output3dUrl: null,
      };
      break;
    }

    case "splitGrid": {
      const d = data as import("@/types").SplitGridNodeData;
      // SplitGrid source is input content, save to inputs
      // Skip if already has ref (prevents duplicates on re-save after hydration)
      if (d.sourceImageRef && isDataUrl(d.sourceImage)) {
        newData = { ...d, sourceImage: null };
      } else if (isDataUrl(d.sourceImage)) {
        const imageId = await saveImageAndGetId(d.sourceImage, workflowPath, savedImageIds, "inputs");
        newData = { ...d, sourceImage: null, sourceImageRef: imageId };
      } else {
        newData = d;
      }
      break;
    }

    default:
      newData = data;
  }

  return {
    ...node,
    data: newData,
  } as WorkflowNode;
}

// In-flight saves guard to prevent duplicate concurrent uploads of the same media
const inFlightSaves = new Map<string, Promise<string>>();

/**
 * Save an image and return its ID (with deduplication)
 * @param folder - "inputs" for user-uploaded images, "generations" for AI-generated images
 * @param existingId - Optional ID to use instead of generating a new one (for consistency with history)
 */
async function saveImageAndGetId(
  imageData: string,
  workflowPath: string,
  savedImageIds: Map<string, string>,
  folder: "inputs" | "generations" = "inputs",
  existingId?: string
): Promise<string> {
  // Use MD5 hash for reliable deduplication (consistent with save-generation API, Phase 13 decision)
  // Include folder in hash so same image in different folders gets different IDs
  const hash = `${folder}-${computeContentHash(imageData)}`;

  // Skip deduplication if an explicit ID is requested - we must use that exact ID
  // to maintain consistency with imageHistory. Otherwise, deduplicate by content.
  if (!existingId && savedImageIds.has(hash)) {
    return savedImageIds.get(hash)!;
  }

  // Check if there's already an in-flight save for this hash
  if (!existingId && inFlightSaves.has(hash)) {
    return inFlightSaves.get(hash)!;
  }

  // Use existing ID if provided (for consistency with imageHistory), otherwise generate new
  const imageId = existingId || generateImageId();

  const savePromise = (async () => {
    const response = await fetchWithTimeout(
      "/api/workflow-images",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowPath,
          imageId,
          imageData,
          folder,
        }),
      }
    );

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Failed to save image: ${result.error}`);
    }

    savedImageIds.set(hash, imageId);
    return imageId;
  })();

  if (!existingId) {
    inFlightSaves.set(hash, savePromise);
  }

  try {
    return await savePromise;
  } catch (error) {
    throw error;
  } finally {
    inFlightSaves.delete(hash);
  }
}

/**
 * Save video and return its ref (base64 only, preserve HTTP URLs)
 * @returns ref ID if saved, null otherwise
 */
async function saveVideoAndGetRef(
  videoData: string,
  workflowPath: string,
  savedMediaIds: Map<string, string>,
  existingId?: string
): Promise<string | null> {
  // Only externalize base64 data URLs
  if (!isDataUrl(videoData)) {
    return null;
  }

  const hash = `video-${computeContentHash(videoData)}`;

  // Skip deduplication if an explicit ID is requested
  if (!existingId && savedMediaIds.has(hash)) {
    return savedMediaIds.get(hash)!;
  }

  if (!existingId && inFlightSaves.has(hash)) {
    return inFlightSaves.get(hash)!;
  }

  const videoId = existingId || generateMediaId("vid");

  const savePromise = (async () => {
    const response = await fetchWithTimeout(
      "/api/save-generation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: `${workflowPath}/generations`,
          createDirectory: true,
          imageId: videoId,
          video: videoData,
        }),
      },
      60000 // 60s timeout for larger video files
    );

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Failed to save video: ${result.error}`);
    }

    const actualId = result.imageId || videoId;
    savedMediaIds.set(hash, actualId);
    return actualId;
  })();

  if (!existingId) {
    inFlightSaves.set(hash, savePromise);
  }

  try {
    return await savePromise;
  } catch (error) {
    throw error;
  } finally {
    inFlightSaves.delete(hash);
  }
}

/**
 * Save audio and return its ref (base64 only, preserve HTTP URLs)
 * @returns ref ID if saved, null otherwise
 */
async function saveAudioAndGetRef(
  audioData: string,
  workflowPath: string,
  savedMediaIds: Map<string, string>,
  existingId?: string
): Promise<string | null> {
  // Only externalize base64 data URLs
  if (!isDataUrl(audioData)) {
    return null;
  }

  const hash = `audio-${computeContentHash(audioData)}`;

  // Skip deduplication if an explicit ID is requested
  if (!existingId && savedMediaIds.has(hash)) {
    return savedMediaIds.get(hash)!;
  }

  if (!existingId && inFlightSaves.has(hash)) {
    return inFlightSaves.get(hash)!;
  }

  const audioId = existingId || generateMediaId("aud");

  const savePromise = (async () => {
    const response = await fetchWithTimeout(
      "/api/save-generation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: `${workflowPath}/generations`,
          createDirectory: true,
          imageId: audioId,
          audio: audioData,
        }),
      },
      60000 // 60s timeout for larger audio files
    );

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Failed to save audio: ${result.error}`);
    }

    const actualId = result.imageId || audioId;
    savedMediaIds.set(hash, actualId);
    return actualId;
  })();

  if (!existingId) {
    inFlightSaves.set(hash, savePromise);
  }

  try {
    return await savePromise;
  } catch (error) {
    throw error;
  } finally {
    inFlightSaves.delete(hash);
  }
}

/**
 * Load all external media into a workflow, replacing refs with base64 data
 * Returns a new workflow object with base64 data instead of refs
 */
export async function hydrateWorkflowMedia(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  const loadedMedia = new Map<string, string>(); // mediaId -> base64 (for caching/deduplication)

  // Process nodes in parallel batches with controlled concurrency
  const BATCH_SIZE = 3;
  const hydratedNodes: WorkflowNode[] = new Array(workflow.nodes.length);

  for (let i = 0; i < workflow.nodes.length; i += BATCH_SIZE) {
    const batch = workflow.nodes.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((node, batchIndex) =>
        hydrateNodeMedia(node, workflowPath, loadedMedia)
          .then(result => ({ index: i + batchIndex, result }))
      )
    );

    for (const { index, result } of results) {
      hydratedNodes[index] = result;
    }
  }

  return {
    ...workflow,
    nodes: hydratedNodes,
  };
}

/**
 * Legacy function name for backward compatibility
 */
export async function hydrateWorkflowImages(
  workflow: WorkflowFile,
  workflowPath: string
): Promise<WorkflowFile> {
  return hydrateWorkflowMedia(workflow, workflowPath);
}

/**
 * Hydrate media for a single node
 */
async function hydrateNodeMedia(
  node: WorkflowNode,
  workflowPath: string,
  loadedMedia: Map<string, string>
): Promise<WorkflowNode> {
  const data = node.data as WorkflowNodeData;
  let newData: WorkflowNodeData;

  switch (node.type) {
    case "imageInput": {
      const d = data as import("@/types").ImageInputNodeData;
      if (d.imageRef && !d.image) {
        const image = await loadMediaById(d.imageRef, workflowPath, loadedMedia, "image");
        newData = {
          ...d,
          image,
        };
      } else {
        newData = d;
      }
      break;
    }

    case "audioInput": {
      const d = data as import("@/types").AudioInputNodeData;
      if (d.audioFileRef && !d.audioFile) {
        const audioFile = await loadMediaById(d.audioFileRef, workflowPath, loadedMedia, "audio");
        newData = {
          ...d,
          audioFile,
        };
      } else {
        newData = d;
      }
      break;
    }

    case "videoInput": {
      const d = data as import("@/types").VideoInputNodeData;
      if (d.videoRef && !d.video) {
        const video = await loadMediaById(d.videoRef, workflowPath, loadedMedia, "video");
        newData = {
          ...d,
          video,
        };
      } else {
        newData = d;
      }
      break;
    }

    case "annotation": {
      const d = data as import("@/types").AnnotationNodeData;
      let sourceImage = d.sourceImage;
      let outputImage = d.outputImage;

      if (d.sourceImageRef && !d.sourceImage) {
        sourceImage = await loadMediaById(d.sourceImageRef, workflowPath, loadedMedia, "image");
      }
      if (d.outputImageRef && !d.outputImage) {
        outputImage = await loadMediaById(d.outputImageRef, workflowPath, loadedMedia, "image");
      }

      newData = {
        ...d,
        sourceImage,
        outputImage,
      };
      break;
    }

    case "nanoBanana": {
      const d = data as import("@/types").NanoBananaNodeData;
      let outputImage = d.outputImage;
      const inputImages = [...(d.inputImages || [])];
      const selectedHistoryIndex = normalizeGenerationHistoryIndex(
        d.selectedHistoryIndex,
        d.imageHistory?.length || 0
      );
      const selectedHistoryRef = d.imageHistory?.[selectedHistoryIndex]?.id;
      const outputImageRef = selectedHistoryRef || d.outputImageRef;

      if (outputImageRef && !d.outputImage) {
        outputImage = await loadMediaById(outputImageRef, workflowPath, loadedMedia, "image");
      }

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadMediaById(ref, workflowPath, loadedMedia, "image");
          }
        }
      }

      newData = {
        ...d,
        inputImages,
        outputImage,
        outputImageRef,
        selectedHistoryIndex,
      };
      break;
    }

    case "llmGenerate": {
      const d = data as import("@/types").LLMGenerateNodeData;
      const inputImages = [...(d.inputImages || [])];

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadMediaById(ref, workflowPath, loadedMedia, "image");
          }
        }
      }

      newData = {
        ...d,
        inputImages,
      };
      break;
    }

    case "generateVideo": {
      const d = data as import("@/types").GenerateVideoNodeData;
      const inputImages = [...(d.inputImages || [])];
      let outputVideo = d.outputVideo;

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadMediaById(ref, workflowPath, loadedMedia, "image");
          }
        }
      }

      // Hydrate output video from ref (skip HTTP URLs)
      if (d.outputVideoRef && !d.outputVideo) {
        outputVideo = await loadMediaById(d.outputVideoRef, workflowPath, loadedMedia, "video");
      }

      newData = {
        ...d,
        inputImages,
        outputVideo,
      };
      break;
    }

    case "generate3d": {
      const d = data as import("@/types").Generate3DNodeData;
      const inputImages = [...(d.inputImages || [])];

      // Hydrate input images from refs
      if (d.inputImageRefs && d.inputImageRefs.length > 0) {
        for (let i = 0; i < d.inputImageRefs.length; i++) {
          const ref = d.inputImageRefs[i];
          if (ref) {
            inputImages[i] = await loadMediaById(ref, workflowPath, loadedMedia, "image");
          }
        }
      }

      newData = {
        ...d,
        inputImages,
      };
      break;
    }

    case "generateAudio": {
      const d = data as import("@/types").GenerateAudioNodeData;
      let outputAudio = d.outputAudio;

      // Hydrate output audio from ref (skip HTTP URLs)
      if (d.outputAudioRef && !d.outputAudio) {
        outputAudio = await loadMediaById(d.outputAudioRef, workflowPath, loadedMedia, "audio");
      }

      newData = {
        ...d,
        outputAudio,
      };
      break;
    }

    case "output": {
      // Output content is not persisted - it's regenerated on each workflow run
      // and saved to /outputs directory during execution
      newData = data;
      break;
    }

    case "outputGallery": {
      const d = data as import("@/types").OutputGalleryNodeData;
      const images = [...(d.images || [])];
      const videos = [...(d.videos || [])];

      // Hydrate images from refs
      if (d.imageRefs && d.imageRefs.length > 0) {
        for (let i = 0; i < d.imageRefs.length; i++) {
          const ref = d.imageRefs[i];
          if (ref && ref !== "" && (!images[i] || images[i] === "")) {
            images[i] = await loadMediaById(ref, workflowPath, loadedMedia, "image");
          }
        }
      }

      // Hydrate videos from refs
      if (d.videoRefs && d.videoRefs.length > 0) {
        for (let i = 0; i < d.videoRefs.length; i++) {
          const ref = d.videoRefs[i];
          if (ref && ref !== "" && (!videos[i] || videos[i] === "")) {
            videos[i] = await loadMediaById(ref, workflowPath, loadedMedia, "video");
          }
        }
      }

      // Rebuild arrays keeping refs in sync. An entry with an empty media value
      // may simply have failed to hydrate (transient error, legacy folder layout,
      // fs read error) even though the underlying file still exists on disk.
      // Preserve such entries (empty media, ref intact) so a one-time load hiccup
      // never permanently deletes gallery items; only drop true empty placeholders
      // that carry neither media nor a ref to recover from.
      const filteredImages: string[] = [];
      const filteredImageRefs: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const media = images[i];
        const ref = d.imageRefs?.[i] || "";
        const hasMedia = !!media && media !== "";
        if (hasMedia || ref !== "") {
          filteredImages.push(hasMedia ? media : "");
          filteredImageRefs.push(ref);
        }
      }
      const filteredVideos: string[] = [];
      const filteredVideoRefs: string[] = [];
      for (let i = 0; i < videos.length; i++) {
        const media = videos[i];
        const ref = d.videoRefs?.[i] || "";
        const hasMedia = !!media && media !== "";
        if (hasMedia || ref !== "") {
          filteredVideos.push(hasMedia ? media : "");
          filteredVideoRefs.push(ref);
        }
      }
      newData = {
        ...d,
        images: filteredImages,
        imageRefs: filteredImageRefs,
        videos: filteredVideos,
        videoRefs: filteredVideoRefs,
      };
      break;
    }

    case "imageCompare": {
      const d = data as import("@/types").ImageCompareNodeData;
      let imageA = d.imageA;
      let imageB = d.imageB;

      if (d.imageARef && !d.imageA) {
        imageA = await loadMediaById(d.imageARef, workflowPath, loadedMedia, "image");
      }
      if (d.imageBRef && !d.imageB) {
        imageB = await loadMediaById(d.imageBRef, workflowPath, loadedMedia, "image");
      }

      newData = {
        ...d,
        imageA,
        imageB,
      };
      break;
    }

    case "videoStitch": {
      // videoStitch content is not persisted - it's regenerated on each workflow run
      newData = data;
      break;
    }

    case "easeCurve": {
      // easeCurve content is not persisted - it's regenerated on each workflow run
      newData = data;
      break;
    }

    case "videoTrim": {
      // videoTrim content is not persisted - it's regenerated on each workflow run
      newData = data;
      break;
    }

    case "videoFrameGrab": {
      // videoFrameGrab content is not persisted - it's regenerated on each workflow run
      newData = data;
      break;
    }

    case "removeBackground": {
      // removeBackground content is not persisted - it's regenerated on each workflow run
      newData = data;
      break;
    }

    case "glbViewer": {
      const d = data as import("@/types").GLBViewerNodeData;
      if (d.capturedImageRef && !d.capturedImage) {
        const capturedImage = await loadMediaById(d.capturedImageRef, workflowPath, loadedMedia, "image");
        newData = {
          ...d,
          capturedImage,
        };
      } else {
        newData = d;
      }
      break;
    }

    case "comfyApp": {
      const d = data as import("@/types").ComfyAppNodeData;
      const refs = d.outputRefs ?? {};
      const outputs: Record<string, string> = { ...(d.outputs ?? {}) };
      for (const [handleId, ref] of Object.entries(refs)) {
        if (outputs[handleId]) continue;
        const declared = d.app?.outputs.find((o) => o.id === handleId);
        const mediaType =
          declared?.type === "video" ? "video" : declared?.type === "audio" ? "audio" : "image";
        outputs[handleId] = await loadMediaById(ref, workflowPath, loadedMedia, mediaType);
      }
      // Rebuild the typed mirrors from the restored outputs, in the same
      // declared order the executor uses, so downstream nodes see the same
      // value they did before the save.
      const firstOfType = (type: string): string | null => {
        for (const declared of d.app?.outputs ?? []) {
          if (declared.type !== type) continue;
          const value = outputs[declared.id];
          if (value) return value;
        }
        return null;
      };
      newData = {
        ...d,
        outputs,
        outputImage: firstOfType("image"),
        outputVideo: firstOfType("video"),
        outputAudio: firstOfType("audio"),
        outputText: firstOfType("text"),
        output3dUrl: firstOfType("3d"),
      };
      break;
    }

    case "splitGrid": {
      const d = data as import("@/types").SplitGridNodeData;
      if (d.sourceImageRef && !d.sourceImage) {
        const sourceImage = await loadMediaById(d.sourceImageRef, workflowPath, loadedMedia, "image");
        newData = {
          ...d,
          sourceImage,
        };
      } else {
        newData = d;
      }
      break;
    }

    default:
      newData = data;
  }

  return {
    ...node,
    data: newData,
  } as WorkflowNode;
}

/**
 * Load media by ID (with caching)
 * @param mediaType - Type of media to load (image, video, audio)
 */
async function loadMediaById(
  mediaId: string,
  workflowPath: string,
  loadedMedia: Map<string, string>,
  mediaType: "image" | "video" | "audio"
): Promise<string> {
  if (loadedMedia.has(mediaId)) {
    return loadedMedia.get(mediaId)!;
  }

  let response: Response;

  if (mediaType === "image") {
    // Use workflow-images API for images (legacy path)
    const params = new URLSearchParams({
      workflowPath,
      imageId: mediaId,
    });

    response = await fetch(`/api/workflow-images?${params.toString()}`);
  } else {
    // Use load-generation API for videos and audio
    // Try generations/ subfolder first, fall back to root for legacy files
    response = await fetch("/api/load-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directoryPath: `${workflowPath}/generations`,
        imageId: mediaId,
      }),
    });

    let genResult = await response.json();

    // Fallback to root directory for legacy files saved before generations/ fix
    if (!genResult.success && genResult.notFound) {
      response = await fetch("/api/load-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: workflowPath,
          imageId: mediaId,
        }),
      });
      genResult = await response.json();
    }

    if (!genResult.success) {
      console.log(`${mediaType} not found: ${mediaId}`);
      return "";
    }
    const mediaData = mediaType === "video" ? genResult.video : genResult.audio;
    if (!mediaData) {
      console.log(`${mediaType} not found or invalid payload: ${mediaId}`);
      return "";
    }
    loadedMedia.set(mediaId, mediaData);
    return mediaData;
  }

  // Only images reach here (video/audio return early above)
  const result = await response.json();

  if (!result.success) {
    console.log(`${mediaType} not found: ${mediaId}`);
    return "";
  }

  loadedMedia.set(mediaId, result.image);
  return result.image;
}
