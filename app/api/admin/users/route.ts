import { NextRequest, NextResponse } from "next/server";
import { AuthError, listUsersForAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const users = await listUsersForAdmin(request);
    return NextResponse.json({ users });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Kullanıcılar yüklenemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
