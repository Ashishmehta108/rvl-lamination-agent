import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:7000";
const API_TOKEN = process.env.API_AUTH_TOKEN || "dev-local-token";

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  const resolvedParams = await params;
  return handleRequest(req, resolvedParams.path);
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  const resolvedParams = await params;
  return handleRequest(req, resolvedParams.path);
}

async function handleRequest(req: NextRequest, pathSegments: string[]) {
  const path = pathSegments.join("/");
  const searchParams = req.nextUrl.searchParams.toString();
  const url = `${BACKEND_URL}/${path}${searchParams ? `?${searchParams}` : ""}`;

  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${API_TOKEN}`);
  // Remove host header to avoid SSL/Routing issues
  headers.delete("host");

  try {
    const options: RequestInit = {
      method: req.method,
      headers,
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
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
