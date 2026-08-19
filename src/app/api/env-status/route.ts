import { NextResponse } from "next/server";

export interface EnvStatusResponse {
  gemini: boolean;
  openai: boolean;
  anthropic: boolean;
  replicate: boolean;
  fal: boolean;
  kie: boolean;
  wavespeed: boolean;
  orcarouter: boolean;
}

export async function GET() {
  // Check which API keys are configured via environment variables
  const status: EnvStatusResponse = {
    gemini: !!process.env.GEMINI_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    replicate: !!process.env.REPLICATE_API_KEY,
    fal: !!process.env.FAL_API_KEY,
    kie: !!process.env.KIE_API_KEY,
    wavespeed: !!process.env.WAVESPEED_API_KEY,
    orcarouter: !!process.env.ORCAROUTER_API_KEY,
  };

  return NextResponse.json(status);
}
