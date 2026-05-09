"use client";

import {
  buildMaterialFileUrl,
  MATERIAL_STORAGE_BUCKET,
  normalizeMaterialFileUrl,
} from "@/lib/storage/shared";

type Primitive = string | number | boolean | null;
type Row = Record<string, any>;
type TableName =
  | "users"
  | "sessions"
  | "invites"
  | "courses"
  | "weeks"
  | "flashcards"
  | "test_questions"
  | "open_ended_questions"
  | "materials"
  | "learning_goals";

type Filter = { column: string; value: Primitive };

type DbResponse<T> = Promise<{ data: T; error: Error | null }>;

type DbRequest = {
  action: "select" | "insert" | "update" | "delete";
  table: TableName;
  filters?: Filter[];
  payload?: Row | Row[];
  orderColumn?: string | null;
  ascending?: boolean;
  selectAfterMutation?: boolean;
  returnSingle?: boolean;
};

type LegacyDbShape = Record<TableName, Row[]>;

const LEGACY_DB_KEY = "ustad-ai-local-db";
const LEGACY_FILE_MAP_KEY = "ustad-ai-local-storage";
const LEGACY_FILE_DB_NAME = "ustad-ai-local-files";
const LEGACY_FILE_STORE_NAME = "files";
const LEGACY_MIGRATION_FLAG = "ustad-ai-legacy-migrated-v1";

const legacyObjectUrlCache = new Map<string, string>();
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

const EMPTY_LEGACY_DB: LegacyDbShape = {
  users: [],
  sessions: [],
  invites: [],
  courses: [],
  weeks: [],
  flashcards: [],
  test_questions: [],
  open_ended_questions: [],
  materials: [],
  learning_goals: [],
};

const LEGACY_TEXT_FIXES: Record<string, string> = {
  "Insan Haklari Hukuku": "İnsan Hakları Hukuku",
  "AIHM, AYM bireysel basvuru ve BM mekanizmalari":
    "AİHM, AYM bireysel başvuru ve BM mekanizmaları",
  "Sen Insan Haklari Hukuku alaninda uzman bir Turk hukuk asistanisin. Ogrencilere Turkce olarak yardim ediyorsun. Yanitlarin acik, pedagojik ve pratik orneklerle desteklenmis olsun.":
    "Sen İnsan Hakları Hukuku alanında uzman bir Türk hukuk asistanısın. Öğrencilere Türkçe olarak yardım ediyorsun. Yanıtların açık, pedagojik ve pratik örneklerle desteklenmiş olsun.",
  "Dersin amacinin ve islenis stratejisinin anlatilmasi":
    "Dersin amacının ve işleniş stratejisinin anlatılması",
  "Genel olarak insan haklarina giris ve insan haklari felsefesi":
    "Genel olarak insan haklarına giriş ve insan hakları felsefesi",
  "Insan haklarinin ozellikleri ve haklarin siniflandirilmasi":
    "İnsan haklarının özellikleri ve hakların sınıflandırılması",
  "Insan haklari koruma mekanizmalari": "İnsan hakları koruma mekanizmaları",
  "BM insan haklari koruma mekanizmalari": "BM insan hakları koruma mekanizmaları",
  "Anayasa Mahkemesi bireysel basvuru": "Anayasa Mahkemesi bireysel başvuru",
  "Avrupa Insan Haklari Mahkemesinin yapisi ve isleyisi":
    "Avrupa İnsan Hakları Mahkemesinin yapısı ve işleyişi",
  "AIHM'ye bireysel basvuru ve sartlar": "AİHM'ye bireysel başvuru ve şartlar",
  "Genel tekrar ve odev dagitimi": "Genel tekrar ve ödev dağıtımı",
  "Avrupa Insan Haklari Sozlesmesindeki haklar":
    "Avrupa İnsan Hakları Sözleşmesindeki haklar",
  "Odev ve sunum": "Ödev ve sunum",
  "Final sinavi": "Final sınavı",
  "Temel kavramlari kavra": "Temel kavramları kavra",
  "Basvuru sartlarini ogren": "Başvuru şartlarını öğren",
  "Mekanizmalari analiz et": "Mekanizmaları analiz et",
};

function normalizeLegacyValue<T>(value: T): T {
  if (typeof value === "string") {
    return (LEGACY_TEXT_FIXES[value] ?? value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeLegacyValue(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeLegacyValue(item),
      ]),
    ) as T;
  }

  return value;
}

async function requestDb<T>(body: DbRequest): DbResponse<T> {
  try {
    const response = await fetch("/api/db", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: T;
      error?: string;
    };

    if (!response.ok) {
      return {
        data: null as T,
        error: new Error(payload.error || `Request failed with status ${response.status}`),
      };
    }

    return { data: payload.data as T, error: null };
  } catch (error) {
    return {
      data: null as T,
      error: error instanceof Error ? error : new Error("Database request failed."),
    };
  }
}

