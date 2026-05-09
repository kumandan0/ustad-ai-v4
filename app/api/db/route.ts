import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const body = await request.json();
    const data = await queryTable({
      ...body,
      client: auth.supabase,
      scope: {
        userId: auth.user.id,
        role: auth.user.role,
      },
    });
    const response = NextResponse.json({ data });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Bir hata olustu.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
