import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteStoredFile,
  queryTable,
  readStoredFile,
  storeUploadedFile,
} from "@/lib/server/store";
import {
  MATERIAL_STORAGE_BUCKET,
  parseMaterialFileUrl,
  type StorageProvider,
} from "@/lib/storage/shared";
import {
  renderInfographicPng,
  type GeneratedInfographicSpec,
} from "@/lib/server/infographic";

export type AutomationKind =
  | "audio_summary"
  | "infographic"
  | "flashcards"
  | "test_questions"
  | "open_ended_questions";

export type AutomationDifficulty = "easy" | "medium" | "hard";

export type AutomationOptions = {
  count?: number;
  difficulty?: AutomationDifficulty;
};

type CourseRow = {
  id: number;
  name: string;
};

type WeekRow = {
  id: number;
  course_id: number;
  week_index: number;
  title: string;
};

type MaterialFileType = "pdf" | "audio" | "infographic";

type MaterialRow = {
  id: number;
  course_id: number;
  week_id: number | null;
  week_index: number;
  file_type: MaterialFileType;
  file_name: string;
  file_url: string;
  mime_type?: string | null;
  storage_provider?: StorageProvider | null;
  storage_file_id?: string | null;
};

type FlashcardRow = {
  id: number;
  course_id: number;
  week_index: number;
  front: string;
  back: string;
};

type TestQuestionRow = {
  id: number;
  course_id: number;
  week_index: number;
  question: string;
  options: string[];
  correct_index: number;
};

type OpenEndedQuestionRow = {
  id: number;
  course_id: number;
  week_index: number;
  question: string;
  answer: string | null;
};

type UploadedGeminiFile = {
  uri: string;
  mimeType: string;
};

type GeneratedMaterialResult = {
  kind: "audio_summary" | "infographic";
  material: MaterialRow;
  replacedExisting: boolean;
  summaryText?: string;
};

type GeneratedQuestionResult =
  | {
      kind: "flashcards";
      items: FlashcardRow[];
      skippedDuplicates: number;
    }
  | {
      kind: "test_questions";
      items: TestQuestionRow[];
      skippedDuplicates: number;
    }
  | {
      kind: "open_ended_questions";
      items: OpenEndedQuestionRow[];
      skippedDuplicates: number;
    };

export type AutomationResult = GeneratedMaterialResult | GeneratedQuestionResult;

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_API_BASE =
  process.env.GEMINI_UPLOAD_API_BASE ?? "https://generativelanguage.googleapis.com/upload/v1beta";
const GEMINI_STRUCTURED_MODEL =
  process.env.GEMINI_AUTOMATION_MODEL ??
  process.env.GEMINI_MATERIALS_MODEL ??
  "gemini-2.5-flash";
const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE ?? "Achird";
const AUDIO_NARRATION_SECTION_COUNT = 8;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary_title: { type: "string" },
    summary_text: { type: "string" },
    narration_sections: {
      type: "array",
      minItems: AUDIO_NARRATION_SECTION_COUNT,
      maxItems: AUDIO_NARRATION_SECTION_COUNT,
      items: { type: "string" },
    },
    key_points: {
      type: "array",
      items: { type: "string" },
      minItems: 6,
      maxItems: 6,
    },
    takeaway: { type: "string" },
  },
  required: ["summary_title", "summary_text", "narration_sections", "key_points", "takeaway"],
  additionalProperties: false,
} as const;

const INFOGRAPHIC_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    subtitle: { type: "string" },
    sections: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          bullets: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: { type: "string" },
          },
        },
        required: ["heading", "bullets"],
        additionalProperties: false,
      },
    },
    takeaway: { type: "string" },
  },
  required: ["headline", "subtitle", "sections", "takeaway"],
  additionalProperties: false,
} as const;

function buildFlashcardSchema(count: number) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            front: { type: "string" },
            back: { type: "string" },
          },
          required: ["front", "back"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  } as const;
}

function buildTestSchema(count: number) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string" },
            },
            correct_index: {
              type: "integer",
              minimum: 0,
              maximum: 3,
            },
          },
          required: ["question", "options", "correct_index"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  } as const;
}

