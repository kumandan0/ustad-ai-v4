import { NextRequest, NextResponse } from "next/server";
import { AuthError, requestPasswordRecovery } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      email?: string;
    };

    const result = await requestPasswordRecovery(request, {
      email: body.email ?? "",
    });

    return NextResponse.json({ ok: true, email: result.email });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Şifre yenileme e-postası gönderilemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
