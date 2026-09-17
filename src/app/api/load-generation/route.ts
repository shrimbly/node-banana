import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";

// Supported file extensions
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'aac'];

// Video extensions
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'];

// Audio extensions
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

// Extension to MIME type mapping
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

// POST: Load a generated image or video from the generations folder by ID
export async function POST(request: NextRequest) {
  let directoryPath: string | undefined;
  let imageId: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    imageId = body.imageId;

    logger.info('file.load', 'Generation load request received', {
      directoryPath,
      imageId,
    });

    if (!directoryPath || !imageId) {
      logger.warn('file.load', 'Generation load validation failed: missing fields', {
        hasDirectoryPath: !!directoryPath,
        hasImageId: !!imageId,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Both inputs are caller-supplied and are joined into a filesystem path
    // below, so both have to be checked first.
    const pathCheck = validateWorkflowPath(directoryPath);
    if (!pathCheck.valid) {
      logger.warn('file.load', 'Generation load rejected: invalid directory path', {
        directoryPath,
        reason: pathCheck.error,
      });
      return NextResponse.json(
        { success: false, error: pathCheck.error },
        { status: 400 }
      );
    }

    // The app mints ids as `img-<base36 timestamp>-<6 random>`, so anything
    // outside that alphabet is not an id we wrote — and a separator would let
    // the path.join below escape the directory entirely.
    if (!/^[A-Za-z0-9_-]+$/.test(imageId)) {
      logger.warn('file.load', 'Generation load rejected: invalid image id', { imageId });
      return NextResponse.json(
        { success: false, error: "Invalid image id" },
        { status: 400 }
      );
    }

    // Validate directory exists
    try {
      const stats = await fs.stat(directoryPath);
      if (!stats.isDirectory()) {
        logger.warn('file.error', 'Generation load failed: path is not a directory', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      logger.warn('file.error', 'Generation load failed: directory does not exist', {
        directoryPath,
      });
      return NextResponse.json(
        { success: false, error: "Directory does not exist" },
        { status: 400 }
      );
    }

    // Find the file by ID with any supported extension
    let foundExtension: string | null = null;
    let filePath: string | null = null;

    for (const ext of SUPPORTED_EXTENSIONS) {
      const candidatePath = path.join(directoryPath, `${imageId}.${ext}`);
      try {
        await fs.access(candidatePath);
        foundExtension = ext;
        filePath = candidatePath;
        break;
      } catch {
        // File doesn't exist with this extension, continue
      }
    }

    if (!foundExtension || !filePath) {
      // Return 200 with success: false to avoid Next.js error overlay
      // Missing files are expected when workflow refs point to deleted/moved images
      logger.info('file.load', 'Generation file not found (expected for missing refs)', {
        imageId,
        directoryPath,
      });
      return NextResponse.json({
        success: false,
        error: "File not found",
        notFound: true,
      });
    }

    // Read the file
    const buffer = await fs.readFile(filePath);

    // Convert to base64 data URL
    const mimeType = EXT_TO_MIME[foundExtension] || 'application/octet-stream';
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Determine content type
    const isVideo = VIDEO_EXTENSIONS.includes(foundExtension);
    const isAudio = AUDIO_EXTENSIONS.includes(foundExtension);
    const contentType = isVideo ? 'video' : isAudio ? 'audio' : 'image';

    logger.info('file.load', 'Generation loaded successfully', {
      filePath,
      extension: foundExtension,
      contentType,
      fileSize: buffer.length,
    });

    // Return appropriate response field based on content type
    const response: Record<string, unknown> = {
      success: true,
      contentType,
    };

    if (isVideo) {
      response.video = dataUrl;
    } else if (isAudio) {
      response.audio = dataUrl;
    } else {
      response.image = dataUrl;
    }

    return NextResponse.json(response);
  } catch (error) {
    logger.error('file.error', 'Failed to load generation', {
      directoryPath,
      imageId,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Load failed",
      },
      { status: 500 }
    );
  }
}