function buildOpenEndedSchema(count: number) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
          },
          required: ["question", "answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  } as const;
}

function sanitizeStorageSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

function buildStudyIntentPrompt(courseName: string, weekTitle: string) {
  return [
    `${courseName} dersinden "${weekTitle}" konusunda sınavım var.`,
    "Ders kitabından bu konuyu anlatan kısmı sana yükledim.",
    "Sadece yüklediğim metne dayanarak, konunun tamamını kapsayan, öğrencinin tekrar yapmasına gerçekten yardımcı olacak bir çıktı üret.",
    "Gereksiz genel geçer cümlelerden kaçın; önemli bilgi, kavram, ayrım, şart, süreç ve sınavda karışabilecek noktaları öne çıkar.",
  ].join(" ");
}

function clampCount(kind: AutomationKind, rawCount: number | null | undefined) {
  const count = Number(rawCount ?? 0);

  if (kind === "flashcards") {
    return Math.max(4, Math.min(30, Number.isFinite(count) ? Math.round(count) : 14));
  }

  if (kind === "test_questions") {
    return Math.max(4, Math.min(24, Number.isFinite(count) ? Math.round(count) : 12));
  }

  if (kind === "open_ended_questions") {
    return Math.max(2, Math.min(12, Number.isFinite(count) ? Math.round(count) : 6));
  }

  return 0;
}

function normalizeDifficulty(value: string | null | undefined): AutomationDifficulty {
  if (value === "easy" || value === "hard") {
    return value;
  }

  return "medium";
}

function buildDifficultyInstruction(
  kind: Extract<AutomationKind, "flashcards" | "test_questions" | "open_ended_questions">,
  difficulty: AutomationDifficulty,
) {
  if (kind === "flashcards") {
    if (difficulty === "easy") {
      return "Bilgi kartları kolay düzeyde olsun; temel tanım, ilke, unsur ve doğrudan hatırlama gerektiren noktaları öne çıkar.";
    }

    if (difficulty === "hard") {
      return "Bilgi kartları zor düzeyde olsun; karıştırılabilecek ayrımlar, istisnalar, şartlar ve analitik karşılaştırmalar ağırlıklı olsun.";
    }

    return "Bilgi kartları orta düzeyde olsun; hem temel bilgiyi hem de karşılaştırma ve ayırt etme becerisini dengeli ölçsün.";
  }

  if (kind === "test_questions") {
    if (difficulty === "easy") {
      return "Test soruları kolay düzeyde olsun; temel kavramlar, doğrudan bilgi ve çekirdek ilkeler üzerinde yoğunlaşsın.";
    }

    if (difficulty === "hard") {
      return "Test soruları zor düzeyde olsun; ince ayrım, çok benzer seçenekler arasında doğru tercihi yapma, yorum ve uygulama becerisi istesin.";
    }

    return "Test soruları orta düzeyde olsun; temel bilgi ile yorumlama ve karşılaştırma becerisini dengeli biçimde ölçsün.";
  }

  if (difficulty === "easy") {
    return "Açık uçlu sorular kolay düzeyde olsun; öğrencinin temel kavramları açıklamasını ve doğrudan bilgiyi ifade etmesini beklesin.";
  }

  if (difficulty === "hard") {
    return "Açık uçlu sorular zor düzeyde olsun; karşılaştırma, analiz, yorum, şartların birlikte değerlendirilmesi ve sonuç çıkarma becerisi gerektirsin.";
  }

  return "Açık uçlu sorular orta düzeyde olsun; açıklama ile birlikte yorum ve karşılaştırma gerektirsin.";
}

function normalizeText(value: string) {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9çğıöşü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGeminiText(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiError(payload: any) {
  const apiMessage =
    payload?.error?.message ||
    payload?.promptFeedback?.blockReason ||
    payload?.candidates?.[0]?.finishReason;

  if (!apiMessage) {
    return null;
  }

  return String(apiMessage);
}

function extractGeminiInlineData(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }

  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (inlineData?.data) {
      return {
        data: String(inlineData.data),
        mimeType: String(inlineData.mimeType ?? inlineData.mime_type ?? ""),
      };
    }
  }

  return null;
}

