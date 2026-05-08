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

function normalizeEmail(email: string) {
  return email.trim().toLocaleLowerCase("en-US");
}

function assertStrongPassword(password: string) {
  if (password.length < 6) {
    throw new AuthError("Şifre en az 6 karakter olmalı.", 400);
  }
}

function buildSessionUser(profile: ProfileRow | null, user: User): SessionUser {
  return {
    id: user.id,
    name:
      (profile?.full_name && profile.full_name.trim()) ||
      (typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "") ||
      user.email?.split("@")[0] ||
      "Kullanıcı",
    email: profile?.email || user.email || "",
    role: profile?.role ?? "student",
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

  await maybeMigrateLegacyWorkspace({
    supabase: context.supabase,
    user: {
      id: context.user.id,
      email: context.user.email,
    },
  });

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

export async function registerUser(
  request: NextRequest,
  input: { name: string; email: string; password: string; inviteCode?: string },
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

  assertStrongPassword(password);

  const publicClient = await createVerifiedPublicClient();
  let validatedInviteId: number | null = null;
  const inviteCode = input.inviteCode?.trim() ?? "";

  if (inviteCode) {
    const { data: inviteValidation, error: inviteError } = await publicClient.rpc(
      "validate_invite_code",
      {
        input_code: inviteCode,
        input_email: email,
      },
    );

    if (inviteError) {
      throw new AuthError("Davet kodu doğrulanamadı.", 500);
    }

    if (!inviteValidation?.valid) {
      throw new AuthError(String(inviteValidation?.error ?? "Geçersiz davet kodu."), 400);
    }

    validatedInviteId = Number(inviteValidation.invite_id);
  }

  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);
  const signupResult = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
      },
    },
  });

  if (signupResult.error) {
    throw new AuthError(signupResult.error.message, 400);
  }

  let sessionUser = signupResult.data.user;

  if (!signupResult.data.session) {
    const signInResult = await supabase.auth.signInWithPassword({ email, password });
    if (signInResult.error || !signInResult.data.user) {
      throw new AuthError(
        "Kayıt oluşturuldu ancak oturum açılamadı. Supabase Auth ayarlarında e-posta doğrulaması açık olabilir.",
        400,
      );
    }
    sessionUser = signInResult.data.user;
  }

  if (!sessionUser) {
    throw new AuthError("Kullanıcı hesabı oluşturulamadı.", 500);
  }

  const profile = await getProfileById(supabase, sessionUser.id);

  if (validatedInviteId) {
    await supabase.rpc("consume_invite_code", {
      invite_id: validatedInviteId,
    });
  }

  return {
    user: buildSessionUser(profile, sessionUser),
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

export async function listUsersForAdmin(request: NextRequest) {
  const admin = await requireAdmin(request);
  const [{ data: profiles, error: profilesError }, { data: courses, error: coursesError }] =
    await Promise.all([
      admin.supabase
        .from("profiles")
        .select("id,email,full_name,role,created_at")
        .order("created_at", { ascending: true }),
      admin.supabase.from("courses").select("id,user_id"),
    ]);

  if (profilesError) {
    throw new AuthError("Kullanıcılar yüklenemedi.", 500);
  }

  if (coursesError) {
    throw new AuthError("Ders sayıları yüklenemedi.", 500);
  }

  const courseCounts = new Map<string, number>();
  (courses ?? []).forEach((course) => {
    const key = String(course.user_id);
    courseCounts.set(key, (courseCounts.get(key) ?? 0) + 1);
  });

  return (profiles ?? []).map((profile) => ({
    id: String(profile.id),
    name: String(profile.full_name ?? profile.email ?? "Kullanıcı"),
    email: String(profile.email ?? ""),
    role: (profile.role ?? "student") as UserRole,
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
