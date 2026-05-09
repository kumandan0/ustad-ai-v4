import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";
import {
  MATERIAL_STORAGE_BUCKET,
  parseMaterialFileUrl,
  type StorageProvider,
} from "@/lib/storage/shared";

export const runtime = "nodejs";

type MaterialAccessRow = {
  id: number;
  file_url: string;
  storage_provider: StorageProvider | null;
  storage_file_id: string | null;
};

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

  return (
    materials.find((material) => {
      if (material.storage_provider === "supabase" && material.storage_file_id) {
        return bucket === MATERIAL_STORAGE_BUCKET && material.storage_file_id === filePath;
      }

      const location = parseMaterialFileUrl(String(material.file_url ?? ""));
      return location?.bucket === bucket && location.filePath === filePath;
    }) ?? null
  );
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket");
    const filePath = url.searchParams.get("path");

    if (!bucket || !filePath) {
      return NextResponse.json({ error: "Eksik dosya bilgisi." }, { status: 400 });
    }

    const material = await findAuthorizedMaterialForFile(
      auth.supabase,
      { userId: auth.user.id, role: auth.user.role },
      bucket,
      filePath,
    );
    if (!material) {
      return NextResponse.json({ error: "Bu dosyaya erişim izniniz yok." }, { status: 403 });
    }

    if (material.storage_provider === "supabase") {
      const { data, error } = await auth.supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, 60 * 10);

      if (error || !data?.signedUrl) {
        return NextResponse.json(
          { error: error?.message || "Dosya bağlantısı oluşturulamadı." },
          { status: 500 },
        );
      }

      const response = NextResponse.json({
        url: data.signedUrl,
        expiresIn: 600,
      });
      return auth.applyCookies(response);
    }

    const response = NextResponse.json({
      url: `/api/files?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(filePath)}`,
      expiresIn: 300,
    });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Dosya bağlantısı oluşturulamadı.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
