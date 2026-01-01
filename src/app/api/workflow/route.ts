import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";

// POST: Save workflow to file
export async function POST(request: NextRequest) {
  let directoryPath: string | undefined;
  let filename: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    filename = body.filename;
    const workflow = body.workflow;

    logger.info('file.save', 'Workflow save request received', {
      directoryPath,
      filename,
      hasWorkflow: !!workflow,
      nodeCount: workflow?.nodes?.length,
      edgeCount: workflow?.edges?.length,
    });

    if (!directoryPath || !filename || !workflow) {
      logger.warn('file.save', 'Workflow save validation failed: missing fields', {
        hasDirectoryPath: !!directoryPath,
        hasFilename: !!filename,
        hasWorkflow: !!workflow,
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
        logger.warn('file.error', 'Workflow save failed: path is not a directory', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      logger.warn('file.error', 'Workflow save failed: directory does not exist', {
        directoryPath,
      });
      return NextResponse.json(
        { success: false, error: "Directory does not exist" },
        { status: 400 }
      );
    }

    // Sanitize filename (remove special chars, ensure .json extension)
    const safeName = filename.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filePath = path.join(directoryPath, `${safeName}.json`);

    // Write workflow JSON
    const json = JSON.stringify(workflow, null, 2);
    await fs.writeFile(filePath, json, "utf-8");

    logger.info('file.save', 'Workflow saved successfully', {
      filePath,
      fileSize: json.length,
    });

    return NextResponse.json({
      success: true,
      filePath,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to save workflow', {
      directoryPath,
      filename,
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

// GET: Validate directory path
export async function GET(request: NextRequest) {
  const directoryPath = request.nextUrl.searchParams.get("path");

  logger.info('file.load', 'Directory validation request received', {
    directoryPath,
  });

  if (!directoryPath) {
    logger.warn('file.load', 'Directory validation failed: missing path parameter');
    return NextResponse.json(
      { success: false, error: "Path parameter required" },
      { status: 400 }
    );
  }

  try {
    const stats = await fs.stat(directoryPath);
    const isDirectory = stats.isDirectory();
    logger.info('file.load', 'Directory validation successful', {
      directoryPath,
      exists: true,
      isDirectory,
    });
    return NextResponse.json({
      success: true,
      exists: true,
      isDirectory,
    });
  } catch (error) {
    logger.info('file.load', 'Directory does not exist', {
      directoryPath,
    });
    return NextResponse.json({
      success: true,
      exists: false,
      isDirectory: false,
    });
  }
}
