import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function buildRedirectUrl(
  request: NextRequest,
  params?: {
    auth?: string;
    message?: string;
  },
) {
  const url = new URL("/", request.nextUrl.origin);

  if (params?.auth) {
    url.searchParams.set("auth", params.auth);
  }

  if (params?.message) {
    url.searchParams.set("message", params.message);
  }

  return url;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const { supabase, applyCookies } = createRouteHandlerSupabaseClient(request);

  if (!code) {
    const response = NextResponse.redirect(
      buildRedirectUrl(request, {
        auth: "error",
        message: "Doğrulama bağlantısı geçerli görünmüyor. Lütfen e-postandaki bağlantıyı yeniden deneyin.",
      }),
    );
    return applyCookies(response);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const response = NextResponse.redirect(
      buildRedirectUrl(request, {
        auth: "error",
        message:
          "E-posta doğrulaması tamamlanamadı. Bağlantıyı yeniden deneyebilir veya tekrar giriş yapabilirsin.",
      }),
    );
    return applyCookies(response);
  }

  const response = NextResponse.redirect(
    buildRedirectUrl(request, {
      auth: "verified",
    }),
  );
  return applyCookies(response);
}
