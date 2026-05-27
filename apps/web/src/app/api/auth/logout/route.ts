import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const isSecure = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const response = NextResponse.json({ ok: true });
  response.cookies.set("rvl_token", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}
