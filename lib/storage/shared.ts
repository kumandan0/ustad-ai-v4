export const MATERIAL_STORAGE_BUCKET = "ustad-materials";

export type StorageProvider = "local" | "supabase" | "google_drive" | "koofr";

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildMaterialFileUrl(bucket: string, filePath: string) {
  const params = new URLSearchParams({
    bucket,
    path: filePath,
  });

  return `/api/files?${params.toString()}`;
}

export function parseMaterialFileUrl(fileUrl: string) {
  if (!fileUrl) {
    return null;
  }

  try {
    const parsed = new URL(fileUrl, "http://local");

    if (parsed.pathname === "/api/files") {
      const bucket = parsed.searchParams.get("bucket");
      const filePath = parsed.searchParams.get("path");
      if (!bucket || !filePath) {
        return null;
      }

      return {
        bucket: safeDecode(bucket),
        filePath: safeDecode(filePath),
      };
    }

    const storagePublicMarker = "/storage/v1/object/public/";
    const publicIndex = parsed.pathname.indexOf(storagePublicMarker);
    if (publicIndex !== -1) {
      const remainder = parsed.pathname.slice(publicIndex + storagePublicMarker.length);
      const slashIndex = remainder.indexOf("/");
      if (slashIndex === -1) {
        return null;
      }

      return {
        bucket: safeDecode(remainder.slice(0, slashIndex)),
        filePath: safeDecode(remainder.slice(slashIndex + 1)),
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function normalizeMaterialFileUrl(fileUrl: string) {
  const parsed = parseMaterialFileUrl(fileUrl);
  if (!parsed) {
    return fileUrl;
  }

  return buildMaterialFileUrl(parsed.bucket, parsed.filePath);
}
