import { NextRequest, NextResponse } from "next/server";
import { AuthError, deleteUserByAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { userId?: string };
    await deleteUserByAdmin(request, body.userId ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Kullanıcı silinemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
