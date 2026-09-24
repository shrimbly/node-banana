import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";
import { validateMediaUrl } from "@/utils/urlValidation";

export const maxDuration = 300; // 5 minute timeout for large media operations

// Helper to get file extension from MIME type
function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "model/vnd.usdz+zip": "usdz",
    "model/fbx": "fbx",
    "model/stl": "stl",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
  };

  // Check explicit mapping first
  if (mimeToExt[mimeType]) {
    return mimeToExt[mimeType];
  }

  // Fallback based on MIME type prefix
  if (mimeType.startsWith("image/")) {
    return "png";
  }
  if (mimeType.startsWith("video/")) {
    return "mp4";
  }
  if (mimeType.startsWith("model/")) {
    return "glb";
  }
  if (mimeType.startsWith("audio/")) {
    return "mp3";
  }

  // Unknown type - use generic binary extension
  return "bin";
}

// Helper to detect if a string is an HTTP URL
function isHttpUrl(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

// Known file extensions for 3D models and common media
const KNOWN_3D_EXTENSIONS = new Set(["glb", "gltf", "obj", "fbx", "usdz", "stl", "ply"]);
const KNOWN_MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mov"]);

// Helper to extract a recognized file extension from a URL pathname
export function getExtensionFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf(".");
    if (lastDot === -1 || lastDot === pathname.length - 1) return null;
    const ext = pathname.substring(lastDot + 1).toLowerCase();
    if (KNOWN_3D_EXTENSIONS.has(ext) || KNOWN_MEDIA_EXTENSIONS.has(ext)) return ext;
    return null;
  } catch {
    return null;
  }
}