async function uploadGeminiFile(
  apiKey: string,
  displayName: string,
  mimeType: string,
  buffer: Buffer,
) {
  const startResponse = await fetch(`${GEMINI_UPLOAD_API_BASE}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
  });

  const startPayload = await startResponse.json().catch(() => null);
  if (!startResponse.ok) {
    throw new Error(
      extractGeminiError(startPayload) || "Gemini dosya yükleme isteği başarısız oldu.",
    );
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini dosya yükleme bağlantısı alınamadı.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(buffer),
  });

  const uploadPayload = await uploadResponse.json().catch(() => null);
  if (!uploadResponse.ok) {
    throw new Error(
      extractGeminiError(uploadPayload) || "Gemini dosyası tamamlanamadı.",
    );
  }

  const file = uploadPayload?.file ?? uploadPayload;
  const uri = file?.uri;
  const responseMimeType = file?.mimeType ?? file?.mime_type ?? mimeType;

  if (typeof uri !== "string" || !uri) {
    throw new Error("Gemini dosya URI bilgisi döndürmedi.");
  }

  return {
    uri,
    mimeType: String(responseMimeType),
  } satisfies UploadedGeminiFile;
}

async function generateGeminiJson<T>(params: {
  apiKey: string;
  prompt: string;
  schema: Record<string, unknown>;
  file: UploadedGeminiFile;
}) {
  const response = await fetch(
    `${GEMINI_API_BASE}/models/${GEMINI_STRUCTURED_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: params.prompt },
              {
                file_data: {
                  mime_type: params.file.mimeType,
                  file_uri: params.file.uri,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: params.schema,
        },
      }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      extractGeminiError(payload) || "Gemini yapılandırılmış veri üretimi başarısız oldu.",
    );
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error(
      extractGeminiError(payload) || "Gemini boş bir JSON yanıtı döndürdü.",
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Gemini yanıtı JSON olarak çözümlenemedi.");
  }
}

