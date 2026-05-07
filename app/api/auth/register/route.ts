import { NextRequest, NextResponse } from "next/server";
import {
  AuthError,
  registerUser,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
      inviteCode?: string;
    };

    const session = await registerUser(request, {
      name: body.name ?? "",
      email: body.email ?? "",
      password: body.password ?? "",
      inviteCode: body.inviteCode ?? "",
    });

    const response = NextResponse.json({ user: session.user });
    return session.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Kayıt sırasında bir hata oluştu.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
