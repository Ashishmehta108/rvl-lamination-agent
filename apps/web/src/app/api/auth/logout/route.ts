import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("rvl_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}
