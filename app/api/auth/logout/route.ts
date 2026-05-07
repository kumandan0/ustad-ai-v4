import { NextRequest, NextResponse } from "next/server";
import {
  AuthError,
  logoutCurrentUser,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const session = await logoutCurrentUser(request);
    const response = NextResponse.json({ ok: true });
    return session.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Çıkış yapılamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
