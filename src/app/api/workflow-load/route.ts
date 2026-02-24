import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";

// POST: Load workflow JSON from disk by path
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { directoryPath, filename } = body;

    if (!directoryPath || !filename) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: directoryPath and filename" },
        { status: 400 }
      );
    }

    // Same sanitization as the save route
    const safeName = filename.replace(/[^a-zA-Z0-9-_]/g, "_");
    const filePath = path.join(directoryPath, `${safeName}.json`);

    // Prevent path traversal
    const resolvedDir = path.resolve(directoryPath);
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedDir)) {
      return NextResponse.json(
        { success: false, error: "Invalid file path" },
        { status: 400 }
      );
    }

    const content = await fs.readFile(resolvedFile, "utf-8");
    const workflow = JSON.parse(content);

    return NextResponse.json({ success: true, workflow });
  } catch (error) {
    const isNotFound =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";

    return NextResponse.json(
      {
        success: false,
        error: isNotFound
          ? "Workflow file not found"
          : error instanceof Error
          ? error.message
          : "Failed to load workflow",
      },
      { status: isNotFound ? 404 : 500 }
    );
  }
}
