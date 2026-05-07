import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";
import { deleteStoredFile, readStoredFile, storeUploadedFile } from "@/lib/server/store";

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

function parseMaterialLocation(fileUrl: string) {
  try {
    const parsed = new URL(fileUrl, "http://local");
    const bucket = parsed.searchParams.get("bucket");
    const filePath = parsed.searchParams.get("path");

    if (parsed.pathname !== "/api/files" || !bucket || !filePath) {
      return null;
    }

    return { bucket, filePath };
  } catch {
    return null;
  }
}

async function ensureUserCanAccessFile(
  client: Parameters<typeof queryTable>[0]["client"],
  bucket: string,
  filePath: string,
) {
  const materials = (await queryTable({
    action: "select",
    table: "materials",
    client,
  })) as Array<Record<string, any>>;

  const matchedMaterial = materials.find((material) => {
    const location = parseMaterialLocation(String(material.file_url ?? ""));
    return location?.bucket === bucket && location.filePath === filePath;
  });

  if (!matchedMaterial) {
    throw new AuthError("Bu dosyaya erişim izniniz yok.", 403);
  }
}

function inferCourseIdFromFilePath(filePath: string) {
  const fileName = filePath.split("/").pop() ?? "";
  const match = /^(\d+)_/.exec(fileName);
  return match ? Number(match[1]) : null;
}

async function ensureUserCanAccessCourse(
  client: Parameters<typeof queryTable>[0]["client"],
  courseId: number,
) {
  const data = await queryTable({
    action: "select",
    table: "courses",
    filters: [{ column: "id", value: courseId }],
    returnSingle: true,
    client,
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

    await ensureUserCanAccessFile(auth.supabase, bucket, filePath);
    const file = await readStoredFile(bucket, filePath);
    const size = file.buffer.length;
    const range = parseRangeHeader(request.headers.get("range"), size);
    const contentType = type || file.contentType;

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

    const courseId = explicitCourseId > 0
      ? explicitCourseId
      : inferCourseIdFromFilePath(filePath);

    if (!courseId) {
      return NextResponse.json({ error: "Geçersiz ders bilgisi." }, { status: 400 });
    }

    await ensureUserCanAccessCourse(auth.supabase, courseId);
    const data = await storeUploadedFile(bucket, filePath, file);
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

    await ensureUserCanAccessFile(auth.supabase, bucket, filePath);
    await deleteStoredFile(bucket, filePath);
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
