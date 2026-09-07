import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const maxDuration = 300; // 5 minute timeout for large workflow files

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

    // Validate path to prevent traversal attacks
    const pathValidation = validateWorkflowPath(directoryPath);
    if (!pathValidation.valid) {
      logger.warn('file.error', 'Workflow save failed: invalid path', {
        directoryPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Ensure project directory exists (supports saving into new subfolders)
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
      const err = dirError as NodeJS.ErrnoException;
      const isNotFound =
        err?.code === "ENOENT" ||
        (typeof err?.message === "string" &&
          (err.message.includes("ENOENT") || err.message.includes("no such file or directory")));

      if (!isNotFound) {
        logger.warn('file.error', 'Workflow save failed: directory validation error', {
          directoryPath,
          error: dirError instanceof Error ? dirError.message : 'Unknown error',
        });
        return NextResponse.json(
          { success: false, error: "Directory validation failed" },
          { status: 400 }
        );
      }

      try {
        await fs.mkdir(directoryPath, { recursive: true });
      } catch (mkdirError) {
        logger.warn('file.error', 'Workflow save failed: could not create directory', {
          directoryPath,
          error: mkdirError instanceof Error ? mkdirError.message : 'Unknown error',
        });
        return NextResponse.json(
          { success: false, error: "Could not create directory" },
          { status: 500 }
        );
      }
    }

    // Auto-create subfolders for inputs and generations
    const inputsFolder = path.join(directoryPath, "inputs");
    const generationsFolder = path.join(directoryPath, "generations");

    try {
      await fs.mkdir(inputsFolder, { recursive: true });
      await fs.mkdir(generationsFolder, { recursive: true });
    } catch (mkdirError) {
      logger.warn('file.save', 'Failed to create subfolders (non-fatal)', {
        inputsFolder,
        generationsFolder,
        error: mkdirError instanceof Error ? mkdirError.message : 'Unknown error',
      });
      // Continue anyway - folders may already exist or be created later
    }

    // Sanitize filename (remove special chars, ensure .json extension)
    const safeName = filename.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filePath = path.join(directoryPath, `${safeName}.json`);

    // Finish writing beside the destination before replacing the last good
    // save. A direct write truncates that save even if the disk fills midway.
    const json = JSON.stringify(workflow, null, 2);
    const temporaryPath = path.join(directoryPath, `.workflow-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, json, { encoding: "utf-8", flag: "wx" });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

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

// GET: Validate directory path, or load workflow from directory
export async function GET(request: NextRequest) {
  const directoryPath = request.nextUrl.searchParams.get("path");
  const shouldLoad = request.nextUrl.searchParams.get("load") === "true";

  logger.info('file.load', 'Directory request received', {
    directoryPath,
    shouldLoad,
  });

  if (!directoryPath) {
    logger.warn('file.load', 'Directory validation failed: missing path parameter');
    return NextResponse.json(
      { success: false, error: "Path parameter required" },
      { status: 400 }
    );
  }

  // Validate path to prevent traversal attacks
  const pathValidation = validateWorkflowPath(directoryPath);
  if (!pathValidation.valid) {
    logger.warn('file.error', 'Directory validation failed: invalid path', {
      directoryPath,
      error: pathValidation.error,
    });
    return NextResponse.json(
      { success: false, error: pathValidation.error },
      { status: 400 }
    );
  }

  try {
    const stats = await fs.stat(directoryPath);
    const isDirectory = stats.isDirectory();

    if (!isDirectory) {
      return NextResponse.json({
        success: true,
        exists: true,
        isDirectory: false,
      });
    }

    // If load=true, find and return a workflow JSON from the directory
    if (shouldLoad) {
      const entries = await fs.readdir(directoryPath);
      const jsonFiles = entries.filter(f => f.endsWith(".json"));

      // Gather candidates with mtime for deterministic selection (newest first)
      const candidates: { jsonFile: string; filePath: string; mtime: number }[] = [];
      for (const jsonFile of jsonFiles) {
        try {
          const filePath = path.join(directoryPath, jsonFile);
          const stat = await fs.stat(filePath);
          candidates.push({ jsonFile, filePath, mtime: stat.mtimeMs });
        } catch {
          continue;
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime);

      for (const { jsonFile, filePath } of candidates) {
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const parsed = JSON.parse(content);

          if (
            typeof parsed.version === "number" &&
            Array.isArray(parsed.nodes) &&
            Array.isArray(parsed.edges)
          ) {
            const filename = path.basename(jsonFile, ".json");
            logger.info('file.load', 'Workflow loaded from directory', {
              directoryPath,
              filename: jsonFile,
            });
            return NextResponse.json({
              success: true,
              workflow: parsed,
              filename,
            });
          }
        } catch {
          // Skip files that can't be read or parsed
          continue;
        }
      }

      logger.warn('file.load', 'No valid workflow file found in directory', {
        directoryPath,
        jsonFilesChecked: jsonFiles.length,
      });
      return NextResponse.json(
        { success: false, error: "No workflow file found in directory" },
        { status: 404 }
      );
    }

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
