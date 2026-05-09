import type { SupabaseClient } from "@supabase/supabase-js";
import { del, get, put } from "@vercel/blob";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildMaterialFileUrl,
  type StorageProvider,
} from "@/lib/storage/shared";

type Primitive = string | number | boolean | null;
type Row = Record<string, any>;

const blobToken = process.env.BLOB_READ_WRITE_TOKEN || "";
const dataDir = path.join(process.cwd(), ".data");
const localUploadsDir = path.join(dataDir, "uploads");

export type TableName =
  | "profiles"
  | "invites"
  | "courses"
  | "weeks"
  | "flashcards"
  | "test_questions"
  | "open_ended_questions"
  | "materials"
  | "learning_goals"
  | "test_attempts"
  | "chat_threads"
  | "chat_messages";

export type Filter = { column: string; value: Primitive };
export type QueryScope = { userId: string; role: "admin" | "student" };

export type DbRequest = {
  action: "select" | "insert" | "update" | "delete" | "replace";
  table?: TableName;
  filters?: Filter[];
  payload?: Row | Row[];
  orderColumn?: string | null;
  ascending?: boolean;
  selectAfterMutation?: boolean;
  returnSingle?: boolean;
  client: SupabaseClient;
  scope?: QueryScope;
};

const USER_SCOPED_TABLES = new Set<TableName>([
  "courses",
  "weeks",
  "flashcards",
  "test_questions",
  "open_ended_questions",
  "materials",
  "learning_goals",
  "test_attempts",
  "chat_threads",
  "chat_messages",
]);

function isUserScopedTable(table: TableName) {
  return USER_SCOPED_TABLES.has(table);
}

function applyFilters<TBuilder extends { eq: Function; is: Function }>(
  builder: TBuilder,
  filters: Filter[] = [],
) {
  return filters.reduce((current, filter) => {
    if (filter.value === null) {
      return current.is(filter.column, null);
    }

    return current.eq(filter.column, filter.value);
  }, builder);
}

export async function queryTable(request: DbRequest) {
  if (request.action === "replace") {
    throw new Error("Legacy replace islemi artik desteklenmiyor.");
  }

  if (!request.table) {
    throw new Error("Tablo belirtilmedi.");
  }

  const scopeFilters =
    request.scope && isUserScopedTable(request.table)
      ? [{ column: "user_id", value: request.scope.userId } satisfies Filter]
      : [];
  const mergedFilters = [...scopeFilters, ...(request.filters ?? [])];

  if (request.action === "select") {
    let builder = applyFilters(request.client.from(request.table).select("*"), mergedFilters);
    if (request.orderColumn) {
      builder = builder.order(request.orderColumn, {
        ascending: request.ascending ?? true,
      });
    }

    if (request.returnSingle) {
      const { data, error } = await builder.maybeSingle();
      if (error) {
        throw error;
      }
      return data;
    }

    const { data, error } = await builder;
    if (error) {
      throw error;
    }
    return data ?? [];
  }

  if (request.action === "insert") {
    const payloadWithScope =
      request.scope && isUserScopedTable(request.table)
        ? Array.isArray(request.payload)
          ? (request.payload as Row[]).map((row) => ({ ...row, user_id: request.scope!.userId }))
          : { ...(request.payload as Row), user_id: request.scope.userId }
        : request.payload;

    let builder = request.client
      .from(request.table)
      .insert(payloadWithScope as Row | Row[]);
    if (request.selectAfterMutation || request.returnSingle) {
      builder = builder.select();
    }

    if (request.returnSingle) {
      const { data, error } = await builder.single();
      if (error) {
        throw error;
      }
      return data;
    }

    const { data, error } = await builder;
    if (error) {
      throw error;
    }
    return data ?? [];
  }

  if (request.action === "update") {
    let builder = applyFilters(
      request.client.from(request.table).update(request.payload as Row),
      mergedFilters,
    );

    if (request.selectAfterMutation || request.returnSingle) {
      builder = builder.select();
    }

    if (request.returnSingle) {
      const { data, error } = await builder.single();
      if (error) {
        throw error;
      }
      return data;
    }

    const { data, error } = await builder;
    if (error) {
      throw error;
    }
    return data ?? [];
  }

  let builder = applyFilters(request.client.from(request.table).delete(), mergedFilters);
  if (request.selectAfterMutation || request.returnSingle) {
    builder = builder.select();
  }

  if (request.returnSingle) {
    const { data, error } = await builder.single();
    if (error) {
      throw error;
    }
    return data;
  }

  const { data, error } = await builder;
  if (error) {
    throw error;
  }
  return data ?? [];
}

function inferContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

async function buildStoredFileDetails(bucket: string, filePath: string, file: File) {
  const storedPath = normalizeStoragePath(filePath);
  const normalizedBucket = normalizeStoragePath(bucket);
  const contentType = file.type || inferContentType(filePath);
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  return {
    path: storedPath,
    publicUrl: buildMaterialFileUrl(normalizedBucket, storedPath),
    contentType,
    fileBuffer,
  };
}

