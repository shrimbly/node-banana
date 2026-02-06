import { NextResponse } from "next/server";
import { getOAuthStatus, getOAuthTokens } from "@/lib/auth/openaiAuthStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getOAuthStatus();
  const tokens = await getOAuthTokens();

  return NextResponse.json({
    ...status,
    accountId: tokens?.accountId,
  });
}
