import { QueryClient } from "@tanstack/react-query";
import { apiErrorCopy, API_ERROR_FALLBACK } from "../api-errors";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

/**
 * Thai copy for a failed API response.
 *
 * This used to return the server's own `message`, which is English, and the
 * Dashboard rendered it inside a Thai sentence. It now keys on the stable error
 * `code` (see `../api-errors`) and never passes server prose through — a
 * reworded English string would otherwise produce an untranslated banner with
 * no test failing.
 *
 * `fallback` is the caller's own Thai sentence. It is used only when the
 * response carries no recognisable code, and a caller's Thai fallback is a
 * better last resort than the neutral generic sentence.
 */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown } | string | null;
  } | null;

  const code =
    readCode(data?.error && typeof data.error !== "string" ? data.error.code : undefined) ??
    readCode(data?.code);

  if (code) return apiErrorCopy(code);

  // No code to key on. A Thai fallback from the caller beats either the neutral
  // sentence or an English string; this is the only path that can still surface
  // caller-supplied copy.
  return fallback.trim() || API_ERROR_FALLBACK;
}

function readCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 }
  }
});
