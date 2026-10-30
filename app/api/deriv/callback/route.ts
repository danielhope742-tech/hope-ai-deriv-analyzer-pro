
import { NextRequest, NextResponse } from "next/server";

const CLIENT_ID = process.env.DERIV_CLIENT_ID!;
const REDIRECT_URI =
  "https://hope-ai-deriv-analyzer-pro.vercel.app/api/deriv/callback";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL("/?deriv_error=login_cancelled", url.origin)
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  const savedState = request.cookies.get("deriv_oauth_state")?.value;
  const verifier = request.cookies.get("deriv_pkce_verifier")?.value;

  if (!CLIENT_ID || !code || !returnedState || !savedState || !verifier) {
    return new NextResponse(
      "OAuth information is incomplete. Please start Connect Deriv again.",
      { status: 400 }
    );
  }

  if (returnedState !== savedState) {
    return new NextResponse("OAuth state verification failed.", {
      status: 403,
    });
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });

    const response = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        cache: "no-store",
      }
    );

    const tokens = await response.json();

    if (!response.ok || !tokens.access_token) {
      console.error("Deriv OAuth exchange failed:", response.status);
      return new NextResponse(
        "Deriv authorization failed. Please try Connect Deriv again.",
        { status: 502 }
      );
    }

    const result = NextResponse.redirect(
      new URL("/?deriv_connected=1", url.origin)
    );

    result.cookies.set("deriv_access_token", tokens.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Number(tokens.expires_in) || 3600,
    });

    result.cookies.delete("deriv_oauth_state");
    result.cookies.delete("deriv_pkce_verifier");

    return result;
  } catch {
    return new NextResponse(
      "Could not contact Deriv. Please try again.",
      { status: 502 }
    );
  }
}
