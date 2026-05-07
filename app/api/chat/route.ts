import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { createChatReply } from "@/lib/server/chat";

export const runtime = "nodejs";

type Message = {
  role?: string;
  content?: string;
};

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const body = (await request.json()) as {
      messages?: Message[];
      systemPrompt?: string;
      mode?: "general" | "materials";
      courseId?: number | null;
    };

    const content = await createChatReply({
      messages: body.messages ?? [],
      systemPrompt: body.systemPrompt ?? "",
      mode: body.mode ?? "general",
      courseId: body.courseId ?? null,
      scope: { userId: auth.user.id, role: auth.user.role },
      client: auth.supabase,
    });

    const response = NextResponse.json({ content });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ content: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Sohbet sırasında beklenmeyen bir hata oluştu.";
    return NextResponse.json({ content: message }, { status: 500 });
  }
}
