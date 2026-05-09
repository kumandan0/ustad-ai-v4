import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";
import { deleteStoredFile, readStoredFile, storeUploadedFile } from "@/lib/server/store";
import {
  buildMaterialFileUrl,
  MATERIAL_STORAGE_BUCKET,
  parseMaterialFileUrl,
  type StorageProvider,
} from "@/lib/storage/shared";

export const runtime = "nodejs";

function parseRangeHeader(rangeHeader: string | null, size: number) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return null;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= size) {
    return null;
  }

  return { start, end };
}

type MaterialAccessRow = {
  id: number;
  user_id: string;
  course_id: number;
  week_id: number | null;
  week_index: number;
  file_type: "pdf" | "audio" | "infographic";
  file_name: string;
  file_url: string;
  storage_provider: StorageProvider | null;
  storage_file_id: string | null;
  mime_type: string | null;
};

function sanitizeStorageSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

async function tryMigrateLocalMaterialToSupabase(params: {
  supabase: Parameters<typeof queryTable>[0]["client"];
  material: MaterialAccessRow;
  contentType: string;
  buffer: Buffer;
}) {
  if (params.material.storage_provider !== "local") {
    return null;
  }

  const targetPath = [
    sanitizeStorageSegment(params.material.user_id),
    String(params.material.course_id),
    String(params.material.week_id ?? `week-${params.material.week_index}`),
    params.material.file_type,
    `${params.material.id}-${sanitizeStorageSegment(params.material.file_name)}`,
  ].join("/");

  const { error: uploadError } = await params.supabase.storage
    .from(MATERIAL_STORAGE_BUCKET)
    .upload(targetPath, params.buffer, {
      upsert: true,
      contentType: params.contentType,
    });

  if (uploadError) {
    throw uploadError;
  }

  const nextFileUrl = buildMaterialFileUrl(MATERIAL_STORAGE_BUCKET, targetPath);
  const { error: updateError } = await params.supabase
    .from("materials")
    .update({
      file_url: nextFileUrl,
      mime_type: params.contentType,
      storage_provider: "supabase",
      storage_file_id: targetPath,
    })
    .eq("id", params.material.id)
    .eq("user_id", params.material.user_id);

  if (updateError) {
    throw updateError;
  }

  return {
    fileUrl: nextFileUrl,
    storageFileId: targetPath,
  };
}

async function findAuthorizedMaterialForFile(
  client: Parameters<typeof queryTable>[0]["client"],
  scope: NonNullable<Parameters<typeof queryTable>[0]["scope"]>,
  bucket: string,
  filePath: string,
) {
  const materials = (await queryTable({
    action: "select",
    table: "materials",
    client,
    scope,
  })) as MaterialAccessRow[];

  const matchedMaterial = materials.find((material) => {
    if (material.storage_provider === "supabase" && material.storage_file_id) {
      return bucket === MATERIAL_STORAGE_BUCKET && material.storage_file_id === filePath;
    }

    const location = parseMaterialFileUrl(String(material.file_url ?? ""));
    return location?.bucket === bucket && location.filePath === filePath;
  });

  if (!matchedMaterial) {
    throw new AuthError("Bu dosyaya erişim izniniz yok.", 403);
  }

  return matchedMaterial;
}

function inferCourseIdFromFilePath(filePath: string) {
  const fileName = filePath.split("/").pop() ?? "";
  const match = /^(\d+)_/.exec(fileName);
  return match ? Number(match[1]) : null;
}

async function ensureUserCanAccessCourse(
  client: Parameters<typeof queryTable>[0]["client"],
  scope: NonNullable<Parameters<typeof queryTable>[0]["scope"]>,
  courseId: number,
) {
  const data = await queryTable({
    action: "select",
    table: "courses",
    filters: [{ column: "id", value: courseId }],
    returnSingle: true,
    client,
    scope,
  });

  if (!data) {
    throw new AuthError("Bu derse erişim izniniz yok.", 403);
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket");
    const filePath = url.searchParams.get("path");
    const type = url.searchParams.get("type") ?? undefined;

    if (!bucket || !filePath) {
      return NextResponse.json({ error: "Eksik dosya bilgisi." }, { status: 400 });
    }

    const material = await findAuthorizedMaterialForFile(
      auth.supabase,
      { userId: auth.user.id, role: auth.user.role },
      bucket,
      filePath,
    );

    if (material.storage_provider === "supabase") {
      const { data: signedData, error: signedError } = await auth.supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, 60 * 5);

      if (signedError || !signedData?.signedUrl) {
        const message =
          signedError?.message || "Dosya için imzalı bağlantı oluşturulamadı.";
        return NextResponse.json({ error: message }, { status: 500 });
      }

      return auth.applyCookies(
        NextResponse.redirect(signedData.signedUrl, {
          status: 307,
          headers: {
            "Cache-Control": "private, max-age=60",
          },
        }),
      );
    }

    const file = await readStoredFile({
      client: auth.supabase,
      bucket,
      filePath,
      provider: material.storage_provider,
      contentType: material.mime_type,
    });
    const size = file.buffer.length;
    const range = parseRangeHeader(request.headers.get("range"), size);
    const contentType = type || material.mime_type || file.contentType;

    if (material.storage_provider === "local") {
      void tryMigrateLocalMaterialToSupabase({
        supabase: auth.supabase,
        material,
        contentType,
        buffer: file.buffer,
      }).catch((migrationError) => {
        console.error("Local materyal Supabase Storage'a taşınamadı:", migrationError);
      });
    }

    if (range) {
      const chunk = file.buffer.subarray(range.start, range.end + 1);
      return auth.applyCookies(
        new NextResponse(chunk, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(chunk.length),
            "Cache-Control": "no-store",
          },
        }),
      );
    }

    return auth.applyCookies(
      new NextResponse(file.buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(size),
          "Cache-Control": "no-store",
        },
      }),
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Dosya okunamadi.";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const formData = await request.formData();
    const bucket = String(formData.get("bucket") ?? "");
    const filePath = String(formData.get("path") ?? "");
    const file = formData.get("file");
    const explicitCourseId = Number(formData.get("courseId") ?? "");

    if (!bucket || !filePath || !(file instanceof File)) {
      return NextResponse.json({ error: "Eksik yukleme bilgisi." }, { status: 400 });
    }

    if (bucket !== MATERIAL_STORAGE_BUCKET) {
      return NextResponse.json({ error: "Geçersiz dosya deposu." }, { status: 400 });
    }

    const courseId = explicitCourseId > 0
      ? explicitCourseId
      : inferCourseIdFromFilePath(filePath);

    if (!courseId) {
      return NextResponse.json({ error: "Geçersiz ders bilgisi." }, { status: 400 });
    }

    await ensureUserCanAccessCourse(
      auth.supabase,
      { userId: auth.user.id, role: auth.user.role },
      courseId,
    );
    const data = await storeUploadedFile({
      client: auth.supabase,
      bucket,
      filePath,
      file,
      provider: "supabase",
    });
    const response = NextResponse.json({ data });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Dosya yuklenemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket");
    const filePath = url.searchParams.get("path");

    if (!bucket || !filePath) {
      return NextResponse.json({ error: "Eksik dosya bilgisi." }, { status: 400 });
    }

    const material = await findAuthorizedMaterialForFile(auth.supabase, bucket, filePath);
    await deleteStoredFile({
      client: auth.supabase,
      bucket,
      filePath,
      provider: material.storage_provider,
    });
    const response = NextResponse.json({ ok: true });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Dosya silinemedi.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
