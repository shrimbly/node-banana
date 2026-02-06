import { NextResponse } from "next/server";
import { buildAuthUrl, createCodeChallenge, generateRandomString } from "@/lib/auth/openaiOAuth";
import { setOAuthHandshake } from "@/lib/auth/openaiAuthStore";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/openai/callback`;

  const state = generateRandomString(24);
  const codeVerifier = generateRandomString(48);
  const codeChallenge = createCodeChallenge(codeVerifier);

  await setOAuthHandshake(state, codeVerifier);

  const authUrl = buildAuthUrl({ state, codeChallenge, redirectUri, clientId: process.env.OPENAI_OAUTH_CLIENT_ID });

  return NextResponse.json({ url: authUrl });
}
