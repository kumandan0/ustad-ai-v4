"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ChangeEvent,
  type ElementType,
} from "react";
import { useRouter } from "next/navigation";
import {
  Send,
  Plus,
  Activity,
  Target,
  BarChart2,
  MessageSquare,
  LayoutList,
  FileText,
  Headphones,
  CheckCircle,
  X,
  Play,
  Eye,
  Trash2,
  GraduationCap,
  ChevronRight,
  Layers,
  ClipboardList,
  PenLine,
  Upload,
  Shuffle,
  Edit2,
  Save,
  BookOpen,
  ChevronDown,
  BookMarked,
  PlusCircle,
  ImageIcon,
  Shield,
  Users,
  LogOut,
  Sparkles,
} from "lucide-react";
import {
  createClient,
  deleteStoredFileUrl,
  MATERIAL_STORAGE_BUCKET,
  resolveStoredFileUrl,
} from "@/lib/supabase/client";

interface Course {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  syllabus: string[];
  created_at?: string;
}

interface Week {
  id: number;
  course_id: number;
  week_index: number;
  title: string;
}

interface Flashcard {
  id: number;
  course_id: number;
  week_index: number;
  front: string;
  back: string;
}

interface TestQuestion {
  id: number;
  course_id: number;
  week_index: number;
  question: string;
  options: string[];
  correct_index: number;
}

interface OpenEndedQuestion {
  id: number;
  course_id: number;
  week_index: number;
  question: string;
  answer: string | null;
}

interface Material {
  id: number;
  course_id: number;
  week_id?: number | null;
  week_index: number;
  file_type: "pdf" | "audio" | "infographic";
  file_name: string;
  file_url: string;
  mime_type?: string | null;
  storage_provider?: "local" | "supabase" | "google_drive" | "koofr" | null;
  storage_file_id?: string | null;
  preview_url?: string | null;
}

type MaterialFileType = Material["file_type"];
type WeekMaterials = Partial<Record<MaterialFileType, Material>>;
type ChatMode = "general" | "materials";
type AutomationKind =
  | "audio_summary"
  | "infographic"
  | "flashcards"
  | "test_questions"
  | "open_ended_questions";
type AutomationDifficulty = "easy" | "medium" | "hard";
type QuestionAutomationKind = Extract<
  AutomationKind,
  "flashcards" | "test_questions" | "open_ended_questions"
>;

interface LearningGoal {
  id: number;
  course_id: number;
  week_index: number;
  label: string;
  topic_title: string;
  custom_label: boolean;
  progress: number;
  correct_answers: number;
  total_questions: number;
  last_attempt_at?: string;
}

interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "student";
  ai_pro_enabled: boolean;
  created_at?: string;
}

interface AdminUserSummary extends SessionUser {
  course_count: number;
}

interface AdminInviteSummary {
  id: number;
  code: string;
  email: string | null;
  role: "admin" | "student";
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  is_active: boolean;
  created_at?: string;
}

const DEFAULT_ASSISTANT_PROMPT = "Sen yardımsever bir öğretmen asistanısın. Türkçe yanıt ver.";
const ACTIVE_COURSE_STORAGE_KEY = "ustad-ai-active-course-id";
const BOOTSTRAP_SESSION_KEY_PREFIX = "ustad-ai-bootstrap";
const BOOTSTRAP_FLOW_VERSION = "v3";

const QUESTION_AUTOMATION_DEFAULTS: Record<
  QuestionAutomationKind,
  { count: number; min: number; max: number; label: string }
> = {
  flashcards: { count: 14, min: 4, max: 30, label: "bilgi kartı" },
  test_questions: { count: 12, min: 4, max: 24, label: "test sorusu" },
  open_ended_questions: { count: 6, min: 2, max: 12, label: "açık uçlu soru" },
};

const AUTOMATION_DIFFICULTY_LABELS: Record<AutomationDifficulty, string> = {
  easy: "Kolay",
  medium: "Orta",
  hard: "Zor",
};

const buildCourseSyllabus = (weeks: number) =>
  Array.from({ length: weeks }, (_, index) => `Hafta ${index + 1} Konusu`);

const sanitizeStorageSegment = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";

const buildWeeksPayload = (courseId: number, syllabus: string[]) =>
  syllabus.map((title, index) => ({
    course_id: courseId,
    week_index: index,
    title,
  }));

const buildLearningGoalsPayload = (courseId: number, syllabus: string[]) =>
  syllabus.map((title, index) => ({
    course_id: courseId,
    week_index: index,
    label: title,
    topic_title: title,
    custom_label: false,
    progress: 0,
    correct_answers: 0,
    total_questions: 0,
  }));

const parseCSV = (line: string) => {
  const result: string[] = [];
  let cur = "";
  let inQ = false;

  for (const c of line) {
    if (c === '"') {
      inQ = !inQ;
    } else if (c === "," && !inQ) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }

  result.push(cur.trim());
  return result;
};

const sortLearningGoals = (goals: LearningGoal[]) =>
  [...goals].sort((left, right) => left.week_index - right.week_index);

const getAssessmentVisual = (progress: number, totalQuestions: number, availableQuestions: number) => {
  if (availableQuestions === 0) {
    return {
      label: "Test yok",
      badgeBg: "#f3f4f6",
      badgeColor: "#6b7280",
      barColor: "#cbd5e1",
    };
  }

  if (totalQuestions === 0) {
    return {
      label: "Ölçülmedi",
      badgeBg: "#eef2ff",
      badgeColor: "#6366f1",
      barColor: "#c7d2fe",
    };
  }

  if (progress < 50) {
    return {
      label: "Geliştirilmeli",
      badgeBg: "#fee2e2",
      badgeColor: "#b91c1c",
      barColor: "#dc2626",
    };
  }

  if (progress < 70) {
    return {
      label: "Orta",
      badgeBg: "#fef3c7",
      badgeColor: "#b45309",
      barColor: "#d97706",
    };
  }

  if (progress < 85) {
    return {
      label: "İyi",
      badgeBg: "#dbeafe",
      badgeColor: "#1d4ed8",
      barColor: "#2563eb",
    };
  }

  return {
    label: "Çok iyi",
    badgeBg: "#dcfce7",
    badgeColor: "#15803d",
    barColor: "#16a34a",
  };
};

