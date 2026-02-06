import { NextResponse } from "next/server";
import { clearOAuthHandshake, clearOAuthTokens } from "@/lib/auth/openaiAuthStore";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearOAuthTokens();
  await clearOAuthHandshake();
  return NextResponse.json({ success: true });
}
