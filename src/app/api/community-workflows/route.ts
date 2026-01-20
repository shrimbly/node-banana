import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { CommunityWorkflowMeta } from "@/types/quickstart";
import {
  getCommunityWorkflowConfig,
  getDefaultCommunityConfig,
} from "@/lib/quickstart/communityWorkflows";

/**
 * GET: List all community workflows from the examples directory
 */
export async function GET() {
  try {
    const examplesDir = path.join(process.cwd(), "examples");

    // Check if examples directory exists
    try {
      await fs.access(examplesDir);
    } catch {
      return NextResponse.json({
        success: true,
        workflows: [],
      });
    }

    // Read directory contents
    const files = await fs.readdir(examplesDir);

    // Filter for JSON files (exclude directories like sample-images)
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    // Get metadata for each workflow
    const workflows: CommunityWorkflowMeta[] = await Promise.all(
      jsonFiles.map(async (filename) => {
        const filePath = path.join(examplesDir, filename);
        const stats = await fs.stat(filePath);
        const id = filename.replace(/\.json$/, "");

        // Get config or generate default
        const config = getCommunityWorkflowConfig(id) ?? getDefaultCommunityConfig(id, filename);

        // Parse workflow to get node count
        let nodeCount = 0;
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const workflow = JSON.parse(content);
          nodeCount = workflow.nodes?.length ?? 0;
        } catch {
          // If parsing fails, default to 0
        }

        return {
          id,
          name: config.name,
          filename,
          author: config.author,
          size: stats.size,
          description: config.description,
          nodeCount,
          tags: config.tags,
          previewImage: config.previewImage,
          hoverImage: config.hoverImage,
          sortOrder: config.sortOrder,
        };
      })
    );

    // Sort by sortOrder (ascending)
    workflows.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

    return NextResponse.json({
      success: true,
      workflows,
    });
  } catch (error) {
    console.error("Error listing community workflows:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to list community workflows",
      },
      { status: 500 }
    );
  }
}
