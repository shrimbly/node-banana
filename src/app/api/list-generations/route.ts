import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { validateWorkflowPath } from "@/utils/pathValidation";

/** The media /api/load-generation can serve, so the two routes agree on what counts. */
const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "mp3", "wav", "ogg", "flac", "aac"]);

/**
 * The generation ids present in a folder: every supported media file, by its
 * name without the extension. A node's carousel keeps only the entries this
 * lists. A folder that does not exist lists nothing, since nothing in it can
 * be loaded; any other failure is reported so the caller keeps its history.
 */
export async function GET(request: NextRequest) {
  const directoryPath = request.nextUrl.searchParams.get("path");
  if (!directoryPath) {
    return NextResponse.json({ success: false, error: "Path parameter required" }, { status: 400 });
  }
  const validation = validateWorkflowPath(directoryPath);
  if (!validation.valid) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  let entries: string[];
  try {
    entries = await fs.readdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ success: true, ids: [] });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Could not read the folder" },
      { status: 500 }
    );
  }

  const ids = entries
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase()))
    .map((name) => name.slice(0, -path.extname(name).length));
  return NextResponse.json({ success: true, ids });
}
