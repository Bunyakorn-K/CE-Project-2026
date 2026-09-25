import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, Card } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../../lib/api/client";
import { authAtom } from "../../../lib/atoms/auth";

export const Route = createFileRoute("/_authenticated/admin/ai")({
  component: AiConsolePage
});

type AiSettings = { baseUrl: string; model: string; systemPrompt: string; temperature: number; hasApiKey: boolean; updatedAt: number | null };
type ChatMsg = { role: "user" | "assistant" | "system"; content: string; model: string | null; createdAt?: number };
type FormState = { baseUrl: string; apiKey: string; model: string; systemPrompt: string; temperature: number };

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

const EMPTY_FORM: FormState = { baseUrl: "", apiKey: "", model: "", systemPrompt: "", temperature: 0 };

function AiConsolePage() {
  const [user] = useAtom(authAtom);
  const isOwner = user?.grants.some((grant) => grant.role === "owner") ?? false;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [hydrated, setHydrated] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [threadId, setThreadId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("threadId"));

  const settingsQuery = useQuery({
    queryKey: ["ai", "settings"],
    queryFn: () => fetchJson<{ settings: AiSettings }>("/api/ai/settings", "ไม่สามารถโหลดการตั้งค่า AI ได้"),
    enabled: isOwner
  });

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings || hydrated) return;
    setForm({
      baseUrl: settings.baseUrl,
      apiKey: "",
      model: settings.model,
      systemPrompt: settings.systemPrompt,
      temperature: settings.temperature
    });
    setHydrated(true);
  }, [hydrated, settingsQuery.data]);

  const modelsQuery = useQuery({
    queryKey: ["ai", "models", settingsQuery.data?.settings.baseUrl],
    queryFn: async () => {
      const data = await fetchJson<{ models: string[]; error: string | null }>("/api/ai/models", "ไม่สามารถโหลดรายชื่อโมเดลได้");
      if (data.error) throw new Error(data.error);
      return data.models;
    },
    enabled: isOwner && settingsQuery.data?.settings.hasApiKey === true,
    staleTime: 10 * 60 * 1000
  });

  const historyQuery = useQuery({
    queryKey: ["ai", "chat", threadId],
    queryFn: () => fetchJson<{ messages: ChatMsg[] }>(`/api/ai/chat?threadId=${encodeURIComponent(threadId ?? "")}`, "ไม่สามารถโหลดประวัติสนทนาได้"),
    enabled: isOwner && Boolean(threadId)
  });

  useEffect(() => {
    if (historyQuery.data) setMessages(historyQuery.data.messages);
  }, [historyQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const response = await fetch(apiUrl("/api/ai/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `บันทึกการตั้งค่าไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { settings: AiSettings };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ai", "settings"] });
    }
  });

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const response = await fetch(apiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threadId: threadId ?? undefined, message })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `ส่งข้อความไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { threadId: string; reply: string };
    },
    onSuccess: async (data, message) => {
      setThreadId(data.threadId);
      setMessages((current) => [...current, { role: "user", content: message, model: null }, { role: "assistant", content: data.reply, model: form.model }]);
      setChatInput("");
      await queryClient.invalidateQueries({ queryKey: ["ai", "chat", data.threadId] });
    }
  });

  if (!isOwner) {
    return (
      <div className="page-content">
        <section className="surface-card restricted-state">
          <h1>เข้าถึงไม่ได้</h1>
          <p>AI Console ใช้ได้เฉพาะบัญชีบทบาทเจ้าของ</p>
          <Link to="/dashboard" className="secondary-button w-fit">กลับภาพรวม</Link>
        </section>
      </div>
    );
  }

  const modelOptions = Array.from(new Set([form.model, ...(modelsQuery.data ?? [])].filter(Boolean)));
  const hasApiKey = settingsQuery.data?.settings.hasApiKey === true;

  return (
    <div className="page-content">
      <section className="surface-card surface-card--dark">
        <h1>AI Console</h1>
        <p>ตั้งค่า gateway โมเดล และทดสอบผู้ช่วยแบบข้อความผ่านเซิร์ฟเวอร์</p>
      </section>

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>Provider และ Gateway</h2><span>API key ไม่เคยถูกส่งกลับจากเซิร์ฟเวอร์</span></div>
          {settingsQuery.isLoading && <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดการตั้งค่า AI</div>}
          {settingsQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดการตั้งค่า AI ได้: {settingsQuery.error.message}</div>}
          {settingsQuery.data && (
            <form
              className="settings-form"
              onSubmit={(event) => {
                event.preventDefault();
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
              <label className="field-control" htmlFor="ai-base-url"><span>Base URL แบบ OpenAI-compatible</span><input id="ai-base-url" type="url" required value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://gateway.example" /></label>
              <label className="field-control" htmlFor="ai-api-key"><span>API key {hasApiKey ? "· มี key ที่บันทึกไว้แล้ว เว้นว่างเพื่อคงเดิม" : "· ยังไม่ได้ตั้งค่า"}</span><input id="ai-api-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={hasApiKey ? "คงค่าเดิม" : "ใส่ API key"} /></label>
              <label className="field-control" htmlFor="ai-model"><span>โมเดลเริ่มต้น</span><select id="ai-model" required value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}>{modelOptions.length === 0 && <option value="">ยังไม่มีโมเดลที่ค้นพบ</option>}{modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              <label className="field-control" htmlFor="ai-temperature"><span>Temperature ({form.temperature}/100)</span><input id="ai-temperature" type="range" min={0} max={100} value={form.temperature} onChange={(event) => setForm((current) => ({ ...current, temperature: Number(event.target.value) }))} /></label>
              <div className="form-actions">
                <Button type="submit" className="primary-button" isDisabled={saveMutation.isPending}>{saveMutation.isPending ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</Button>
                <Button type="button" className="secondary-button" onPress={() => void queryClient.invalidateQueries({ queryKey: ["ai", "models"] })} isDisabled={!hasApiKey || modelsQuery.isFetching}>{modelsQuery.isFetching ? "กำลังโหลดโมเดล…" : "รีเฟรชโมเดล"}</Button>
              </div>
              {modelsQuery.isError && <p className="error-message" role="alert">โหลดรายชื่อโมเดลไม่สำเร็จ: {modelsQuery.error.message}</p>}
              {saveMutation.isError && <p className="error-message" role="alert">บันทึกไม่สำเร็จ: {saveMutation.error.message}</p>}
              {saveMutation.isSuccess && <p className="feedback-message feedback-message--success" role="status">บันทึกการตั้งค่าแล้ว</p>}
            </form>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>System prompt</h2><span>รองรับ role, branches และ tools เป็นข้อความเทมเพลต</span></div>
          <label className="sr-only" htmlFor="ai-system-prompt">System prompt</label>
          <textarea id="ai-system-prompt" className="field-control field-textarea" value={form.systemPrompt} onChange={(event) => setForm((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder="คุณคือผู้ช่วยข้อมูลของระบบ LaundryTwin" />
          <p className="kpi-detail">ตัวแปรเทมเพลตที่มีในระบบ: <code>{"{{role}}"}</code> <code>{"{{branches}}"}</code> <code>{"{{tools}}"}</code></p>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>ทดสอบการสนทนา</h2><span>{threadId ? `Thread: ${threadId}` : "เริ่ม thread ใหม่"}</span></div>
          <div className="ai-thread" role="log" aria-live="polite" aria-label="ข้อความสนทนา">
            {historyQuery.isLoading && <p className="state-message">กำลังโหลดประวัติสนทนา</p>}
            {historyQuery.isError && <p className="error-message">โหลดประวัติสนทนาไม่สำเร็จ: {historyQuery.error.message}</p>}
            {!historyQuery.isLoading && messages.length === 0 && <p className="state-message">ส่งข้อความเพื่อทดสอบ gateway ที่ตั้งค่าไว้</p>}
            {messages.map((message, index) => <div key={`${message.role}-${message.createdAt ?? index}-${message.content.slice(0, 20)}`} className={`chat-message chat-message--${message.role}`}><strong>{message.role === "user" ? "คุณ" : message.role === "assistant" ? "ผู้ช่วย" : "ระบบ"}</strong><p>{message.content}</p>{message.model && <small>{message.model}</small>}</div>)}
            {chatMutation.isPending && <p className="state-message" role="status">กำลังรอคำตอบ…</p>}
          </div>
          <form className="chat-form" onSubmit={(event) => { event.preventDefault(); if (chatInput.trim() && !chatMutation.isPending) chatMutation.mutate(chatInput.trim()); }}>
            <label className="sr-only" htmlFor="ai-chat-input">ข้อความถาม AI</label>
            <input id="ai-chat-input" value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="ถามเกี่ยวกับรายได้ รอบซัก หรือข้อมูลเครื่อง" />
            <Button type="submit" className="primary-button" isDisabled={!chatInput.trim() || chatMutation.isPending}>{chatMutation.isPending ? "กำลังส่ง…" : "ส่งข้อความ"}</Button>
          </form>
          {chatMutation.isError && <p className="error-message" role="alert">ส่งข้อความไม่สำเร็จ: {chatMutation.error.message}</p>}
          <p className="ai-limitation">AI Console ปัจจุบันเป็น plain chat completion ยังไม่เรียก MCP tools จากหน้านี้ และไม่แสดง audit trail ของ tool call</p>
        </Card.Content>
      </Card>
    </div>
  );
}
