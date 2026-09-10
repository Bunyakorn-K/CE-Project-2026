import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@heroui/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useState } from "react";
import { apiUrl } from "../../../lib/api/client";
import { authAtom } from "../../../lib/atoms/auth";

export const Route = createFileRoute("/_authenticated/admin/ai")({
  component: AiConsolePage
});

type AiSettings = {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  hasApiKey: boolean;
  updatedAt: number | null;
};

type ChatMsg = { role: "user" | "assistant" | "system"; content: string; model: string | null };

function AiConsolePage() {
  const [user] = useAtom(authAtom);
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["ai", "settings"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/ai/settings"), { credentials: "include" });
      const data = (await res.json()) as { settings: AiSettings };
      return data.settings;
    }
  });

  const modelsQuery = useQuery({
    queryKey: ["ai", "models"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/ai/models"), { credentials: "include" });
      const data = (await res.json()) as { models: string[]; error: string | null };
      if (data.error) throw new Error(data.error);
      return data.models;
    },
    enabled: settingsQuery.data?.hasApiKey === true,
    staleTime: 10 * 60 * 1000
  });

  const [form, setForm] = useState<{
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    temperature: number;
  } | null>(null);

  // hydrate the local form once when settings load
  if (form === null && settingsQuery.data) {
    const s = settingsQuery.data;
    setForm({ baseUrl: s.baseUrl, apiKey: "", model: s.model, systemPrompt: s.systemPrompt, temperature: s.temperature });
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: unknown) => {
      const res = await fetch(apiUrl("/api/ai/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai", "settings"] });
    }
  });

  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(apiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threadId: threadId ?? undefined, message })
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "Chat failed");
      }
      return (await res.json()) as { threadId: string; reply: string };
    },
    onSuccess: (data, message) => {
      setThreadId(data.threadId);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: message, model: null },
        { role: "assistant", content: data.reply, model: null }
      ]);
      setChatInput("");
    }
  });

  if (!user || !user.grants.some((g) => g.role === "owner")) {
    return <p className="text-danger">Owner role required to manage AI settings.</p>;
  }

  if (settingsQuery.isLoading) return <p className="text-default-500">Loading settings…</p>;
  if (settingsQuery.isError) return <p className="text-danger">Failed to load settings.</p>;
  if (form === null) return <p className="text-default-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">AI Console</h1>

      <section className="rounded-xl border border-divider p-4">
        <h2 className="mb-3 text-lg font-semibold">Provider / Gateway</h2>
        <div className="grid max-w-xl grid-cols-1 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Base URL (OpenAI-compatible)</span>
            <input
              className="rounded-lg border border-divider bg-background px-3 py-2 text-sm outline-none"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://llm.kovaspire.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>
              API Key {settingsQuery.data?.hasApiKey ? <em className="text-xs text-success">(stored — leave blank to keep)</em> : null}
            </span>
            <input
              className="rounded-lg border border-divider bg-background px-3 py-2 text-sm outline-none"
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={settingsQuery.data?.hasApiKey ? "•••••••• (unchanged)" : "sk-…"}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Default model</span>
            <input
              list="ai-models"
              className="rounded-lg border border-divider bg-background px-3 py-2 text-sm outline-none"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="openrouter/deepseek-v3"
            />
            <datalist id="ai-models">
              {(modelsQuery.data ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Temperature ({form.temperature}/100)</span>
            <input
              type="range"
              min={0}
              max={100}
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            isDisabled={saveMutation.isPending}
            onPress={() => {
              const payload: Record<string, unknown> = {
                baseUrl: form.baseUrl,
                model: form.model,
                systemPrompt: form.systemPrompt,
                temperature: form.temperature
              };
              if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
              saveMutation.mutate(payload);
            }}
          >
            Save settings
          </Button>
          <Button variant="ghost" onPress={() => void qc.invalidateQueries({ queryKey: ["ai", "models"] })}>
            Refresh models
          </Button>
          {modelsQuery.isError && <span className="self-center text-xs text-danger">{modelsQuery.error.message}</span>}
        </div>
        {saveMutation.isError && <p className="mt-2 text-sm text-danger">{saveMutation.error.message}</p>}
        {saveMutation.isSuccess && <p className="mt-2 text-sm text-success">Saved.</p>}
      </section>

      <section className="rounded-xl border border-divider p-4">
        <h2 className="mb-3 text-lg font-semibold">System prompt</h2>
        <textarea
          className="min-h-40 w-full rounded-lg border border-divider bg-background px-3 py-2 font-mono text-xs outline-none"
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          placeholder={"คุณคือผู้ช่วยข้อมูลของระบบ LaundryTwin…"}
        />
        <p className="mt-1 text-xs text-default-500">
          Template variables: <code>{"{{role}}"}</code> <code>{"{{branches}}"}</code> <code>{"{{tools}}"}</code>
        </p>
      </section>

      <section className="rounded-xl border border-divider p-4">
        <h2 className="mb-3 text-lg font-semibold">Chat playground</h2>
        <div className="flex max-h-96 min-h-48 flex-col gap-2 overflow-y-auto rounded-lg bg-default-50 p-3">
          {messages.length === 0 && (
            <p className="self-center text-sm text-default-400">Send a message to test the configured gateway.</p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "self-end bg-primary/15" : "self-start bg-default-100"
              }`}
            >
              {m.content}
            </div>
          ))}
          {chatMutation.isPending && <p className="self-start text-xs text-default-400">Thinking…</p>}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="flex-1 rounded-lg border border-divider bg-background px-3 py-2 text-sm outline-none"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chatInput.trim() && !chatMutation.isPending) {
                chatMutation.mutate(chatInput.trim());
              }
            }}
            placeholder="Ask about revenue, cycles, machine status…"
          />
          <Button
            isDisabled={!chatInput.trim() || chatMutation.isPending}
            onPress={() => chatMutation.mutate(chatInput.trim())}
          >
            Send
          </Button>
        </div>
        {chatMutation.isError && <p className="mt-2 text-sm text-danger">{chatMutation.error.message}</p>}
      </section>
    </div>
  );
}