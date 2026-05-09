import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { queryTable } from "@/lib/server/store";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/server";
import { buildMaterialFileUrl, MATERIAL_STORAGE_BUCKET } from "@/lib/storage/shared";

export const runtime = "nodejs";

type MaterialFileType = "audio" | "pdf" | "infographic";

type WeekRow = {
  id: number;
  course_id: number;
  user_id: string;
  week_index: number;
  title: string;
};

type MaterialRow = {
  id: number;
  user_id: string;
  course_id: number;
  week_id: number | null;
  week_index: number;
  file_type: MaterialFileType;
  file_name: string;
  file_url: string;
  mime_type: string | null;
  storage_provider: "local" | "supabase" | "google_drive" | "koofr" | null;
  storage_file_id: string | null;
};

type StorageListEntry = {
  name: string;
  id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  metadata?: {
    mimetype?: string;
  } | null;
};

function inferMimeType(fileType: MaterialFileType, fileName: string) {
  const lowered = fileName.toLowerCase();
  if (fileType === "audio") {
    if (lowered.endsWith(".mp3")) return "audio/mpeg";
    if (lowered.endsWith(".wav")) return "audio/wav";
    if (lowered.endsWith(".m4a")) return "audio/mp4";
    if (lowered.endsWith(".ogg")) return "audio/ogg";
    return "audio/mpeg";
  }

  if (fileType === "pdf") {
    return "application/pdf";
  }

  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "image/png";
}

function sortNewestFirst(entries: StorageListEntry[]) {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at ?? left.created_at ?? "") || 0;
    const rightTime = Date.parse(right.updated_at ?? right.created_at ?? "") || 0;
    return rightTime - leftTime;
  });
}

async function loadAuthorizedWeek(
  client: Parameters<typeof queryTable>[0]["client"],
  scope: NonNullable<Parameters<typeof queryTable>[0]["scope"]>,
  courseId: number,
  weekIndex: number,
) {
  const week = (await queryTable({
    action: "select",
    table: "weeks",
    filters: [
      { column: "course_id", value: courseId },
      { column: "week_index", value: weekIndex },
    ],
    returnSingle: true,
    client,
    scope,
  })) as WeekRow | null;

  if (!week) {
    throw new AuthError("Bu hafta için erişim izniniz yok.", 403);
  }

  return week;
}

async function syncSingleWeek(params: {
  auth: Awaited<ReturnType<typeof requireUser>>;
  courseId: number;
  week: WeekRow;
  currentMaterials: MaterialRow[];
  serviceClient: ReturnType<typeof createServiceRoleSupabaseClient>;
}) {
  const importedMaterials: MaterialRow[] = [];
  const fileTypes: MaterialFileType[] = ["audio", "pdf", "infographic"];

  for (const fileType of fileTypes) {
    const folderPath = [
      params.auth.user.id,
      String(params.courseId),
      String(params.week.id),
      fileType,
    ].join("/");
    const { data: entries, error: listError } = await params.serviceClient.storage
      .from(MATERIAL_STORAGE_BUCKET)
      .list(folderPath, {
        limit: 100,
        sortBy: { column: "updated_at", order: "desc" },
      });

    if (listError) {
      throw listError;
    }

    const candidates = sortNewestFirst(
      ((entries as StorageListEntry[] | null) ?? []).filter(
        (entry) => entry.name && entry.name !== ".emptyFolderPlaceholder",
      ),
    );

    const latest = candidates[0];
    if (!latest) {
      continue;
    }

    const storageFileId = `${folderPath}/${latest.name}`;
    const fileUrl = buildMaterialFileUrl(MATERIAL_STORAGE_BUCKET, storageFileId);
    const mimeType = latest.metadata?.mimetype || inferMimeType(fileType, latest.name);
    const existing = params.currentMaterials.find(
      (material) =>
        material.week_index === params.week.week_index &&
        material.file_type === fileType &&
        material.course_id === params.courseId,
    );

    if (existing) {
      const { data: updated, error: updateError } = await params.auth.supabase
        .from("materials")
        .update({
          file_name: latest.name,
          file_url: fileUrl,
          mime_type: mimeType,
          storage_provider: "supabase",
          storage_file_id: storageFileId,
        })
        .eq("id", existing.id)
        .eq("user_id", params.auth.user.id)
        .select()
        .single();

      if (updateError || !updated) {
        throw updateError ?? new Error("Materyal kaydı güncellenemedi.");
      }

      importedMaterials.push(updated as MaterialRow);
    } else {
      const { data: inserted, error: insertError } = await params.auth.supabase
        .from("materials")
        .insert({
          user_id: params.auth.user.id,
          course_id: params.courseId,
          week_id: params.week.id,
          week_index: params.week.week_index,
          file_type: fileType,
          file_name: latest.name,
          file_url: fileUrl,
          mime_type: mimeType,
          storage_provider: "supabase",
          storage_file_id: storageFileId,
        })
        .select()
        .single();

      if (insertError || !inserted) {
        throw insertError ?? new Error("Materyal kaydı oluşturulamadı.");
      }

      importedMaterials.push(inserted as MaterialRow);
    }
  }

  return importedMaterials;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    const body = (await request.json().catch(() => ({}))) as {
      courseId?: number;
      weekIndex?: number | null;
    };

    const courseId = Number(body.courseId ?? 0);
    const weekIndex =
      body.weekIndex === null || body.weekIndex === undefined
        ? null
        : Number(body.weekIndex);

    if (!courseId) {
      return NextResponse.json({ error: "Eksik senkronizasyon bilgisi." }, { status: 400 });
    }

    const serviceClient = createServiceRoleSupabaseClient();
    const currentMaterials = (await queryTable({
      action: "select",
      table: "materials",
      filters: [{ column: "course_id", value: courseId }],
      client: auth.supabase,
      scope: {
        userId: auth.user.id,
        role: auth.user.role,
      },
    })) as MaterialRow[];

    const importedMaterials: MaterialRow[] = [];

    if (weekIndex !== null && weekIndex >= 0) {
      const week = await loadAuthorizedWeek(
        auth.supabase,
        { userId: auth.user.id, role: auth.user.role },
        courseId,
        weekIndex,
      );

      importedMaterials.push(
        ...(await syncSingleWeek({
          auth,
          courseId,
          week,
          currentMaterials,
          serviceClient,
        })),
      );
    } else {
      const weeks = (await queryTable({
        action: "select",
        table: "weeks",
        filters: [{ column: "course_id", value: courseId }],
        orderColumn: "week_index",
        client: auth.supabase,
        scope: {
          userId: auth.user.id,
          role: auth.user.role,
        },
      })) as WeekRow[];

      for (const week of weeks) {
        importedMaterials.push(
          ...(await syncSingleWeek({
            auth,
            courseId,
            week,
            currentMaterials,
            serviceClient,
          })),
        );
      }
    }

    if (importedMaterials.length === 0) {
      return NextResponse.json(
        { error: "Supabase Storage içinde bağlanacak dosya bulunamadı." },
        { status: 404 },
      );
    }

    const response = NextResponse.json({ data: importedMaterials });
    return auth.applyCookies(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : "Supabase Storage senkronizasyonu başarısız oldu.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