async function requestJson<T>(url: string, body: Record<string, unknown>): DbResponse<T> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: T;
      error?: string;
    };

    if (!response.ok) {
      return {
        data: null as T,
        error: new Error(payload.error || `Request failed with status ${response.status}`),
      };
    }

    return { data: payload.data as T, error: null };
  } catch (error) {
    return {
      data: null as T,
      error: error instanceof Error ? error : new Error("Request failed."),
    };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeLegacyDb(raw: Partial<LegacyDbShape>): LegacyDbShape {
  return normalizeLegacyValue({
    ...clone(EMPTY_LEGACY_DB),
    ...raw,
  });
}

function readLegacyDbFromLocalStorage(): LegacyDbShape | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(LEGACY_DB_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeLegacyDb(JSON.parse(raw) as Partial<LegacyDbShape>);
  } catch {
    return null;
  }
}

function readLegacyFileMapFromLocalStorage(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(LEGACY_FILE_MAP_KEY);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function openLegacyFileDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = window.indexedDB.open(LEGACY_FILE_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_FILE_STORE_NAME)) {
        db.createObjectStore(LEGACY_FILE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readLegacyIndexedFile(key: string): Promise<Blob | null> {
  return openLegacyFileDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(LEGACY_FILE_STORE_NAME, "readonly");
        const store = transaction.objectStore(LEGACY_FILE_STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
        request.onerror = () => reject(request.error);
      }),
  );
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const response = await fetch(dataUrl);
    return await response.blob();
  } catch {
    return null;
  }
}

function parseLegacyFileUrl(url: string) {
  if (url.startsWith("idb://")) {
    const withoutScheme = url.slice("idb://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex === -1) {
      return null;
    }

    const bucket = withoutScheme.slice(0, slashIndex);
    const filePath = decodeURIComponent(withoutScheme.slice(slashIndex + 1));
    return { bucket, filePath, key: `${bucket}:${filePath}` };
  }

  if (url.startsWith("data:")) {
    return { dataUrl: url };
  }

  return null;
}

async function readLegacyBlobFromUrl(url: string): Promise<Blob | null> {
  const parsed = parseLegacyFileUrl(url);
  if (!parsed) {
    return null;
  }

  if ("dataUrl" in parsed) {
    return dataUrlToBlob(parsed.dataUrl);
  }

  const map = readLegacyFileMapFromLocalStorage();
  const mappedDataUrl = map[parsed.key];
  if (mappedDataUrl) {
    const mappedBlob = await dataUrlToBlob(mappedDataUrl);
    if (mappedBlob) {
      return mappedBlob;
    }
  }

  return readLegacyIndexedFile(parsed.key);
}

function sanitizePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

function buildMigrationPath(material: Row, sourceUrl: string) {
  const parsed = parseLegacyFileUrl(sourceUrl);
  if (parsed && "bucket" in parsed) {
    return parsed.filePath;
  }

  const fileName = sanitizePathPart(String(material.file_name ?? `material-${material.id}`));
  return `materials/migrated/${material.course_id}/${material.week_index}/${material.id}-${fileName}`;
}

// YENİ: VERCEL LİMİTİNİ AŞIP DOĞRUDAN SUPABASE'E YÜKLEYEN FONKSİYON
async function uploadFile(
  bucket: string,
  filePath: string,
  file: Blob | File,
  fileName?: string,
  options?: { courseId?: number },
) {
  const formData = new FormData();
  formData.append("bucket", bucket);
  formData.append("path", filePath);
  formData.append("file", file, fileName ?? (file instanceof File ? file.name : "upload.bin"));
  if (options?.courseId) {
    formData.append("courseId", String(options.courseId));
  }

  try {
    const response = await fetch("/api/files", {
      method: "POST",
      body: formData,
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { path: string; publicUrl: string; contentType?: string };
      error?: string;
    };

    if (!response.ok) {
      return {
        data: null,
        error: new Error(payload.error || `Upload failed with status ${response.status}`),
      };
    }

    return {
      data: payload.data ?? { path: filePath, publicUrl: buildFileUrl(bucket, filePath) },
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error("Upload failed."),
    };
  }
}

async function replaceServerDb(db: LegacyDbShape) {
  return requestJson<LegacyDbShape>("/api/db", { action: "replace", db });
}

export async function migrateLegacyDataIfNeeded(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.localStorage.getItem(LEGACY_MIGRATION_FLAG) === "1") {
    return false;
  }

  const legacyDb = readLegacyDbFromLocalStorage();
  if (!legacyDb) {
    return false;
  }

  const hasContent = Object.values(legacyDb).some((rows) => rows.length > 0);
  if (!hasContent) {
    window.localStorage.setItem(LEGACY_MIGRATION_FLAG, "1");
    return false;
  }

  const nextDb = clone(legacyDb);
  for (let index = 0; index < nextDb.materials.length; index += 1) {
    const material = nextDb.materials[index];
    const sourceUrl = String(material.file_url ?? "");
    if (!sourceUrl) {
      continue;
    }

    const blob = await readLegacyBlobFromUrl(sourceUrl);
    if (!blob) {
      continue;
    }

    const uploadPath = buildMigrationPath(material, sourceUrl);
    const { data, error } = await uploadFile(
      MATERIAL_STORAGE_BUCKET,
      uploadPath,
      blob,
      String(material.file_name ?? `material-${material.id}`),
      {
        courseId: Number(material.course_id ?? 0) || undefined,
      },
    );

    if (!error && data?.publicUrl) {
      material.file_url = data.publicUrl;
    }
  }

  const { error } = await replaceServerDb(nextDb);
  if (error) {
    throw error;
  }

  window.localStorage.setItem(LEGACY_MIGRATION_FLAG, "1");
  return true;
}

