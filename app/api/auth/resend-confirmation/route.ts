import { NextRequest, NextResponse } from "next/server";
import { AuthError, resendConfirmationEmail } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      email?: string;
    };

    const result = await resendConfirmationEmail(request, {
      email: body.email ?? "",
    });

    return NextResponse.json({ ok: true, email: result.email });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Doğrulama e-postası yeniden gönderilemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