async function storeFileInSupabaseStorage(
  client: SupabaseClient,
  bucket: string,
  filePath: string,
  fileBuffer: Buffer,
  contentType: string,
) {
  const { error } = await client.storage.from(bucket).upload(filePath, fileBuffer, {
    upsert: true,
    contentType,
  });

  if (error) {
    throw error;
  }
}

async function storeFileInLegacyStorage(
  bucket: string,
  filePath: string,
  fileBuffer: Buffer,
  contentType: string,
) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;

  if (blobToken) {
    const blob = await put(storedPath, fileBuffer, {
      access: "public",
      allowOverwrite: true,
      contentType,
      token: blobToken,
    });

    return {
      path: storedPath,
      publicUrl: blob.url,
      contentType,
    };
  }

  const absolutePath = getLocalUploadPath(storedPath);
  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, fileBuffer);
  } catch (error) {
    throw new Error(
      `Legacy dosya yerel depoya yazılamadı: ${
        error instanceof Error ? error.message : "bilinmeyen hata"
      }`,
    );
  }

  return {
    path: storedPath,
    publicUrl: getPublicFileUrl(bucket, filePath),
    contentType,
  };
}

async function deleteFileFromLegacyStorage(bucket: string, filePath: string) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;

  if (blobToken) {
    await del(storedPath, { token: blobToken });
    return;
  }

  try {
    await fs.unlink(getLocalUploadPath(storedPath));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function deleteFileFromSupabaseStorage(
  client: SupabaseClient,
  bucket: string,
  filePath: string,
) {
  const { error } = await client.storage.from(bucket).remove([filePath]);
  if (error) {
    throw error;
  }
}

async function readLegacyStoredFile(bucket: string, filePath: string) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;

  if (blobToken) {
    const blob = await get(storedPath, { access: "public", token: blobToken });

    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      throw new Error("Dosya bulunamadi.");
    }

    const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
    return { buffer, contentType: blob.blob.contentType || inferContentType(filePath) };
  }

  try {
    const buffer = await fs.readFile(getLocalUploadPath(storedPath));
    return { buffer, contentType: inferContentType(filePath) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Legacy dosya yerel depoda bulunamadı.");
    }

    throw new Error(
      `Legacy dosya okunamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`,
    );
  }
}

async function readSupabaseStoredFile(
  client: SupabaseClient,
  bucket: string,
  filePath: string,
  contentType?: string | null,
) {
  const { data, error } = await client.storage.from(bucket).download(filePath);
  if (error || !data) {
    throw error ?? new Error("Dosya bulunamadi.");
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  return {
    buffer,
    contentType: contentType || data.type || inferContentType(filePath),
  };
}

export async function storeUploadedFile(params: {
  client: SupabaseClient;
  bucket: string;
  filePath: string;
  file: File;
  provider?: StorageProvider;
}) {
  const fileDetails = await buildStoredFileDetails(params.bucket, params.filePath, params.file);
  const provider = params.provider ?? "supabase";

  if (provider === "supabase") {
    await storeFileInSupabaseStorage(
      params.client,
      params.bucket,
      fileDetails.path,
      fileDetails.fileBuffer,
      fileDetails.contentType,
    );
  } else {
    await storeFileInLegacyStorage(
      params.bucket,
      fileDetails.path,
      fileDetails.fileBuffer,
      fileDetails.contentType,
    );
  }

  return {
    path: fileDetails.path,
    publicUrl: fileDetails.publicUrl,
    contentType: fileDetails.contentType,
  };
}

export async function deleteStoredFile(params: {
  client?: SupabaseClient;
  bucket: string;
  filePath: string;
  provider?: StorageProvider | null;
}) {
  if (params.provider === "supabase") {
    if (!params.client) {
      throw new Error("Supabase istemcisi olmadan storage dosyasi silinemez.");
    }

    await deleteFileFromSupabaseStorage(params.client, params.bucket, params.filePath);
    return;
  }

  await deleteFileFromLegacyStorage(params.bucket, params.filePath);
}

export async function readStoredFile(params: {
  client?: SupabaseClient;
  bucket: string;
  filePath: string;
  provider?: StorageProvider | null;
  contentType?: string | null;
}) {
  if (params.provider === "supabase") {
    if (!params.client) {
      throw new Error("Supabase istemcisi olmadan storage dosyasi okunamaz.");
    }

    return readSupabaseStoredFile(
      params.client,
      params.bucket,
      params.filePath,
      params.contentType,
    );
  }

  return readLegacyStoredFile(params.bucket, params.filePath);
}

export function getPublicFileUrl(bucket: string, filePath: string) {
  return buildMaterialFileUrl(bucket, filePath);
}

function normalizeStoragePath(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error("Invalid storage path.");
  }
  return normalized;
}

function getLocalUploadPath(storedPath: string) {
  return path.join(localUploadsDir, storedPath);
}