// Helper to compute MD5 hash of buffer content
function computeContentHash(buffer: Buffer): string {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Helper to find existing file by hash suffix
async function findExistingFileByHash(
  directoryPath: string,
  hash: string,
  extension: string
): Promise<string | null> {
  try {
    const files = await fs.readdir(directoryPath);
    // Look for files ending with this hash before extension
    const hashSuffix = `_${hash}.${extension}`;
    const matching = files.find((f) => f.endsWith(hashSuffix));
    return matching || null;
  } catch {
    return null;
  }
}

// POST: Save a generated image or video to the generations folder (or outputs folder)
export async function POST(request: NextRequest) {
  let directoryPath: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    const image = body.image;
    const video = body.video;
    const model3d = body.model3d;
    const audio = body.audio;
    const prompt = body.prompt;
    const imageId = body.imageId; // Optional ID for carousel support
    const customFilename = body.customFilename; // Optional custom filename (without extension)
    const createDirectory = body.createDirectory; // Optional flag to create directory if it doesn't exist

    const isVideo = !!video;
    const isModel = !!model3d;
    const isAudio = !!audio;
    const content = video || model3d || audio || image;

    logger.info('file.save', 'Generation auto-save request received', {
      directoryPath,
      hasImage: !!image,
      hasVideo: !!video,
      hasModel3d: !!model3d,
      hasAudio: !!audio,
      prompt,
      customFilename,
    });

    if (!directoryPath || !content) {
      logger.warn('file.save', 'Generation save validation failed: missing fields', {
        hasDirectoryPath: !!directoryPath,
        hasContent: !!content,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // The directory is chosen by the caller, so it has to be checked before it
    // reaches mkdir/writeFile — the sibling workflow routes do the same.
    const pathCheck = validateWorkflowPath(directoryPath);
    if (!pathCheck.valid) {
      logger.warn('file.error', 'Generation save rejected: invalid directory path', {
        directoryPath,
        reason: pathCheck.error,
      });
      return NextResponse.json(
        { success: false, error: pathCheck.error },
        { status: 400 }
      );
    }

    // Validate directory exists (or create if requested)
    try {
      const stats = await fs.stat(directoryPath);
      if (!stats.isDirectory()) {
        logger.warn('file.error', 'Generation save failed: path is not a directory', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      // Directory doesn't exist - create it if requested
      if (createDirectory) {
        try {
          await fs.mkdir(directoryPath, { recursive: true });
          logger.info('file.save', 'Created output directory', { directoryPath });
        } catch (mkdirError) {
          logger.error('file.error', 'Failed to create output directory', {
            directoryPath,
          }, mkdirError instanceof Error ? mkdirError : undefined);
          return NextResponse.json(
            { success: false, error: "Failed to create output directory" },
            { status: 500 }
          );
        }
      } else {
        logger.warn('file.error', 'Generation save failed: directory does not exist', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Directory does not exist" },
          { status: 400 }
        );
      }
    }

    let buffer: Buffer;
    let extension: string;

    if (isHttpUrl(content)) {
      // The URL is caller-supplied and fetched by the server, so it has to be
      // screened the same way the provider adapters screen their media URLs.
      const urlCheck = validateMediaUrl(content);
      if (!urlCheck.valid) {
        logger.warn('file.error', 'Generation save rejected: unsafe content URL', {
          reason: urlCheck.error,
        });
        return NextResponse.json(
          { success: false, error: urlCheck.error },
          { status: 400 }
        );
      }

      // Handle HTTP URL (common for large video files from providers)
      logger.info('file.save', 'Fetching content from URL', { url: content.substring(0, 100) });

      // Set up timeout to prevent hanging requests (60 seconds for large video files)
      const FETCH_TIMEOUT_MS = 60000;
      const MAX_CONTENT_SIZE = 500 * 1024 * 1024; // 500MB max

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(content, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Failed to fetch content: ${response.status} ${response.statusText}`);
        }

        // Check content-length before downloading to avoid excessive bandwidth usage
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          if (size > MAX_CONTENT_SIZE) {
            throw new Error(`Content size ${size} bytes exceeds maximum allowed ${MAX_CONTENT_SIZE} bytes`);
          }
        }

        const rawSaveContentType = response.headers.get("content-type");

        // For 3D models, try extracting extension from URL first (most reliable with CDN URLs)
        const urlExtension = isModel ? getExtensionFromUrl(content) : null;

        if (urlExtension) {
          extension = urlExtension;
        } else {
          const contentType = (rawSaveContentType && (rawSaveContentType.startsWith("video/") || rawSaveContentType.startsWith("image/") || rawSaveContentType.startsWith("model/") || rawSaveContentType.startsWith("audio/")))
            ? rawSaveContentType
            : (isModel ? "model/gltf-binary" : isAudio ? "audio/mpeg" : isVideo ? "video/mp4" : "image/png");
          extension = getExtensionFromMime(contentType);
        }

        const arrayBuffer = await response.arrayBuffer();

        // Double-check actual size after download
        if (arrayBuffer.byteLength > MAX_CONTENT_SIZE) {
          throw new Error(`Downloaded content size ${arrayBuffer.byteLength} bytes exceeds maximum allowed ${MAX_CONTENT_SIZE} bytes`);
        }

        buffer = Buffer.from(arrayBuffer);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
        }
        throw fetchError;
      }
    } else {
      // Handle base64 data URL
      const dataUrlMatch = content.match(/^data:([\w/+-]+);base64,/);
      if (dataUrlMatch) {
        const mimeType = dataUrlMatch[1];
        extension = getExtensionFromMime(mimeType);
        const base64Data = content.replace(/^data:[\w/+-]+;base64,/, "");
        buffer = Buffer.from(base64Data, "base64");
      } else {
        // Fallback: assume it's raw base64 without data URL prefix
        extension = isAudio ? "mp3" : isVideo ? "mp4" : "png";
        buffer = Buffer.from(content, "base64");
      }
    }

    // Safety net: if extension resolved to "bin" but we know the media type, use correct extension
    if (extension === "bin") {
      if (isModel && isHttpUrl(content)) {
        extension = getExtensionFromUrl(content) || "glb";
      } else {
        extension = isModel ? "glb" : isAudio ? "mp3" : isVideo ? "mp4" : "png";
      }
    }

    // Compute content hash for deduplication
    const contentHash = computeContentHash(buffer);

    // Check for existing file with same hash (deduplication)
    const existingFile = await findExistingFileByHash(directoryPath, contentHash, extension);
    if (existingFile) {
      const existingPath = path.join(directoryPath, existingFile);
      logger.info('file.save', 'Generation deduplicated: existing file found', {
        contentHash,
        existingFile,
        filePath: existingPath,
      });

      return NextResponse.json({
        success: true,
        filePath: existingPath,
        filename: existingFile,
        imageId: existingFile.replace(`.${extension}`, ''),
        isDuplicate: true,
      });
    }

    // Generate filename - use custom filename if provided, otherwise use prompt snippet
    let filename: string;
    if (customFilename) {
      // Sanitize custom filename
      const sanitizedFilename = customFilename
        .replace(/[^a-zA-Z0-9-_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
      filename = `${sanitizedFilename}_${contentHash}.${extension}`;
    } else {
      const promptSnippet = prompt
        ? prompt
            .slice(0, 30)
            .replace(/[^a-zA-Z0-9]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "")
            .toLowerCase()
        : "generation";
      filename = `${promptSnippet}_${contentHash}.${extension}`;
    }
    const filePath = path.join(directoryPath, filename);

    // Write the file
    await fs.writeFile(filePath, buffer);

    logger.info('file.save', 'Generation auto-saved successfully', {
      filePath,
      filename,
      fileSize: buffer.length,
      isVideo,
      isModel,
      isAudio,
      contentHash,
    });

    return NextResponse.json({
      success: true,
      filePath,
      filename,
      imageId: filename.replace(`.${extension}`, ''),
      isDuplicate: false,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to save generation', {
      directoryPath,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Save failed",
      },
      { status: 500 }
    );
  }
}
