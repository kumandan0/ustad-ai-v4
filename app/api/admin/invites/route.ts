import { NextRequest, NextResponse } from "next/server";
import {
  AuthError,
  createInvite,
  listInvitesForAdmin,
  revokeInvite,
} from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const invites = await listInvitesForAdmin(request);
    return NextResponse.json({ invites });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Davetler yüklenemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      email?: string;
      expiresInDays?: number;
    };

    const invite = await createInvite(request, {
      email: body.email,
      expiresInDays: body.expiresInDays,
    });

    return NextResponse.json({ invite });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Davet oluşturulamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { inviteId?: number };
    await revokeInvite(request, Number(body.inviteId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Davet iptal edilemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
