export type PdfResponseMetadata = {
  url?: string;
  headers?: Record<string, unknown>;
  mimeType?: unknown;
};

function asHeaderText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(", ");
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  return "";
}

export function normalizeResponseHeaders(headers: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers || typeof headers !== "object") {
    return normalized;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    normalized[key.toLowerCase()] = asHeaderText(value);
  }
  return normalized;
}

export function isPdfMime(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value.split(";")[0]?.trim().toLowerCase() === "application/pdf";
}

function contentDispositionPdfFilename(value: string): string | undefined {
  const filenameStar = /filename\*\s*=\s*(?:UTF-8''|)([^;]+)/i.exec(value)?.[1];
  const filename = /filename\s*=\s*("([^"]+)"|[^;]+)/i.exec(value)?.[1];
  const raw = filenameStar ?? filename;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function urlPdfFilename(value: string): string | undefined {
  try {
    const url = new URL(value);
    const name = url.pathname.split("/").filter(Boolean).pop();
    return name && /\.pdf$/i.test(name) ? name : undefined;
  } catch {
    const name = value.split(/[?#]/)[0]?.split("/").filter(Boolean).pop();
    return name && /\.pdf$/i.test(name) ? name : undefined;
  }
}

export function inferPdfResponseFilename(meta: PdfResponseMetadata): string {
  const headers = normalizeResponseHeaders(meta.headers);
  const dispositionName = contentDispositionPdfFilename(headers["content-disposition"] ?? "");
  if (dispositionName) {
    return /\.pdf$/i.test(dispositionName) ? dispositionName : `${dispositionName}.pdf`;
  }
  const urlName = meta.url ? urlPdfFilename(meta.url) : undefined;
  return urlName ?? "download.pdf";
}

export function pdfResponseMetadataMatches(meta: PdfResponseMetadata): boolean {
  const headers = normalizeResponseHeaders(meta.headers);
  const dispositionName = contentDispositionPdfFilename(headers["content-disposition"] ?? "");
  return (
    isPdfMime(headers["content-type"]) ||
    isPdfMime(meta.mimeType) ||
    Boolean(dispositionName && /\.pdf$/i.test(dispositionName)) ||
    Boolean(meta.url && urlPdfFilename(meta.url))
  );
}

export function hasPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function decodeCdpResponseBody(result: unknown): Buffer {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const body = typeof record.body === "string" ? record.body : "";
  if (!body) {
    return Buffer.alloc(0);
  }
  return record.base64Encoded === true ? Buffer.from(body, "base64") : Buffer.from(body);
}
