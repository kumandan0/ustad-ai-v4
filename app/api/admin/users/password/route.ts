import { NextRequest, NextResponse } from "next/server";
import { AuthError, updateUserPassword } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      userId?: string;
      newPassword?: string;
    };

    await updateUserPassword(request, body.userId ?? "", body.newPassword ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Şifre sıfırlanamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
