import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { queryClient } from "./lib/api/client";
import { LiffGate } from "./lib/components/liff-gate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiffGate>
        <RouterProvider router={router} />
      </LiffGate>
    </QueryClientProvider>
  </StrictMode>
);