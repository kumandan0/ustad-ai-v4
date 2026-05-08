import type { SupabaseClient } from "@supabase/supabase-js";
import { queryTable, readStoredFile, type QueryScope } from "@/lib/server/store";
import { parseMaterialFileUrl, type StorageProvider } from "@/lib/storage/shared";

type ChatMode = "general" | "materials";

type Message = {
  role?: string;
  content?: string;
};

type CourseRow = {
  id: number;
  name: string;
  description?: string;
  system_prompt?: string;
};

type WeekRow = {
  course_id: number;
  week_index: number;
  title: string;
};

type MaterialRow = {
  id: number;
  course_id: number;
  week_index: number;
  file_type: "pdf" | "audio" | "infographic";
  file_name: string;
  file_url: string;
  mime_type?: string | null;
  storage_provider?: StorageProvider | null;
  storage_file_id?: string | null;
};

type MaterialSelection = MaterialRow & {
  weekTitle: string;
  score: number;
};

type GeminiTextPart = { text: string };
type GeminiFilePart = {
  file_data: {
    mime_type: string;
    file_uri: string;
  };
};

type GeminiPart = GeminiTextPart | GeminiFilePart;

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type UploadedGeminiFile = {
  uri: string;
  mimeType: string;
};

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_API_BASE =
  process.env.GEMINI_UPLOAD_API_BASE ?? "https://generativelanguage.googleapis.com/upload/v1beta";
const GEMINI_GENERAL_MODEL = process.env.GEMINI_GENERAL_MODEL ?? "gemini-2.5-flash";
const GEMINI_MATERIALS_MODEL =
  process.env.GEMINI_MATERIALS_MODEL ?? process.env.GEMINI_GENERAL_MODEL ?? "gemini-2.5-flash";
const MAX_SELECTED_MATERIALS = 5;

const TURKISH_CHAR_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  İ: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

function normalizeText(value: string) {
  return value
    .replace(/[çğıİöşü]/g, (char) => TURKISH_CHAR_MAP[char] ?? char)
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreMaterial(question: string, weekTitle: string, fileName: string, weekIndex: number) {
  const normalizedQuestion = normalizeText(question);
  const haystack = normalizeText(`${weekTitle} ${fileName}`);
  const tokens = tokenize(question);
  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += weekTitle.toLocaleLowerCase("tr-TR").includes(token) ? 4 : 2;
    }
  }

  if (normalizedQuestion.includes(`hafta ${weekIndex + 1}`)) {
    score += 6;
  }

  return score;
}

function mapMessagesToGeminiContents(messages: Message[]) {
  return messages
    .filter((message) => typeof message.content === "string" && message.content.trim().length > 0)
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content) }],
    })) as GeminiContent[];
}

function withAugmentedLastUserMessage(
  contents: GeminiContent[],
  extraParts: GeminiPart[],
  fallbackQuestion: string,
): GeminiContent[] {
  if (extraParts.length === 0) {
    return contents;
  }

  const nextContents: GeminiContent[] = [...contents];

  for (let index = nextContents.length - 1; index >= 0; index -= 1) {
    const content = nextContents[index];
    if (content.role !== "user") {
      continue;
    }

    nextContents[index] = {
      ...content,
      parts: [...extraParts, ...content.parts],
    };
    return nextContents;
  }

  return [
    ...nextContents,
    {
      role: "user",
      parts: [...extraParts, { text: fallbackQuestion || "Bu materyalleri kullanarak soruyu yanıtla." }],
    },
  ];
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

async function buildMaterialScopedContext(
  courseId: number,
  question: string,
  client: SupabaseClient,
) {
  const [materialsData, weeksData, courseData] = await Promise.all([
    queryTable({
      action: "select",
      table: "materials",
      filters: [{ column: "course_id", value: courseId }],
      client,
    }) as Promise<MaterialRow[]>,
    queryTable({
      action: "select",
      table: "weeks",
      filters: [{ column: "course_id", value: courseId }],
      orderColumn: "week_index",
      client,
    }) as Promise<WeekRow[]>,
    queryTable({
      action: "select",
      table: "courses",
      filters: [{ column: "id", value: courseId }],
      returnSingle: true,
      client,
    }) as Promise<CourseRow | null>,
  ]);

  const weeksByIndex = new Map(
    weeksData.map((week) => [Number(week.week_index), String(week.title || "").trim()]),
  );

  const selectedMaterials = [...materialsData]
    .map((material) => {
      const weekIndex = Number(material.week_index);
      const weekTitle = weeksByIndex.get(weekIndex) ?? `Hafta ${weekIndex + 1}`;
      return {
        ...material,
        weekTitle,
        score: scoreMaterial(question, weekTitle, material.file_name, weekIndex),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.week_index - right.week_index;
    })
    .slice(0, MAX_SELECTED_MATERIALS);

  const contextSummary =
    selectedMaterials.length > 0
      ? selectedMaterials
          .map(
            (material) =>
              `- Hafta ${Number(material.week_index) + 1}: ${material.weekTitle} | ${material.file_type.toUpperCase()} | ${material.file_name}`,
          )
          .join("\n")
      : "Bu ders için henüz yüklenmiş materyal bulunmuyor.";

  return {
    courseName: courseData?.name ?? "Bu ders",
    selectedMaterials,
    contextSummary,
  };
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
      extractGeminiError(startPayload) || "Gemini dosya yukleme istegi basarisiz oldu.",
    );
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini dosya yukleme baglantisi alinamadi.");
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
      extractGeminiError(uploadPayload) || "Gemini dosyasi tamamlanamadi.",
    );
  }

  const file = uploadPayload?.file ?? uploadPayload;
  const uri = file?.uri;
  const responseMimeType = file?.mimeType ?? file?.mime_type ?? mimeType;

  if (typeof uri !== "string" || !uri) {
    throw new Error("Gemini dosya URI bilgisi dondurmedi.");
  }

  return {
    uri,
    mimeType: String(responseMimeType),
  } satisfies UploadedGeminiFile;
}

