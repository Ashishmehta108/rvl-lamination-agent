import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:7000";
const API_TOKEN = "dev-local-token";
//  "rvl-prod-secure-token-7a2b9f";

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await context.params;
  return handleRequest(req, resolvedParams.path ?? []);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await context.params;
  return handleRequest(req, resolvedParams.path ?? []);
}

async function handleRequest(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join("/");
  const searchParams = req.nextUrl.searchParams.toString();
  const url = `${BACKEND_URL}/${path}${searchParams ? `?${searchParams}` : ""}`;

  const jwtToken = req.cookies.get("rvl_token")?.value;
  const clientAuth = req.headers.get("Authorization");

  const headers = new Headers(req.headers);
  if (path.startsWith("chat") || path.startsWith("auth/")) {
    if (clientAuth) {
      headers.set("Authorization", clientAuth);
    } else if (jwtToken) {
      headers.set("Authorization", `Bearer ${jwtToken}`);
    }
  } else {
    headers.set("Authorization", `Bearer ${API_TOKEN}`);
  }

  // Remove host header to avoid SSL/Routing issues
  headers.delete("host");

  // Bypass ngrok browser warning page
  headers.set("ngrok-skip-browser-warning", "true");

  try {
    const options: RequestInit = {
      method: req.method,
      headers,
      cache: "no-store",
      // @ts-ignore - duplex is needed for streaming bodies in some versions
      duplex: 'half'
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      options.body = req.body;
    }

    const response = await fetch(url, options);
    const data = await response.blob();

    return new NextResponse(data, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0"
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
