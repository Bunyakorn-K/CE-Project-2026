import { createAuthClient } from "better-auth/react";

export const apiBaseUrl = import.meta.env.VITE_API_URL ?? "";

export const authClient = createAuthClient({
  baseURL: apiBaseUrl || window.location.origin,
  fetchOptions: {
    credentials: "include"
  }
});
