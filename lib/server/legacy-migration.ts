import fs from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

type LegacyRow = Record<string, any>;

type LegacyDb = {
  users?: LegacyRow[];
  courses?: LegacyRow[];
  weeks?: LegacyRow[];
  flashcards?: LegacyRow[];
  test_questions?: LegacyRow[];
  open_ended_questions?: LegacyRow[];
  materials?: LegacyRow[];
  learning_goals?: LegacyRow[];
};

const LEGACY_DB_PATH = path.join(process.cwd(), ".data", "ustad-db.json");

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

async function readLegacyDb() {
  try {
    const raw = await fs.readFile(LEGACY_DB_PATH, "utf8");
    return JSON.parse(raw) as LegacyDb;
  } catch {
    return null;
  }
}

function parseSyllabus(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

export async function maybeMigrateLegacyWorkspace(params: {
  supabase: SupabaseClient;
  user: { id: string; email: string };
}) {
  const legacyDb = await readLegacyDb();
  if (!legacyDb) {
    return;
  }

  const legacyUsers = legacyDb.users ?? [];
  const legacyUser = legacyUsers.find(
    (user) => normalizeEmail(String(user.email ?? "")) === normalizeEmail(params.user.email),
  );

  if (!legacyUser) {
    return;
  }

  const { count, error: countError } = await params.supabase
    .from("courses")
    .select("id", { count: "exact", head: true });

  if (countError) {
    return;
  }

  if ((count ?? 0) > 0) {
    return;
  }

  const ownerId = Number(legacyUser.id);
  const legacyCourses = (legacyDb.courses ?? []).filter(
    (course) => Number(course.owner_user_id ?? course.user_id ?? 0) === ownerId,
  );

  if (legacyCourses.length === 0) {
    return;
  }

  const courseIdMap = new Map<number, number>();
  const weekIdMap = new Map<string, number>();

  for (const legacyCourse of legacyCourses) {
    const { data: insertedCourse, error: courseError } = await params.supabase
      .from("courses")
      .insert({
        user_id: params.user.id,
        name: String(legacyCourse.name ?? "Ders"),
        description: legacyCourse.description ? String(legacyCourse.description) : null,
        system_prompt: legacyCourse.system_prompt ? String(legacyCourse.system_prompt) : null,
        syllabus: parseSyllabus(legacyCourse.syllabus),
        created_at: legacyCourse.created_at ?? undefined,
      })
      .select("id")
      .single();

    if (courseError || !insertedCourse) {
      continue;
    }

    const newCourseId = Number(insertedCourse.id);
    courseIdMap.set(Number(legacyCourse.id), newCourseId);

    const legacyWeeks = (legacyDb.weeks ?? []).filter(
      (week) => Number(week.course_id) === Number(legacyCourse.id),
    );

    for (const legacyWeek of legacyWeeks) {
      const { data: insertedWeek } = await params.supabase
        .from("weeks")
        .insert({
          user_id: params.user.id,
          course_id: newCourseId,
          week_index: Number(legacyWeek.week_index ?? 0),
          title: String(legacyWeek.title ?? `Hafta ${Number(legacyWeek.week_index ?? 0) + 1}`),
          created_at: legacyWeek.created_at ?? undefined,
        })
        .select("id")
        .single();

      if (insertedWeek?.id) {
        weekIdMap.set(`${newCourseId}:${Number(legacyWeek.week_index ?? 0)}`, Number(insertedWeek.id));
      }
    }
  }

  const migrateRows = async (
    table: "flashcards" | "test_questions" | "open_ended_questions" | "materials" | "learning_goals",
    mapper: (row: LegacyRow, newCourseId: number, newWeekId: number | null) => LegacyRow,
  ) => {
    const rows = legacyDb[table] ?? [];

    for (const row of rows) {
      const legacyCourseId = Number(row.course_id ?? 0);
      const newCourseId = courseIdMap.get(legacyCourseId);
      if (!newCourseId) {
        continue;
      }

      const weekIndex = Number(row.week_index ?? 0);
      const newWeekId = weekIdMap.get(`${newCourseId}:${weekIndex}`) ?? null;
      await params.supabase.from(table).insert(
        mapper(row, newCourseId, newWeekId),
      );
    }
  };

  await migrateRows("flashcards", (row, newCourseId, newWeekId) => ({
    user_id: params.user.id,
    course_id: newCourseId,
    week_id: newWeekId,
    week_index: Number(row.week_index ?? 0),
    front: String(row.front ?? ""),
    back: String(row.back ?? ""),
    created_at: row.created_at ?? undefined,
  }));

  await migrateRows("test_questions", (row, newCourseId, newWeekId) => ({
    user_id: params.user.id,
    course_id: newCourseId,
    week_id: newWeekId,
    week_index: Number(row.week_index ?? 0),
    question: String(row.question ?? ""),
    options: Array.isArray(row.options) ? row.options : [],
    correct_index: Number(row.correct_index ?? 0),
    created_at: row.created_at ?? undefined,
  }));

  await migrateRows("open_ended_questions", (row, newCourseId, newWeekId) => ({
    user_id: params.user.id,
    course_id: newCourseId,
    week_id: newWeekId,
    week_index: Number(row.week_index ?? 0),
    question: String(row.question ?? ""),
    answer: row.answer ? String(row.answer) : null,
    created_at: row.created_at ?? undefined,
  }));

  await migrateRows("materials", (row, newCourseId, newWeekId) => ({
    user_id: params.user.id,
    course_id: newCourseId,
    week_id: newWeekId,
    week_index: Number(row.week_index ?? 0),
    file_type: row.file_type === "infographic" ? "infographic" : String(row.file_type ?? "pdf"),
    file_name: String(row.file_name ?? "dosya"),
    file_url: String(row.file_url ?? ""),
    mime_type: row.mime_type ? String(row.mime_type) : null,
    storage_provider: "local",
    storage_file_id: null,
    created_at: row.created_at ?? undefined,
  }));

  await migrateRows("learning_goals", (row, newCourseId, newWeekId) => ({
    user_id: params.user.id,
    course_id: newCourseId,
    week_id: newWeekId,
    week_index: Number(row.week_index ?? 0),
    label: String(row.label ?? row.topic_title ?? ""),
    topic_title: String(row.topic_title ?? row.label ?? ""),
    custom_label: Boolean(row.custom_label),
    progress: Number(row.progress ?? 0),
    correct_answers: Number(row.correct_answers ?? 0),
    total_questions: Number(row.total_questions ?? 0),
    last_attempt_at: row.last_attempt_at ?? null,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }));
}
