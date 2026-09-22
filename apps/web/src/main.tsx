import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { LiffGate } from "./lib/components/liff-gate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiffGate>
      <RouterProvider router={router} />
    </LiffGate>
  </StrictMode>
);