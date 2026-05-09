import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";
import { buildMaterialFileUrl, MATERIAL_STORAGE_BUCKET } from "@/lib/storage/shared";

export const runtime = "nodejs";

type CourseRow = {
  id: number;
  user_id: string;
};

async function ensureUserCanAccessCourse(
  client: Parameters<typeof queryTable>[0]["client"],
  scope: NonNullable<Parameters<typeof queryTable>[0]["scope"]>,
  courseId: number,
) {
  const data = (await queryTable({
    action: "select",
    table: "courses",
    filters: [{ column: "id", value: courseId }],
    returnSingle: true,
    client,
    scope,
  })) as CourseRow | null;

  if (!data) {
    throw new AuthError("Bu derse erişim izniniz yok.", 403);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const body = (await request.json().catch(() => ({}))) as {
      bucket?: string;
      path?: string;
      courseId?: number | null;
    };

    const bucket = String(body.bucket ?? "");
    const filePath = String(body.path ?? "");
    const courseId = Number(body.courseId ?? 0);

    if (!bucket || !filePath || !courseId) {
      return NextResponse.json({ error: "Eksik yükleme bilgisi." }, { status: 400 });
    }

    if (bucket !== MATERIAL_STORAGE_BUCKET) {
      return NextResponse.json({ error: "Geçersiz dosya deposu." }, { status: 400 });
    }

    await ensureUserCanAccessCourse(
      auth.supabase,
      { userId: auth.user.id, role: auth.user.role },
      courseId,
    );

    const { data, error } = await auth.supabase.storage
      .from(bucket)
      .createSignedUploadUrl(filePath, { upsert: true });

    if (error || !data?.token) {
      throw error ?? new Error("İmzalı yükleme bağlantısı oluşturulamadı.");
    }

    const response = NextResponse.json({
      data: {
        signedUrl: data.signedUrl,
        token: data.token,
        path: data.path,
        publicUrl: buildMaterialFileUrl(bucket, data.path),
      },
    });

    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "İmzalı yükleme bağlantısı oluşturulamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
