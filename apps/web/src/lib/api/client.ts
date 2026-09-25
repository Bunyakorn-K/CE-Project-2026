import { QueryClient } from "@tanstack/react-query";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as {
    message?: unknown;
    error?: { message?: unknown } | string | null;
  } | null;
  if (typeof data?.message === "string" && data.message.trim()) return data.message;
  if (typeof data?.error === "string" && data.error.trim()) return data.error;
  if (data?.error && typeof data.error !== "string" && typeof data.error.message === "string" && data.error.message.trim()) return data.error.message;
  return fallback;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 }
  }
});
