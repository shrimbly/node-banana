import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { buildProposalPrompt } from "@/lib/quickstart/proposalPrompt";
import { parseJSONFromResponse } from "@/lib/quickstart/validation";
import type { WorkflowProposal, WorkflowComplexity, NodeType } from "@/types";
import { ASSISTANT_MODEL } from "@/lib/llm/catalog";

export const maxDuration = 60; // 1 minute timeout

interface ProposeRequest {
  description: string;
}

interface ProposeResponse {
  success: boolean;
  proposal?: WorkflowProposal;
  error?: string;
}

/**
 * Validate that a parsed response matches the WorkflowProposal structure
 * Returns validation errors or null if valid
 */
function validateProposalShape(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return "Response must be an object";
  }

  const proposal = data as Record<string, unknown>;

  // Required string fields
  if (!proposal.name || typeof proposal.name !== "string") {
    return "Proposal must have a name (string)";
  }
  if (!proposal.description || typeof proposal.description !== "string") {
    return "Proposal must have a description (string)";
  }

  // Validate nodes array
  if (!Array.isArray(proposal.nodes)) {
    return "Proposal must have a nodes array";
  }

  const validNodeTypes: NodeType[] = [
    "imageInput",
    "annotation",
    "prompt",
    "nanoBanana",
    "generateVideo",
    "llmGenerate",
    "splitGrid",
    "output",
  ];

  for (let i = 0; i < proposal.nodes.length; i++) {
    const node = proposal.nodes[i] as Record<string, unknown>;
    if (!node || typeof node !== "object") {
      return `nodes[${i}] must be an object`;
    }
    if (!node.id || typeof node.id !== "string") {
      return `nodes[${i}] must have an id (string)`;
    }
    if (!node.type || !validNodeTypes.includes(node.type as NodeType)) {
      return `nodes[${i}] must have a valid type (${validNodeTypes.join(", ")})`;
    }
    if (!node.purpose || typeof node.purpose !== "string") {
      return `nodes[${i}] must have a purpose (string)`;
    }
    if (!node.suggestedTitle || typeof node.suggestedTitle !== "string") {
      return `nodes[${i}] must have a suggestedTitle (string)`;
    }
  }

  // Validate connections array
  if (!Array.isArray(proposal.connections)) {
    return "Proposal must have a connections array";
  }

  const validConnectionTypes = ["image", "text", "reference"];
  const nodeIds = new Set(
    (proposal.nodes as Array<{ id: string }>).map((n) => n.id)
  );

  for (let i = 0; i < proposal.connections.length; i++) {
    const conn = proposal.connections[i] as Record<string, unknown>;
    if (!conn || typeof conn !== "object") {
      return `connections[${i}] must be an object`;
    }
    if (!conn.from || typeof conn.from !== "string") {
      return `connections[${i}] must have a 'from' (string)`;
    }
    if (!conn.to || typeof conn.to !== "string") {
      return `connections[${i}] must have a 'to' (string)`;
    }
    if (!conn.type || !validConnectionTypes.includes(conn.type as string)) {
      return `connections[${i}] must have a valid type (image, text, reference)`;
    }
    if (!conn.description || typeof conn.description !== "string") {
      return `connections[${i}] must have a description (string)`;
    }
    // Validate node references
    if (!nodeIds.has(conn.from as string)) {
      return `connections[${i}].from references unknown node: ${conn.from}`;
    }
    if (!nodeIds.has(conn.to as string)) {
      return `connections[${i}].to references unknown node: ${conn.to}`;
    }
  }

  // Validate optional groups array
  if (proposal.groups !== undefined) {
    if (!Array.isArray(proposal.groups)) {
      return "groups must be an array if provided";
    }
    const validColors = ["neutral", "blue", "green", "purple", "orange"];
    for (let i = 0; i < proposal.groups.length; i++) {
      const group = proposal.groups[i] as Record<string, unknown>;
      if (!group || typeof group !== "object") {
        return `groups[${i}] must be an object`;
      }
      if (!group.name || typeof group.name !== "string") {
        return `groups[${i}] must have a name (string)`;
      }
      if (!group.color || !validColors.includes(group.color as string)) {
        return `groups[${i}] must have a valid color (${validColors.join(", ")})`;
      }
      if (!Array.isArray(group.nodeIds)) {
        return `groups[${i}] must have a nodeIds array`;
      }
      if (!group.purpose || typeof group.purpose !== "string") {
        return `groups[${i}] must have a purpose (string)`;
      }
    }
  }

  // Validate estimatedComplexity
  const validComplexities: WorkflowComplexity[] = [
    "simple",
    "moderate",
    "complex",
  ];
  if (
    !proposal.estimatedComplexity ||
    !validComplexities.includes(proposal.estimatedComplexity as WorkflowComplexity)
  ) {
    return `estimatedComplexity must be one of: ${validComplexities.join(", ")}`;
  }

  // Validate optional warnings
  if (proposal.warnings !== undefined) {
    if (!Array.isArray(proposal.warnings)) {
      return "warnings must be an array if provided";
    }
    for (let i = 0; i < proposal.warnings.length; i++) {
      if (typeof proposal.warnings[i] !== "string") {
        return `warnings[${i}] must be a string`;
      }
    }
  }

  return null; // Valid
}