async function uploadSelectedMaterials(
  apiKey: string,
  materials: MaterialSelection[],
  client: SupabaseClient,
) {
  const uploadedFiles: UploadedGeminiFile[] = [];
  const skippedNotes: string[] = [];

  for (const material of materials) {
    const location = parseMaterialFileUrl(material.file_url);
    if (!location) {
      skippedNotes.push(`${material.file_name}: dosya konumu cozumlenemedi.`);
      continue;
    }

    try {
      const storedFile = await readStoredFile({
        client,
        bucket: location.bucket,
        filePath: material.storage_file_id || location.filePath,
        provider: material.storage_provider,
        contentType: material.mime_type,
      });
      const upload = await uploadGeminiFile(
        apiKey,
        material.file_name,
        storedFile.contentType,
        storedFile.buffer,
      );
      uploadedFiles.push(upload);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Materyal Gemini'ye aktarilamadi.";
      skippedNotes.push(`${material.file_name}: ${message}`);
    }
  }

  return { uploadedFiles, skippedNotes };
}

async function generateGeminiResponse(params: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: GeminiContent[];
}) {
  const response = await fetch(`${GEMINI_API_BASE}/models/${params.model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: params.systemInstruction }],
      },
      contents: params.contents,
      generationConfig: {
        responseMimeType: "text/plain",
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      extractGeminiError(payload) || "Gemini yaniti alinamadi. Lutfen tekrar dene.",
    );
  }

  const text = extractGeminiText(payload);
  if (text) {
    return text;
  }

  throw new Error(
    extractGeminiError(payload) || "Gemini yaniti bos dondu. Lutfen soruyu yeniden dene.",
  );
}

async function persistChatExchange(params: {
  client: SupabaseClient;
  scope: QueryScope;
  courseId?: number | null;
  mode: ChatMode;
  userMessage: string;
  assistantMessage: string;
}) {
  if (!params.userMessage.trim() || !params.assistantMessage.trim()) {
    return;
  }

  const { data: thread } = await params.client
    .from("chat_threads")
    .insert({
      user_id: params.scope.userId,
      course_id: params.courseId ?? null,
      mode: params.mode,
      title: params.userMessage.slice(0, 120),
    })
    .select("id")
    .single();

  if (!thread?.id) {
    return;
  }

  await params.client.from("chat_messages").insert([
    {
      thread_id: thread.id,
      user_id: params.scope.userId,
      role: "user",
      content: params.userMessage,
    },
    {
      thread_id: thread.id,
      user_id: params.scope.userId,
      role: "assistant",
      content: params.assistantMessage,
    },
  ]);
}

export async function createChatReply(params: {
  messages: Message[];
  systemPrompt?: string;
  mode?: ChatMode;
  courseId?: number | null;
  scope: QueryScope;
  client: SupabaseClient;
}) {
  const messages = params.messages ?? [];
  const systemPrompt = (params.systemPrompt ?? "").trim();
  const mode = params.mode ?? "general";
  const apiKey = process.env.GEMINI_API_KEY ?? null;
  const lastUserMessage =
    [...messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";

  if (!apiKey) {
    if (mode === "materials" && params.courseId) {
      const scoped = await buildMaterialScopedContext(params.courseId, lastUserMessage, params.client);
      const message = [
        "Bu projede iki sohbet modu hazir, ancak gercek AI yanitlari icin `GEMINI_API_KEY` henuz tanimli degil.",
        "Materyal modu bu derste kullanabilecegi kaynaklari tespit etti:",
        scoped.contextSummary,
        "Anahtari bagladigimizda bu mod yalnizca bu materyallere dayanarak yanit verecek.",
      ].join("\n\n");
      await persistChatExchange({
        client: params.client,
        scope: params.scope,
        courseId: params.courseId,
        mode,
        userMessage: lastUserMessage,
        assistantMessage: message,
      });
      return message;
    }

    const message = [
      "Bu projede gercek AI sohbet altyapisi hazir, ancak `GEMINI_API_KEY` henuz tanimli degil.",
      "Anahtar eklendiginde hem Genel AI hem de Ders Materyalleri modu platform icinde aktif calisacak.",
    ].join("\n\n");
    await persistChatExchange({
      client: params.client,
      scope: params.scope,
      courseId: params.courseId,
      mode,
      userMessage: lastUserMessage,
      assistantMessage: message,
    });
    return message;
  }

  const geminiContents = mapMessagesToGeminiContents(messages);

  if (mode === "materials") {
    if (!params.courseId) {
      const message = "Materyal modunu kullanmak icin once bir ders secili olmali.";
      await persistChatExchange({
        client: params.client,
        scope: params.scope,
        courseId: params.courseId,
        mode,
        userMessage: lastUserMessage,
        assistantMessage: message,
      });
      return message;
    }

    const scoped = await buildMaterialScopedContext(
      params.courseId,
      lastUserMessage,
      params.client,
    );


    if (scoped.selectedMaterials.length === 0) {
      const message =
        "Bu ders icin henuz yuklenmis PDF, ses veya infografik materyali yok. Once mufredat bolumunden materyal ekleyebilirsin.";
      await persistChatExchange({
        client: params.client,
        scope: params.scope,
        courseId: params.courseId,
        mode,
        userMessage: lastUserMessage,
        assistantMessage: message,
      });
      return message;
    }

    const { uploadedFiles, skippedNotes } = await uploadSelectedMaterials(
      apiKey,
      scoped.selectedMaterials,
      params.client,
    );

    if (uploadedFiles.length === 0) {
      const message = [
        "Materyal modu secilen dosyalari AI tarafina aktaramadigi icin bu soruyu su an yanitlayamadi.",
        "Istenen materyaller:",
        scoped.contextSummary,
        skippedNotes.length > 0 ? `Sorunlar:\n- ${skippedNotes.join("\n- ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      await persistChatExchange({
        client: params.client,
        scope: params.scope,
        courseId: params.courseId,
        mode,
        userMessage: lastUserMessage,
        assistantMessage: message,
      });
      return message;
    }

    const contextParts: GeminiPart[] = [
      {
        text: [
          `${scoped.courseName} dersi icin secilen materyaller bunlardir.`,
          "Bu materyaller senin tek bilgi kaynagin olacak.",
          `Secilen materyal ozeti:\n${scoped.contextSummary}`,
          skippedNotes.length > 0
            ? `Bu istekte kullanilamayan materyaller:\n- ${skippedNotes.join("\n- ")}`
            : "",
          "Yalnizca sana verilen materyallere dayanarak cevap ver. Materyallerde yeterli bilgi yoksa bunu acikca soyle.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...uploadedFiles.map((file) => ({
        file_data: {
          mime_type: file.mimeType,
          file_uri: file.uri,
        },
      })),
    ];

    const materialInstructions = [
      "Sen yalnizca kullanicinin sectigi ders materyallerine dayanarak yanit veren bir egitim asistanisin.",
      "Cevaplarini Turkce ver.",
      "Materyaller disinda bilgi uydurma; eksikse bunu acikca belirt.",
      "Mumkun oldugunda cevabinda hangi hafta veya materyale dayandigini kisaca belirt.",
      systemPrompt ? `Ders yonergesi: ${systemPrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const contents: GeminiContent[] = withAugmentedLastUserMessage(
      geminiContents,
      contextParts,
      lastUserMessage,
    );

    const reply = await generateGeminiResponse({
      apiKey,
      model: GEMINI_MATERIALS_MODEL,
      systemInstruction: materialInstructions,
      contents,
    });

    const finalReply = reply || "Bu materyallere dayanarak net bir yanit uretemedim.";
    await persistChatExchange({
      client: params.client,
      scope: params.scope,
      courseId: params.courseId,
      mode,
      userMessage: lastUserMessage,
      assistantMessage: finalReply,
    });
    return finalReply;
  }

  const generalInstructions = [
    "Sen Turkce yanit veren yardimsever bir egitim asistanisin.",
    systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const reply = await generateGeminiResponse({
    apiKey,
    model: GEMINI_GENERAL_MODEL,
    systemInstruction: generalInstructions,
    contents: geminiContents,
  });

  const finalReply = reply || "Bu soru icin yanit uretemedim.";
  await persistChatExchange({
    client: params.client,
    scope: params.scope,
    courseId: params.courseId,
    mode,
    userMessage: lastUserMessage,
    assistantMessage: finalReply,
  });
  return finalReply;
}
