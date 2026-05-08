import { NextRequest, NextResponse } from "next/server";
import { AuthError, bootstrapUserWorkspace } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const session = await bootstrapUserWorkspace(request);
    const response = NextResponse.json({ user: session.user, ok: true });
    return session.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Çalışma alanı hazırlanamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
