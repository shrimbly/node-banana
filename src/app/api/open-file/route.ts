import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import path from "path";
import os from "os";
import { isLocalhostRequest } from "@/utils/localhostRequest";

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
    // Only allow requests from localhost
    if (!isLocalhostRequest(req)) {
        return NextResponse.json(
            { success: false, error: "Forbidden: localhost only" },
            { status: 403 }
        );
    }

    try {
        const body = await req.json();
        const { filePath: inputPath } = body;

        if (!inputPath || typeof inputPath !== "string") {
            return NextResponse.json(
                { success: false, error: "File path is required" },
                { status: 400 }
            );
        }

        // Normalize and resolve the path to prevent traversal attacks
        const normalizedPath = path.resolve(inputPath);

        // Restrict to user's home directory
        const homeDir = os.homedir();
        if (!normalizedPath.startsWith(homeDir + path.sep) && normalizedPath !== homeDir) {
            return NextResponse.json(
                { success: false, error: "Path is outside allowed directory" },
                { status: 403 }
            );
        }

        // Validate that the path exists and is a file
        try {
            const stats = await stat(normalizedPath);
            if (!stats.isFile()) {
                return NextResponse.json(
                    { success: false, error: "Path is not a file" },
                    { status: 400 }
                );
            }
        } catch {
            return NextResponse.json(
                { success: false, error: "File does not exist" },
                { status: 400 }
            );
        }

        const platform = os.platform();
        let command = "";
        let args: string[] = [];

        switch (platform) {
            case "darwin":
                command = "open";
                args = ["-R", normalizedPath];
                break;
            case "win32":
                command = "explorer";
                args = [`/select,"${normalizedPath}"`];
                break;
            case "linux":
                // Linux has no universal "reveal in folder" — open parent directory
                command = "xdg-open";
                args = [path.dirname(normalizedPath)];
                break;
            default:
                command = "xdg-open";
                args = [path.dirname(normalizedPath)];
        }

        try {
            await execFileAsync(command, args);
        } catch (err: unknown) {
            // Windows explorer returns non-zero exit code even on success
            if (platform === "win32" && err && typeof err === "object" && "code" in err) {
                // Explorer launched successfully despite non-zero exit
            } else {
                throw err;
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to reveal file:", error);
        return NextResponse.json(
            { success: false, error: "Failed to open file location" },
            { status: 500 }
        );
    }
}
