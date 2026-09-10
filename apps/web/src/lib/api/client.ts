import { QueryClient } from "@tanstack/react-query";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 }
  }
});