function chunkTextForSpeech(text: string, maxChars = 2600) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }

    let offset = 0;
    while (offset < sentence.length) {
      const slice = sentence.slice(offset, offset + maxChars).trim();
      if (slice) {
        chunks.push(slice);
      }
      offset += maxChars;
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function generateSpeechPcm(params: {
  apiKey: string;
  text: string;
}) {
  const response = await fetch(`${GEMINI_API_BASE}/models/${GEMINI_TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: params.text }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: GEMINI_TTS_VOICE,
            },
          },
        },
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      extractGeminiError(payload) || "Gemini sesli özet üretimi başarısız oldu.",
    );
  }

  const inlineData = extractGeminiInlineData(payload);
  if (!inlineData?.data) {
    throw new Error("Gemini ses çıktısı döndürmedi.");
  }

  return Buffer.from(inlineData.data, "base64");
}

async function generateSpeechWav(params: {
  apiKey: string;
  segments: string[];
}) {
  const chunks = params.segments.flatMap((segment) => chunkTextForSpeech(segment));
  if (chunks.length === 0) {
    throw new Error("Ses üretimi için anlatım metni oluşturulamadı.");
  }

  const pcmBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    pcmBuffers.push(
      await generateSpeechPcm({
        apiKey: params.apiKey,
        text: chunk,
      }),
    );
  }

  return pcmToWav(Buffer.concat(pcmBuffers));
}

function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const wavBuffer = Buffer.alloc(44 + pcmBuffer.length);

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

async function loadWeekContext(courseId: number, weekIndex: number, client: SupabaseClient) {
  const [course, week, materials] = await Promise.all([
    queryTable({
      action: "select",
      table: "courses",
      filters: [{ column: "id", value: courseId }],
      returnSingle: true,
      client,
    }) as Promise<CourseRow | null>,
    queryTable({
      action: "select",
      table: "weeks",
      filters: [
        { column: "course_id", value: courseId },
        { column: "week_index", value: weekIndex },
      ],
      returnSingle: true,
      client,
    }) as Promise<WeekRow | null>,
    queryTable({
      action: "select",
      table: "materials",
      filters: [
        { column: "course_id", value: courseId },
        { column: "week_index", value: weekIndex },
      ],
      client,
    }) as Promise<MaterialRow[]>,
  ]);

  if (!course) {
    throw new Error("Ders bulunamadı veya erişim izniniz yok.");
  }

  if (!week) {
    throw new Error("Hafta bilgisi bulunamadı.");
  }

  const pdfMaterial = materials.find((material) => material.file_type === "pdf") ?? null;
  return {
    course,
    week,
    materials,
    pdfMaterial,
  };
}

async function uploadPdfMaterialToGemini(
  client: SupabaseClient,
  material: MaterialRow,
  apiKey: string,
) {
  const location = parseMaterialFileUrl(material.file_url);
  const bucket = location?.bucket ?? MATERIAL_STORAGE_BUCKET;
  const filePath = material.storage_file_id || location?.filePath;

  if (!filePath) {
    throw new Error("PDF dosyasının depolama yolu çözümlenemedi.");
  }

  const storedFile = await readStoredFile({
    client,
    bucket,
    filePath,
    provider: material.storage_provider,
    contentType: material.mime_type,
  });

  return uploadGeminiFile(
    apiKey,
    material.file_name,
    material.mime_type || storedFile.contentType || "application/pdf",
    storedFile.buffer,
  );
}

function buildGeneratedFilePath(params: {
  userId: string;
  courseId: number;
  weekId: number;
  kind: MaterialFileType;
  fileName: string;
}) {
  return [
    sanitizeStorageSegment(params.userId),
    String(params.courseId),
    String(params.weekId),
    params.kind,
    `${Date.now()}-${sanitizeStorageSegment(params.fileName)}`,
  ].join("/");
}

async function upsertGeneratedMaterial(params: {
  client: SupabaseClient;
  userId: string;
  courseId: number;
  week: WeekRow;
  fileType: Extract<MaterialFileType, "audio" | "infographic">;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  existingMaterials: MaterialRow[];
}) {
  const existingMaterial =
    params.existingMaterials.find((material) => material.file_type === params.fileType) ?? null;
  const storagePath = buildGeneratedFilePath({
    userId: params.userId,
    courseId: params.courseId,
    weekId: params.week.id,
    kind: params.fileType,
    fileName: params.fileName,
  });

  const file = new File([new Uint8Array(params.buffer)], params.fileName, {
    type: params.mimeType,
  });
  const upload = await storeUploadedFile({
    client: params.client,
    bucket: MATERIAL_STORAGE_BUCKET,
    filePath: storagePath,
    file,
    provider: "supabase",
  });

  try {
    const { data, error } = await params.client
      .from("materials")
      .insert({
        course_id: params.courseId,
        week_id: params.week.id,
        week_index: params.week.week_index,
        file_type: params.fileType,
        file_name: params.fileName,
        file_url: upload.publicUrl,
        mime_type: params.mimeType,
        storage_provider: "supabase",
        storage_file_id: upload.path,
      })
      .select()
      .single();

    if (error || !data) {
      throw error ?? new Error("Üretilen materyal veritabanına kaydedilemedi.");
    }

    if (existingMaterial) {
      const existingLocation = parseMaterialFileUrl(existingMaterial.file_url);
      const existingBucket = existingLocation?.bucket ?? MATERIAL_STORAGE_BUCKET;
      const existingPath = existingMaterial.storage_file_id || existingLocation?.filePath;
      if (existingPath) {
        await deleteStoredFile({
          client: params.client,
          bucket: existingBucket,
          filePath: existingPath,
          provider: existingMaterial.storage_provider,
        }).catch(() => undefined);
      }

      await params.client.from("materials").delete().eq("id", existingMaterial.id);
    }

    return {
      material: data as MaterialRow,
      replacedExisting: Boolean(existingMaterial),
    };
  } catch (error) {
    await deleteStoredFile({
      client: params.client,
      bucket: MATERIAL_STORAGE_BUCKET,
      filePath: upload.path,
      provider: "supabase",
    }).catch(() => undefined);
    throw error;
  }
}

async function generateAudioSummary(params: {
  apiKey: string;
  pdfFile: UploadedGeminiFile;
  course: CourseRow;
  week: WeekRow;
  client: SupabaseClient;
  userId: string;
  materials: MaterialRow[];
}) {
  const summary = await generateGeminiJson<{
    summary_title: string;
    summary_text: string;
    narration_sections: string[];
    key_points: string[];
    takeaway: string;
  }>({
    apiKey: params.apiKey,
    file: params.pdfFile,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    prompt: [
      buildStudyIntentPrompt(params.course.name, params.week.title),
      "Senden oldukça detaylı, hacimli ve pedagojik bir sesli konu anlatımı istiyorum.",
      "Bu anlatım öğrencinin sınav öncesi yalnızca dinleyerek konuyu tekrar etmesine yardımcı olmalı.",
      "Bölümdeki her önemli bilgiyi atlamadan, öğrencinin sadece bu anlatımı dinleyerek konuyu büyük ölçüde kavrayabileceği bir akış kur.",
      "summary_title: en fazla 8 kelime olsun.",
      "summary_text: 4 veya 5 paragrafta, toplam yaklaşık 220-320 kelime olsun.",
      `narration_sections: tam ${AUDIO_NARRATION_SECTION_COUNT} bölüm üret; her bölüm tek bir string olsun; her bölüm seslendirilmeye uygun, akıcı, doğal ve ayrıntılı bir anlatım içersin; madde işareti kullanma; her bölüm yaklaşık 350-430 kelime olsun; toplam anlatım en az yaklaşık 20 dakikalık bir ders tekrarı hissi vermeli.`,
      "key_points: sınav öncesi tekrar için 6 kısa ve yüksek değerli hatırlatma maddesi ver.",
      "takeaway: öğrencinin aklında kalması gereken en önemli ana fikri tek ama güçlü bir cümleyle yaz.",
      "Yalnızca PDF'deki bilgiye dayan. Emin olmadığın bilgi ekleme.",
    ].join("\n"),
  });

  const audioBuffer = await generateSpeechWav({
    apiKey: params.apiKey,
    segments: [
      `${params.week.title} için sesli özet başlıyor.`,
      ...summary.narration_sections.map(
        (section, index) => `Bölüm ${index + 1}. ${section}`,
      ),
      `Ana çıkarım: ${summary.takeaway}`,
    ],
  });

  const generated = await upsertGeneratedMaterial({
    client: params.client,
    userId: params.userId,
    courseId: params.course.id,
    week: params.week,
    fileType: "audio",
    fileName: `hafta-${params.week.week_index + 1}-sesli-ozet.wav`,
    mimeType: "audio/wav",
    buffer: audioBuffer,
    existingMaterials: params.materials,
  });

  return {
    kind: "audio_summary" as const,
    material: generated.material,
    replacedExisting: generated.replacedExisting,
    summaryText: summary.summary_text,
  };
}

async function generateInfographic(params: {
  apiKey: string;
  pdfFile: UploadedGeminiFile;
  course: CourseRow;
  week: WeekRow;
  client: SupabaseClient;
  userId: string;
  materials: MaterialRow[];
}) {
  const spec = await generateGeminiJson<GeneratedInfographicSpec>({
    apiKey: params.apiKey,
    file: params.pdfFile,
    schema: INFOGRAPHIC_SCHEMA as unknown as Record<string, unknown>,
    prompt: [
      buildStudyIntentPrompt(params.course.name, params.week.title),
      "Senden tek infografik üzerinden tüm konuyu tekrar ettirecek kadar dolu, ayrıntılı ama görsel olarak okunabilir bir Türkçe infografik planı istiyorum.",
      "headline kısa ve güçlü olsun.",
      "subtitle en fazla 2 cümle olsun ve konunun kapsamını özetlesin.",
      "4 bölüm üret; her bölümde tam 3 madde olsun.",
      "Bu 4 bölüm birlikte konunun tamamını kapsasın; temel kavramlar, ayrımlar, mekanizmalar, şartlar ve sınavda karışabilecek noktalar görünür olsun.",
      "Maddeler kısa ama bilgi yoğun olsun; tekrar amaçlı bakıldığında hatırlatıcı değer taşısın.",
      "takeaway tek cümlelik güçlü bir özet olsun.",
      "Sadece PDF'deki içeriğe dayan.",
    ].join("\n"),
  });

  const pngBuffer = await renderInfographicPng({
    courseName: params.course.name,
    weekLabel: `Hafta ${params.week.week_index + 1}`,
    spec,
  });

  const generated = await upsertGeneratedMaterial({
    client: params.client,
    userId: params.userId,
    courseId: params.course.id,
    week: params.week,
    fileType: "infographic",
    fileName: `hafta-${params.week.week_index + 1}-infografik.png`,
    mimeType: "image/png",
    buffer: pngBuffer,
    existingMaterials: params.materials,
  });

  return {
    kind: "infographic" as const,
    material: generated.material,
    replacedExisting: generated.replacedExisting,
  };
}

function filterDuplicateFlashcards(
  generatedItems: Array<{ front: string; back: string }>,
  existingItems: FlashcardRow[],
) {
  const existingSet = new Set(existingItems.map((item) => normalizeText(item.front)));
  const nextItems: Array<{ front: string; back: string }> = [];
  const localSet = new Set<string>();

  for (const item of generatedItems) {
    const key = normalizeText(item.front);
    if (!key || existingSet.has(key) || localSet.has(key)) {
      continue;
    }
    localSet.add(key);
    nextItems.push(item);
  }

  return {
    items: nextItems,
    skippedDuplicates: generatedItems.length - nextItems.length,
  };
}

function filterDuplicateQuestions<T extends { question: string }>(generatedItems: T[], existingItems: T[]) {
  const existingSet = new Set(existingItems.map((item) => normalizeText(item.question)));
  const nextItems: T[] = [];
  const localSet = new Set<string>();

  for (const item of generatedItems) {
    const key = normalizeText(item.question);
    if (!key || existingSet.has(key) || localSet.has(key)) {
      continue;
    }
    localSet.add(key);
    nextItems.push(item);
  }

  return {
    items: nextItems,
    skippedDuplicates: generatedItems.length - nextItems.length,
  };
}

async function generateFlashcards(params: {
  apiKey: string;
  pdfFile: UploadedGeminiFile;
  course: CourseRow;
  week: WeekRow;
  client: SupabaseClient;
  options?: AutomationOptions;
}) {
  const count = clampCount("flashcards", params.options?.count);
  const difficulty = normalizeDifficulty(params.options?.difficulty);
  const generated = await generateGeminiJson<{
    items: Array<{ front: string; back: string }>;
  }>({
    apiKey: params.apiKey,
    file: params.pdfFile,
    schema: buildFlashcardSchema(count) as unknown as Record<string, unknown>,
    prompt: [
      buildStudyIntentPrompt(params.course.name, params.week.title),
      `Senden oldukça detaylı ve hacimli ama gereksiz olmayan tam ${count} adet bilgi kartı istiyorum.`,
      buildDifficultyInstruction("flashcards", difficulty),
      "Kartlar öğrencinin konuyu hızlıca öğrenmesine ve pekiştirmesine yardım etsin.",
      "Tanım, ilke, unsur, şart, karşılaştırma, mekanizma, sonuç ve örnek türlerinde dengeli dağılım kur.",
      "front kısa ve net olsun; back açıklayıcı olsun ama 4 cümleyi geçmesin.",
      "Birbirini tekrar eden veya sadece farklı kelimelerle aynı şeyi soran kartlar üretme.",
      "Sadece PDF'deki bilgiye dayan.",
    ].join("\n"),
  });

  const { data: existingRows } = await params.client
    .from("flashcards")
    .select("*")
    .eq("course_id", params.course.id)
    .eq("week_index", params.week.week_index);

  const filtered = filterDuplicateFlashcards(
    generated.items ?? [],
    (existingRows as FlashcardRow[] | null) ?? [],
  );

  if (filtered.items.length === 0) {
    return {
      kind: "flashcards" as const,
      items: [],
      skippedDuplicates: filtered.skippedDuplicates,
    };
  }

  const { data, error } = await params.client
    .from("flashcards")
    .insert(
      filtered.items.map((item) => ({
        course_id: params.course.id,
        week_index: params.week.week_index,
        front: item.front.trim(),
        back: item.back.trim(),
      })),
    )
    .select();

  if (error) {
    throw error;
  }

  return {
    kind: "flashcards" as const,
    items: (data as FlashcardRow[] | null) ?? [],
    skippedDuplicates: filtered.skippedDuplicates,
  };
}

async function generateTestQuestions(params: {
  apiKey: string;
  pdfFile: UploadedGeminiFile;
  course: CourseRow;
  week: WeekRow;
  client: SupabaseClient;
  options?: AutomationOptions;
}) {
  const count = clampCount("test_questions", params.options?.count);
  const difficulty = normalizeDifficulty(params.options?.difficulty);
  const generated = await generateGeminiJson<{
    items: Array<{ question: string; options: string[]; correct_index: number }>;
  }>({
    apiKey: params.apiKey,
    file: params.pdfFile,
    schema: buildTestSchema(count) as unknown as Record<string, unknown>,
    prompt: [
      buildStudyIntentPrompt(params.course.name, params.week.title),
      `Senden ${params.course.name} dersinin "${params.week.title}" konusu için öğrenmeyi pekiştirecek ve alt başlıkların tamamını kapsayacak tam ${count} çoktan seçmeli soru istiyorum.`,
      buildDifficultyInstruction("test_questions", difficulty),
      "Her soruda 4 seçenek olsun ve yalnızca 1 doğru cevap bulunsun.",
      "Soruların bir kısmı temel kavrayışı, bir kısmı ayrım yapma becerisini, bir kısmı da yorumlama becerisini ölçsün.",
      "Seçenekler açık, tutarlı ve öğretici olsun; yapay veya anlamsız çeldirici kurma.",
      "Sorular konu kapsamını dengeli dağıtsın; aynı alt noktayı tekrar tekrar sorma.",
      "correct_index değerini 0 ile 3 arasında ver.",
      "Sadece PDF'deki bilgiye dayan.",
    ].join("\n"),
  });

  const { data: existingRows } = await params.client
    .from("test_questions")
    .select("*")
    .eq("course_id", params.course.id)
    .eq("week_index", params.week.week_index);

  const filtered = filterDuplicateQuestions(
    (generated.items ?? []).map((item) => ({
      question: item.question,
      options: (item.options ?? []).slice(0, 4),
      correct_index: Number(item.correct_index ?? 0),
    })),
    ((existingRows as TestQuestionRow[] | null) ?? []).map((item) => ({
      ...item,
      options: item.options as string[],
    })),
  );

  if (filtered.items.length === 0) {
    return {
      kind: "test_questions" as const,
      items: [],
      skippedDuplicates: filtered.skippedDuplicates,
    };
  }

  const { data, error } = await params.client
    .from("test_questions")
    .insert(
      filtered.items.map((item) => ({
        course_id: params.course.id,
        week_index: params.week.week_index,
        question: item.question.trim(),
        options: item.options.map((option) => option.trim()),
        correct_index: Math.max(0, Math.min(3, Number(item.correct_index ?? 0))),
      })),
    )
    .select();

  if (error) {
    throw error;
  }

  return {
    kind: "test_questions" as const,
    items:
      ((data as TestQuestionRow[] | null) ?? []).map((item) => ({
        ...item,
        options: item.options as string[],
      })) ?? [],
    skippedDuplicates: filtered.skippedDuplicates,
  };
}

async function generateOpenEndedQuestions(params: {
  apiKey: string;
  pdfFile: UploadedGeminiFile;
  course: CourseRow;
  week: WeekRow;
  client: SupabaseClient;
  options?: AutomationOptions;
}) {
  const count = clampCount("open_ended_questions", params.options?.count);
  const difficulty = normalizeDifficulty(params.options?.difficulty);
  const generated = await generateGeminiJson<{
    items: Array<{ question: string; answer: string }>;
  }>({
    apiKey: params.apiKey,
    file: params.pdfFile,
    schema: buildOpenEndedSchema(count) as unknown as Record<string, unknown>,
    prompt: [
      buildStudyIntentPrompt(params.course.name, params.week.title),
      `Senden ${params.course.name} dersinin "${params.week.title}" konusu için tam ${count} açık uçlu soru istiyorum.`,
      buildDifficultyInstruction("open_ended_questions", difficulty),
      "Sorular açıklama, karşılaştırma, yorum ve analiz gerektirsin.",
      "Her soruya 3-5 cümlelik model cevap yaz.",
      "Sorular birlikte konunun farklı yönlerini kapsasın ve birbirini tekrar etmesin.",
      "Sadece PDF'deki bilgiye dayan.",
    ].join("\n"),
  });

  const { data: existingRows } = await params.client
    .from("open_ended_questions")
    .select("*")
    .eq("course_id", params.course.id)
    .eq("week_index", params.week.week_index);

  const filtered = filterDuplicateQuestions(
    (generated.items ?? []).map((item) => ({
      question: item.question,
      answer: item.answer,
    })),
    ((existingRows as OpenEndedQuestionRow[] | null) ?? []).map((item) => ({
      question: item.question,
      answer: item.answer ?? "",
    })),
  );

  if (filtered.items.length === 0) {
    return {
      kind: "open_ended_questions" as const,
      items: [],
      skippedDuplicates: filtered.skippedDuplicates,
    };
  }

  const { data, error } = await params.client
    .from("open_ended_questions")
    .insert(
      filtered.items.map((item) => ({
        course_id: params.course.id,
        week_index: params.week.week_index,
        question: item.question.trim(),
        answer: item.answer.trim() || null,
      })),
    )
    .select();

  if (error) {
    throw error;
  }

  return {
    kind: "open_ended_questions" as const,
    items: (data as OpenEndedQuestionRow[] | null) ?? [],
    skippedDuplicates: filtered.skippedDuplicates,
  };
}

export async function generateAutomationArtifact(params: {
  kind: AutomationKind;
  courseId: number;
  weekIndex: number;
  userId: string;
  client: SupabaseClient;
  options?: AutomationOptions;
}) {
  const apiKey = process.env.GEMINI_API_KEY ?? null;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY tanımlı olmadığı için otomatik üretim çalıştırılamadı.");
  }

  const context = await loadWeekContext(params.courseId, params.weekIndex, params.client);
  if (!context.pdfMaterial) {
    throw new Error("Bu hafta için önce bir PDF materyali yüklemen gerekiyor.");
  }

  const pdfFile = await uploadPdfMaterialToGemini(params.client, context.pdfMaterial, apiKey);

  switch (params.kind) {
    case "audio_summary":
      return generateAudioSummary({
        apiKey,
        pdfFile,
        course: context.course,
        week: context.week,
        client: params.client,
        userId: params.userId,
        materials: context.materials,
      });
    case "infographic":
      return generateInfographic({
        apiKey,
        pdfFile,
        course: context.course,
        week: context.week,
        client: params.client,
        userId: params.userId,
        materials: context.materials,
      });
    case "flashcards":
      return generateFlashcards({
        apiKey,
        pdfFile,
        course: context.course,
        week: context.week,
        client: params.client,
        options: params.options,
      });
    case "test_questions":
      return generateTestQuestions({
        apiKey,
        pdfFile,
        course: context.course,
        week: context.week,
        client: params.client,
        options: params.options,
      });
    case "open_ended_questions":
      return generateOpenEndedQuestions({
        apiKey,
        pdfFile,
        course: context.course,
        week: context.week,
        client: params.client,
        options: params.options,
      });
    default:
      throw new Error("Bilinmeyen otomasyon isteği.");
  }
}