export async function POST(request: NextRequest) {
  const requestId = `prop-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  console.log(`[Propose:${requestId}] New request received`);

  try {
    const body: ProposeRequest = await request.json();
    const { description } = body;

    console.log(`[Propose:${requestId}] Parameters:`, {
      hasDescription: !!description,
      descriptionLength: description?.length || 0,
    });

    // Validate description (same as existing endpoint)
    if (
      !description ||
      typeof description !== "string" ||
      description.trim().length < 3
    ) {
      console.warn(`[Propose:${requestId}] Invalid description`);
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error:
            "Please provide a description of your workflow (at least 3 characters)",
        },
        { status: 400 }
      );
    }

    // Check API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(`[Propose:${requestId}] No GEMINI_API_KEY configured`);
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error: "API key not configured. Add GEMINI_API_KEY to .env.local",
        },
        { status: 500 }
      );
    }

    // Build the proposal prompt
    const prompt = buildProposalPrompt(description.trim());
    console.log(`[Propose:${requestId}] Prompt built, length: ${prompt.length}`);

    // Call Gemini API
    console.log(`[Propose:${requestId}] Calling Gemini API...`);
    const ai = new GoogleGenAI({ apiKey });
    const startTime = Date.now();

    const response = await ai.models.generateContent({
      model: ASSISTANT_MODEL,
      contents: prompt,
      config: {
        temperature: 0.3, // Lower for more consistent JSON output
        maxOutputTokens: 8192,
      },
    });

    const duration = Date.now() - startTime;
    console.log(`[Propose:${requestId}] Gemini API response in ${duration}ms`);

    // Extract text from response
    const responseText = response.text;
    if (!responseText) {
      console.error(`[Propose:${requestId}] No text in Gemini response`);
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error: "No response from AI model",
        },
        { status: 500 }
      );
    }

    console.log(
      `[Propose:${requestId}] Response text length: ${responseText.length}`
    );

    // Parse JSON from response
    let parsedProposal: unknown;
    try {
      parsedProposal = parseJSONFromResponse(responseText);
      console.log(`[Propose:${requestId}] JSON parsed successfully`);
    } catch (error) {
      console.error(`[Propose:${requestId}] JSON parse error:`, error);
      console.error(
        `[Propose:${requestId}] Response text:`,
        responseText.substring(0, 500)
      );
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error: "Failed to parse proposal from AI response. Please try again.",
        },
        { status: 500 }
      );
    }

    // Validate the proposal shape
    const validationError = validateProposalShape(parsedProposal);
    if (validationError) {
      console.error(
        `[Propose:${requestId}] Validation error: ${validationError}`
      );
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error: `Invalid proposal structure: ${validationError}. Please try again.`,
        },
        { status: 500 }
      );
    }

    const proposal = parsedProposal as WorkflowProposal;

    console.log(
      `[Propose:${requestId}] Success - nodes: ${proposal.nodes.length}, connections: ${proposal.connections.length}`
    );

    return NextResponse.json<ProposeResponse>({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error(`[Propose:${requestId}] Unexpected error:`, error);

    // Handle rate limiting
    if (error instanceof Error && error.message.includes("429")) {
      return NextResponse.json<ProposeResponse>(
        {
          success: false,
          error: "Rate limit reached. Please wait a moment and try again.",
        },
        { status: 429 }
      );
    }

    return NextResponse.json<ProposeResponse>(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to generate proposal",
      },
      { status: 500 }
    );
  }
}
