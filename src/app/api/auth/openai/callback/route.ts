import { NextResponse } from "next/server";
import { exchangeAuthorizationCode, decodeJwtPayload } from "@/lib/auth/openaiOAuth";
import {
  buildTokenPayload,
  clearOAuthHandshake,
  getOAuthHandshake,
  setOAuthTokens,
} from "@/lib/auth/openaiAuthStore";

export const dynamic = "force-dynamic";

const renderHtml = (message: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenAI Auth</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0f0f0f; color: #e5e5e5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { background: #1a1a1a; padding: 24px 28px; border-radius: 12px; border: 1px solid #2b2b2b; text-align: center; max-width: 420px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 14px; margin: 0; color: #a3a3a3; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${message}</h1>
      <p>You can close this window and return to the app.</p>
    </div>
  </body>
</html>`;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new NextResponse(renderHtml("Missing authorization details"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  const handshake = await getOAuthHandshake();
  if (!handshake || handshake.state !== state) {
    return new NextResponse(renderHtml("Authorization validation failed"), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    const redirectUri = process.env.OPENAI_OAUTH_REDIRECT_URI || `${url.origin}/api/auth/openai/callback`;
    const tokenResponse = await exchangeAuthorizationCode({
      code,
      codeVerifier: handshake.codeVerifier,
      redirectUri,
      clientId: process.env.OPENAI_OAUTH_CLIENT_ID,
    });

    const tokens = buildTokenPayload(tokenResponse);
    const payload = tokenResponse.id_token ? decodeJwtPayload(tokenResponse.id_token) : null;
    const accountId = payload?.account_id || payload?.sub;

    await setOAuthTokens({
      ...tokens,
      accountId: typeof accountId === "string" ? accountId : undefined,
    });
    await clearOAuthHandshake();

    return new NextResponse(renderHtml("OpenAI connected"), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    await clearOAuthHandshake();
    const message = error instanceof Error ? error.message : "Authorization failed";
    return new NextResponse(renderHtml(message), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}
