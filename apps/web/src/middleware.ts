import { NextRequest, NextResponse } from "next/server";
import { decodeJwt } from "jose";
/** Routes that are always public (no auth check). */
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/_next", "/favicon.ico"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get("rvl_token")?.value;

  if (!token) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  try {
    const payload = decodeJwt(token);
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      throw new Error("Token expired");
    }
    const { userId, tenantId, role } = payload as {
      userId: string;
      tenantId: string;
      role: string;
    };

    // For /api/proxy/* requests, inject user identity headers so the backend can trust them
    const res = NextResponse.next();
    if (pathname.startsWith("/api/proxy")) {
      res.headers.set("x-user-id", userId ?? "");
      res.headers.set("x-tenant-id", tenantId ?? "");
      res.headers.set("x-role", role ?? "");
    }

    return res;
  } catch (err: any) {
    console.error("Middleware JWT verification failed:", err?.message || err, "Token is:", token);
    // Token invalid or expired — redirect to login
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    const response = NextResponse.redirect(loginUrl);
    // Clear the bad cookie
    response.cookies.set("rvl_token", "", { maxAge: 0, path: "/" });
    return response;
  }
}

export const config = {
  // Apply middleware to all routes except Next.js internals and static files
  matcher: ["/((?!_next/static|_next/image|images|icons|favicon\\.ico).*)"]
};
