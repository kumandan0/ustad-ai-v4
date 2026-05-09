import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerSupabaseClient, createServiceRoleSupabaseClient } from "@/lib/supabase/server";
import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/supabase/config";
import {
  maybeMigrateLegacyMaterialsToSupabase,
  maybeMigrateLegacyWorkspace,
} from "@/lib/server/legacy-migration";

export type UserRole = "admin" | "student";

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  created_at?: string;
};

type InviteRow = {
  id: number;
  code: string;
  email: string | null;
  role: UserRole;
  created_by_user_id: string;
  expires_at: string;
  used_by_user_id: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at?: string;
};

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  ai_pro_enabled: boolean;
  created_at?: string;
};

export type AdminInviteSummary = {
  id: number;
  code: string;
  email: string | null;
  role: UserRole;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  is_active: boolean;
  created_at?: string;
};

export type AdminUserSummary = SessionUser & {
  course_count: number;
};

export type AuthContext = {
  user: SessionUser;
  supabase: SupabaseClient;
  applyCookies(response: NextResponse): NextResponse;
};

export class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

function mapAuthEmailDispatchError(error: { message?: string; status?: number | string }) {
  const rawMessage = error.message?.trim() || "E-posta işlemi sırasında bir hata oluştu.";
  const normalizedMessage = rawMessage.toLocaleLowerCase("en-US");
  const status =
    typeof error.status === "number"
      ? error.status
      : Number.isFinite(Number(error.status))
        ? Number(error.status)
        : 400;

  if (
    status === 429 ||
    normalizedMessage.includes("email rate limit") ||
    normalizedMessage.includes("rate limit exceeded")
  ) {
    return new AuthError(
      "Bu e-posta adresi için kısa süre içinde çok fazla işlem yapıldı. Lütfen birkaç dakika bekleyip tekrar dene ya da gelen kutundaki mevcut e-postayı kullan.",
      429,
    );
  }

  return new AuthError(rawMessage, status);
}

function mapSignupErrorToAuthError(error: { message?: string; status?: number | string }) {
  const rawMessage = error.message?.trim() || "Kayıt sırasında bir hata oluştu.";
  const normalizedMessage = rawMessage.toLocaleLowerCase("en-US");
  const status =
    typeof error.status === "number"
      ? error.status
      : Number.isFinite(Number(error.status))
        ? Number(error.status)
        : 400;

  if (
    status === 429 ||
    normalizedMessage.includes("email rate limit") ||
    normalizedMessage.includes("rate limit exceeded")
  ) {
    return new AuthError(
      "Bu e-posta adresine kısa süre içinde çok fazla doğrulama e-postası gönderildi. Lütfen birkaç dakika bekleyip tekrar dene ya da gelen kutundaki mevcut doğrulama e-postasını kullan.",
      429,
    );
  }

  if (
    normalizedMessage.includes("user already registered") ||
    normalizedMessage.includes("already been registered")
  ) {
    return new AuthError(
      "Bu e-posta adresiyle daha önce hesap oluşturulmuş görünüyor. E-posta doğrulamanı tamamladıysan giriş yapabilirsin; tamamlamadıysan mevcut doğrulama e-postanı kullan.",
      409,
    );
  }

  return new AuthError(rawMessage, status);
}

function normalizeEmail(email: string) {
  return email.trim().toLocaleLowerCase("en-US");
}

function getLegacyImportEmail() {
  const value = process.env.LEGACY_IMPORT_EMAIL?.trim() ?? "";
  return value ? normalizeEmail(value) : "";
}

function getRequestOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  if (forwardedHost) {
    return `${forwardedProto ?? "https"}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

function assertStrongPassword(password: string) {
  if (password.length < 6) {
    throw new AuthError("Şifre en az 6 karakter olmalı.", 400);
  }
}

function buildSessionUser(profile: ProfileRow | null, user: User): SessionUser {
  const aiProEnabled =
    profile?.role === "admin" || user.user_metadata?.ai_pro_enabled === true;

  return {
    id: user.id,
    name:
      (profile?.full_name && profile.full_name.trim()) ||
      (typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "") ||
      user.email?.split("@")[0] ||
      "Kullanıcı",
    email: profile?.email || user.email || "",
    role: profile?.role ?? "student",
    ai_pro_enabled: aiProEnabled,
    created_at: profile?.created_at,
  };
}

async function getProfileById(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role,created_at")
    .eq("id", userId)
    .single();

  if (error) {
    return null;
  }

  return data as ProfileRow;
}

async function createVerifiedPublicClient() {
  return createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function buildAuthContext(request: NextRequest) {
  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  const profile = await getProfileById(supabase, user.id);
  return {
    user: buildSessionUser(profile, user),
    supabase,
    applyCookies,
  } satisfies AuthContext;
}

export async function bootstrapUserWorkspace(request: NextRequest) {
  const context = await requireUser(request);
  const legacyImportEmail = getLegacyImportEmail();
  const shouldMigrateLegacyWorkspace =
    legacyImportEmail.length > 0 &&
    normalizeEmail(context.user.email) === legacyImportEmail;

  if (shouldMigrateLegacyWorkspace) {
    await maybeMigrateLegacyWorkspace({
      supabase: context.supabase,
      user: {
        id: context.user.id,
        email: context.user.email,
      },
    });
  }

  await maybeMigrateLegacyMaterialsToSupabase({
    supabase: context.supabase,
    user: {
      id: context.user.id,
    },
  });

  const refreshedProfile = await getProfileById(context.supabase, context.user.id);

  return {
    ...context,
    user: buildSessionUser(refreshedProfile, {
      id: context.user.id,
      email: context.user.email,
      user_metadata: {
        full_name: context.user.name,
      },
    } as User),
  } satisfies AuthContext;
}

function buildInviteCode() {
  return randomBytes(6).toString("hex").toUpperCase();
}

export async function getCurrentUserFromRequest(request: NextRequest) {
  const context = await buildAuthContext(request);
  return context?.user ?? null;
}

export async function requireUser(request: NextRequest) {
  const context = await buildAuthContext(request);
  if (!context) {
    throw new AuthError("Bu işlem için giriş yapmalısınız.", 401);
  }

  return context;
}

export async function requireAdmin(request: NextRequest) {
  const context = await requireUser(request);
  if (context.user.role !== "admin") {
    throw new AuthError("Bu işlem için admin yetkisi gerekiyor.", 403);
  }

  return context;
}

export function ensureAutomationAccess(user: SessionUser) {
  if (user.role === "admin" || user.ai_pro_enabled) {
    return;
  }

  throw new AuthError(
    "AI ile otomatik üretim Pro özelliğidir. Bu hesap için henüz aktif değil.",
    403,
  );
}

export async function registerUser(
  request: NextRequest,
  input: {
    name: string;
    email: string;
    password: string;
    acceptedKvkk: boolean;
    acceptedTerms: boolean;
    marketingConsent?: boolean;
  },
) {
  const fullName = input.name.trim();
  const email = normalizeEmail(input.email);
  const password = input.password;

  if (!fullName) {
    throw new AuthError("İsim gerekli.", 400);
  }

  if (!email || !email.includes("@")) {
    throw new AuthError("Geçerli bir e-posta girin.", 400);
  }

  if (!input.acceptedKvkk || !input.acceptedTerms) {
    throw new AuthError(
      "KVKK Aydınlatma Metni ve Kullanım Şartları onaylanmadan kayıt oluşturulamaz.",
      400,
    );
  }

  assertStrongPassword(password);

  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);
  const emailRedirectTo = new URL("/auth/callback", getRequestOrigin(request)).toString();
  const signupResult = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo,
      data: {
        full_name: fullName,
        accepted_kvkk: true,
        accepted_terms: true,
        marketing_consent: Boolean(input.marketingConsent),
        consented_at: new Date().toISOString(),
      },
    },
  });

  if (signupResult.error) {
    throw mapSignupErrorToAuthError(signupResult.error);
  }

  if (!signupResult.data.session) {
    return {
      user: null,
      requiresEmailConfirmation: true,
      email,
      applyCookies,
    };
  }

  const sessionUser = signupResult.data.user;

  if (!sessionUser) {
    throw new AuthError("Kullanıcı hesabı oluşturulamadı.", 500);
  }

  const profile = await getProfileById(supabase, sessionUser.id);

  return {
    user: buildSessionUser(profile, sessionUser),
    requiresEmailConfirmation: false,
    applyCookies,
  };
}

export async function loginUser(
  request: NextRequest,
  input: { email: string; password: string },
) {
  const email = normalizeEmail(input.email);
  const password = input.password;
  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    if (error?.message?.toLocaleLowerCase("en-US").includes("email not confirmed")) {
      throw new AuthError(
        "E-posta adresini doğruladıktan sonra giriş yapabilirsin. Gelen kutundaki doğrulama bağlantısını kontrol et.",
        401,
      );
    }
    throw new AuthError("E-posta veya şifre hatalı.", 401);
  }

  const profile = await getProfileById(supabase, data.user.id);
  return {
    user: buildSessionUser(profile, data.user),
    applyCookies,
  };
}

export async function logoutCurrentUser(request: NextRequest) {
  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);
  const { error } = await supabase.auth.signOut();

  if (error) {
    throw new AuthError("Çıkış yapılamadı.", 500);
  }

  return { applyCookies };
}

export async function resendConfirmationEmail(
  request: NextRequest,
  input: { email: string },
) {
  const email = normalizeEmail(input.email);

  if (!email || !email.includes("@")) {
    throw new AuthError("Geçerli bir e-posta girin.", 400);
  }

  const supabase = await createVerifiedPublicClient();
  const emailRedirectTo = new URL("/auth/callback", getRequestOrigin(request)).toString();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo,
    },
  });

  if (error) {
    throw mapAuthEmailDispatchError(error);
  }

  return { email };
}

export async function requestPasswordRecovery(
  request: NextRequest,
  input: { email: string },
) {
  const email = normalizeEmail(input.email);

  if (!email || !email.includes("@")) {
    throw new AuthError("Geçerli bir e-posta girin.", 400);
  }

  const supabase = await createVerifiedPublicClient();
  const redirectTo = new URL("/auth/callback", getRequestOrigin(request)).toString();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });

  if (error) {
    throw mapAuthEmailDispatchError(error);
  }

  return { email };
}

export async function listUsersForAdmin(request: NextRequest) {
  const admin = await requireAdmin(request);
  const serviceClient = createServiceRoleSupabaseClient();
  const [
    { data: profiles, error: profilesError },
    { data: courses, error: coursesError },
    { data: authUsersData, error: authUsersError },
  ] =
    await Promise.all([
      admin.supabase
        .from("profiles")
        .select("id,email,full_name,role,created_at")
        .order("created_at", { ascending: true }),
      admin.supabase.from("courses").select("id,user_id"),
      serviceClient.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      }),
    ]);

  if (profilesError) {
    throw new AuthError("Kullanıcılar yüklenemedi.", 500);
  }

  if (coursesError) {
    throw new AuthError("Ders sayıları yüklenemedi.", 500);
  }

  if (authUsersError) {
    throw new AuthError("Kullanıcı yetkileri yüklenemedi.", 500);
  }

  const courseCounts = new Map<string, number>();
  (courses ?? []).forEach((course) => {
    const key = String(course.user_id);
    courseCounts.set(key, (courseCounts.get(key) ?? 0) + 1);
  });

  const automationAccessByUserId = new Map<string, boolean>();
  (authUsersData?.users ?? []).forEach((user) => {
    automationAccessByUserId.set(user.id, user.user_metadata?.ai_pro_enabled === true);
  });

  return (profiles ?? []).map((profile) => ({
    id: String(profile.id),
    name: String(profile.full_name ?? profile.email ?? "Kullanıcı"),
    email: String(profile.email ?? ""),
    role: (profile.role ?? "student") as UserRole,
    ai_pro_enabled:
      (profile.role ?? "student") === "admin" ||
      automationAccessByUserId.get(String(profile.id)) === true,
    created_at: profile.created_at ?? undefined,
    course_count: courseCounts.get(String(profile.id)) ?? 0,
  })) satisfies AdminUserSummary[];
}

export async function createInvite(
  request: NextRequest,
  input: { email?: string; expiresInDays?: number },
) {
  const admin = await requireAdmin(request);
  const expiresInDays = Math.min(Math.max(Number(input.expiresInDays ?? 7), 1), 30);
  const code = buildInviteCode();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await admin.supabase
    .from("invites")
    .insert({
      code,
      email: input.email ? normalizeEmail(input.email) : null,
      role: "student",
      created_by_user_id: admin.user.id,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error || !data) {
    throw new AuthError(error?.message || "Davet oluşturulamadı.", 500);
  }

  const invite = data as InviteRow;
  return {
    id: invite.id,
    code: invite.code,
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at,
    used_at: invite.used_at,
    revoked_at: invite.revoked_at,
    is_active: !invite.used_at && !invite.revoked_at && new Date(invite.expires_at).getTime() > Date.now(),
    created_at: invite.created_at,
  } satisfies AdminInviteSummary;
}

export async function listInvitesForAdmin(request: NextRequest) {
  const admin = await requireAdmin(request);
  const { data, error } = await admin.supabase
    .from("invites")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new AuthError("Davetler yüklenemedi.", 500);
  }

  return ((data ?? []) as InviteRow[]).map((invite) => ({
    id: invite.id,
    code: invite.code,
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at,
    used_at: invite.used_at,
    revoked_at: invite.revoked_at,
    is_active: !invite.used_at && !invite.revoked_at && new Date(invite.expires_at).getTime() > Date.now(),
    created_at: invite.created_at,
  })) satisfies AdminInviteSummary[];
}

export async function revokeInvite(request: NextRequest, inviteId: number) {
  const admin = await requireAdmin(request);
  const { error } = await admin.supabase
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .is("used_at", null);

  if (error) {
    throw new AuthError("Davet iptal edilemedi.", 500);
  }
}

export async function changeOwnPassword(
  request: NextRequest,
  currentPassword: string,
  newPassword: string,
) {
  assertStrongPassword(newPassword);
  const context = await requireUser(request);
  const verifyClient = await createVerifiedPublicClient();
  const verification = await verifyClient.auth.signInWithPassword({
    email: context.user.email,
    password: currentPassword,
  });

  if (verification.error) {
    throw new AuthError("Mevcut şifre hatalı.", 400);
  }

  const { error } = await context.supabase.auth.updateUser({ password: newPassword });
  if (error) {
    throw new AuthError(error.message || "Şifre değiştirilemedi.", 500);
  }

  return { applyCookies: context.applyCookies };
}

export async function completePasswordRecovery(
  request: NextRequest,
  newPassword: string,
) {
  assertStrongPassword(newPassword);
  const context = await requireUser(request);
  const { error } = await context.supabase.auth.updateUser({ password: newPassword });

  if (error) {
    throw new AuthError(error.message || "Şifre yenilenemedi.", 500);
  }

  return { applyCookies: context.applyCookies };
}

export async function updateUserPassword(
  request: NextRequest,
  userId: string,
  newPassword: string,
) {
  assertStrongPassword(newPassword);
  await requireAdmin(request);
  const serviceClient = createServiceRoleSupabaseClient();
  const { error } = await serviceClient.auth.admin.updateUserById(userId, {
    password: newPassword,
  });

  if (error) {
    throw new AuthError(error.message || "Şifre sıfırlanamadı.", 500);
  }
}

export async function deleteUserByAdmin(request: NextRequest, userId: string) {
  const admin = await requireAdmin(request);
  if (admin.user.id === userId) {
    throw new AuthError("Admin kendi hesabını bu ekrandan silemez.", 400);
  }

  const serviceClient = createServiceRoleSupabaseClient();
  const { error } = await serviceClient.auth.admin.deleteUser(userId);
  if (error) {
    throw new AuthError(error.message || "Kullanıcı silinemedi.", 500);
  }
}

export async function updateUserAutomationAccess(
  request: NextRequest,
  userId: string,
  enabled: boolean,
) {
  const admin = await requireAdmin(request);
  if (admin.user.id === userId) {
    throw new AuthError("Admin hesabı için Pro erişim zaten her zaman açıktır.", 400);
  }

  const serviceClient = createServiceRoleSupabaseClient();
  const [{ data: authUserData, error: authUserError }, { data: profileData, error: profileError }] =
    await Promise.all([
      serviceClient.auth.admin.getUserById(userId),
      admin.supabase.from("profiles").select("role").eq("id", userId).single(),
    ]);

  if (authUserError || !authUserData.user) {
    throw new AuthError(authUserError?.message || "Kullanıcı bulunamadı.", 404);
  }

  if (profileError || !profileData) {
    throw new AuthError("Kullanıcı profili bulunamadı.", 404);
  }

  if ((profileData.role as UserRole) === "admin") {
    throw new AuthError("Admin kullanıcılar için bu yetki kapatılamaz.", 400);
  }

  const nextMetadata = {
    ...(authUserData.user.user_metadata ?? {}),
    ai_pro_enabled: enabled,
  };

  const { error } = await serviceClient.auth.admin.updateUserById(userId, {
    user_metadata: nextMetadata,
  });

  if (error) {
    throw new AuthError(error.message || "Pro erişim güncellenemedi.", 500);
  }
}
