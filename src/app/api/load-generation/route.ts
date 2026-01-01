import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";

// POST: Load a generated image from the generations folder by ID
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

    // Construct file path (ID is the filename without extension)
    const filename = `${imageId}.png`;
    const filePath = path.join(directoryPath, filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      logger.warn('file.error', 'Generation load failed: file not found', {
        filePath,
      });
      return NextResponse.json(
        { success: false, error: "Image file not found" },
        { status: 404 }
      );
    }

    // Read the image file
    const buffer = await fs.readFile(filePath);

    // Convert to base64 data URL
    const base64 = buffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    logger.info('file.load', 'Generation loaded successfully', {
      filePath,
      filename,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      image: dataUrl,
    });
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
