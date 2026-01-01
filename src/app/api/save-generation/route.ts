import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";

// POST: Save a generated image to the generations folder
export async function POST(request: NextRequest) {
  let directoryPath: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    const image = body.image;
    const prompt = body.prompt;
    const imageId = body.imageId; // Optional ID for carousel support

    logger.info('file.save', 'Generation auto-save request received', {
      directoryPath,
      hasImage: !!image,
      prompt,
    });

    if (!directoryPath || !image) {
      logger.warn('file.save', 'Generation save validation failed: missing fields', {
        hasDirectoryPath: !!directoryPath,
        hasImage: !!image,
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
        logger.warn('file.error', 'Generation save failed: path is not a directory', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      logger.warn('file.error', 'Generation save failed: directory does not exist', {
        directoryPath,
      });
      return NextResponse.json(
        { success: false, error: "Directory does not exist" },
        { status: 400 }
      );
    }

    // Generate filename: use imageId if provided, otherwise timestamp + sanitized prompt snippet
    let filename: string;
    if (imageId) {
      filename = `${imageId}.png`;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const promptSnippet = prompt
        ? prompt
            .slice(0, 30)
            .replace(/[^a-zA-Z0-9]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "")
            .toLowerCase()
        : "generation";
      filename = `${timestamp}_${promptSnippet}.png`;
    }
    const filePath = path.join(directoryPath, filename);

    // Extract base64 data and convert to buffer
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    // Write the image file
    await fs.writeFile(filePath, buffer);

    logger.info('file.save', 'Generation auto-saved successfully', {
      filePath,
      filename,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      filePath,
      filename,
      imageId: imageId || filename.replace('.png', ''), // Return ID for carousel tracking
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
