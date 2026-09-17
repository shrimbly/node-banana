import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import path from "path";
import os from "os";
import { isLocalhostRequest } from "@/utils/localhostRequest";

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
    // This opens a directory in the *server's* file manager, so it carries the
    // same guard its sibling open-file route already has.
    if (!isLocalhostRequest(req)) {
        return NextResponse.json(
            { success: false, error: "Forbidden: localhost only" },
            { status: 403 }
        );
    }

    try {
        const body = await req.json();
        const { path: inputPath } = body;

        if (!inputPath || typeof inputPath !== "string") {
            return NextResponse.json(
                { success: false, error: "Path is required" },
                { status: 400 }
            );
        }

        // Normalize and resolve the path to prevent traversal attacks
        const normalizedPath = path.resolve(inputPath);

        // Restrict to user's home directory, as open-file does
        const homeDir = os.homedir();
        if (!normalizedPath.startsWith(homeDir + path.sep) && normalizedPath !== homeDir) {
            return NextResponse.json(
                { success: false, error: "Path is outside allowed directory" },
                { status: 403 }
            );
        }

        // Validate that the path exists and is a directory
        try {
            const stats = await stat(normalizedPath);
            if (!stats.isDirectory()) {
                return NextResponse.json(
                    { success: false, error: "Path is not a directory" },
                    { status: 400 }
                );
            }
        } catch {
            return NextResponse.json(
                { success: false, error: "Directory does not exist" },
                { status: 400 }
            );
        }

        let command = "";
        let args: string[] = [];
        const platform = os.platform();

        switch (platform) {
            case "darwin":
                command = "open";
                args = [normalizedPath];
                break;
            case "win32":
                command = "explorer";
                args = [normalizedPath];
                break;
            case "linux":
                command = "xdg-open";
                args = [normalizedPath];
                break;
            default:
                // Fallback for other Unix-like systems
                command = "xdg-open";
                args = [normalizedPath];
        }

        await execFileAsync(command, args);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to open directory:", error);
        return NextResponse.json(
            { success: false, error: "Failed to open directory" },
            { status: 500 }
        );
    }
}
