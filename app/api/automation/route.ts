import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import {
  generateAutomationArtifact,
  type AutomationKind,
} from "@/lib/server/automation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const body = (await request.json()) as {
      kind?: AutomationKind;
      courseId?: number;
      weekIndex?: number;
    };

    if (!body.kind || !Number.isInteger(body.courseId) || !Number.isInteger(body.weekIndex)) {
      return NextResponse.json({ error: "Eksik otomasyon bilgisi." }, { status: 400 });
    }

    const data = await generateAutomationArtifact({
      kind: body.kind,
      courseId: Number(body.courseId),
      weekIndex: Number(body.weekIndex),
      userId: auth.user.id,
      client: auth.supabase,
    });

    const response = NextResponse.json({ data });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error
        ? error.message
        : "Otomatik içerik üretimi sırasında beklenmeyen bir hata oluştu.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
