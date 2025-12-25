
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { path } = body;

        if (!path) {
            return NextResponse.json(
                { success: false, error: "Path is required" },
                { status: 400 }
            );
        }

        let command = "";
        let args: string[] = [];
        const platform = os.platform();

        switch (platform) {
            case "darwin":
                command = "open";
                args = [path];
                break;
            case "win32":
                command = "explorer";
                args = [path];
                break;
            case "linux":
                command = "xdg-open";
                args = [path];
                break;
            default:
                // Fallback for other Unix-like systems
                command = "xdg-open";
                args = [path];
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
