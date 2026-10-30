
import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";

const CLIENT_ID = process.env.DERIV_CLIENT_ID;

const REDIRECT_URI =
  "https://hope-ai-deriv-analyzer-pro.vercel.app/api/deriv/callback";

function base64url(value: Buffer) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function GET() {
  if (!CLIENT_ID) {
    return new NextResponse(
      "DERIV_CLIENT_ID is not configured in Vercel.",
      { status: 500 }
    );
  }

  const verifier = base64url(randomBytes(32));

  const challenge = base64url(
    createHash("sha256").update(verifier).digest()
  );

  const state = randomBytes(32).toString("hex");

  const authUrl = new URL("https://auth.deriv.com/oauth2/auth");

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "trade");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authUrl);

  response.cookies.set("deriv_pkce_verifier", verifier, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  response.cookies.set("deriv_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return response;
}
