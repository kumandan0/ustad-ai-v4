import type { SupabaseClient } from "@supabase/supabase-js";
import { del, get, put } from "@vercel/blob";
import fs from "node:fs/promises";
import path from "node:path";

type Primitive = string | number | boolean | null;
type Row = Record<string, any>;

const blobToken = process.env.BLOB_READ_WRITE_TOKEN || "";
const allowLocalDevelopmentStorage = process.env.ALLOW_LOCAL_STORAGE === "1" || !process.env.VERCEL;
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
};

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

  if (request.action === "select") {
    let builder = applyFilters(request.client.from(request.table).select("*"), request.filters);
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
    let builder = request.client.from(request.table).insert(request.payload as Row | Row[]);
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
      request.filters,
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

  let builder = applyFilters(request.client.from(request.table).delete(), request.filters);
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

export async function storeUploadedFile(bucket: string, filePath: string, file: File) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;
  const contentType = file.type || inferContentType(filePath);

  if (blobToken) {
    const blob = await put(storedPath, file, {
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

  if (!allowLocalDevelopmentStorage) {
    throw new Error("BLOB_READ_WRITE_TOKEN environment variable is missing.");
  }

  const absolutePath = getLocalUploadPath(storedPath);
  const buffer = Buffer.from(await file.arrayBuffer());

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  return {
    path: storedPath,
    publicUrl: getPublicFileUrl(bucket, filePath),
    contentType,
  };
}

export async function deleteStoredFile(bucket: string, filePath: string) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;

  if (blobToken) {
    await del(storedPath, { token: blobToken });
    return;
  }

  if (!allowLocalDevelopmentStorage) {
    throw new Error("BLOB_READ_WRITE_TOKEN environment variable is missing.");
  }

  try {
    await fs.unlink(getLocalUploadPath(storedPath));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readStoredFile(bucket: string, filePath: string) {
  const storedPath = `${normalizeStoragePath(bucket)}/${normalizeStoragePath(filePath)}`;

  if (blobToken) {
    const blob = await get(storedPath, { access: "public", token: blobToken });

    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      throw new Error("Dosya bulunamadi.");
    }

    const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
    return { buffer, contentType: blob.blob.contentType || inferContentType(filePath) };
  }

  if (!allowLocalDevelopmentStorage) {
    throw new Error("BLOB_READ_WRITE_TOKEN environment variable is missing.");
  }

  const buffer = await fs.readFile(getLocalUploadPath(storedPath));
  return { buffer, contentType: inferContentType(filePath) };
}

export function getPublicFileUrl(bucket: string, filePath: string) {
  return `/api/files?bucket=${bucket}&path=${filePath}`;
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
