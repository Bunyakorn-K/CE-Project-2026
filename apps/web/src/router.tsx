import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/api/client";

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function createAppRouter(client?: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient: client ?? queryClient },
    defaultPreload: "intent"
  });
}