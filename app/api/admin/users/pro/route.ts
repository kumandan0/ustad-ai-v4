import { NextRequest, NextResponse } from "next/server";
import { AuthError, updateUserAutomationAccess } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      userId?: string;
      enabled?: boolean;
    };

    await updateUserAutomationAccess(request, body.userId ?? "", Boolean(body.enabled));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Pro erişim güncellenemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