function resolveLegacyObjectUrl(url: string) {
  const cached = legacyObjectUrlCache.get(url);
  if (cached) {
    return cached;
  }

  return readLegacyBlobFromUrl(url).then((blob) => {
    if (!blob) {
      return "";
    }

    const objectUrl = URL.createObjectURL(blob);
    legacyObjectUrlCache.set(url, objectUrl);
    return objectUrl;
  });
}

class QueryBuilder<T extends Row | Row[] | null>
  implements PromiseLike<{ data: T; error: Error | null }>
{
  private action: DbRequest["action"] = "select";
  private filters: Filter[] = [];
  private orderColumn: string | null = null;
  private ascending = true;
  private payload: Row | Row[] | null = null;
  private selectAfterMutation = false;
  private returnSingle = false;

  constructor(private table: TableName) {}

  select() {
    this.selectAfterMutation = true;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Row) {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(column: string, value: Primitive) {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderColumn = column;
    this.ascending = options?.ascending ?? true;
    return this.execute() as DbResponse<T>;
  }

  single() {
    this.returnSingle = true;
    return this.execute();
  }

  then<TResult1 = { data: T; error: Error | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: T; error: Error | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private execute() {
    return requestDb<T>({
      action: this.action,
      table: this.table,
      filters: this.filters,
      payload: this.payload ?? undefined,
      orderColumn: this.orderColumn,
      ascending: this.ascending,
      selectAfterMutation: this.selectAfterMutation,
      returnSingle: this.returnSingle,
    });
  }
}

function buildFileUrl(bucket: string, filePath: string) {
  return buildMaterialFileUrl(bucket, filePath);
}

export async function resolveStoredFileUrl(url: string): Promise<string> {
  if (!url) {
    return "";
  }

  if (url.startsWith("idb://") || url.startsWith("data:")) {
    return resolveLegacyObjectUrl(url);
  }

  const normalized = normalizeMaterialFileUrl(url);
  if (!normalized.startsWith("/api/files")) {
    return normalized;
  }

  const cached = signedUrlCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  try {
    const parsed = new URL(normalized, window.location.origin);
    const response = await fetch(
      `/api/files/url?bucket=${encodeURIComponent(parsed.searchParams.get("bucket") ?? "")}&path=${encodeURIComponent(parsed.searchParams.get("path") ?? "")}`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      url?: string;
      expiresIn?: number;
    };

    if (response.ok && payload.url) {
      signedUrlCache.set(normalized, {
        url: payload.url,
        expiresAt: Date.now() + Math.max(30, Number(payload.expiresIn ?? 300) - 15) * 1000,
      });
      return payload.url;
    }
  } catch {
    // Fallback below.
  }

  return normalized;
}

export async function deleteStoredFileUrl(url: string): Promise<void> {
  try {
    const normalized = normalizeMaterialFileUrl(url);
    if (!normalized.startsWith("/api/files")) {
      return;
    }

    const parsed = new URL(normalized, window.location.origin);
    await fetch(parsed.toString(), { method: "DELETE" });
  } catch {
    // Ignore cleanup failures
  }
}

export function createClient(): any {
  return {
    from(table: TableName) {
      return {
        select: () => new QueryBuilder(table),
        insert: (payload: Row | Row[]) => new QueryBuilder(table).insert(payload),
        update: (payload: Row) => new QueryBuilder(table).update(payload),
        delete: () => new QueryBuilder(table).delete(),
      };
    },
    storage: {
      from(bucket: string) {
        return {
          upload: (
            filePath: string,
            file: File,
            options?: { courseId?: number },
          ) => uploadFile(bucket, filePath, file, file.name, options),
          getPublicUrl(filePath: string) {
            return { data: { publicUrl: buildFileUrl(bucket, filePath) } };
          },
        };
      },
    },
  };
}

export { MATERIAL_STORAGE_BUCKET };
