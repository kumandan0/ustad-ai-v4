import { NextRequest, NextResponse } from "next/server";
import { AuthError, completePasswordRecovery } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      newPassword?: string;
    };

    const result = await completePasswordRecovery(request, body.newPassword ?? "");
    const response = NextResponse.json({ ok: true });
    return result.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Şifre yenilenemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
