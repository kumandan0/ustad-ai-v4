import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const response = NextResponse.json({ user: auth.user });
    return auth.applyCookies(response);
  } catch (error) {
    return NextResponse.json({ user: null });
  }
}
