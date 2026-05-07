import { NextRequest, NextResponse } from "next/server";
import {
  AuthError,
  loginUser,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };

    const session = await loginUser(request, {
      email: body.email ?? "",
      password: body.password ?? "",
    });

    const response = NextResponse.json({ user: session.user });
    return session.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Giriş sırasında bir hata oluştu.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