export default function UstadAI() {
  const supabaseRef = useRef<any>(null);
  const courseLoadRequestRef = useRef(0);
  const router = useRouter();
  if (!supabaseRef.current) {
    supabaseRef.current = createClient();
  }
  const supabase = supabaseRef.current;

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authForm, setAuthForm] = useState({
    name: "",
    email: "",
    password: "",
    inviteCode: "",
    acceptedKvkk: false,
    acceptedTerms: false,
    marketingConsent: false,
  });
  const [legalModal, setLegalModal] = useState<{
    isOpen: boolean;
    title: string;
    url: string;
  }>({ isOpen: false, title: "", url: "" });
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [adminInvites, setAdminInvites] = useState<AdminInviteSummary[]>([]);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [proAccessLoadingUserId, setProAccessLoadingUserId] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({ email: "", expiresInDays: 7 });
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState<AdminUserSummary | null>(null);
  const [adminPasswordForm, setAdminPasswordForm] = useState({ password: "", confirmPassword: "" });
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordModalMode, setPasswordModalMode] = useState<"change" | "recovery">("change");
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [resendConfirmationSubmitting, setResendConfirmationSubmitting] = useState(false);
  const [forgotPasswordModalOpen, setForgotPasswordModalOpen] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState("");
  const [forgotPasswordSubmitting, setForgotPasswordSubmitting] = useState(false);

  const [courses, setCourses] = useState<Course[]>([]);
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null);
  const [courseDropOpen, setCourseDropOpen] = useState(false);
  const [addCourseModal, setAddCourseModal] = useState(false);
  const [newCourse, setNewCourse] = useState({
    name: "",
    description: "",
    system_prompt: "",
    weeks: 14,
  });

  const [activeTab, setActiveTab] = useState("curriculum");
  const [expandedExamWeek, setExpandedExamWeek] = useState<number | null>(null);
  const [examView, setExamView] = useState<{ weekIndex: number; type: string } | null>(null);

  const [weeks, setWeeks] = useState<Week[]>([]);
  const [flashcards, setFlashcards] = useState<Record<number, Flashcard[]>>({});
  const [testQuestions, setTestQuestions] = useState<Record<number, TestQuestion[]>>({});
  const [openEndedQuestions, setOpenEndedQuestions] = useState<
    Record<number, OpenEndedQuestion[]>
  >({});
  const [materials, setMaterials] = useState<Record<number, WeekMaterials>>({});
  const [learningGoals, setLearningGoals] = useState<LearningGoal[]>([]);

  const [editingWeek, setEditingWeek] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [addModal, setAddModal] = useState<{
    isOpen: boolean;
    type: string | null;
    weekIndex: number;
  }>({ isOpen: false, type: null, weekIndex: 0 });
  const [flashcardForm, setFlashcardForm] = useState({ front: "", back: "" });
  const [testForm, setTestForm] = useState({
    question: "",
    options: ["", "", "", ""],
    correctIndex: 0,
  });
  const [openEndedForm, setOpenEndedForm] = useState({ question: "", answer: "" });

  const [editingOE, setEditingOE] = useState<OpenEndedQuestion | null>(null);
  const [editOEForm, setEditOEForm] = useState({ question: "", answer: "" });

  const [editingGoal, setEditingGoal] = useState<LearningGoal | null>(null);
  const [editGoalForm, setEditGoalForm] = useState({ label: "" });

  const [previewModal, setPreviewModal] = useState<{
    isOpen: boolean;
    type: MaterialFileType | null;
    url: string;
    name: string;
    weekIndex: number;
    loading: boolean;
  }>({ isOpen: false, type: null, url: "", name: "", weekIndex: 0, loading: false });
  const [playMode, setPlayMode] = useState<{
    weekIndex: number;
    cards: Flashcard[];
    currentIndex: number;
    flipped: boolean;
  } | null>(null);
  const [testMode, setTestMode] = useState<{
    weekIndex: number;
    questions: TestQuestion[];
    currentIndex: number;
    selected: number | null;
    score: number;
    done: boolean;
  } | null>(null);

  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("general");
  const [automationLoading, setAutomationLoading] = useState<Record<string, boolean>>({});
  const [automationConfigModal, setAutomationConfigModal] = useState<{
    isOpen: boolean;
    kind: QuestionAutomationKind | null;
    weekIndex: number;
    count: number;
    difficulty: AutomationDifficulty;
  }>({
    isOpen: false,
    kind: null,
    weekIndex: 0,
    count: QUESTION_AUTOMATION_DEFAULTS.flashcards.count,
    difficulty: "medium",
  });
  const [loading, setLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [stats, setStats] = useState({ messages: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeCourse = courses.find((course) => course.id === activeCourseId) ?? null;
  const isAdmin = sessionUser?.role === "admin";
  const canUseAutomation = Boolean(sessionUser && (sessionUser.role === "admin" || sessionUser.ai_pro_enabled));

  const resetWorkspaceState = useCallback(() => {
    setCourses([]);
    setActiveCourseId(null);
    setWeeks([]);
    setFlashcards({});
    setTestQuestions({});
    setOpenEndedQuestions({});
    setMaterials({});
    setLearningGoals([]);
    setMessages([]);
    setInput("");
    setExamView(null);
    setExpandedExamWeek(null);
    setPreviewModal({
      isOpen: false,
      type: null,
      url: "",
      name: "",
      weekIndex: 0,
      loading: false,
    });
    setPlayMode(null);
    setTestMode(null);
    setCourseDropOpen(false);
    setAddCourseModal(false);
    setAdminUsers([]);
    setAdminInvites([]);
    setAdminModalOpen(false);
    setResetPasswordUser(null);
    setPasswordModalOpen(false);
    setPasswordModalMode("change");
    setForgotPasswordModalOpen(false);
    setForgotPasswordEmail("");
    setAutomationLoading({});
    setAutomationConfigModal({
      isOpen: false,
      kind: null,
      weekIndex: 0,
      count: QUESTION_AUTOMATION_DEFAULTS.flashcards.count,
      difficulty: "medium",
    });
  }, []);

  const buildAutomationKey = useCallback(
    (kind: AutomationKind, weekIndex: number) => `${kind}:${weekIndex}`,
    [],
  );

  const openQuestionAutomationModal = useCallback(
    (kind: QuestionAutomationKind, weekIndex: number) => {
      if (!canUseAutomation) {
        alert("AI ile otomatik üretim Pro özelliğidir. Bu hesap için henüz aktif değil.");
        return;
      }

      const defaults = QUESTION_AUTOMATION_DEFAULTS[kind];
      setAutomationConfigModal({
        isOpen: true,
        kind,
        weekIndex,
        count: defaults.count,
        difficulty: "medium",
      });
    },
    [canUseAutomation],
  );

  const fetchJsonWithTimeout = useCallback(
    async <T,>(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 8000): Promise<T> => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(input, {
          cache: "no-store",
          ...init,
          signal: controller.signal,
        });

        return (await response.json().catch(() => ({}))) as T;
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [],
  );

  const fetchSession = useCallback(async () => {
    setAuthLoading(true);

    try {
      const payload = await fetchJsonWithTimeout<{
        user?: SessionUser | null;
      }>("/api/auth/session");

      setSessionUser(payload.user ?? null);
    } catch {
      setSessionUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, [fetchJsonWithTimeout]);

  const showResendConfirmationAction =
    authMode === "login" &&
    authForm.email.trim().length > 0 &&
    ((authNotice && authNotice.toLocaleLowerCase("tr-TR").includes("doğrula")) ||
      (authError && authError.toLocaleLowerCase("tr-TR").includes("doğrula")));

  const handleAuthSubmit = useCallback(async () => {
    const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    setAuthSubmitting(true);
    setAuthError("");
    setAuthNotice("");

    if (authMode === "register" && (!authForm.acceptedKvkk || !authForm.acceptedTerms)) {
      setAuthError("Devam etmek için zorunlu onay kutularını işaretlemelisin.");
      setAuthSubmitting(false);
      return;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...authForm,
          inviteCode: "",
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        user?: SessionUser | null;
        requiresEmailConfirmation?: boolean;
        email?: string;
        error?: string;
      };

      if (!response.ok) {
        setAuthError(payload.error || "İşlem tamamlanamadı.");
        return;
      }

      if (authMode === "register" && payload.requiresEmailConfirmation) {
        setAuthMode("login");
        setAuthForm((prev) => ({
          ...prev,
          name: "",
          email: payload.email || prev.email,
          password: "",
          inviteCode: "",
          acceptedKvkk: false,
          acceptedTerms: false,
          marketingConsent: false,
        }));
        setAuthNotice(
          "Hesabın oluşturuldu. E-postana gönderdiğimiz doğrulama bağlantısına tıkladıktan sonra giriş yapabilirsin.",
        );
        return;
      }

      if (!payload.user) {
        setAuthError("İşlem tamamlanamadı.");
        return;
      }

      resetWorkspaceState();
      setSessionUser(payload.user);
      setAuthForm({
        name: "",
        email: "",
        password: "",
        inviteCode: "",
        acceptedKvkk: false,
        acceptedTerms: false,
        marketingConsent: false,
      });
      setAuthMode("login");
      setActiveTab("curriculum");
      setChatMode("general");
    } catch {
      setAuthError("Bağlantı kurulamadı. Lütfen tekrar deneyin.");
    } finally {
      setAuthSubmitting(false);
    }
  }, [authForm, authMode, resetWorkspaceState]);

  const handleResendConfirmation = useCallback(async () => {
    if (!authForm.email.trim()) {
      setAuthError("Doğrulama e-postasını yeniden göndermek için e-posta adresini gir.");
      return;
    }

    setResendConfirmationSubmitting(true);
    setAuthError("");
    setAuthNotice("");

    try {
      const response = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authForm.email }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Doğrulama e-postası yeniden gönderilemedi.");
      }

      setAuthNotice(
        "Doğrulama bağlantısını yeniden gönderdik. E-postanı kontrol ettikten sonra giriş yapabilirsin.",
      );
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Doğrulama e-postası yeniden gönderilemedi.",
      );
    } finally {
      setResendConfirmationSubmitting(false);
    }
  }, [authForm.email]);

  const handleForgotPasswordRequest = useCallback(async () => {
    if (!forgotPasswordEmail.trim()) {
      setAuthError("Şifre yenileme bağlantısı göndermek için e-posta adresini gir.");
      return;
    }

    setForgotPasswordSubmitting(true);
    setAuthError("");
    setAuthNotice("");

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotPasswordEmail }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Şifre yenileme e-postası gönderilemedi.");
      }

      setForgotPasswordModalOpen(false);
      setAuthMode("login");
      setAuthForm((prev) => ({
        ...prev,
        email: forgotPasswordEmail.trim(),
      }));
      setAuthNotice(
        "Bu e-posta adresiyle bir hesap varsa, şifre yenileme bağlantısı gönderildi. Gelen kutunu kontrol edebilirsin.",
      );
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Şifre yenileme e-postası gönderilemedi.",
      );
    } finally {
      setForgotPasswordSubmitting(false);
    }
  }, [forgotPasswordEmail]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }

    resetWorkspaceState();
    setSessionUser(null);
    setAuthMode("login");
    setAuthNotice("");
    setPasswordModalMode("change");
    setAuthForm({
      name: "",
      email: "",
      password: "",
      inviteCode: "",
      acceptedKvkk: false,
      acceptedTerms: false,
      marketingConsent: false,
    });
    setAuthError("");
    setDataLoading(false);
  }, [resetWorkspaceState]);

  const loadAdminPanel = useCallback(async () => {
    setAdminLoading(true);

    try {
      const [usersResponse, invitesResponse] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/invites"),
      ]);
      const usersPayload = (await usersResponse.json().catch(() => ({}))) as {
        users?: AdminUserSummary[];
        error?: string;
      };
      const invitesPayload = (await invitesResponse.json().catch(() => ({}))) as {
        invites?: AdminInviteSummary[];
        error?: string;
      };

      if (!usersResponse.ok) {
        throw new Error(usersPayload.error || "Üye listesi yüklenemedi.");
      }

      if (!invitesResponse.ok) {
        throw new Error(invitesPayload.error || "Davet listesi yüklenemedi.");
      }

      setAdminUsers(usersPayload.users ?? []);
      setAdminInvites(invitesPayload.invites ?? []);
      setAdminModalOpen(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Admin paneli yüklenemedi.");
    } finally {
      setAdminLoading(false);
    }
  }, []);

  const handleCreateInvite = useCallback(async () => {
    setInviteSubmitting(true);

    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inviteForm),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        invite?: AdminInviteSummary;
        error?: string;
      };

      if (!response.ok || !payload.invite) {
        throw new Error(payload.error || "Davet oluşturulamadı.");
      }

      setInviteForm({ email: "", expiresInDays: 7 });
      await loadAdminPanel();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Davet oluşturulamadı.");
    } finally {
      setInviteSubmitting(false);
    }
  }, [inviteForm, loadAdminPanel]);

  const handleRevokeInvite = useCallback(async (inviteId: number) => {
    try {
      const response = await fetch("/api/admin/invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Davet iptal edilemedi.");
      }

      await loadAdminPanel();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Davet iptal edilemedi.");
    }
  }, [loadAdminPanel]);

  const handleDeleteUser = useCallback(async (userId: string) => {
    if (!confirm("Bu kullanıcıyı silmek istediğine emin misin? Tüm ders verileri de silinecek.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kullanıcı silinemedi.");
      }

      await loadAdminPanel();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Kullanıcı silinemedi.");
    }
  }, [loadAdminPanel]);

  const handleToggleAutomationProAccess = useCallback(
    async (userId: string, enabled: boolean) => {
      setProAccessLoadingUserId(userId);

      try {
        const response = await fetch("/api/admin/users/pro", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, enabled }),
        });

        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Pro erişim güncellenemedi.");
        }

        await loadAdminPanel();
      } catch (error) {
        alert(error instanceof Error ? error.message : "Pro erişim güncellenemedi.");
      } finally {
        setProAccessLoadingUserId(null);
      }
    },
    [loadAdminPanel],
  );

  const handleAdminPasswordReset = useCallback(async () => {
    if (!resetPasswordUser) {
      return;
    }

    if (
      !adminPasswordForm.password ||
      adminPasswordForm.password !== adminPasswordForm.confirmPassword
    ) {
      alert("Yeni şifre alanları aynı olmalı.");
      return;
    }

    try {
      const response = await fetch("/api/admin/users/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: resetPasswordUser.id,
          newPassword: adminPasswordForm.password,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Şifre sıfırlanamadı.");
      }

      setResetPasswordUser(null);
      setAdminPasswordForm({ password: "", confirmPassword: "" });
      alert("Şifre başarıyla sıfırlandı.");
    } catch (error) {
      alert(error instanceof Error ? error.message : "Şifre sıfırlanamadı.");
    }
  }, [adminPasswordForm, resetPasswordUser]);

  const handleChangePassword = useCallback(async () => {
    if (!passwordForm.newPassword || passwordForm.newPassword !== passwordForm.confirmPassword) {
      setAuthError("Yeni şifre alanları aynı olmalı.");
      return;
    }

    if (passwordModalMode === "change" && !passwordForm.currentPassword) {
      setAuthError("Mevcut şifreni girmelisin.");
      return;
    }

    setPasswordSubmitting(true);
    setAuthError("");

    try {
      const response = await fetch(
        passwordModalMode === "recovery"
          ? "/api/auth/password/recovery"
          : "/api/auth/password",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword:
            passwordModalMode === "change" ? passwordForm.currentPassword : undefined,
          newPassword: passwordForm.newPassword,
        }),
        },
      );

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Şifre değiştirilemedi.");
      }

      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordModalOpen(false);
      setPasswordModalMode("change");
      alert(
        passwordModalMode === "recovery"
          ? "Şifren yenilendi. Yeni şifrenle hesabını kullanabilirsin."
          : "Şifren güncellendi.",
      );
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Şifre değiştirilemedi.");
    } finally {
      setPasswordSubmitting(false);
    }
  }, [passwordForm, passwordModalMode]);

  const syncLearningGoals = useCallback(
    async (courseId: number, weeksList: Week[]) => {
      const { data: goalsData } = await supabase
        .from("learning_goals")
        .select()
        .eq("course_id", courseId)
        .order("week_index");

      const existingGoals = ((goalsData as Partial<LearningGoal>[] | null) ?? []).map((goal) => ({
        ...goal,
        week_index: Number(goal.week_index),
      }));

      const hasWeekBasedGoals =
        existingGoals.length === weeksList.length &&
        existingGoals.every((goal) => Number.isInteger(goal.week_index));

      if (!hasWeekBasedGoals) {
        if (existingGoals.length > 0) {
          await supabase.from("learning_goals").delete().eq("course_id", courseId);
        }

        const defaultGoals = weeksList.map((week) => ({
          course_id: courseId,
          week_index: week.week_index,
          label: week.title,
          topic_title: week.title,
          custom_label: false,
          progress: 0,
          correct_answers: 0,
          total_questions: 0,
        }));

        const { data: insertedGoals } = await supabase
          .from("learning_goals")
          .insert(defaultGoals)
          .select();

        setLearningGoals(
          sortLearningGoals(
            ((insertedGoals as LearningGoal[] | null) ?? []).map((goal) => ({
              ...goal,
              week_index: Number(goal.week_index),
              topic_title: String(goal.topic_title ?? goal.label ?? ""),
              custom_label: Boolean(goal.custom_label),
              progress: Number(goal.progress ?? 0),
              correct_answers: Number(goal.correct_answers ?? 0),
              total_questions: Number(goal.total_questions ?? 0),
            })),
          ),
        );
        return;
      }

      const normalizedGoals = sortLearningGoals(
        existingGoals.map((goal) => {
          const matchingWeek = weeksList.find((week) => week.week_index === goal.week_index);
          const topicTitle =
            matchingWeek?.title ??
            String(goal.topic_title ?? goal.label ?? `Hafta ${goal.week_index + 1}`);
          const customLabel =
            typeof goal.custom_label === "boolean"
              ? goal.custom_label
              : typeof goal.label === "string" && goal.label.trim().length > 0 && goal.label !== topicTitle;

          return {
            id: Number(goal.id),
            course_id: courseId,
            week_index: goal.week_index,
            label:
              customLabel && typeof goal.label === "string" && goal.label.trim().length > 0
                ? goal.label
                : topicTitle,
            topic_title: topicTitle,
            custom_label: customLabel,
            progress: Number(goal.progress ?? 0),
            correct_answers: Number(goal.correct_answers ?? 0),
            total_questions: Number(goal.total_questions ?? 0),
            last_attempt_at:
              typeof goal.last_attempt_at === "string" ? goal.last_attempt_at : undefined,
          };
        }),
      );

      const updates = normalizedGoals.flatMap((goal) => {
        const original = existingGoals.find((item) => Number(item.id) === goal.id);
        if (!original) {
          return [];
        }

        const payload: Partial<LearningGoal> = {};
        if (original.label !== goal.label) {
          payload.label = goal.label;
        }
        if (original.topic_title !== goal.topic_title) {
          payload.topic_title = goal.topic_title;
        }
        if (original.custom_label !== goal.custom_label) {
          payload.custom_label = goal.custom_label;
        }
        if (original.correct_answers === undefined) {
          payload.correct_answers = goal.correct_answers;
        }
        if (original.total_questions === undefined) {
          payload.total_questions = goal.total_questions;
        }

        if (Object.keys(payload).length === 0) {
          return [];
        }

        return [supabase.from("learning_goals").update(payload).eq("id", goal.id)];
      });

      if (updates.length > 0) {
        await Promise.all(updates);
      }

      setLearningGoals(normalizedGoals);
    },
    [supabase],
  );

  const loadCourses = useCallback(async () => {
    const { data } = await supabase.from("courses").select().order("created_at");

    if (data && data.length > 0) {
      const parsed = data.map((course) => ({
        ...course,
        syllabus:
          typeof course.syllabus === "string"
            ? (JSON.parse(course.syllabus) as string[])
            : ((course.syllabus as string[]) ?? []),
      })) as Course[];

      setCourses(parsed);
      const storedCourseId =
        typeof window !== "undefined"
          ? Number(window.localStorage.getItem(ACTIVE_COURSE_STORAGE_KEY))
          : Number.NaN;

      setActiveCourseId((currentCourseId) => {
        const preferredCourseId =
          currentCourseId ??
          (Number.isInteger(storedCourseId) ? storedCourseId : null);

        if (
          preferredCourseId !== null &&
          parsed.some((course) => course.id === preferredCourseId)
        ) {
          return preferredCourseId;
        }

        return parsed[0].id;
      });
      return true;
    }
    setCourses([]);
    setActiveCourseId(null);
    return false;
  }, [supabase]);

  const resolveMaterialPreviewUrl = useCallback(async (material: Material) => {
    const resolvedUrl = await resolveStoredFileUrl(String(material.file_url ?? ""));
    return resolvedUrl || material.preview_url || String(material.file_url ?? "");
  }, []);

  const prefetchMaterialPreview = useCallback(
    async (material: Material, weekIndex: number) => {
      const previewUrl = await resolveMaterialPreviewUrl(material);

      setMaterials((prev) => {
        const currentWeek = prev[weekIndex] ?? {};
        const currentMaterial = currentWeek[material.file_type] ?? material;

        return {
          ...prev,
          [weekIndex]: {
            ...currentWeek,
            [material.file_type]: {
              ...currentMaterial,
              preview_url: previewUrl,
            },
          },
        };
      });

      return previewUrl;
    },
    [resolveMaterialPreviewUrl],
  );

  const openMaterialPreview = useCallback(
    async (material: Material) => {
      setPreviewModal({
        isOpen: true,
        type: material.file_type,
        url: "",
        name: material.file_name,
        weekIndex: material.week_index,
        loading: true,
      });

      try {
        const previewUrl = await prefetchMaterialPreview(material, material.week_index);
        setPreviewModal((prev) =>
          prev.isOpen &&
          prev.weekIndex === material.week_index &&
          prev.type === material.file_type
            ? {
                ...prev,
                url: previewUrl,
                loading: false,
              }
            : prev,
        );
      } catch (error) {
        console.error(error);
        setPreviewModal((prev) =>
          prev.isOpen &&
          prev.weekIndex === material.week_index &&
          prev.type === material.file_type
            ? {
                ...prev,
                url: material.preview_url || String(material.file_url ?? ""),
                loading: false,
              }
            : prev,
        );
      }
    },
    [prefetchMaterialPreview],
  );

  const loadCourseData = useCallback(
    async (courseId: number) => {
      const requestId = courseLoadRequestRef.current + 1;
      courseLoadRequestRef.current = requestId;
      const isStale = () => courseLoadRequestRef.current !== requestId;

      setDataLoading(true);

      try {
        let resolvedWeeks: Week[] = [];

        const { data: weeksData } = await supabase
          .from("weeks")
          .select()
          .eq("course_id", courseId)
          .order("week_index");

        if (isStale()) {
          return;
        }

        if (weeksData && weeksData.length > 0) {
          resolvedWeeks = weeksData as Week[];
          setWeeks(resolvedWeeks);
        } else {
          const course = courses.find((item) => item.id === courseId);
          if (course) {
            const defaultWeeks = course.syllabus.map((title, index) => ({
              course_id: courseId,
              week_index: index,
              title,
            }));
            const { data: insertedWeeks } = await supabase.from("weeks").insert(defaultWeeks).select();
            if (isStale()) {
              return;
            }
            if (insertedWeeks) {
              resolvedWeeks = insertedWeeks as Week[];
              setWeeks(resolvedWeeks);
            }
          }
        }

        const { data: flashcardsData } = await supabase
          .from("flashcards")
          .select()
          .eq("course_id", courseId)
          .order("created_at");

        if (isStale()) {
          return;
        }

        if (flashcardsData) {
          const grouped: Record<number, Flashcard[]> = {};
          flashcardsData.forEach((flashcard) => {
            if (!grouped[Number(flashcard.week_index)]) {
              grouped[Number(flashcard.week_index)] = [];
            }
            grouped[Number(flashcard.week_index)].push(flashcard as Flashcard);
          });
          setFlashcards(grouped);
        } else {
          setFlashcards({});
        }

        const { data: testsData } = await supabase
          .from("test_questions")
          .select()
          .eq("course_id", courseId)
          .order("created_at");

        if (isStale()) {
          return;
        }

        if (testsData) {
          const grouped: Record<number, TestQuestion[]> = {};
          testsData.forEach((question) => {
            const weekIndex = Number(question.week_index);
            if (!grouped[weekIndex]) {
              grouped[weekIndex] = [];
            }
            grouped[weekIndex].push({
              ...(question as TestQuestion),
              options: (question.options as string[]) ?? [],
            });
          });
          setTestQuestions(grouped);
        } else {
          setTestQuestions({});
        }

        const { data: openEndedData } = await supabase
          .from("open_ended_questions")
          .select()
          .eq("course_id", courseId)
          .order("created_at");

        if (isStale()) {
          return;
        }

        if (openEndedData) {
          const grouped: Record<number, OpenEndedQuestion[]> = {};
          openEndedData.forEach((question) => {
            const weekIndex = Number(question.week_index);
            if (!grouped[weekIndex]) {
              grouped[weekIndex] = [];
            }
            grouped[weekIndex].push(question as OpenEndedQuestion);
          });
          setOpenEndedQuestions(grouped);
        } else {
          setOpenEndedQuestions({});
        }

        const { data: materialsData } = await supabase
          .from("materials")
          .select()
          .eq("course_id", courseId);

        if (isStale()) {
          return;
        }

        if (materialsData) {
          const grouped: Record<number, WeekMaterials> = {};
          (materialsData as Material[]).forEach((material) => {
            const weekIndex = Number(material.week_index);
            if (!grouped[weekIndex]) {
              grouped[weekIndex] = {};
            }
            grouped[weekIndex][material.file_type as MaterialFileType] = {
              ...(material as Material),
              preview_url: null,
            };
          });
          setMaterials(grouped);

          void Promise.all(
            (materialsData as Material[]).map(async (material) => ({
              material,
              previewUrl: await resolveMaterialPreviewUrl(material),
            })),
          )
            .then((resolvedMaterials) => {
              if (isStale()) {
                return;
              }

              setMaterials((prev) => {
                const next = { ...prev };

                resolvedMaterials.forEach(({ material, previewUrl }) => {
                  const weekIndex = Number(material.week_index);
                  const currentWeek = next[weekIndex] ?? {};
                  const currentMaterial =
                    currentWeek[material.file_type as MaterialFileType] ?? material;

                  next[weekIndex] = {
                    ...currentWeek,
                    [material.file_type]: {
                      ...currentMaterial,
                      preview_url: previewUrl,
                    },
                  };
                });

                return next;
              });
            })
            .catch((error) => {
              if (!isStale()) {
                console.error(error);
              }
            });
        } else {
          setMaterials({});
        }

        if (resolvedWeeks.length > 0) {
          await syncLearningGoals(courseId, resolvedWeeks);
          if (isStale()) {
            return;
          }
        } else {
          setLearningGoals([]);
        }
      } catch (error) {
        if (!isStale()) {
          console.error(error);
        }
      } finally {
        if (!isStale()) {
          setDataLoading(false);
        }
      }
    },
    [courses, resolveMaterialPreviewUrl, supabase, syncLearningGoals],
  );

  useEffect(() => {
    let cancelled = false;

    const loadSession = () => {
      if (!cancelled) {
        void fetchSession();
      }
    };

    loadSession();

    return () => {
      cancelled = true;
    };
  }, [fetchSession]);

  useEffect(() => {
    if (authLoading || typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    const authStatus = url.searchParams.get("auth");
    const message = url.searchParams.get("message");

    if (!authStatus && !message) {
      return;
    }

    if (authStatus === "recovery") {
      setAuthMode("login");
      setAuthError("");
      setAuthNotice("Bağlantı doğrulandı. Şimdi yeni şifreni belirleyebilirsin.");
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordModalMode("recovery");
      setPasswordModalOpen(true);
      setForgotPasswordModalOpen(false);
    } else if (!sessionUser) {
      if (authStatus === "verified") {
        setAuthMode("login");
        setAuthError("");
        setAuthNotice("E-posta adresin doğrulandı. Şimdi giriş yapabilirsin.");
      } else if (authStatus === "error") {
        setAuthNotice("");
        setAuthMode("login");
        setAuthError(
          message ||
            "E-posta doğrulaması tamamlanamadı. Lütfen bağlantıyı yeniden deneyin.",
        );
      }
    }

    url.searchParams.delete("auth");
    url.searchParams.delete("message");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [authLoading, router, sessionUser]);

  useEffect(() => {
    let cancelled = false;

    if (authLoading) {
      return () => {
        cancelled = true;
      };
    }

    if (!sessionUser) {
      resetWorkspaceState();
      setDataLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const loadInitialCourses = async () => {
      if (!cancelled) {
        setDataLoading(true);
        const bootstrapKey =
          typeof window !== "undefined"
            ? `${BOOTSTRAP_SESSION_KEY_PREFIX}:${sessionUser.id}:${BOOTSTRAP_FLOW_VERSION}`
            : "";
        const hasBootstrapMarker =
          typeof window !== "undefined" &&
          bootstrapKey.length > 0 &&
          window.sessionStorage.getItem(bootstrapKey) === "1";

        const runBootstrap = async () => {
          try {
            await fetchJsonWithTimeout<{ user?: SessionUser | null }>(
              "/api/auth/bootstrap",
              { method: "POST" },
              15000,
            );
            if (typeof window !== "undefined" && bootstrapKey.length > 0) {
              window.sessionStorage.setItem(bootstrapKey, "1");
            }
          } catch (error) {
            console.error(error);
          }
        };

        const hasCourses = await loadCourses();
        if (cancelled) {
          return;
        }

        if (hasCourses) {
          setDataLoading(false);
          if (!hasBootstrapMarker) {
            void runBootstrap();
          }
          return;
        }

        if (!hasBootstrapMarker) {
          await runBootstrap();
          if (cancelled) {
            return;
          }
        }

        const hasCoursesAfterBootstrap = await loadCourses();
        if (cancelled) {
          return;
        }

        setDataLoading(false);
        if (!hasCoursesAfterBootstrap) {
          setAddCourseModal(true);
        }
      }
    };

    void loadInitialCourses();

    return () => {
      cancelled = true;
    };
  }, [authLoading, sessionUser, loadCourses, resetWorkspaceState]);

  useEffect(() => {
    if (sessionUser && activeCourseId !== null && courses.length > 0) {
      setWeeks([]);
      setFlashcards({});
      setTestQuestions({});
      setOpenEndedQuestions({});
      setMaterials({});
      setLearningGoals([]);
      setMessages([]);
      setExamView(null);
      setExpandedExamWeek(null);
      setPreviewModal({
        isOpen: false,
        type: null,
        url: "",
        name: "",
        weekIndex: 0,
        loading: false,
      });
      setPlayMode(null);
      setTestMode(null);
      void loadCourseData(activeCourseId);
    }
  }, [sessionUser, activeCourseId, courses.length, loadCourseData]);

  useEffect(() => {
    if (activeCourseId === null || typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ACTIVE_COURSE_STORAGE_KEY, String(activeCourseId));
  }, [activeCourseId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const getWeekTitle = (weekIndex: number) => {
    const week = weeks.find((item) => item.week_index === weekIndex);
    if (week) {
      return week.title;
    }

    return activeCourse?.syllabus[weekIndex] ?? `Hafta ${weekIndex + 1}`;
  };

  const weekCount = activeCourse?.syllabus.length ?? 14;

  const saveAssessmentResult = useCallback(
    async (weekIndex: number, correctAnswers: number, totalQuestions: number) => {
      if (!activeCourseId || totalQuestions <= 0) {
        return;
      }

      const matchingWeek = weeks.find((week) => week.week_index === weekIndex);
      const topicTitle =
        matchingWeek?.title ?? activeCourse?.syllabus[weekIndex] ?? `Hafta ${weekIndex + 1}`;
      const progress = Math.round((correctAnswers / totalQuestions) * 100);
      const payload = {
        topic_title: topicTitle,
        progress,
        correct_answers: correctAnswers,
        total_questions: totalQuestions,
        last_attempt_at: new Date().toISOString(),
      };

      const existingGoal = learningGoals.find((goal) => goal.week_index === weekIndex);

      if (existingGoal) {
        const nextGoal = existingGoal.custom_label
          ? { ...existingGoal, ...payload }
          : { ...existingGoal, ...payload, label: topicTitle };
        await supabase
          .from("learning_goals")
          .update(existingGoal.custom_label ? payload : { ...payload, label: topicTitle })
          .eq("id", existingGoal.id);
        setLearningGoals((prev) =>
          sortLearningGoals(prev.map((goal) => (goal.id === existingGoal.id ? nextGoal : goal))),
        );
        return;
      }

      const { data, error } = await supabase
        .from("learning_goals")
        .insert({
          course_id: activeCourseId,
          week_index: weekIndex,
          label: topicTitle,
          custom_label: false,
          ...payload,
        })
        .select()
        .single();

      if (!error && data) {
        setLearningGoals((prev) =>
          sortLearningGoals([
            ...prev,
            {
              ...(data as LearningGoal),
              week_index: Number(data.week_index),
              topic_title: String(data.topic_title ?? data.label ?? ""),
              custom_label: Boolean(data.custom_label),
              progress: Number(data.progress ?? 0),
              correct_answers: Number(data.correct_answers ?? 0),
              total_questions: Number(data.total_questions ?? 0),
            },
          ]),
        );
      }
    },
    [activeCourse, activeCourseId, learningGoals, supabase, weeks],
  );

  const handleAddCourse = async () => {
    if (!newCourse.name.trim()) {
      return;
    }

    const weekCount = Math.min(30, Math.max(1, Number(newCourse.weeks) || 14));
    const syllabus = buildCourseSyllabus(weekCount);

    const { data, error } = await supabase
      .from("courses")
      .insert({
        name: newCourse.name.trim(),
        description: newCourse.description.trim(),
        system_prompt: newCourse.system_prompt.trim() || DEFAULT_ASSISTANT_PROMPT,
        syllabus: JSON.stringify(syllabus),
      })
      .select()
      .single();

    if (!error && data) {
      const courseId = Number(data.id);
      await Promise.allSettled([
        supabase.from("weeks").insert(buildWeeksPayload(courseId, syllabus)),
        supabase.from("learning_goals").insert(buildLearningGoalsPayload(courseId, syllabus)),
      ]);

      const parsed = { ...(data as Course), syllabus } as Course;
      setCourses((prev) => [...prev, parsed]);
      setActiveCourseId(parsed.id);
      setActiveTab("curriculum");
    } else {
      alert("Ders oluşturulamadı. Lütfen tekrar deneyin.");
    }

    setNewCourse({ name: "", description: "", system_prompt: "", weeks: 14 });
    setAddCourseModal(false);
  };

  const handleDeleteCourse = async (id: number) => {
    if (!confirm("Bu dersi silmek istediğine emin misin? Tüm içerikler silinecek.")) {
      return;
    }

    await supabase.from("courses").delete().eq("id", id);
    const remaining = courses.filter((course) => course.id !== id);
    setCourses(remaining);

    if (activeCourseId === id) {
      setActiveCourseId(remaining[0]?.id ?? null);
    }
  };

  const updateWeekTitle = async (weekIndex: number, newTitle: string) => {
    if (!activeCourseId) {
      return;
    }

    await supabase
      .from("weeks")
      .update({ title: newTitle })
      .eq("course_id", activeCourseId)
      .eq("week_index", weekIndex);

    const matchingGoal = learningGoals.find((goal) => goal.week_index === weekIndex);
    if (matchingGoal) {
      await supabase
        .from("learning_goals")
        .update(
          matchingGoal.custom_label
            ? { topic_title: newTitle }
            : { label: newTitle, topic_title: newTitle },
        )
        .eq("id", matchingGoal.id);
    }

    setWeeks((prev) =>
      prev.map((week) => (week.week_index === weekIndex ? { ...week, title: newTitle } : week)),
    );
    setLearningGoals((prev) =>
      sortLearningGoals(
        prev.map((goal) =>
          goal.week_index === weekIndex
            ? goal.custom_label
              ? { ...goal, topic_title: newTitle }
              : { ...goal, label: newTitle, topic_title: newTitle }
            : goal,
        ),
      ),
    );
    setEditingWeek(null);
  };

  const addFlashcard = async () => {
    if (!flashcardForm.front.trim() || !flashcardForm.back.trim() || !activeCourseId) {
      return;
    }

    const { data, error } = await supabase
      .from("flashcards")
      .insert({
        course_id: activeCourseId,
        week_index: addModal.weekIndex,
        front: flashcardForm.front,
        back: flashcardForm.back,
      })
      .select()
      .single();

    if (!error && data) {
      setFlashcards((prev) => ({
        ...prev,
        [addModal.weekIndex]: [...(prev[addModal.weekIndex] || []), data as Flashcard],
      }));
    }

    setFlashcardForm({ front: "", back: "" });
    setAddModal({ isOpen: false, type: null, weekIndex: 0 });
  };

  const deleteFlashcard = async (weekIndex: number, id: number) => {
    await supabase.from("flashcards").delete().eq("id", id);
    setFlashcards((prev) => ({
      ...prev,
      [weekIndex]: prev[weekIndex].filter((card) => card.id !== id),
    }));
  };

  const addTestQuestion = async () => {
    if (!testForm.question.trim() || testForm.options.some((option) => !option.trim()) || !activeCourseId) {
      return;
    }

    const { data, error } = await supabase
      .from("test_questions")
      .insert({
        course_id: activeCourseId,
        week_index: addModal.weekIndex,
        question: testForm.question,
        options: testForm.options,
        correct_index: testForm.correctIndex,
      })
      .select()
      .single();

    if (!error && data) {
      setTestQuestions((prev) => ({
        ...prev,
        [addModal.weekIndex]: [
          ...(prev[addModal.weekIndex] || []),
          { ...(data as TestQuestion), options: (data.options as string[]) ?? [] },
        ],
      }));
    }

    setTestForm({ question: "", options: ["", "", "", ""], correctIndex: 0 });
    setAddModal({ isOpen: false, type: null, weekIndex: 0 });
  };

  const deleteTestQuestion = async (weekIndex: number, id: number) => {
    await supabase.from("test_questions").delete().eq("id", id);
    setTestQuestions((prev) => ({
      ...prev,
      [weekIndex]: prev[weekIndex].filter((question) => question.id !== id),
    }));
  };

  const addOpenEnded = async () => {
    if (!openEndedForm.question.trim() || !activeCourseId) {
      return;
    }

    const { data, error } = await supabase
      .from("open_ended_questions")
      .insert({
        course_id: activeCourseId,
        week_index: addModal.weekIndex,
        question: openEndedForm.question,
        answer: openEndedForm.answer || null,
      })
      .select()
      .single();

    if (!error && data) {
      setOpenEndedQuestions((prev) => ({
        ...prev,
        [addModal.weekIndex]: [...(prev[addModal.weekIndex] || []), data as OpenEndedQuestion],
      }));
    }

    setOpenEndedForm({ question: "", answer: "" });
    setAddModal({ isOpen: false, type: null, weekIndex: 0 });
  };

  const deleteOpenEnded = async (weekIndex: number, id: number) => {
    await supabase.from("open_ended_questions").delete().eq("id", id);
    setOpenEndedQuestions((prev) => ({
      ...prev,
      [weekIndex]: prev[weekIndex].filter((question) => question.id !== id),
    }));
  };

  const startEditOE = (question: OpenEndedQuestion) => {
    setEditingOE(question);
    setEditOEForm({ question: question.question, answer: question.answer ?? "" });
  };

  const saveEditOE = async () => {
    if (!editingOE) {
      return;
    }

    const { error } = await supabase
      .from("open_ended_questions")
      .update({ question: editOEForm.question, answer: editOEForm.answer || null })
      .eq("id", editingOE.id);

    if (!error) {
      setOpenEndedQuestions((prev) => {
        const weekIndex = editingOE.week_index;
        return {
          ...prev,
          [weekIndex]: prev[weekIndex].map((question) =>
            question.id === editingOE.id
              ? { ...question, question: editOEForm.question, answer: editOEForm.answer || null }
              : question,
          ),
        };
      });
    }

    setEditingOE(null);
  };

  const startEditGoal = (goal: LearningGoal) => {
    setEditingGoal(goal);
    setEditGoalForm({ label: goal.custom_label ? goal.label : "" });
  };

  const saveEditGoal = async () => {
    if (!editingGoal) {
      return;
    }

    const trimmedLabel = editGoalForm.label.trim();
    const customLabel = trimmedLabel.length > 0 && trimmedLabel !== editingGoal.topic_title;
    const nextLabel = customLabel ? trimmedLabel : editingGoal.topic_title;
    const payload = { label: nextLabel, custom_label: customLabel };

    const { error } = await supabase
      .from("learning_goals")
      .update(payload)
      .eq("id", editingGoal.id);

    if (!error) {
      setLearningGoals((prev) =>
        sortLearningGoals(
          prev.map((goal) =>
            goal.id === editingGoal.id ? { ...goal, ...payload, label: nextLabel } : goal,
          ),
        ),
      );
    }

    setEditingGoal(null);
  };

const handleFileUpload = async (
    weekIndex: number,
    fileType: MaterialFileType,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!activeCourseId || !sessionUser) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const selectedWeek = weeks.find((week) => week.week_index === weekIndex);
    if (!selectedWeek) {
      alert("Bu hafta bilgisi henüz yüklenmedi. Lütfen sayfayı yenileyip tekrar deneyin.");
      event.target.value = "";
      return;
    }

    const safeFileName = sanitizeStorageSegment(file.name);
    const filePath = [
      sessionUser.id,
      String(activeCourseId),
      String(selectedWeek.id),
      fileType,
      `${Date.now()}-${safeFileName}`,
    ].join("/");
    const existingMaterial = materials[weekIndex]?.[fileType];

    try {
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(MATERIAL_STORAGE_BUCKET)
        .upload(filePath, file, { courseId: activeCourseId });

      if (uploadError || !uploadData) {
        throw uploadError ?? new Error("Dosya Supabase'e yüklenemedi.");
      }

      const { data, error } = await supabase
        .from("materials")
        .insert({
          course_id: activeCourseId,
          week_id: selectedWeek.id,
          week_index: weekIndex,
          file_type: fileType,
          file_name: file.name,
          file_url: uploadData.publicUrl,
          mime_type: uploadData.contentType || file.type || null,
          storage_provider: "supabase",
          storage_file_id: uploadData.path,
        })
        .select()
        .single();

      if (error || !data) {
        await deleteStoredFileUrl(uploadData.publicUrl);
        throw error ?? new Error("Dosya veritabanına kaydedilemedi.");
      }

      if (existingMaterial?.file_url) {
        await deleteStoredFileUrl(existingMaterial.file_url);
        await supabase.from("materials").delete().eq("id", existingMaterial.id);
      }

      const nextMaterial = {
        ...(data as Material),
        preview_url: null,
      } as Material;

      setMaterials((prev) => ({
        ...prev,
        [weekIndex]: {
          ...prev[weekIndex],
          [fileType]: nextMaterial,
        },
      }));

      void prefetchMaterialPreview(nextMaterial, weekIndex);
    } catch (error) {
      console.error(error);
      alert("Dosya yüklenemedi. Lütfen daha küçük bir dosya deneyin veya sayfayı yenileyip tekrar deneyin.");
    } finally {
      event.target.value = "";
    }
  };

  const handleDeleteFile = async (weekIndex: number, fileType: MaterialFileType) => {
    if (!activeCourseId) {
      return;
    }

    const material = materials[weekIndex]?.[fileType];
    if (!material) {
      return;
    }

    await deleteStoredFileUrl(material.file_url);
    await supabase.from("materials").delete().eq("id", material.id);
    setMaterials((prev) => {
      const updated = { ...prev };
      if (updated[weekIndex]) {
        delete updated[weekIndex][fileType];
        if (
          !updated[weekIndex].audio &&
          !updated[weekIndex].pdf &&
          !updated[weekIndex].infographic
        ) {
          delete updated[weekIndex];
        }
      }
      return updated;
    });
  };

  const handleFlashcardCSV = async (weekIndex: number, event: ChangeEvent<HTMLInputElement>) => {
    if (!activeCourseId) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const text = String(loadEvent.target?.result ?? "");
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const firstLine = lines[0]?.toLowerCase() || "";
      const start =
        firstLine.includes("front") ||
        firstLine.includes("on") ||
        firstLine.includes("ön") ||
        firstLine.includes("soru")
          ? 1
          : 0;

      const cards = lines.slice(start).flatMap((line) => {
        const parts = parseCSV(line);
        return parts[0]?.trim() && parts[1]?.trim()
          ? [
              {
                course_id: activeCourseId,
                week_index: weekIndex,
                front: parts[0].trim(),
                back: parts[1].trim(),
              },
            ]
          : [];
      });

      if (cards.length) {
        const { data, error } = await supabase.from("flashcards").insert(cards).select();
        if (!error && data) {
          setFlashcards((prev) => ({
            ...prev,
            [weekIndex]: [...(prev[weekIndex] || []), ...(data as Flashcard[])],
          }));
          alert(`${cards.length} kart yüklendi.`);
        }
      } else {
        alert("Kart bulunamadı. Format: ön_yüz,arka_yüz");
      }
    };

    reader.readAsText(file, "UTF-8");
    event.target.value = "";
  };

  const handleTestCSV = async (weekIndex: number, event: ChangeEvent<HTMLInputElement>) => {
    if (!activeCourseId) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const text = String(loadEvent.target?.result ?? "");
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const firstLine = lines[0]?.toLowerCase() || "";
      const start = firstLine.includes("soru") || firstLine.includes("question") ? 1 : 0;

      const questions = lines.slice(start).flatMap((line) => {
        const parts = parseCSV(line);
        const parsedIndex = parseInt(parts[5] ?? "", 10);
        const correctIndex =
          !Number.isNaN(parsedIndex) && parsedIndex >= 0 && parsedIndex <= 3 ? parsedIndex : 0;

        return parts[0]?.trim() &&
          parts[1]?.trim() &&
          parts[2]?.trim() &&
          parts[3]?.trim() &&
          parts[4]?.trim()
          ? [
              {
                course_id: activeCourseId,
                week_index: weekIndex,
                question: parts[0].trim(),
                options: [
                  parts[1].trim(),
                  parts[2].trim(),
                  parts[3].trim(),
                  parts[4].trim(),
                ],
                correct_index: correctIndex,
              },
            ]
          : [];
      });

      if (questions.length) {
        const { data, error } = await supabase.from("test_questions").insert(questions).select();
        if (!error && data) {
          setTestQuestions((prev) => ({
            ...prev,
            [weekIndex]: [
              ...(prev[weekIndex] || []),
              ...(data as TestQuestion[]).map((item) => ({
                ...item,
                options: item.options as string[],
              })),
            ],
          }));
          alert(`${questions.length} soru yüklendi.`);
        }
      } else {
        alert("Soru bulunamadı. Format: soru,A,B,C,D,doğruIndex(0-3)");
      }
    };

    reader.readAsText(file, "UTF-8");
    event.target.value = "";
  };

  const handleOpenEndedCSV = async (weekIndex: number, event: ChangeEvent<HTMLInputElement>) => {
    if (!activeCourseId) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const text = String(loadEvent.target?.result ?? "");
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const firstLine = lines[0]?.toLowerCase() || "";
      const start =
        firstLine.includes("soru") ||
        firstLine.includes("question") ||
        firstLine.includes("cevap") ||
        firstLine.includes("answer")
          ? 1
          : 0;

      const questions = lines.slice(start).flatMap((line) => {
        const parts = parseCSV(line);
        const question = parts[0]?.trim();
        const answer = parts[1]?.trim() || null;

        return question
          ? [
              {
                course_id: activeCourseId,
                week_index: weekIndex,
                question,
                answer,
              },
            ]
          : [];
      });

      if (questions.length) {
        const { data, error } = await supabase
          .from("open_ended_questions")
          .insert(questions)
          .select();

        if (!error && data) {
          setOpenEndedQuestions((prev) => ({
            ...prev,
            [weekIndex]: [...(prev[weekIndex] || []), ...(data as OpenEndedQuestion[])],
          }));
          alert(`${questions.length} açık uçlu soru yüklendi.`);
        }
      } else {
        alert("Soru bulunamadı. Format: soru,model_cevap");
      }
    };

    reader.readAsText(file, "UTF-8");
    event.target.value = "";
  };

  const runAutomation = useCallback(
    async (
      kind: AutomationKind,
      weekIndex: number,
      options?: {
        count?: number;
        difficulty?: AutomationDifficulty;
      },
    ) => {
      if (!activeCourseId) {
        return;
      }

      if (!canUseAutomation) {
        alert("AI ile otomatik üretim Pro özelliğidir. Bu hesap için henüz aktif değil.");
        return;
      }

      const requestKey = buildAutomationKey(kind, weekIndex);
      setAutomationLoading((prev) => ({ ...prev, [requestKey]: true }));

      try {
        const response = await fetch("/api/automation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            courseId: activeCourseId,
            weekIndex,
            options,
          }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          data?: {
            kind?: AutomationKind;
            material?: Material;
            replacedExisting?: boolean;
            items?: Array<Flashcard | TestQuestion | OpenEndedQuestion>;
            skippedDuplicates?: number;
          };
          error?: string;
        };

        if (!response.ok || !payload.data?.kind) {
          throw new Error(payload.error || "AI üretimi tamamlanamadı.");
        }

        if (payload.data.kind === "audio_summary" || payload.data.kind === "infographic") {
          const material = payload.data.material;
          if (!material) {
            throw new Error("Üretilen materyal alınamadı.");
          }

          const nextMaterial = {
            ...material,
            preview_url: null,
          } as Material;

          setMaterials((prev) => ({
            ...prev,
            [weekIndex]: {
              ...prev[weekIndex],
              [material.file_type]: nextMaterial,
            },
          }));

          void prefetchMaterialPreview(nextMaterial, weekIndex);

          const label =
            payload.data.kind === "audio_summary" ? "sesli özet" : "infografik";
          alert(
            payload.data.replacedExisting
              ? `AI ${label} üretildi ve mevcut ${label} materyalinin yerine kaydedildi.`
              : `AI ${label} hazır.`,
          );
          return;
        }

        if (payload.data.kind === "flashcards") {
          const items = (payload.data.items as Flashcard[] | undefined) ?? [];
          if (items.length > 0) {
            setFlashcards((prev) => ({
              ...prev,
              [weekIndex]: [...(prev[weekIndex] || []), ...items],
            }));
          }

          const skipped = Number(payload.data.skippedDuplicates ?? 0);
          alert(
            items.length > 0
              ? `${items.length} bilgi kartı üretildi${skipped > 0 ? `, ${skipped} benzer kart atlandı` : ""}.`
              : "Yeni bilgi kartı üretilemedi; benzer kartlar zaten mevcut olabilir.",
          );
          return;
        }

        if (payload.data.kind === "test_questions") {
          const items = ((payload.data.items as TestQuestion[] | undefined) ?? []).map(
            (item) => ({
              ...item,
              options: item.options as string[],
            }),
          );

          if (items.length > 0) {
            setTestQuestions((prev) => ({
              ...prev,
              [weekIndex]: [...(prev[weekIndex] || []), ...items],
            }));
          }

          const skipped = Number(payload.data.skippedDuplicates ?? 0);
          alert(
            items.length > 0
              ? `${items.length} test sorusu üretildi${skipped > 0 ? `, ${skipped} benzer soru atlandı` : ""}.`
              : "Yeni test sorusu üretilemedi; benzer sorular zaten mevcut olabilir.",
          );
          return;
        }

        if (payload.data.kind === "open_ended_questions") {
          const items = (payload.data.items as OpenEndedQuestion[] | undefined) ?? [];
          if (items.length > 0) {
            setOpenEndedQuestions((prev) => ({
              ...prev,
              [weekIndex]: [...(prev[weekIndex] || []), ...items],
            }));
          }

          const skipped = Number(payload.data.skippedDuplicates ?? 0);
          alert(
            items.length > 0
              ? `${items.length} açık uçlu soru üretildi${skipped > 0 ? `, ${skipped} benzer soru atlandı` : ""}.`
              : "Yeni açık uçlu soru üretilemedi; benzer sorular zaten mevcut olabilir.",
          );
        }
      } catch (error) {
        alert(error instanceof Error ? error.message : "AI üretimi tamamlanamadı.");
      } finally {
        setAutomationLoading((prev) => {
          const next = { ...prev };
          delete next[requestKey];
          return next;
        });
      }
    },
    [activeCourseId, buildAutomationKey, canUseAutomation, prefetchMaterialPreview],
  );

  const submitQuestionAutomation = useCallback(async () => {
    if (!automationConfigModal.kind) {
      return;
    }

    const defaults = QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind];
    const normalizedCount = Math.max(
      defaults.min,
      Math.min(defaults.max, Number(automationConfigModal.count) || defaults.count),
    );

    setAutomationConfigModal((prev) => ({
      ...prev,
      isOpen: false,
      count: normalizedCount,
    }));

    await runAutomation(automationConfigModal.kind, automationConfigModal.weekIndex, {
      count: normalizedCount,
      difficulty: automationConfigModal.difficulty,
    });
  }, [automationConfigModal, runAutomation]);

  const sendMessage = async () => {
    if (!input.trim() || loading) {
      return;
    }

    const userMessage = { role: "user", content: input };
    const newMessages = [...messages, userMessage];

    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setStats((prev) => ({ ...prev, messages: prev.messages + 1 }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          systemPrompt: activeCourse?.system_prompt ?? "",
          mode: chatMode,
          courseId: activeCourseId,
        }),
      });
      const data = (await response.json()) as { content?: string };
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.content || "Bir hata oluştu." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Bağlantı hatası oluştu." },
      ]);
    }

    setLoading(false);
  };

  const startFlashcardPlay = (weekIndex: number) => {
    const cards = [...(flashcards[weekIndex] || [])].sort(() => Math.random() - 0.5);
    setPlayMode({ weekIndex, cards, currentIndex: 0, flipped: false });
  };

  const startTestMode = (weekIndex: number) => {
    const questions = [...(testQuestions[weekIndex] || [])].sort(() => Math.random() - 0.5);
    setTestMode({
      weekIndex,
      questions,
      currentIndex: 0,
      selected: null,
      score: 0,
      done: false,
    });
  };

  const handleTestAnswer = (index: number) => {
    if (!testMode || testMode.selected !== null) {
      return;
    }

    const correct = testMode.questions[testMode.currentIndex].correct_index === index;
    setTestMode((prev) =>
      prev
        ? { ...prev, selected: index, score: correct ? prev.score + 1 : prev.score }
        : null,
    );
  };

  const nextTestQuestion = () => {
    if (!testMode) {
      return;
    }

    const next = testMode.currentIndex + 1;
    if (next >= testMode.questions.length) {
      void saveAssessmentResult(testMode.weekIndex, testMode.score, testMode.questions.length);
      setTestMode((prev) => (prev ? { ...prev, done: true } : null));
    } else {
      setTestMode((prev) => (prev ? { ...prev, currentIndex: next, selected: null } : null));
    }
  };

  if (authLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background:
            "radial-gradient(circle at top, rgba(37,99,235,0.12), transparent 32%), #f8fafc",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            background: "#fff",
            borderRadius: 20,
            boxShadow: "0 20px 60px rgba(15,23,42,0.12)",
            padding: 28,
            textAlign: "center",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", fontWeight: 800, fontSize: 24, color: "#1e40af", marginBottom: 16 }}>
            <BookMarked size={22} style={{ marginRight: 8, color: "#2563eb" }} />
            Ustad<span style={{ color: "#2563eb" }}>.ai</span>
          </div>
          <div
            style={{
              width: 48,
              height: 48,
              border: "4px solid #e5e7eb",
              borderTopColor: "#2563eb",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              margin: "0 auto 16px",
            }}
          />
          <p style={{ color: "#6b7280", margin: 0 }}>Oturum hazırlanıyor...</p>
        </div>
      </div>
    );
  }

  if (!sessionUser) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background:
            "radial-gradient(circle at top, rgba(37,99,235,0.16), transparent 30%), linear-gradient(180deg, #eff6ff 0%, #f8fafc 35%, #ffffff 100%)",
        }}
      >
        {legalModal.isOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15,23,42,0.52)",
              zIndex: 70,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 960,
                height: "88vh",
                background: "#fff",
                borderRadius: 24,
                boxShadow: "0 30px 80px rgba(15,23,42,0.22)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "18px 22px",
                  borderBottom: "1px solid #e5e7eb",
                  background: "#fff",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 18, color: "#111827" }}>
                    {legalModal.title}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    Metni okuyup kayıt ekranına geri dönebilirsin.
                  </div>
                </div>
                <button
                  onClick={() => setLegalModal({ isOpen: false, title: "", url: "" })}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#6b7280",
                  }}
                >
                  <X size={22} />
                </button>
              </div>
              <iframe
                src={legalModal.url}
                title={legalModal.title}
                style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
              />
            </div>
          </div>
        )}

        {forgotPasswordModalOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 72,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 420,
                background: "#fff",
                borderRadius: 18,
                boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                <h3 style={{ margin: 0, fontSize: 16 }}>Şifreyi Yenile</h3>
                <button
                  onClick={() => {
                    setForgotPasswordModalOpen(false);
                    setAuthError("");
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <X size={18} color="#6b7280" />
                </button>
              </div>
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ margin: 0, color: "#6b7280", fontSize: 13, lineHeight: 1.6 }}>
                  Hesabına bağlı e-posta adresini gir. Eğer bu e-posta ile bir hesap varsa,
                  şifreni yenilemen için sana bir bağlantı göndereceğiz.
                </p>
                <input
                  type="email"
                  value={forgotPasswordEmail}
                  onChange={(event) => setForgotPasswordEmail(event.target.value)}
                  placeholder="E-posta"
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    border: "1px solid #d1d5db",
                    borderRadius: 12,
                    fontSize: 14,
                    boxSizing: "border-box",
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleForgotPasswordRequest();
                    }
                  }}
                />
                {authError && (
                  <div
                    style={{
                      background: "#fef2f2",
                      color: "#b91c1c",
                      border: "1px solid #fecaca",
                      borderRadius: 12,
                      padding: "10px 12px",
                      fontSize: 13,
                    }}
                  >
                    {authError}
                  </div>
                )}
                <button
                  onClick={() => void handleForgotPasswordRequest()}
                  disabled={forgotPasswordSubmitting}
                  style={{
                    width: "100%",
                    padding: "12px 0",
                    background: forgotPasswordSubmitting ? "#93c5fd" : "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 12,
                    fontWeight: 700,
                    cursor: forgotPasswordSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  {forgotPasswordSubmitting ? "Gönderiliyor..." : "Şifre Yenileme E-postası Gönder"}
                </button>
              </div>
            </div>
          </div>
        )}

        {passwordModalOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 72,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 420,
                background: "#fff",
                borderRadius: 18,
                boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  {passwordModalMode === "recovery" ? "Yeni Şifre Belirle" : "Şifremi Değiştir"}
                </h3>
                <button
                  onClick={() => {
                    setPasswordModalOpen(false);
                    setPasswordModalMode("change");
                    setAuthError("");
                    setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <X size={18} color="#6b7280" />
                </button>
              </div>
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                {passwordModalMode === "recovery" && (
                  <p style={{ margin: 0, color: "#6b7280", fontSize: 13, lineHeight: 1.6 }}>
                    Şifre yenileme bağlantısı doğrulandı. Devam etmek için yeni şifreni belirle.
                  </p>
                )}
                {passwordModalMode === "change" && (
                  <input
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(event) =>
                      setPasswordForm((prev) => ({ ...prev, currentPassword: event.target.value }))
                    }
                    placeholder="Mevcut şifre"
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      border: "1px solid #d1d5db",
                      borderRadius: 12,
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                )}
                <input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(event) =>
                    setPasswordForm((prev) => ({ ...prev, newPassword: event.target.value }))
                  }
                  placeholder="Yeni şifre"
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    border: "1px solid #d1d5db",
                    borderRadius: 12,
                    fontSize: 14,
                    boxSizing: "border-box",
                  }}
                />
                <input
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(event) =>
                    setPasswordForm((prev) => ({ ...prev, confirmPassword: event.target.value }))
                  }
                  placeholder="Yeni şifre tekrar"
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    border: "1px solid #d1d5db",
                    borderRadius: 12,
                    fontSize: 14,
                    boxSizing: "border-box",
                  }}
                />
                {authError && (
                  <div
                    style={{
                      background: "#fef2f2",
                      color: "#b91c1c",
                      border: "1px solid #fecaca",
                      borderRadius: 12,
                      padding: "10px 12px",
                      fontSize: 13,
                    }}
                  >
                    {authError}
                  </div>
                )}
                <button
                  onClick={() => void handleChangePassword()}
                  disabled={passwordSubmitting}
                  style={{
                    width: "100%",
                    padding: "12px 0",
                    background: passwordSubmitting ? "#93c5fd" : "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 12,
                    fontWeight: 700,
                    cursor: passwordSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  {passwordSubmitting
                    ? "Güncelleniyor..."
                    : passwordModalMode === "recovery"
                      ? "Yeni Şifreyi Kaydet"
                      : "Şifreyi Güncelle"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div
          style={{
            width: "100%",
            maxWidth: 900,
            display: "grid",
            gridTemplateColumns: "1.1fr 0.9fr",
            gap: 24,
          }}
        >
          <div
            style={{
              background: "#0f172a",
              color: "#fff",
              borderRadius: 24,
              padding: 32,
              boxShadow: "0 30px 80px rgba(15,23,42,0.28)",
            }}
          >
            <div style={{ display: "inline-flex", alignItems: "center", fontWeight: 800, fontSize: 24, marginBottom: 20 }}>
              <BookMarked size={24} style={{ marginRight: 10, color: "#60a5fa" }} />
              Ustad<span style={{ color: "#60a5fa" }}>.ai</span>
            </div>
            <h1 style={{ fontSize: 34, lineHeight: 1.15, margin: "0 0 14px" }}>
              Derslerini, materyallerini ve imtihan hazırlığını tek çalışma alanında topla
            </h1>
            <p style={{ color: "#cbd5e1", fontSize: 15, lineHeight: 1.7, margin: "0 0 22px" }}>
              Ustad.ai; müfredatını, ders materyallerini, testlerini, ölçme-değerlendirme sonuçlarını ve AI sohbet desteğini tek yerde düzenlemeni sağlar.
            </p>
            <div style={{ display: "grid", gap: 12 }}>
              {[
                {
                  title: "Müfredatını düzenle",
                  description:
                    "Derslerini haftalara ayır, PDF, ses kaydı ve görsellerini ilgili konularla birlikte sakla.",
                },
                {
                  title: "İmtihana hazırlan",
                  description:
                    "Bilgi kartları, test soruları ve açık uçlu sorularla çalış; istersen kendi içeriklerini ekle, istersen AI desteğiyle yeni içerikler oluştur.",
                },
                {
                  title: "Eksiklerini gör",
                  description:
                    "Çözdüğün testlerdeki doğru cevap oranlarını takip et; hangi konularda güçlü olduğunu, hangi konularda tekrar yapman gerektiğini gör.",
                },
                {
                  title: "AI ile sohbet et",
                  description:
                    "Genel AI sohbetinden destek al veya yalnızca kendi ders materyallerine odaklanan sohbet modu ile kaynaklarına göre cevaplar al.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    padding: "14px 16px",
                    color: "#e2e8f0",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{item.title}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "#cbd5e1" }}>
                    {item.description}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 24,
              padding: 28,
              boxShadow: "0 20px 60px rgba(15,23,42,0.12)",
            }}
          >
            <div style={{ display: "flex", background: "#f3f4f6", padding: 4, borderRadius: 12, gap: 4, marginBottom: 18 }}>
              {([
                ["register", "Kayıt Ol"],
                ["login", "Giriş Yap"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => {
                    setAuthMode(mode);
                    setAuthError("");
                    setAuthNotice("");
                  }}
                  style={{
                    flex: 1,
                    border: "none",
                    borderRadius: 10,
                    padding: "10px 0",
                    background: authMode === mode ? "#fff" : "transparent",
                    color: authMode === mode ? "#2563eb" : "#4b5563",
                    fontWeight: 700,
                    cursor: "pointer",
                    boxShadow: authMode === mode ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <h2 style={{ fontSize: 24, margin: "0 0 8px", color: "#111827" }}>
              {authMode === "register" ? "Hesap oluştur" : "Hesabına giriş yap"}
            </h2>
            <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
              {authMode === "register"
                ? "Derslerini, materyallerini, testlerini ve çalışma ilerlemeni kendi kişisel alanında takip etmek için hesabını oluştur."
                : "Kendi ders alanına ulaşmak için giriş yap."}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {authMode === "register" && (
                <>
                  <input
                    value={authForm.name}
                    onChange={(event) =>
                      setAuthForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="Ad Soyad"
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      border: "1px solid #d1d5db",
                      borderRadius: 12,
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                </>
              )}
              <input
                value={authForm.email}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, email: event.target.value }))
                }
                placeholder="E-posta"
                type="email"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              <input
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                }
                placeholder="Şifre"
                type="password"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAuthSubmit();
                  }
                }}
              />
              {authMode === "login" && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginTop: -4,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAuthError("");
                      setAuthNotice("");
                      setForgotPasswordEmail(authForm.email.trim());
                      setForgotPasswordModalOpen(true);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "#2563eb",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Şifremi unuttum
                  </button>
                </div>
              )}
              {authMode === "register" && (
                <>
                  <div
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "#f8fafc",
                      color: "#64748b",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    Kayıt işlemini tamamlamadan önce aydınlatma ve sözleşme metinlerini inceleyebilirsin.
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "12px 14px",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      background: "#fff",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={authForm.acceptedKvkk}
                      onChange={(event) =>
                        setAuthForm((prev) => ({
                          ...prev,
                          acceptedKvkk: event.target.checked,
                        }))
                      }
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setLegalModal({
                            isOpen: true,
                            title: "KVKK Aydınlatma Metni",
                            url: "/legal/kvkk-aydinlatma-metni.pdf",
                          });
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#2563eb",
                          fontWeight: 700,
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        KVKK Aydınlatma Metni
                      </button>{" "}
                      ’ni okudum. (Zorunlu)
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "12px 14px",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      background: "#fff",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={authForm.acceptedTerms}
                      onChange={(event) =>
                        setAuthForm((prev) => ({
                          ...prev,
                          acceptedTerms: event.target.checked,
                        }))
                      }
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setLegalModal({
                            isOpen: true,
                            title: "Kullanım Şartları / Üyelik Sözleşmesi",
                            url: "/legal/kullanim-sartlari-uyelik-sozlesmesi.pdf",
                          });
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#2563eb",
                          fontWeight: 700,
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        Kullanım Şartları / Üyelik Sözleşmesi
                      </button>{" "}
                      ’ni kabul ediyorum. (Zorunlu)
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "12px 14px",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      background: "#fff",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={authForm.marketingConsent}
                      onChange={(event) =>
                        setAuthForm((prev) => ({
                          ...prev,
                          marketingConsent: event.target.checked,
                        }))
                      }
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
                      Kampanya, duyuru ve pazarlama bildirimleri almak istiyorum. (İsteğe bağlı)
                    </div>
                  </div>
                </>
              )}
              {authNotice && (
                <div
                  style={{
                    background: "#ecfdf5",
                    color: "#166534",
                    border: "1px solid #bbf7d0",
                    borderRadius: 12,
                    padding: "10px 12px",
                    fontSize: 13,
                  }}
                >
                  {authNotice}
                </div>
              )}
              {authError && (
                <div
                  style={{
                    background: "#fef2f2",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    borderRadius: 12,
                    padding: "10px 12px",
                    fontSize: 13,
                  }}
                >
                  {authError}
                </div>
              )}
              <button
                onClick={() => void handleAuthSubmit()}
                disabled={
                  authSubmitting ||
                  (authMode === "register" &&
                    (!authForm.acceptedKvkk || !authForm.acceptedTerms))
                }
                style={{
                  width: "100%",
                  padding: "12px 0",
                  background:
                    authSubmitting ||
                    (authMode === "register" &&
                      (!authForm.acceptedKvkk || !authForm.acceptedTerms))
                      ? "#93c5fd"
                      : "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontWeight: 700,
                  cursor:
                    authSubmitting ||
                    (authMode === "register" &&
                      (!authForm.acceptedKvkk || !authForm.acceptedTerms))
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {authSubmitting
                  ? "İşleniyor..."
                  : authMode === "register"
                    ? "Hesap Oluştur"
                    : "Giriş Yap"}
              </button>
              {authMode === "login" && showResendConfirmationAction && (
                <button
                  type="button"
                  onClick={() => void handleResendConfirmation()}
                  disabled={resendConfirmationSubmitting}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: resendConfirmationSubmitting ? "#93c5fd" : "#2563eb",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: resendConfirmationSubmitting ? "not-allowed" : "pointer",
                    alignSelf: "center",
                  }}
                >
                  {resendConfirmationSubmitting
                    ? "Doğrulama e-postası gönderiliyor..."
                    : "Doğrulama e-postasını yeniden gönder"}
                </button>
              )}
            </div>
          </div>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (dataLoading && courses.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#fff",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              border: "4px solid #e5e7eb",
              borderTopColor: "#2563eb",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              margin: "0 auto 16px",
            }}
          />
          <p style={{ color: "#6b7280" }}>Yükleniyor...</p>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#fff",
        fontFamily: "system-ui,sans-serif",
        color: "#1f2937",
        fontSize: 14,
      }}
    >
      {addCourseModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 500,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ fontWeight: 700, margin: 0, fontSize: 16 }}>Yeni Ders Ekle</h3>
              <button
                onClick={() => setAddCourseModal(false)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 5,
                    color: "#374151",
                  }}
                >
                  Ders Adı *
                </label>
                <input
                  value={newCourse.name}
                  onChange={(event) =>
                    setNewCourse((prev) => ({ ...prev, name: event.target.value }))
                  }
                  placeholder="ör. Medeni Hukuk"
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 5,
                    color: "#374151",
                  }}
                >
                  Açıklama
                </label>
                <input
                  value={newCourse.description}
                  onChange={(event) =>
                    setNewCourse((prev) => ({ ...prev, description: event.target.value }))
                  }
                  placeholder="Kısa ders açıklaması"
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 5,
                    color: "#374151",
                  }}
                >
                  Hafta Sayısı
                </label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={newCourse.weeks}
                  onChange={(event) =>
                    setNewCourse((prev) => ({
                      ...prev,
                      weeks: parseInt(event.target.value, 10) || 14,
                    }))
                  }
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 5,
                    color: "#374151",
                  }}
                >
                  AI Asistan Yönergesi (Opsiyonel)
                </label>
                <textarea
                  value={newCourse.system_prompt}
                  onChange={(event) =>
                    setNewCourse((prev) => ({ ...prev, system_prompt: event.target.value }))
                  }
                  rows={3}
                  placeholder="Bu ders için AI asistanı nasıl davransın?"
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    resize: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <button
                onClick={handleAddCourse}
                style={{
                  padding: "11px 0",
                  background: "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Dersi Oluştur
              </button>
            </div>
          </div>
        </div>
      )}

      {adminModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 760,
              maxHeight: "80vh",
              overflow: "auto",
              background: "#fff",
              borderRadius: 18,
              boxShadow: "0 24px 80px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "18px 22px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: 18 }}>Üyeler</h3>
                <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 13 }}>
                  Admin olarak kayıtlı kullanıcıları buradan görüntüleyebilirsin.
                </p>
              </div>
              <button
                onClick={() => setAdminModalOpen(false)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>

            <div style={{ padding: 20 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.1fr 0.9fr auto",
                  gap: 10,
                  padding: 16,
                  border: "1px solid #e5e7eb",
                  borderRadius: 16,
                  background: "#f8fafc",
                  marginBottom: 18,
                }}
              >
                <input
                  value={inviteForm.email}
                  onChange={(event) =>
                    setInviteForm((prev) => ({ ...prev, email: event.target.value }))
                  }
                  placeholder="Öğrenci e-postası (opsiyonel)"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={inviteForm.expiresInDays}
                  onChange={(event) =>
                    setInviteForm((prev) => ({
                      ...prev,
                      expiresInDays: parseInt(event.target.value, 10) || 7,
                    }))
                  }
                  placeholder="Süre"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={() => void handleCreateInvite()}
                  disabled={inviteSubmitting}
                  style={{
                    border: "none",
                    borderRadius: 10,
                    background: inviteSubmitting ? "#93c5fd" : "#2563eb",
                    color: "#fff",
                    padding: "10px 14px",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: inviteSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  Davet Oluştur
                </button>
              </div>

              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
                  Aktif ve geçmiş davet kodları
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {adminInvites.length === 0 && (
                    <div
                      style={{
                        padding: 14,
                        border: "1px dashed #d1d5db",
                        borderRadius: 12,
                        color: "#6b7280",
                        fontSize: 13,
                        background: "#fff",
                      }}
                    >
                      Henüz davet oluşturulmamış.
                    </div>
                  )}
                  {adminInvites.map((invite) => (
                    <div
                      key={invite.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr auto",
                        gap: 12,
                        alignItems: "center",
                        border: "1px solid #e5e7eb",
                        borderRadius: 14,
                        padding: 14,
                        background: "#fff",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 800, color: "#111827", letterSpacing: 0.3 }}>
                          {invite.code}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                          {invite.email || "Herhangi bir öğrenci kullanabilir"}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {invite.used_at
                          ? `Kullanıldı: ${new Date(invite.used_at).toLocaleDateString("tr-TR")}`
                          : invite.revoked_at
                            ? "İptal edildi"
                            : `Bitiş: ${new Date(invite.expires_at).toLocaleDateString("tr-TR")}`}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            padding: "5px 10px",
                            borderRadius: 999,
                            background: invite.is_active ? "#dcfce7" : "#f3f4f6",
                            color: invite.is_active ? "#15803d" : "#6b7280",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {invite.is_active ? "Aktif" : "Kapalı"}
                        </span>
                        {invite.is_active && (
                          <button
                            onClick={() => void handleRevokeInvite(invite.id)}
                            style={{
                              border: "none",
                              borderRadius: 8,
                              background: "#fef2f2",
                              color: "#b91c1c",
                              padding: "8px 10px",
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            İptal Et
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.1fr 1.1fr 0.5fr 0.4fr 0.9fr",
                  gap: 12,
                  padding: "0 10px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#6b7280",
                }}
              >
                <span>Kullanıcı</span>
                <span>E-posta</span>
                <span>Rol</span>
                <span>Ders</span>
                <span>İşlemler</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {adminUsers.map((user) => (
                  <div
                    key={user.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.1fr 1.1fr 0.5fr 0.4fr 0.9fr",
                      gap: 12,
                      alignItems: "center",
                      border: "1px solid #e5e7eb",
                      borderRadius: 14,
                      padding: 14,
                      background: user.role === "admin" ? "#f8fafc" : "#fff",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: "#111827" }}>{user.name}</div>
                      <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>
                        Kayıt: {user.created_at ? new Date(user.created_at).toLocaleDateString("tr-TR") : "-"}
                      </div>
                    </div>
                    <div style={{ color: "#374151", fontSize: 13 }}>{user.email}</div>
                    <div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "5px 10px",
                            borderRadius: 999,
                            background: user.role === "admin" ? "#dbeafe" : "#f3f4f6",
                            color: user.role === "admin" ? "#1d4ed8" : "#4b5563",
                            fontSize: 12,
                            fontWeight: 700,
                            width: "fit-content",
                          }}
                        >
                          {user.role === "admin" ? "Admin" : "Öğrenci"}
                        </span>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "5px 10px",
                            borderRadius: 999,
                            background: user.ai_pro_enabled ? "#ede9fe" : "#f3f4f6",
                            color: user.ai_pro_enabled ? "#6d28d9" : "#6b7280",
                            fontSize: 11,
                            fontWeight: 700,
                            width: "fit-content",
                          }}
                        >
                          {user.ai_pro_enabled ? "Pro AI Açık" : "Pro AI Kapalı"}
                        </span>
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, color: "#111827" }}>{user.course_count}</div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      {user.role !== "admin" && (
                        <>
                          <button
                            onClick={() =>
                              void handleToggleAutomationProAccess(
                                user.id,
                                !user.ai_pro_enabled,
                              )
                            }
                            disabled={proAccessLoadingUserId === user.id}
                            style={{
                              border: "none",
                              borderRadius: 8,
                              background: user.ai_pro_enabled ? "#fef3c7" : "#dcfce7",
                              color: user.ai_pro_enabled ? "#b45309" : "#15803d",
                              padding: "8px 10px",
                              fontSize: 12,
                              fontWeight: 700,
                              cursor:
                                proAccessLoadingUserId === user.id ? "wait" : "pointer",
                              opacity: proAccessLoadingUserId === user.id ? 0.7 : 1,
                            }}
                          >
                            {proAccessLoadingUserId === user.id
                              ? "Güncelleniyor..."
                              : user.ai_pro_enabled
                                ? "Pro AI Kapat"
                                : "Pro AI Aç"}
                          </button>
                          <button
                            onClick={() => {
                              setResetPasswordUser(user);
                              setAdminPasswordForm({ password: "", confirmPassword: "" });
                            }}
                            style={{
                              border: "none",
                              borderRadius: 8,
                              background: "#ede9fe",
                              color: "#6d28d9",
                              padding: "8px 10px",
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            Şifre Sıfırla
                          </button>
                          <button
                            onClick={() => void handleDeleteUser(user.id)}
                            style={{
                              border: "none",
                              borderRadius: 8,
                              background: "#fee2e2",
                              color: "#b91c1c",
                              padding: "8px 10px",
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            Sil
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {resetPasswordUser && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 65,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              background: "#fff",
              borderRadius: 18,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>Öğrenci Şifresi Sıfırla</h3>
              <button
                onClick={() => {
                  setResetPasswordUser(null);
                  setAdminPasswordForm({ password: "", confirmPassword: "" });
                }}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>
                {resetPasswordUser.name} için yeni geçici şifre belirle.
              </p>
              <input
                type="password"
                value={adminPasswordForm.password}
                onChange={(event) =>
                  setAdminPasswordForm((prev) => ({ ...prev, password: event.target.value }))
                }
                placeholder="Yeni şifre"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              <input
                type="password"
                value={adminPasswordForm.confirmPassword}
                onChange={(event) =>
                  setAdminPasswordForm((prev) => ({ ...prev, confirmPassword: event.target.value }))
                }
                placeholder="Yeni şifre tekrar"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={() => void handleAdminPasswordReset()}
                style={{
                  width: "100%",
                  padding: "12px 0",
                  background: "#6d28d9",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Şifreyi Güncelle
              </button>
            </div>
          </div>
        </div>
      )}

      {passwordModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 65,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              background: "#fff",
              borderRadius: 18,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {passwordModalMode === "recovery" ? "Yeni Şifre Belirle" : "Şifremi Değiştir"}
              </h3>
              <button
                onClick={() => {
                  setPasswordModalOpen(false);
                  setPasswordModalMode("change");
                  setAuthError("");
                  setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
                }}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              {passwordModalMode === "recovery" && (
                <p style={{ margin: 0, color: "#6b7280", fontSize: 13, lineHeight: 1.6 }}>
                  Şifre yenileme bağlantısı doğrulandı. Devam etmek için yeni şifreni belirle.
                </p>
              )}
              {passwordModalMode === "change" && (
                <input
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(event) =>
                    setPasswordForm((prev) => ({ ...prev, currentPassword: event.target.value }))
                  }
                  placeholder="Mevcut şifre"
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    border: "1px solid #d1d5db",
                    borderRadius: 12,
                    fontSize: 14,
                    boxSizing: "border-box",
                  }}
                />
              )}
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={(event) =>
                  setPasswordForm((prev) => ({ ...prev, newPassword: event.target.value }))
                }
                placeholder="Yeni şifre"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              <input
                type="password"
                value={passwordForm.confirmPassword}
                onChange={(event) =>
                  setPasswordForm((prev) => ({ ...prev, confirmPassword: event.target.value }))
                }
                placeholder="Yeni şifre tekrar"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #d1d5db",
                  borderRadius: 12,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              {authError && (
                <div
                  style={{
                    background: "#fef2f2",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    borderRadius: 12,
                    padding: "10px 12px",
                    fontSize: 13,
                  }}
                >
                  {authError}
                </div>
              )}
              <button
                onClick={() => void handleChangePassword()}
                disabled={passwordSubmitting}
                style={{
                  width: "100%",
                  padding: "12px 0",
                  background: passwordSubmitting ? "#93c5fd" : "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontWeight: 700,
                  cursor: passwordSubmitting ? "not-allowed" : "pointer",
                }}
              >
                {passwordSubmitting
                  ? "Güncelleniyor..."
                  : passwordModalMode === "recovery"
                    ? "Yeni Şifreyi Kaydet"
                    : "Şifreyi Güncelle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingOE && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 480,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ fontWeight: 700, margin: 0 }}>Soruyu Düzenle</h3>
              <button
                onClick={() => setEditingOE(null)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Soru
                </label>
                <textarea
                  value={editOEForm.question}
                  onChange={(event) =>
                    setEditOEForm((prev) => ({ ...prev, question: event.target.value }))
                  }
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    resize: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Model Cevap (Opsiyonel)
                </label>
                <textarea
                  value={editOEForm.answer}
                  onChange={(event) =>
                    setEditOEForm((prev) => ({ ...prev, answer: event.target.value }))
                  }
                  rows={4}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    resize: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={saveEditOE}
                  style={{
                    flex: 1,
                    padding: "10px 0",
                    background: "#7c3aed",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Kaydet
                </button>
                <button
                  onClick={() => setEditingOE(null)}
                  style={{
                    flex: 1,
                    padding: "10px 0",
                    background: "#f3f4f6",
                    color: "#374151",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  İptal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingGoal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 400,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ fontWeight: 700, margin: 0 }}>Kısa Konu Adını Düzenle</h3>
              <button
                onClick={() => setEditingGoal(null)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Kısa Görünen Ad
                </label>
                <input
                  value={editGoalForm.label}
                  onChange={(event) =>
                    setEditGoalForm({ label: event.target.value })
                  }
                  placeholder="Örn. AİHM Başvuru"
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Asıl Konu Başlığı
                </label>
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    fontSize: 12,
                    color: "#6b7280",
                    lineHeight: 1.5,
                  }}
                >
                  {editingGoal.topic_title}
                </div>
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "#9ca3af", lineHeight: 1.4 }}>
                  Boş bırakırsan sağ panelde otomatik olarak asıl konu adı gösterilir.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={saveEditGoal}
                  style={{
                    flex: 1,
                    padding: "10px 0",
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Kaydet
                </button>
                <button
                  onClick={() => setEditingGoal(null)}
                  style={{
                    flex: 1,
                    padding: "10px 0",
                    background: "#f3f4f6",
                    color: "#374151",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  İptal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {addModal.isOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 480,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <h3 style={{ fontWeight: 600, margin: 0 }}>
                {addModal.type === "flashcard" && "Yeni Bilgi Kartı"}
                {addModal.type === "test" && "Yeni Test Sorusu"}
                {addModal.type === "openended" && "Yeni Açık Uçlu Soru"}
              </h3>
              <button
                onClick={() => setAddModal({ isOpen: false, type: null, weekIndex: 0 })}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              {addModal.type === "flashcard" && (
                <>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                      Ön Yüz
                    </label>
                    <textarea
                      value={flashcardForm.front}
                      onChange={(event) =>
                        setFlashcardForm((prev) => ({ ...prev, front: event.target.value }))
                      }
                      rows={3}
                      placeholder="Soru veya kavram"
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        resize: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                      Arka Yüz
                    </label>
                    <textarea
                      value={flashcardForm.back}
                      onChange={(event) =>
                        setFlashcardForm((prev) => ({ ...prev, back: event.target.value }))
                      }
                      rows={3}
                      placeholder="Cevap"
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        resize: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <button
                    onClick={addFlashcard}
                    style={{
                      padding: "10px 0",
                      background: "#2563eb",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Ekle
                  </button>
                </>
              )}

              {addModal.type === "test" && (
                <>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                      Soru
                    </label>
                    <textarea
                      value={testForm.question}
                      onChange={(event) =>
                        setTestForm((prev) => ({ ...prev, question: event.target.value }))
                      }
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        resize: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  {testForm.options.map((option, index) => (
                    <div key={index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="radio"
                        name="correct"
                        checked={testForm.correctIndex === index}
                        onChange={() =>
                          setTestForm((prev) => ({ ...prev, correctIndex: index }))
                        }
                      />
                      <input
                        value={option}
                        onChange={(event) => {
                          const options = [...testForm.options];
                          options[index] = event.target.value;
                          setTestForm((prev) => ({ ...prev, options }));
                        }}
                        placeholder={`Seçenek ${String.fromCharCode(65 + index)}`}
                        style={{
                          flex: 1,
                          padding: "6px 10px",
                          border: "1px solid #d1d5db",
                          borderRadius: 6,
                          fontSize: 13,
                        }}
                      />
                    </div>
                  ))}
                  <p style={{ fontSize: 11, color: "#6b7280", margin: 0 }}>
                    Doğru cevap için daireye tıkla
                  </p>
                  <button
                    onClick={addTestQuestion}
                    style={{
                      padding: "10px 0",
                      background: "#059669",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Ekle
                  </button>
                </>
              )}

              {addModal.type === "openended" && (
                <>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                      Soru
                    </label>
                    <textarea
                      value={openEndedForm.question}
                      onChange={(event) =>
                        setOpenEndedForm((prev) => ({ ...prev, question: event.target.value }))
                      }
                      rows={3}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        resize: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                      Model Cevap (Opsiyonel)
                    </label>
                    <textarea
                      value={openEndedForm.answer}
                      onChange={(event) =>
                        setOpenEndedForm((prev) => ({ ...prev, answer: event.target.value }))
                      }
                      rows={4}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 13,
                        resize: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <button
                    onClick={addOpenEnded}
                    style={{
                      padding: "10px 0",
                      background: "#7c3aed",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Ekle
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {automationConfigModal.isOpen && automationConfigModal.kind && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.48)",
            zIndex: 55,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 520,
              background: "#fff",
              borderRadius: 18,
              boxShadow: "0 24px 70px rgba(15,23,42,0.22)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "18px 22px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#111827" }}>
                  AI Üretim Ayarları
                </h3>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>
                  Bu hafta için kaç{" "}
                  {QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind].label} üretileceğini ve
                  zorluk seviyesini seç.
                </p>
              </div>
              <button
                onClick={() =>
                  setAutomationConfigModal((prev) => ({ ...prev, isOpen: false }))
                }
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>

            <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#374151",
                    marginBottom: 8,
                  }}
                >
                  Adet
                </label>
                <input
                  type="number"
                  min={QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind].min}
                  max={QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind].max}
                  value={automationConfigModal.count}
                  onChange={(event) =>
                    setAutomationConfigModal((prev) => ({
                      ...prev,
                      count: Number(event.target.value) || 0,
                    }))
                  }
                  style={{
                    width: "100%",
                    padding: "11px 12px",
                    border: "1px solid #d1d5db",
                    borderRadius: 10,
                    fontSize: 14,
                    boxSizing: "border-box",
                  }}
                />
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  Önerilen aralık: {QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind].min} -{" "}
                  {QUESTION_AUTOMATION_DEFAULTS[automationConfigModal.kind].max}
                </p>
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#374151",
                    marginBottom: 8,
                  }}
                >
                  Zorluk
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {(Object.keys(AUTOMATION_DIFFICULTY_LABELS) as AutomationDifficulty[]).map(
                    (difficulty) => {
                      const active = automationConfigModal.difficulty === difficulty;
                      return (
                        <button
                          key={difficulty}
                          onClick={() =>
                            setAutomationConfigModal((prev) => ({ ...prev, difficulty }))
                          }
                          style={{
                            flex: 1,
                            padding: "10px 0",
                            borderRadius: 10,
                            border: active ? "1px solid #2563eb" : "1px solid #d1d5db",
                            background: active ? "#eff6ff" : "#fff",
                            color: active ? "#1d4ed8" : "#374151",
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          {AUTOMATION_DIFFICULTY_LABELS[difficulty]}
                        </button>
                      );
                    },
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "#f8fafc",
                  border: "1px solid #e5e7eb",
                  fontSize: 12,
                  color: "#475569",
                  lineHeight: 1.55,
                }}
              >
                AI, yüklediğin PDF’e göre bu ayarlara uygun bir üretim yapacak. İstersen daha sonra
                yeniden üretip farklı adet veya zorluk deneyebilirsin.
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() =>
                    setAutomationConfigModal((prev) => ({ ...prev, isOpen: false }))
                  }
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: 10,
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    color: "#374151",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  İptal
                </button>
                <button
                  onClick={() => void submitQuestionAutomation()}
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: 10,
                    border: "none",
                    background: "#2563eb",
                    color: "#fff",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Üretimi Başlat
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {previewModal.isOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              width: "100%",
              maxWidth: 900,
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {previewModal.type === "audio" ? (
                  <Headphones size={18} color="#2563eb" />
                ) : previewModal.type === "infographic" ? (
                  <ImageIcon size={18} color="#ea580c" />
                ) : (
                  <FileText size={18} color="#2563eb" />
                )}
                <div>
                  <div style={{ fontWeight: 600 }}>{previewModal.name}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>
                    Hafta {previewModal.weekIndex + 1}
                  </div>
                </div>
              </div>
              <button
                onClick={() =>
                  setPreviewModal({
                    isOpen: false,
                    type: null,
                    url: "",
                    name: "",
                    weekIndex: 0,
                    loading: false,
                  })
                }
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} color="#6b7280" />
              </button>
            </div>
            <div style={{ flex: 1, padding: 24, overflow: "auto" }}>
              {previewModal.loading ? (
                <div
                  style={{
                    minHeight: "65vh",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 14,
                    color: "#6b7280",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "50%",
                      border: "4px solid #e5e7eb",
                      borderTopColor: "#2563eb",
                      animation: "spin 1s linear infinite",
                    }}
                  />
                  <div style={{ fontSize: 14, fontWeight: 500 }}>Materyal hazırlanıyor...</div>
                </div>
              ) : previewModal.type === "audio" ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "48px 0",
                  }}
                >
                  <div
                    style={{
                      width: 96,
                      height: 96,
                      borderRadius: "50%",
                      background: "#dbeafe",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: 24,
                    }}
                  >
                    <Headphones size={48} color="#2563eb" />
                  </div>
                  <audio
                    key={previewModal.url}
                    controls
                    src={previewModal.url}
                    autoPlay
                    preload="metadata"
                    style={{ width: "100%", maxWidth: 400 }}
                  />
                </div>
              ) : previewModal.type === "infographic" ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: "65vh",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <img
                    src={previewModal.url}
                    alt={previewModal.name}
                    style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
                  />
                </div>
              ) : (
                <iframe
                  src={previewModal.url}
                  style={{
                    width: "100%",
                    height: "65vh",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                  }}
                  title={previewModal.name}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {playMode && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 560, padding: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <span style={{ fontWeight: 600 }}>
                Bilgi Kartları - Hafta {playMode.weekIndex + 1}
              </span>
              <button
                onClick={() => setPlayMode(null)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16, textAlign: "center" }}>
              {playMode.currentIndex + 1} / {playMode.cards.length}
            </div>
            <div
              onClick={() =>
                setPlayMode((prev) => (prev ? { ...prev, flipped: !prev.flipped } : null))
              }
              style={{
                minHeight: 180,
                background: playMode.flipped ? "#ecfdf5" : "#eff6ff",
                borderRadius: 12,
                border: `2px solid ${playMode.flipped ? "#6ee7b7" : "#bfdbfe"}`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: playMode.flipped ? "#059669" : "#2563eb",
                  marginBottom: 12,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                {playMode.flipped ? "Arka Yüz - Cevap" : "Ön Yüz - Soru"}
              </div>
              <p style={{ textAlign: "center", fontSize: 15, fontWeight: 500, color: "#1f2937", margin: 0 }}>
                {playMode.flipped
                  ? playMode.cards[playMode.currentIndex].back
                  : playMode.cards[playMode.currentIndex].front}
              </p>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 16 }}>Çevirmek için tıkla</div>
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 20 }}>
              <button
                onClick={() =>
                  setPlayMode((prev) =>
                    prev
                      ? { ...prev, currentIndex: Math.max(0, prev.currentIndex - 1), flipped: false }
                      : null,
                  )
                }
                disabled={playMode.currentIndex === 0}
                style={{
                  padding: "8px 20px",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  background: "#fff",
                  cursor: playMode.currentIndex === 0 ? "not-allowed" : "pointer",
                  opacity: playMode.currentIndex === 0 ? 0.4 : 1,
                }}
              >
                Önceki
              </button>
              <button
                onClick={() =>
                  setPlayMode((prev) =>
                    prev
                      ? {
                          ...prev,
                          flipped: false,
                          cards: [...prev.cards].sort(() => Math.random() - 0.5),
                          currentIndex: 0,
                        }
                      : null,
                  )
                }
                style={{
                  padding: "8px 12px",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                <Shuffle size={16} />
              </button>
              {playMode.currentIndex < playMode.cards.length - 1 ? (
                <button
                  onClick={() =>
                    setPlayMode((prev) =>
                      prev ? { ...prev, currentIndex: prev.currentIndex + 1, flipped: false } : null,
                    )
                  }
                  style={{
                    padding: "8px 20px",
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  Sonraki
                </button>
              ) : (
                <button
                  onClick={() => setPlayMode(null)}
                  style={{
                    padding: "8px 20px",
                    background: "#059669",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  Tamamla
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {testMode && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 580, padding: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
              <span style={{ fontWeight: 600 }}>Test - Hafta {testMode.weekIndex + 1}</span>
              <button
                onClick={() => setTestMode(null)}
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <X size={18} />
              </button>
            </div>
            {testMode.done ? (
              <div style={{ textAlign: "center", padding: "32px 0" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>
                  {testMode.score >= testMode.questions.length * 0.7 ? "Başarılı" : "Tekrar"}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
                  {testMode.score} / {testMode.questions.length}
                </div>
                <div style={{ color: "#6b7280", marginBottom: 24 }}>
                  {testMode.score >= testMode.questions.length * 0.7
                    ? "Harika! Konuya hâkimsin."
                    : "Biraz daha çalışman gerekiyor."}
                </div>
                <button
                  onClick={() => setTestMode(null)}
                  style={{
                    padding: "10px 28px",
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Kapat
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
                  Soru {testMode.currentIndex + 1} / {testMode.questions.length}
                </div>
                <div
                  style={{
                    background: "#f9fafb",
                    borderRadius: 10,
                    padding: 16,
                    marginBottom: 16,
                    fontWeight: 500,
                  }}
                >
                  {testMode.questions[testMode.currentIndex].question}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {testMode.questions[testMode.currentIndex].options.map((option, index) => {
                    const correctIndex = testMode.questions[testMode.currentIndex].correct_index;
                    let bg = "#fff";
                    let border = "1px solid #d1d5db";
                    let color = "#1f2937";

                    if (testMode.selected !== null) {
                      if (index === correctIndex) {
                        bg = "#ecfdf5";
                        border = "2px solid #059669";
                        color = "#065f46";
                      } else if (index === testMode.selected && index !== correctIndex) {
                        bg = "#fef2f2";
                        border = "2px solid #ef4444";
                        color = "#991b1b";
                      }
                    }

                    return (
                      <button
                        key={index}
                        onClick={() => handleTestAnswer(index)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 14px",
                          background: bg,
                          border,
                          borderRadius: 8,
                          cursor: testMode.selected !== null ? "default" : "pointer",
                          color,
                          textAlign: "left",
                        }}
                      >
                        <span
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: "50%",
                            background:
                              index === correctIndex && testMode.selected !== null ? "#059669" : "#e5e7eb",
                            color: index === correctIndex && testMode.selected !== null ? "#fff" : "#374151",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 700,
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          {String.fromCharCode(65 + index)}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
                {testMode.selected !== null && (
                  <button
                    onClick={nextTestQuestion}
                    style={{
                      marginTop: 16,
                      width: "100%",
                      padding: "10px 0",
                      background: "#2563eb",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {testMode.currentIndex < testMode.questions.length - 1
                      ? "Sonraki Soru"
                      : "Sonuçları Gör"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 20px",
          borderBottom: "1px solid #f3f4f6",
          background: "#fff",
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", fontWeight: 800, fontSize: 17, letterSpacing: "-0.5px", color: "#1e40af" }}>
            <BookMarked size={18} style={{ marginRight: 7, color: "#2563eb" }} />
            Ustad<span style={{ color: "#2563eb" }}>.ai</span>
          </div>

          <div style={{ position: "relative" }}>
            {/* 1. Görünmez Katman: Menü açıldığında ekranı kaplar ama butonun ve menünün ALTINDA kalır */}
            {courseDropOpen && (
              <div
                onClick={() => setCourseDropOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 40 }}
              />
            )}

            {/* 2. Asıl "Ders Seç" Butonu */}
            <button
              onClick={() => setCourseDropOpen((open) => !open)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 13px",
                border: "1px solid #e5e7eb",
                borderRadius: 9,
                fontSize: 13,
                background: "#fff",
                cursor: "pointer",
                fontWeight: 500,
                color: "#374151",
                minWidth: 180,
                position: "relative",
                zIndex: 45, // Görünmez katmanın (40) üstünde kalsın ki tıklanabilsin
              }}
            >
              <BookOpen size={14} color="#6b7280" />
              <span
                style={{
                  flex: 1,
                  textAlign: "left",
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {activeCourse?.name ?? "Ders seç"}
              </span>
              <ChevronDown
                size={13}
                color="#9ca3af"
                style={{
                  transform: courseDropOpen ? "rotate(180deg)" : "none",
                  transition: "transform 0.15s",
                }}
              />
            </button>

            {/* 3. Açılır Menünün Kendisi */}
            {courseDropOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  minWidth: 260,
                  zIndex: 50, // En üstte (50) bu olacak, böylece tıklamaları hiçbir şey engelleyemez
                }}
              >
                <div style={{ padding: "8px 0" }}>
                  {courses.map((course) => (
                    <div key={course.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                      <button
                        onClick={() => {
                          setActiveCourseId(course.id);
                          setCourseDropOpen(false);
                          setActiveTab("curriculum");
                        }}
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "9px 14px",
                          background: course.id === activeCourseId ? "#eff6ff" : "transparent",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 7,
                            background: course.id === activeCourseId ? "#dbeafe" : "#f3f4f6",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <BookOpen size={13} color={course.id === activeCourseId ? "#2563eb" : "#9ca3af"} />
                        </div>
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: 13,
                              color: course.id === activeCourseId ? "#1d4ed8" : "#1f2937",
                            }}
                          >
                            {course.name}
                          </div>
                          {course.description && (
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>
                              {course.description}
                            </div>
                          )}
                        </div>
                      </button>
                      <button
                        onClick={() => handleDeleteCourse(course.id)}
                        style={{ padding: "9px 10px", background: "transparent", border: "none", cursor: "pointer" }}
                      >
                        <Trash2 size={13} color="#d1d5db" />
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: "1px solid #f3f4f6", padding: "6px 0" }}>
                  <button
                    onClick={() => {
                      setCourseDropOpen(false);
                      setAddCourseModal(true);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "9px 14px",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "#2563eb",
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    <PlusCircle size={14} /> Yeni Ders Ekle
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", background: "#f3f4f6", padding: 4, borderRadius: 10, gap: 2 }}>
            {(
              [
                ["curriculum", "Müfredat", LayoutList],
                ["exam", "İmtihan", GraduationCap],
                ["chat", "Sohbet", MessageSquare],
              ] as [string, string, ElementType][]
            ).map(([tab, label, Icon]) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab);
                  if (tab === "exam") {
                    setExamView(null);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "none",
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: "pointer",
                  background: activeTab === tab ? "#fff" : "transparent",
                  color: activeTab === tab ? "#2563eb" : "#6b7280",
                  boxShadow: activeTab === tab ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                  transition: "all 0.15s",
                }}
              >
                <Icon size={14} style={{ marginRight: 6 }} />
                {label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px 6px 12px",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              background: "#fff",
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{sessionUser.name}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>
                {isAdmin ? "Admin" : "Öğrenci"}
              </div>
            </div>
            {isAdmin && (
              <button
                onClick={() => void loadAdminPanel()}
                disabled={adminLoading}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  border: "none",
                  borderRadius: 10,
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: adminLoading ? "wait" : "pointer",
                }}
              >
                <Shield size={13} />
                <Users size={13} />
                Üyeler
              </button>
            )}
            <button
              onClick={() => {
                setAuthError("");
                setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
                setPasswordModalMode("change");
                setPasswordModalOpen(true);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                borderRadius: 10,
                background: "#f3f4f6",
                color: "#374151",
                padding: "8px 10px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <Shield size={13} />
              Şifre
            </button>
            <button
              onClick={() => void handleLogout()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                borderRadius: 10,
                background: "#fef2f2",
                color: "#b91c1c",
                padding: "8px 10px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <LogOut size={13} />
              Çıkış
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto", background: "#f9fafb" }}>
          {!activeCourse && !dataLoading && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                gap: 16,
                color: "#6b7280",
              }}
            >
              <BookMarked size={48} color="#d1d5db" />
              <p style={{ fontWeight: 600, fontSize: 16, color: "#374151" }}>Henüz ders eklenmemiş</p>
              <button
                onClick={() => setAddCourseModal(true)}
                style={{
                  padding: "10px 24px",
                  background: "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                İlk Dersi Ekle
              </button>
            </div>
          )}

          {dataLoading && activeCourse && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  border: "3px solid #e5e7eb",
                  borderTopColor: "#2563eb",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                }}
              />
            </div>
          )}

          {activeTab === "curriculum" && activeCourse && !dataLoading && (
            <div style={{ padding: 32, maxWidth: 900, margin: "0 auto" }}>
              <div style={{ marginBottom: 28 }}>
                <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
                  {activeCourse.name} - Müfredat
                </h2>
                <p style={{ color: "#6b7280", margin: 0 }}>
                  {weekCount} haftalık ders planı. Başlıkları düzenleyebilir, not, ses ve PNG
                  infografik yükleyebilirsin.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Array.from({ length: weekCount }, (_, index) => {
                  const topic = getWeekTitle(index);
                  const isExam = topic.includes("Final") || topic.includes("Vize");
                  const isEditing = editingWeek === index;
                  const hasPdfMaterial = Boolean(materials[index]?.pdf);
                  const audioAutomationLoading = Boolean(
                    automationLoading[buildAutomationKey("audio_summary", index)],
                  );
                  const infographicAutomationLoading = Boolean(
                    automationLoading[buildAutomationKey("infographic", index)],
                  );

                  return (
                    <div
                      key={index}
                      style={{
                        background: isExam ? "#fffbeb" : "#fff",
                        border: `1px solid ${isExam ? "#fde68a" : "#e5e7eb"}`,
                        borderRadius: 12,
                        padding: "20px 24px",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <span
                          style={{
                            padding: "6px 14px",
                            borderRadius: 20,
                            fontSize: 13,
                            fontWeight: 600,
                            background: isExam ? "#fef3c7" : "#dbeafe",
                            color: isExam ? "#92400e" : "#1d4ed8",
                            flexShrink: 0,
                          }}
                        >
                          Hafta {index + 1}
                        </span>
                        {isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
                            <input
                              value={editTitle}
                              onChange={(event) => setEditTitle(event.target.value)}
                              style={{
                                flex: 1,
                                padding: "6px 10px",
                                border: "1px solid #2563eb",
                                borderRadius: 6,
                                fontSize: 13,
                              }}
                              autoFocus
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  void updateWeekTitle(index, editTitle);
                                }
                                if (event.key === "Escape") {
                                  setEditingWeek(null);
                                }
                              }}
                            />
                            <button
                              onClick={() => updateWeekTitle(index, editTitle)}
                              style={{
                                padding: "6px 10px",
                                background: "#2563eb",
                                color: "#fff",
                                border: "none",
                                borderRadius: 6,
                                cursor: "pointer",
                              }}
                            >
                              <Save size={14} />
                            </button>
                            <button
                              onClick={() => setEditingWeek(null)}
                              style={{
                                padding: "6px 10px",
                                background: "#f3f4f6",
                                border: "none",
                                borderRadius: 6,
                                cursor: "pointer",
                              }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <span
                              style={{
                                fontWeight: 500,
                                color: "#1f2937",
                                flex: 1,
                                fontSize: 15,
                                lineHeight: 1.5,
                              }}
                            >
                              {topic}
                            </span>
                            <button
                              onClick={() => {
                                setEditingWeek(index);
                                setEditTitle(topic);
                              }}
                              style={{
                                padding: "4px 8px",
                                background: "#f3f4f6",
                                border: "none",
                                borderRadius: 6,
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 11,
                                color: "#6b7280",
                              }}
                            >
                              <Edit2 size={12} /> Düzenle
                            </button>
                          </>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                        {materials[index]?.audio ? (
                          <div style={{ position: "relative" }}>
                            <button
                              onClick={() => void openMaterialPreview(materials[index].audio!)}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 100,
                                height: 72,
                                border: "1px solid #6ee7b7",
                                borderRadius: 10,
                                background: "#ecfdf5",
                                cursor: "pointer",
                              }}
                            >
                              <Play size={20} color="#059669" />
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "#065f46",
                                  marginTop: 4,
                                  maxWidth: 90,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {materials[index].audio?.file_name}
                              </span>
                            </button>
                            <button
                              onClick={() => handleDeleteFile(index, "audio")}
                              style={{
                                position: "absolute",
                                top: -6,
                                right: -6,
                                background: "#ef4444",
                                border: "none",
                                borderRadius: "50%",
                                width: 18,
                                height: 18,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                              }}
                            >
                              <Trash2 size={10} color="#fff" />
                            </button>
                          </div>
                        ) : (
                          <label
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 100,
                              height: 72,
                              border: "1px dashed #d1d5db",
                              borderRadius: 10,
                              background: "#f9fafb",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="file"
                              accept="audio/*"
                              style={{ display: "none" }}
                              onChange={(event) => handleFileUpload(index, "audio", event)}
                            />
                            <Headphones size={20} color="#9ca3af" />
                            <span style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>
                              Ses Yükle
                            </span>
                          </label>
                        )}
                        {materials[index]?.pdf ? (
                          <div style={{ position: "relative" }}>
                            <button
                              onClick={() => void openMaterialPreview(materials[index].pdf!)}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 100,
                                height: 72,
                                border: "1px solid #6ee7b7",
                                borderRadius: 10,
                                background: "#ecfdf5",
                                cursor: "pointer",
                              }}
                            >
                              <Eye size={20} color="#059669" />
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "#065f46",
                                  marginTop: 4,
                                  maxWidth: 90,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {materials[index].pdf?.file_name}
                              </span>
                            </button>
                            <button
                              onClick={() => handleDeleteFile(index, "pdf")}
                              style={{
                                position: "absolute",
                                top: -6,
                                right: -6,
                                background: "#ef4444",
                                border: "none",
                                borderRadius: "50%",
                                width: 18,
                                height: 18,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                              }}
                            >
                              <Trash2 size={10} color="#fff" />
                            </button>
                          </div>
                        ) : (
                          <label
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 100,
                              height: 72,
                              border: "1px dashed #d1d5db",
                              borderRadius: 10,
                              background: "#f9fafb",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="file"
                              accept=".pdf"
                              style={{ display: "none" }}
                              onChange={(event) => handleFileUpload(index, "pdf", event)}
                            />
                            <FileText size={20} color="#9ca3af" />
                            <span style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>
                              PDF Yükle
                            </span>
                          </label>
                        )}
                        {materials[index]?.infographic ? (
                          <div style={{ position: "relative" }}>
                            <button
                              onClick={() => void openMaterialPreview(materials[index].infographic!)}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 100,
                                height: 72,
                                border: "1px solid #fdba74",
                                borderRadius: 10,
                                background: "#fff7ed",
                                cursor: "pointer",
                              }}
                            >
                              <ImageIcon size={20} color="#ea580c" />
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "#9a3412",
                                  marginTop: 4,
                                  maxWidth: 90,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {materials[index].infographic?.file_name}
                              </span>
                            </button>
                            <button
                              onClick={() => handleDeleteFile(index, "infographic")}
                              style={{
                                position: "absolute",
                                top: -6,
                                right: -6,
                                background: "#ef4444",
                                border: "none",
                                borderRadius: "50%",
                                width: 18,
                                height: 18,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                              }}
                            >
                              <Trash2 size={10} color="#fff" />
                            </button>
                          </div>
                        ) : (
                          <label
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 100,
                              height: 72,
                              border: "1px dashed #fdba74",
                              borderRadius: 10,
                              background: "#fff7ed",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="file"
                              accept=".png,image/png"
                              style={{ display: "none" }}
                              onChange={(event) => handleFileUpload(index, "infographic", event)}
                            />
                            <ImageIcon size={20} color="#f97316" />
                            <span style={{ fontSize: 11, color: "#c2410c", marginTop: 4 }}>
                              İnfografik Yükle
                            </span>
                          </label>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                        <button
                          onClick={() => void runAutomation("audio_summary", index)}
                          disabled={!hasPdfMaterial || audioAutomationLoading || !canUseAutomation}
                          title={
                            !canUseAutomation
                              ? "Bu özellik Pro plana dahildir. Admin hesabı veya admin izni gerekir."
                              : hasPdfMaterial
                              ? "Yüklediğin PDF'den AI ile sesli özet üret"
                              : "Önce bu hafta için bir PDF yükle"
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "8px 14px",
                            background:
                              hasPdfMaterial && canUseAutomation ? "#eff6ff" : "#f3f4f6",
                            color:
                              hasPdfMaterial && canUseAutomation ? "#1d4ed8" : "#9ca3af",
                            border:
                              hasPdfMaterial && canUseAutomation
                                ? "1px solid #bfdbfe"
                                : "1px solid #e5e7eb",
                            borderRadius: 999,
                            cursor:
                              !hasPdfMaterial || audioAutomationLoading || !canUseAutomation
                                ? "not-allowed"
                                : "pointer",
                            fontWeight: 600,
                            fontSize: 12,
                            opacity: audioAutomationLoading ? 0.75 : 1,
                          }}
                        >
                          <Sparkles size={13} />
                          <Headphones size={13} />
                          {audioAutomationLoading
                            ? "Sesli özet üretiliyor..."
                            : canUseAutomation
                              ? "Sesli Özet Üret"
                              : "Sesli Özet (Pro)"}
                        </button>
                        <button
                          onClick={() => void runAutomation("infographic", index)}
                          disabled={
                            !hasPdfMaterial || infographicAutomationLoading || !canUseAutomation
                          }
                          title={
                            !canUseAutomation
                              ? "Bu özellik Pro plana dahildir. Admin hesabı veya admin izni gerekir."
                              : hasPdfMaterial
                              ? "Yüklediğin PDF'den AI ile PNG infografik üret"
                              : "Önce bu hafta için bir PDF yükle"
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "8px 14px",
                            background:
                              hasPdfMaterial && canUseAutomation ? "#fff7ed" : "#f3f4f6",
                            color:
                              hasPdfMaterial && canUseAutomation ? "#c2410c" : "#9ca3af",
                            border:
                              hasPdfMaterial && canUseAutomation
                                ? "1px solid #fdba74"
                                : "1px solid #e5e7eb",
                            borderRadius: 999,
                            cursor:
                              !hasPdfMaterial ||
                              infographicAutomationLoading ||
                              !canUseAutomation
                                ? "not-allowed"
                                : "pointer",
                            fontWeight: 600,
                            fontSize: 12,
                            opacity: infographicAutomationLoading ? 0.75 : 1,
                          }}
                        >
                          <Sparkles size={13} />
                          <ImageIcon size={13} />
                          {infographicAutomationLoading
                            ? "İnfografik üretiliyor..."
                            : canUseAutomation
                              ? "İnfografik Üret"
                              : "İnfografik (Pro)"}
                        </button>
                      </div>
                      <p style={{ margin: "10px 0 0", fontSize: 12, color: "#9ca3af" }}>
                        PDF yüklendiğinde bu haftaya özel sesli özet ve PNG infografik otomatik üretilebilir.
                      </p>
                      {!canUseAutomation && (
                        <p style={{ margin: "6px 0 0", fontSize: 12, color: "#9ca3af" }}>
                          Bu AI üretim araçları Pro özelliğidir. Erişim için admin onayı gerekir.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === "exam" && !examView && activeCourse && !dataLoading && (
            <div style={{ padding: 32, maxWidth: 900, margin: "0 auto" }}>
              <div style={{ marginBottom: 28 }}>
                <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
                  {activeCourse.name} - İmtihan
                </h2>
                <p style={{ color: "#6b7280", margin: 0 }}>
                  Her hafta için bilgi kartları, test ve açık uçlu sorularla pekiştir.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Array.from({ length: weekCount }, (_, index) => {
                  const topic = getWeekTitle(index);
                  const isExpanded = expandedExamWeek === index;

                  return (
                    <div
                      key={index}
                      style={{
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        overflow: "hidden",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                      }}
                    >
                      <button
                        onClick={() => setExpandedExamWeek(isExpanded ? null : index)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "14px 18px",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <span
                            style={{
                              padding: "6px 14px",
                              borderRadius: 20,
                              fontSize: 13,
                              fontWeight: 600,
                              background: "#dbeafe",
                              color: "#1d4ed8",
                              whiteSpace: "nowrap",
                            }}
                          >
                            Hafta {index + 1}
                          </span>
                          <span style={{ fontWeight: 500, fontSize: 15, color: "#1f2937" }}>
                            {topic}
                          </span>
                        </div>
                        <ChevronRight
                          size={16}
                          color="#9ca3af"
                          style={{
                            transform: isExpanded ? "rotate(90deg)" : "none",
                            transition: "transform 0.2s",
                          }}
                        />
                      </button>
                      {isExpanded && (
                        <div
                          style={{
                            borderTop: "1px solid #f3f4f6",
                            padding: 16,
                            background: "#fafafa",
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr 1fr",
                            gap: 10,
                          }}
                        >
                          {(
                            [
                              [
                                "flashcards",
                                "Bilgi Kartları",
                                "Flashcards",
                                Layers,
                                "#2563eb",
                                "#dbeafe",
                                "#eff6ff",
                              ],
                              [
                                "test",
                                "Test Soruları",
                                "Çoktan Seçmeli",
                                ClipboardList,
                                "#059669",
                                "#d1fae5",
                                "#ecfdf5",
                              ],
                              [
                                "openended",
                                "Açık Uçlu",
                                "Klasik Sorular",
                                PenLine,
                                "#7c3aed",
                                "#ede9fe",
                                "#f5f3ff",
                              ],
                            ] as [string, string, string, ElementType, string, string, string][]
                          ).map(([type, label, subLabel, Icon, color, iconBg, cardBg]) => (
                            <button
                              key={type}
                              onClick={() => setExamView({ weekIndex: index, type })}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 8,
                                padding: 16,
                                background: cardBg,
                                border: `1px solid ${iconBg}`,
                                borderRadius: 10,
                                cursor: "pointer",
                              }}
                            >
                              <div
                                style={{
                                  width: 40,
                                  height: 40,
                                  borderRadius: "50%",
                                  background: iconBg,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Icon size={18} color={color} />
                              </div>
                              <span style={{ fontWeight: 600, fontSize: 13, color: "#1f2937" }}>
                                {label}
                              </span>
                              <span style={{ fontSize: 11, color: "#6b7280" }}>{subLabel}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === "exam" && examView && activeCourse && (
            <div style={{ padding: 32, maxWidth: 900, margin: "0 auto" }}>
              <button
                onClick={() => setExamView(null)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#6b7280",
                  fontSize: 13,
                  marginBottom: 24,
                }}
              >
                <ChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Geri Dön
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span
                  style={{
                    padding: "3px 10px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#fef3c7",
                    color: "#92400e",
                  }}
                >
                  Hafta {examView.weekIndex + 1}
                </span>
                {examView.type === "flashcards" && (
                  <span
                    style={{
                      padding: "3px 10px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "#dbeafe",
                      color: "#1d4ed8",
                    }}
                  >
                    Bilgi Kartları
                  </span>
                )}
                {examView.type === "test" && (
                  <span
                    style={{
                      padding: "3px 10px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "#d1fae5",
                      color: "#065f46",
                    }}
                  >
                    Test Soruları
                  </span>
                )}
                {examView.type === "openended" && (
                  <span
                    style={{
                      padding: "3px 10px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "#ede9fe",
                      color: "#5b21b6",
                    }}
                  >
                    Açık Uçlu Sorular
                  </span>
                )}
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 24, color: "#1f2937" }}>
                {getWeekTitle(examView.weekIndex)}
              </h2>

              {examView.type === "flashcards" && (
                <div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <button
                      onClick={() =>
                        setAddModal({ isOpen: true, type: "flashcard", weekIndex: examView.weekIndex })
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#2563eb",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Plus size={14} /> Yeni Kart
                    </button>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#fff",
                        color: "#2563eb",
                        border: "1px solid #bfdbfe",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Upload size={14} /> CSV
                      <input
                        type="file"
                        accept=".csv"
                        style={{ display: "none" }}
                        onChange={(event) => handleFlashcardCSV(examView.weekIndex, event)}
                      />
                    </label>
                    <button
                      onClick={() =>
                        openQuestionAutomationModal("flashcards", examView.weekIndex)
                      }
                      disabled={
                        !materials[examView.weekIndex]?.pdf ||
                        !canUseAutomation ||
                        Boolean(
                          automationLoading[
                            buildAutomationKey("flashcards", examView.weekIndex)
                          ],
                        )
                      }
                      title={
                        !canUseAutomation
                          ? "Bu özellik Pro plana dahildir. Admin hesabı veya admin izni gerekir."
                          : materials[examView.weekIndex]?.pdf
                          ? "Bu haftanın PDF materyalinden AI ile bilgi kartı üret"
                          : "Önce bu hafta için bir PDF yükle"
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#eff6ff"
                            : "#f3f4f6",
                        color:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#1d4ed8"
                            : "#9ca3af",
                        border: materials[examView.weekIndex]?.pdf && canUseAutomation
                          ? "1px solid #bfdbfe"
                          : "1px solid #e5e7eb",
                        borderRadius: 8,
                        cursor:
                          !materials[examView.weekIndex]?.pdf ||
                          !canUseAutomation ||
                          Boolean(
                            automationLoading[
                              buildAutomationKey("flashcards", examView.weekIndex)
                            ],
                          )
                            ? "not-allowed"
                            : "pointer",
                        fontWeight: 600,
                      }}
                    >
                      <Sparkles size={14} />
                      {automationLoading[buildAutomationKey("flashcards", examView.weekIndex)]
                        ? "Üretiliyor..."
                        : canUseAutomation
                          ? "AI ile Üret"
                          : "AI ile Üret (Pro)"}
                    </button>
                    {flashcards[examView.weekIndex]?.length > 0 && (
                      <button
                        onClick={() => startFlashcardPlay(examView.weekIndex)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "8px 16px",
                          background: "#059669",
                          color: "#fff",
                          border: "none",
                          borderRadius: 8,
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        <Play size={14} /> Çalış
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>
                    CSV: ön_yüz,arka_yüz
                  </p>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginTop: -8, marginBottom: 16 }}>
                    PDF yüklersen AI bu haftanın bilgi kartlarını otomatik üretebilir.
                  </p>
                  {!flashcards[examView.weekIndex]?.length ? (
                    <div
                      style={{
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        padding: 32,
                        textAlign: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: "50%",
                          background: "#dbeafe",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          margin: "0 auto 12px",
                        }}
                      >
                        <Layers size={24} color="#2563eb" />
                      </div>
                      <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Henüz Kart Yok</h3>
                      <p style={{ color: "#6b7280", fontSize: 13 }}>
                        Bu hafta için bilgi kartı eklenmemiş.
                      </p>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 12 }}>
                      {flashcards[examView.weekIndex].map((card) => (
                        <div
                          key={card.id}
                          style={{
                            background: "#fff",
                            border: "1px solid #e5e7eb",
                            borderRadius: 12,
                            padding: 16,
                            position: "relative",
                          }}
                        >
                          <button
                            onClick={() => deleteFlashcard(examView.weekIndex, card.id)}
                            style={{
                              position: "absolute",
                              top: 10,
                              right: 10,
                              background: "#fee2e2",
                              border: "none",
                              borderRadius: 6,
                              padding: "4px 6px",
                              cursor: "pointer",
                            }}
                          >
                            <Trash2 size={13} color="#ef4444" />
                          </button>
                          <div style={{ marginBottom: 10 }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                background: "#dbeafe",
                                color: "#1d4ed8",
                                padding: "2px 8px",
                                borderRadius: 4,
                              }}
                            >
                              Ön Yüz
                            </span>
                            <p style={{ margin: "8px 0 0", color: "#1f2937" }}>{card.front}</p>
                          </div>
                          <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 10 }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                background: "#d1fae5",
                                color: "#065f46",
                                padding: "2px 8px",
                                borderRadius: 4,
                              }}
                            >
                              Arka Yüz
                            </span>
                            <p style={{ margin: "8px 0 0", color: "#374151" }}>{card.back}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {examView.type === "test" && (
                <div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <button
                      onClick={() => setAddModal({ isOpen: true, type: "test", weekIndex: examView.weekIndex })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#059669",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Plus size={14} /> Yeni Soru
                    </button>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#fff",
                        color: "#059669",
                        border: "1px solid #6ee7b7",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Upload size={14} /> CSV
                      <input
                        type="file"
                        accept=".csv"
                        style={{ display: "none" }}
                        onChange={(event) => handleTestCSV(examView.weekIndex, event)}
                      />
                    </label>
                    <button
                      onClick={() =>
                        openQuestionAutomationModal("test_questions", examView.weekIndex)
                      }
                      disabled={
                        !materials[examView.weekIndex]?.pdf ||
                        !canUseAutomation ||
                        Boolean(
                          automationLoading[
                            buildAutomationKey("test_questions", examView.weekIndex)
                          ],
                        )
                      }
                      title={
                        !canUseAutomation
                          ? "Bu özellik Pro plana dahildir. Admin hesabı veya admin izni gerekir."
                          : materials[examView.weekIndex]?.pdf
                          ? "Bu haftanın PDF materyalinden AI ile test sorusu üret"
                          : "Önce bu hafta için bir PDF yükle"
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#ecfdf5"
                            : "#f3f4f6",
                        color:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#047857"
                            : "#9ca3af",
                        border: materials[examView.weekIndex]?.pdf && canUseAutomation
                          ? "1px solid #6ee7b7"
                          : "1px solid #e5e7eb",
                        borderRadius: 8,
                        cursor:
                          !materials[examView.weekIndex]?.pdf ||
                          !canUseAutomation ||
                          Boolean(
                            automationLoading[
                              buildAutomationKey("test_questions", examView.weekIndex)
                            ],
                          )
                            ? "not-allowed"
                            : "pointer",
                        fontWeight: 600,
                      }}
                    >
                      <Sparkles size={14} />
                      {automationLoading[buildAutomationKey("test_questions", examView.weekIndex)]
                        ? "Üretiliyor..."
                        : canUseAutomation
                          ? "AI ile Üret"
                          : "AI ile Üret (Pro)"}
                    </button>
                    {testQuestions[examView.weekIndex]?.length > 0 && (
                      <button
                        onClick={() => startTestMode(examView.weekIndex)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "8px 16px",
                          background: "#2563eb",
                          color: "#fff",
                          border: "none",
                          borderRadius: 8,
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                      >
                        <Play size={14} /> Testi Başlat
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>
                    CSV: soru,A,B,C,D,doğruIndex(0-3)
                  </p>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginTop: -8, marginBottom: 16 }}>
                    PDF yüklersen AI bu haftanın çoktan seçmeli sorularını otomatik üretebilir.
                  </p>
                  {!testQuestions[examView.weekIndex]?.length ? (
                    <div
                      style={{
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        padding: 32,
                        textAlign: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: "50%",
                          background: "#d1fae5",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          margin: "0 auto 12px",
                        }}
                      >
                        <ClipboardList size={24} color="#059669" />
                      </div>
                      <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Henüz Soru Yok</h3>
                      <p style={{ color: "#6b7280", fontSize: 13 }}>
                        Bu hafta için test sorusu eklenmemiş.
                      </p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {testQuestions[examView.weekIndex].map((question, index) => (
                        <div
                          key={question.id}
                          style={{
                            background: "#fff",
                            border: "1px solid #e5e7eb",
                            borderRadius: 12,
                            padding: 16,
                            position: "relative",
                          }}
                        >
                          <button
                            onClick={() => deleteTestQuestion(examView.weekIndex, question.id)}
                            style={{
                              position: "absolute",
                              top: 10,
                              right: 10,
                              background: "#fee2e2",
                              border: "none",
                              borderRadius: 6,
                              padding: "4px 6px",
                              cursor: "pointer",
                            }}
                          >
                            <Trash2 size={13} color="#ef4444" />
                          </button>
                          <p style={{ fontWeight: 600, marginBottom: 10 }}>
                            {index + 1}. {question.question}
                          </p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {question.options.map((option, optionIndex) => (
                              <div
                                key={optionIndex}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  padding: "8px 12px",
                                  borderRadius: 8,
                                  background:
                                    optionIndex === question.correct_index ? "#ecfdf5" : "#f9fafb",
                                  border: `1px solid ${
                                    optionIndex === question.correct_index ? "#6ee7b7" : "#e5e7eb"
                                  }`,
                                }}
                              >
                                <span
                                  style={{
                                    width: 22,
                                    height: 22,
                                    borderRadius: "50%",
                                    background:
                                      optionIndex === question.correct_index ? "#059669" : "#e5e7eb",
                                    color:
                                      optionIndex === question.correct_index ? "#fff" : "#374151",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 700,
                                    fontSize: 11,
                                    flexShrink: 0,
                                  }}
                                >
                                  {String.fromCharCode(65 + optionIndex)}
                                </span>
                                <span
                                  style={{
                                    color:
                                      optionIndex === question.correct_index ? "#065f46" : "#374151",
                                    fontSize: 13,
                                  }}
                                >
                                  {option}
                                </span>
                                {optionIndex === question.correct_index && (
                                  <CheckCircle size={14} color="#059669" style={{ marginLeft: "auto" }} />
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {examView.type === "openended" && (
                <div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <button
                      onClick={() =>
                        setAddModal({ isOpen: true, type: "openended", weekIndex: examView.weekIndex })
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#7c3aed",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Plus size={14} /> Yeni Soru
                    </button>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background: "#fff",
                        color: "#7c3aed",
                        border: "1px solid #d8b4fe",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      <Upload size={14} /> CSV
                      <input
                        type="file"
                        accept=".csv"
                        style={{ display: "none" }}
                        onChange={(event) => handleOpenEndedCSV(examView.weekIndex, event)}
                      />
                    </label>
                    <button
                      onClick={() =>
                        openQuestionAutomationModal(
                          "open_ended_questions",
                          examView.weekIndex,
                        )
                      }
                      disabled={
                        !materials[examView.weekIndex]?.pdf ||
                        !canUseAutomation ||
                        Boolean(
                          automationLoading[
                            buildAutomationKey("open_ended_questions", examView.weekIndex)
                          ],
                        )
                      }
                      title={
                        !canUseAutomation
                          ? "Bu özellik Pro plana dahildir. Admin hesabı veya admin izni gerekir."
                          : materials[examView.weekIndex]?.pdf
                          ? "Bu haftanın PDF materyalinden AI ile açık uçlu soru üret"
                          : "Önce bu hafta için bir PDF yükle"
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 16px",
                        background:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#f5f3ff"
                            : "#f3f4f6",
                        color:
                          materials[examView.weekIndex]?.pdf && canUseAutomation
                            ? "#6d28d9"
                            : "#9ca3af",
                        border: materials[examView.weekIndex]?.pdf && canUseAutomation
                          ? "1px solid #d8b4fe"
                          : "1px solid #e5e7eb",
                        borderRadius: 8,
                        cursor:
                          !materials[examView.weekIndex]?.pdf ||
                          !canUseAutomation ||
                          Boolean(
                            automationLoading[
                              buildAutomationKey(
                                "open_ended_questions",
                                examView.weekIndex,
                              )
                            ],
                          )
                            ? "not-allowed"
                            : "pointer",
                        fontWeight: 600,
                      }}
                    >
                      <Sparkles size={14} />
                      {automationLoading[
                        buildAutomationKey("open_ended_questions", examView.weekIndex)
                      ]
                        ? "Üretiliyor..."
                        : canUseAutomation
                          ? "AI ile Üret"
                          : "AI ile Üret (Pro)"}
                    </button>
                  </div>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>
                    CSV: soru,model_cevap
                  </p>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginTop: -8, marginBottom: 16 }}>
                    PDF yüklersen AI bu haftanın açık uçlu sorularını otomatik üretebilir.
                  </p>
                  {!openEndedQuestions[examView.weekIndex]?.length ? (
                    <div
                      style={{
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        padding: 32,
                        textAlign: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: "50%",
                          background: "#ede9fe",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          margin: "0 auto 12px",
                        }}
                      >
                        <PenLine size={24} color="#7c3aed" />
                      </div>
                      <h3 style={{ fontWeight: 600, marginBottom: 4 }}>Henüz Soru Yok</h3>
                      <p style={{ color: "#6b7280", fontSize: 13 }}>
                        Bu hafta için açık uçlu soru eklenmemiş.
                      </p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {openEndedQuestions[examView.weekIndex].map((question, index) => (
                        <div
                          key={question.id}
                          style={{
                            background: "#fff",
                            border: "1px solid #e5e7eb",
                            borderRadius: 12,
                            padding: 16,
                            position: "relative",
                          }}
                        >
                          <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
                            <button
                              onClick={() => startEditOE(question)}
                              style={{
                                background: "#ede9fe",
                                border: "none",
                                borderRadius: 6,
                                padding: "4px 6px",
                                cursor: "pointer",
                              }}
                            >
                              <Edit2 size={13} color="#7c3aed" />
                            </button>
                            <button
                              onClick={() => deleteOpenEnded(examView.weekIndex, question.id)}
                              style={{
                                background: "#fee2e2",
                                border: "none",
                                borderRadius: 6,
                                padding: "4px 6px",
                                cursor: "pointer",
                              }}
                            >
                              <Trash2 size={13} color="#ef4444" />
                            </button>
                          </div>
                          <p style={{ fontWeight: 600, marginBottom: 8, paddingRight: 60 }}>
                            {index + 1}. {question.question}
                          </p>
                          {question.answer && (
                            <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 10 }}>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  background: "#ede9fe",
                                  color: "#5b21b6",
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                }}
                              >
                                Model Cevap
                              </span>
                              <p style={{ margin: "8px 0 0", color: "#374151", fontSize: 13 }}>
                                {question.answer}
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "chat" && activeCourse && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div
                style={{
                  padding: "18px 32px 0",
                  background: "#f9fafb",
                  borderBottom: "1px solid #f3f4f6",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    background: "#eef2f7",
                    padding: 4,
                    borderRadius: 12,
                    gap: 4,
                    flexWrap: "wrap",
                  }}
                >
                  {(
                    [
                      ["general", "Genel AI", "Serbest sohbet ve genel yardım"],
                      ["materials", "Ders Materyalleri", "Sadece yüklenen ders materyallerine göre yanıt"],
                    ] as [ChatMode, string, string][]
                  ).map(([mode, label, description]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        if (chatMode === mode) {
                          return;
                        }
                        setChatMode(mode);
                        setMessages([]);
                        setInput("");
                      }}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 2,
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "none",
                        background: chatMode === mode ? "#fff" : "transparent",
                        boxShadow: chatMode === mode ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                        cursor: "pointer",
                        minWidth: 200,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: chatMode === mode ? "#2563eb" : "#374151",
                        }}
                      >
                        {label}
                      </span>
                      <span style={{ fontSize: 11, color: "#6b7280", textAlign: "left" }}>
                        {description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "24px 32px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {messages.length === 0 && (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      textAlign: "center",
                      padding: 48,
                      color: "#6b7280",
                    }}
                  >
                    <div style={{ fontSize: 40, marginBottom: 16 }}>Ders</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: "#1f2937", marginBottom: 8 }}>
                      {chatMode === "general"
                        ? `${activeCourse.name} - Genel AI`
                        : `${activeCourse.name} - Materyal Asistanı`}
                    </h2>
                    <p style={{ fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
                      {chatMode === "general"
                        ? "Genel sorular sorabilir, kavram açıklatabilir ve serbest biçimde yapay zeka ile sohbet edebilirsin."
                        : "Bu mod yalnızca müfredat bölümüne yüklediğin ders materyallerine dayanarak yanıt verir. Materyaller dışında bilgi uydurmaz."}
                    </p>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    style={{
                      display: "flex",
                      justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        padding: "12px 16px",
                        borderRadius:
                          message.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                        background: message.role === "user" ? "#2563eb" : "#fff",
                        color: message.role === "user" ? "#fff" : "#1f2937",
                        border: message.role === "assistant" ? "1px solid #e5e7eb" : "none",
                        fontSize: 14,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div style={{ display: "flex" }}>
                    <div
                      style={{
                        padding: "12px 16px",
                        borderRadius: "18px 18px 18px 4px",
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        display: "flex",
                        gap: 4,
                      }}
                    >
                      {[0, 1, 2].map((index) => (
                        <div
                          key={index}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "#9ca3af",
                            animation: `bounce 1s ${index * 0.2}s infinite`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div style={{ padding: "16px 32px", background: "#fff", borderTop: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: "8px 8px 8px 16px",
                    background: "#fff",
                  }}
                >
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder={
                      chatMode === "general"
                        ? "Genel bir soru sor..."
                        : `${activeCourse.name} materyallerine göre soru sor...`
                    }
                    style={{
                      flex: 1,
                      border: "none",
                      outline: "none",
                      fontSize: 14,
                      background: "transparent",
                    }}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={loading || !input.trim()}
                    style={{
                      padding: "8px 12px",
                      background: loading || !input.trim() ? "#93c5fd" : "#2563eb",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                    }}
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            width: 280,
            borderLeft: "1px solid #f3f4f6",
            background: "#fff",
            overflowY: "auto",
            padding: 20,
            flexShrink: 0,
          }}
        >
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", fontWeight: 600, marginBottom: 14, color: "#1f2937" }}>
              <Activity size={15} style={{ marginRight: 8, color: "#6b7280" }} /> Aktivite
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>Mesajlar:</span>
              <span style={{ fontWeight: 600, color: "#1f2937" }}>{stats.messages}</span>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: "0 0 24px" }} />

          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", fontWeight: 600, marginBottom: 8, color: "#1f2937" }}>
              <Target size={15} style={{ marginRight: 8, color: "#6b7280" }} />
              Ölçme-Değerlendirme
            </div>
            <p style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5, margin: "0 0 14px" }}>
              Her haftanın başarı yüzdesi, imtihan bölümündeki test sorularına verdiğin doğru
              cevap oranına göre güncellenir.
            </p>

            {learningGoals.length === 0 && (
              <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", marginTop: 8 }}>
                Konu değerlendirmeleri hazırlanıyor.
              </p>
            )}

            {learningGoals.map((goal) => {
              const availableQuestions = testQuestions[goal.week_index]?.length ?? 0;
              const hasResult = goal.total_questions > 0;
              const assessmentVisual = getAssessmentVisual(
                goal.progress,
                goal.total_questions,
                availableQuestions,
              );
              const helperText =
                availableQuestions === 0
                  ? "Bu konu için henüz test sorusu yok."
                  : hasResult
                    ? `Son test sonucu: ${goal.correct_answers}/${goal.total_questions} doğru`
                    : "Henüz çözülmedi.";

              return (
                <div
                  key={goal.id}
                  style={{
                    marginBottom: 14,
                    padding: 12,
                    background: "#f9fafb",
                    border: "1px solid #eef2f7",
                    borderRadius: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span
                        style={{
                          padding: "3px 7px",
                          borderRadius: 999,
                          background: "#eff6ff",
                          color: "#2563eb",
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        H{goal.week_index + 1}
                      </span>
                      <span
                        style={{
                          padding: "3px 7px",
                          borderRadius: 999,
                          background: assessmentVisual.badgeBg,
                          color: assessmentVisual.badgeColor,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        {assessmentVisual.label}
                      </span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#374151",
                          lineHeight: 1.5,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                        title={goal.topic_title}
                      >
                        {goal.label}
                      </div>
                      {goal.custom_label && (
                        <div
                          style={{
                            fontSize: 10,
                            color: "#9ca3af",
                            marginTop: 4,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={goal.topic_title}
                        >
                          Asıl konu: {goal.topic_title}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => startEditGoal(goal)}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        border: "1px solid #e5e7eb",
                        background: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                      title="Kısa adı düzenle"
                    >
                      <Edit2 size={12} color="#6b7280" />
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 999, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${goal.progress}%`,
                          background: assessmentVisual.barColor,
                          borderRadius: 999,
                          transition: "width 0.3s",
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 11, color: "#6b7280", width: 34, textAlign: "right" }}>
                      {goal.progress}%
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: "#9ca3af", margin: "8px 0 0", lineHeight: 1.4 }}>
                    {helperText}
                  </p>
                </div>
              );
            })}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: "0 0 24px" }} />

          <div>
            <div style={{ display: "flex", alignItems: "center", fontWeight: 600, marginBottom: 14, color: "#1f2937" }}>
              <BarChart2 size={15} style={{ marginRight: 8, color: "#6b7280" }} />
              Haftalik Aktivite
            </div>
            {(
              [
                ["Konu Kavrama", "#3b82f6", [20, 35, 40, 60, 80, 100]],
                ["Muhakeme Hizi", "#10b981", [15, 25, 45, 55, 70, 85]],
              ] as [string, string, number[]][]
            ).map(([label, color, bars]) => (
              <div key={label} style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>{label}</p>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28 }}>
                  {bars.map((height, index) => (
                    <div
                      key={index}
                      style={{
                        flex: 1,
                        height: `${height}%`,
                        background: color,
                        borderRadius: "2px 2px 0 0",
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
