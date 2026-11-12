import { recordPendingLiffAccessRequest } from "../access-store";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import { listBranchNames } from "../analytics/queries";
import { isValidLineSignature } from "../line";
import type { PlatformAdapter } from "./adapter";
import type { AccessScope } from "./identity";
import { resolveLineIdentity, roleLabel } from "./identity";
import { answerForMessage, describeBotFailure } from "./conversation";
import { appendTurn, rememberPendingQuestion, takePendingQuestion, turnCount } from "./memory";
import {
  acknowledgeFromChat,
  acknowledgementReply,
  helpText,
  parsePostbackData,
  refusalReply,
  welcomeText
} from "./actions";
import { menuKeyForRoles, richMenuDefinitions } from "../rich-menu";
import { chatEnabled, evaluateChatLimit } from "./limit";
import {
  branchChoiceReplies,
  branchPickerText,
  forgottenText,
  isForgetBranchRequest,
  isSetBranchRequest,
  rememberedBranchText
} from "./actions";
import { clearPreference, readPreference, rememberedLine, setPreference } from "./preferences";
import { ALL_BRANCHES, askWhichBranchText, branchScopeReplies, shouldAskWhichBranch } from "./branch-intent";
import { narrowScopeToBranch } from "./scope";
import { bahtOnly } from "./money";
import { ALREADY_RATED, recordFeedback, thanksText, UNKNOWN_TURN } from "./feedback";
import { shapeAnswer, TRUNCATION_NOTE } from "./shape";
import type { OutboundMessage } from "./adapter";
import { answerAltText, buildAnswerFlex, parseAnswer, stripMarkdown } from "./answer-flex";
import { LineAdapter } from "./line-adapter";
import { McpClient, type McpClientLike } from "./mcp-client";

export type BotDeps = {
  mcpUrl: string;
  mcpToken: string;
  lineChannelAccessToken: string | undefined;
  clickhouse: ClickHouseExecutor;
  fetchImpl?: typeof fetch;
};

type LineSource = { userId?: string; displayName?: string };

type LineTextEvent = {
  type: "message";
  message: { type: "text"; text: string };
  source?: LineSource;
  /** Free reply path; absent on events that are not a user message. */
  replyToken?: string;
};

/** A new follower. Carries a reply token, so the welcome is free. */
type LineFollowEvent = {
  type: "follow" | "unfollow";
  source?: LineSource;
  replyToken?: string;
};

/** A tap on a card button. `postback.data` is user-supplied, so it is a command. */
type LinePostbackEvent = {
  type: "postback";
  postback: { data?: string };
  source?: LineSource;
  replyToken?: string;
};

type LineEvent = LineTextEvent | LineFollowEvent | LinePostbackEvent;

async function branchContextFor(scope: AccessScope, clickhouse: ClickHouseExecutor): Promise<string> {
  try {
    const branches = await listBranchNames(clickhouse);
    const allowed = scope.branchIds.includes("*")
      ? branches
      : branches.filter((branch) => scope.branchIds.includes(branch.branchId));
    return allowed.map((branch) => `${branch.branchName} (${branch.branchId})`).join(", ");
  } catch {
    return "";
  }
}

/**
 * The branch names this person may see, and a lookup from id to name. Failure is not
 * fatal: without the warehouse we can still answer questions, we just cannot show a
 * picker or name the remembered branch.
 */
async function visibleBranches(
  scope: AccessScope,
  clickhouse: ClickHouseExecutor
): Promise<{ branchId: string; branchName: string }[]> {
  try {
    const branches = await listBranchNames(clickhouse);
    return scope.branchIds.includes("*")
      ? branches
      : branches.filter((branch) => scope.branchIds.includes(branch.branchId));
  } catch {
    return [];
  }
}

/** The card header colour, so a role's answer matches the panel it came from. */
const CARD_ACCENTS: Record<string, string> = {
  owner: "#1f6feb",
  manager: "#2ea043",
  technician: "#d29922",
  default: "#57606a"
};

function accentFor(roleLabel: string): string {
  const first = roleLabel.split(",")[0]?.trim() ?? "";
  return CARD_ACCENTS[first] ?? CARD_ACCENTS.default;
}

export function createBotHandler(deps: BotDeps, adapterOverride?: PlatformAdapter, mcpOverride?: McpClientLike) {
  const adapter = adapterOverride ?? new LineAdapter(deps.lineChannelAccessToken);
  const mcp = mcpOverride ?? new McpClient(deps.mcpUrl, deps.mcpToken);
  /**
   * One answer at a time per LINE user, in order.
   *
   * This was a `Set`: a second message that arrived while the first was in flight
   * was silently dropped, so a user who typed twice got one answer and no reason.
   * A queue is the honest behaviour — the second message waits, then answers, and
   * the conversation reads as a conversation.
   */
  const inFlight = new Map<string, Promise<void>>();

  function enqueue(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = inFlight.get(userId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (inFlight.get(userId) === next) inFlight.delete(userId);
      });
    inFlight.set(userId, next);
    return next;
  }

  /**
   * Answer with a free reply when the event carried a token, and a charged push
   * otherwise. Written as two calls rather than one with `undefined`, so a caller
   * that has no token sends exactly what it sent before this existed.
   */
  /**
   * Send the answer as a card when it has shape, as text when it does not.
   *
   * LINE does not render markdown, so a text answer arrived with its `**` and
   * `###` intact — the reader saw the markup. The card is built from the answer's
   * own structure (a heading, `ชื่อ: ค่า` lines, bullets) and the plain text stays
   * as the fallback, so a failure to build one never loses the answer.
   */
  async function deliver(
    userId: string,
    text: string,
    roleLabel: string,
    replyToken?: string,
    quickReplies?: { label: string; text?: string; uri?: string }[],
    /** The turn being answered, so the card's buttons can refer to it. */
    turnId?: string
  ) {
    // At most two messages, cut at paragraph or sentence boundaries, never inside a
    // word — LINE shows a long answer as a wall, and refuses past 5,000 characters.
    const shaped = shapeAnswer(text);
    const first = shaped.parts[0] ?? text;
    const parsed = parseAnswer(first);
    const flex = buildAnswerFlex(parsed, { accent: accentFor(roleLabel), feedbackFor: turnId });

    const parts: OutboundMessage[] = [];
    if (flex) {
      parts.push({ kind: "flex", altText: answerAltText(parsed), contents: flex });
    } else {
      parts.push({ kind: "text", text: stripMarkdown(first) });
    }
    for (const extra of shaped.parts.slice(1)) {
      parts.push({ kind: "text", text: stripMarkdown(extra) });
    }
    if (shaped.truncated) {
      // Say it was cut, in the last message, rather than leaving a sentence that
      // stops mid-thought and reads as a broken bot.
      const last = parts[parts.length - 1];
      const note = TRUNCATION_NOTE;
      if (last?.kind === "text") last.text = `${last.text}\n\n${note}`;
      else parts.push({ kind: "text", text: note });
    }

    // One message: the card or text path that was here before, unchanged. Two
    // messages: one reply carrying both, so the split costs nothing.
    if (parts.length === 1) {
      if (flex && adapter.sendFlex) {
        try {
          return await adapter.sendFlex(userId, answerAltText(parsed), flex, { replyToken, quickReplies });
        } catch {
          // fall through to text
        }
      }
      return reply(userId, stripMarkdown(first), replyToken, quickReplies);
    }

    if (adapter.sendMessages) {
      try {
        return await adapter.sendMessages(userId, parts, { replyToken, quickReplies });
      } catch {
        // fall through to the single-message path below
      }
    }
    return reply(userId, stripMarkdown(first), replyToken, quickReplies);
  }

  async function reply(
    userId: string,
    text: string,
    replyToken?: string,
    quickReplies?: { label: string; text?: string; uri?: string }[]
  ) {
    if (replyToken) {
      return adapter.sendText(userId, text, { replyToken, ...(quickReplies ? { quickReplies } : {}) });
    }
    return adapter.sendText(userId, text, quickReplies ? { quickReplies } : {});
  }

  type Authorised = Extract<ReturnType<typeof resolveLineIdentity>, { ok: true }>;

  /**
   * Ask the model, deliver the card, store the turn.
   *
   * Extracted because two paths end here: the message that arrives with enough
   * scope to answer, and the branch tap that finishes a question the bot held
   * back. `prepared` carries the branch list the caller already fetched, so the
   * common path still makes exactly one warehouse call.
   */
  async function answerInto(
    userId: string,
    identity: Authorised,
    question: string,
    replyToken: string | undefined,
    startedAt: number,
    prepared?: { branches: { branchId: string; branchName: string }[]; remembered: string | null }
  ): Promise<void> {
    const branches = prepared?.branches ?? (await visibleBranches(identity.scope, deps.clickhouse));
    const branchNameCache = new Map(branches.map((branch) => [branch.branchId, branch.branchName]));
    const branchContext = branches.map((branch) => `${branch.branchName} (${branch.branchId})`).join(", ");
    const remembered = prepared?.remembered ?? rememberedLine(userId, (branchId) => branchNameCache.get(branchId) ?? null);

    // The tools run on the narrowed scope; the prompt line alone changed nothing.
    const scope = narrowScopeToBranch({
      scope: identity.scope,
      rememberedBranchId: readPreference(userId, "branch"),
      branches,
      question
    });

    const answer = await answerForMessage(
      {
        userText: question,
        lineUserId: userId,
        roleLabel: roleLabel(identity.principal),
        branchContext,
        scope,
        actorUserId: identity.principal.user.id,
        remembered,
        now: new Date()
      },
      { mcp, fetchImpl: deps.fetchImpl }
    );

    // The prompt asks for baht; this makes it true whatever the model wrote.
    const text = bahtOnly(answer.text);

    // Suggestions on the first answer only: after that the person knows what to
    // type, and a keyboard full of chips on every message is noise.
    const quickReplies = turnCount(userId) === 0 ? FIRST_TURN_REPLIES : undefined;
    const delivered = await deliver(userId, text, roleLabel(identity.principal), replyToken, quickReplies, answer.turnId);

    // The turn is the bot's memory and its record: without this row a follow-up
    // question has nothing to refer to, and nobody can see what the bot said.
    appendTurn({
      lineUserId: userId,
      userText: question,
      // Stored without markdown: this is what the next question is given as
      // context, and a transcript full of `**` teaches the model to use it.
      answerText: stripMarkdown(text),
      model: answer.model,
      steps: answer.steps,
      toolCalls: answer.toolCalls,
      latencyMs: Date.now() - startedAt,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      toolError: answer.toolError,
      delivered: delivered === "reply" || delivered === "push" ? delivered : undefined
    });
  }

  async function answerOne(event: LineTextEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return;
    const startedAt = Date.now();
    try {
      const identity = resolveLineIdentity(userId);
      if (!identity.ok) {
        if (identity.code === "unknown_user") {
          recordPendingLiffAccessRequest({
            lineUserId: userId,
            displayName: event.source?.displayName ?? "LINE bot user"
          });
        }
        await reply(
          userId,
          "บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ใช้งาน LaundryTwin กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์",
          event.replyToken
        );
        return;
      }
      // A switch first, then the allowance: both refuse before spending a model call.
      if (!chatEnabled()) {
        await reply(userId, "ผู้ช่วยถูกปิดปรับปรุงชั่วคราว กรุณาลองใหม่ภายหลัง", event.replyToken);
        return;
      }
      const limit = evaluateChatLimit({ lineUserId: userId });
      if (!limit.allowed) {
        await reply(userId, limit.message, event.replyToken);
        return;
      }

      // Two commands are answered by code, not by the model: setting a remembered
      // branch and forgetting it. They are short, exact and must not cost a model
      // call — a typo in the branch name must fail here, not in a prompt.
      if (isSetBranchRequest(event.message.text)) {
        const branches = await visibleBranches(identity.scope, deps.clickhouse);
        await reply(
          userId,
          branchPickerText(branches),
          event.replyToken,
          branchChoiceReplies(branches)
        );
        return;
      }
      if (isForgetBranchRequest(event.message.text)) {
        const cleared = clearPreference(userId);
        await reply(userId, forgottenText(cleared), event.replyToken);
        return;
      }

      // Typing indicator first: the model plus a tool call takes seconds, and
      // silence reads as "broken". Free, and it covers the whole answer.
      void adapter.showLoading?.(userId);

      // One warehouse call for both the prompt context and the id→name lookup the
      // remembered preference needs.
      const branchesForContext = await visibleBranches(identity.scope, deps.clickhouse);
      const branchNameCache = new Map(branchesForContext.map((branch) => [branch.branchId, branch.branchName]));
      const remembered = rememberedLine(userId, (branchId) => branchNameCache.get(branchId) ?? null);

      // A question about "the shop" from someone with two branches is a question
      // the bot cannot scope by guessing. Ask, hold the question, and answer it
      // when the tap arrives — see `branch-intent.ts` for why this is narrow.
      if (shouldAskWhichBranch({ text: event.message.text, branches: branchesForContext, hasRememberedBranch: Boolean(remembered) })) {
        rememberPendingQuestion({ lineUserId: userId, question: event.message.text });
        await reply(userId, askWhichBranchText(branchesForContext), event.replyToken, branchScopeReplies(branchesForContext));
        return;
      }

      await answerInto(userId, identity, event.message.text, event.replyToken, startedAt, {
        branches: branchesForContext,
        remembered
      });
    } catch (error) {
      console.error("LaundryTwin bot error", error);
      try {
        await reply(userId, describeBotFailure(error), event.replyToken);
      } catch {
        // reply is best-effort; never let a reply failure crash the webhook
      }
    }
  }

  /** The three questions a first-time user is most likely to want. */
  const FIRST_TURN_REPLIES = [
    { label: "ภาพรวมวันนี้", text: "ภาพรวมวันนี้เป็นยังไง" },
    { label: "เมื่อวาน", text: "แล้วเมื่อวานล่ะ" },
    { label: "เครื่องที่มีปัญหา", text: "เครื่องไหนมีปัญหาบ้าง" }
  ];

  /** Menu labels for this role, from the same definitions the rich menu uploads. */
  function menuLabelsFor(principal: Parameters<typeof roleLabel>[0]): string[] {
    const liffId = process.env.LIFF_ID;
    if (!liffId) return [];
    const roles = principal.grants.map((grant) => grant.role);
    const menu = richMenuDefinitions(liffId).find((definition) => definition.key === menuKeyForRoles(roles));
    return menu ? menu.labels : [];
  }

  /** A new follower: greet, and say what the bot can do. The reply token is free. */
  async function handleFollowEvent(event: LineFollowEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return;
    const identity = resolveLineIdentity(userId);
    const branches = identity.ok
      ? identity.scope.branchIds.includes("*")
        ? ["ทุกสาขา"]
        : identity.scope.branchIds
      : [];
    await reply(userId, welcomeText(branches), event.replyToken);
  }

  /**
   * A tap on a postback button.
   *
   * The payload is user-supplied, so it is parsed as a command and authorised from
   * scratch — the alert id in `ack:<id>` proves nothing about who may acknowledge it.
   */
  async function handlePostbackEvent(event: LinePostbackEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return;
    const command = parsePostbackData(event.postback.data);
    const identity = resolveLineIdentity(userId);

    if (!identity.ok) {
      await reply(
        userId,
        "บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ใช้งาน LaundryTwin กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์",
        event.replyToken
      );
      return;
    }

    if (command.kind === "feedback") {
      const result = recordFeedback({ turnId: command.turnId, lineUserId: userId, rating: command.rating });
      await reply(
        userId,
        result === "recorded" ? thanksText(command.rating) : result === "duplicate" ? ALREADY_RATED : UNKNOWN_TURN,
        event.replyToken
      );
      return;
    }

    if (command.kind === "pref") {
      if (command.action === "clear") {
        await reply(userId, forgottenText(clearPreference(userId)), event.replyToken);
        return;
      }
      // The branch id came from a button, but a button payload is still user input:
      // it is checked against this person's scope before it is stored.
      const branches = await visibleBranches(identity.scope, deps.clickhouse);
      // A tap may be finishing a question the bot held back rather than setting a
      // preference; taking it is destructive so a double tap cannot answer twice.
      const pending = takePendingQuestion(userId);

      if (command.branchId === ALL_BRANCHES) {
        if (pending) {
          await answerInto(userId, identity, pending, event.replyToken, Date.now(), { branches, remembered: null });
        } else {
          await reply(userId, "ได้ครับ — จะตอบจากทุกสาขาที่คุณเข้าถึง", event.replyToken);
        }
        return;
      }

      const branch = branches.find((candidate) => candidate.branchId === command.branchId);
      if (!branch) {
        await reply(
          userId,
          "สาขานี้ไม่ใช่สาขาที่คุณเข้าถึงได้ — ไม่ได้บันทึกไว้",
          event.replyToken
        );
        return;
      }
      setPreference(userId, "branch", branch.branchId);

      if (pending) {
        // One reply token, so the question wins: the card's own header names the
        // branch, which says what "จำไว้แล้ว" would have said, and the person gets
        // the answer they asked for in the same breath.
        const remembered = rememberedLine(userId, (branchId) => branches.find((b) => b.branchId === branchId)?.branchName ?? null);
        await answerInto(userId, identity, pending, event.replyToken, Date.now(), { branches, remembered });
        return;
      }

      await reply(userId, rememberedBranchText(branch.branchName), event.replyToken);
      return;
    }

    if (command.kind === "ack") {
      const outcome = acknowledgeFromChat({
        alertId: command.alertId,
        principal: identity.principal,
        lineUserId: userId
      });
      await reply(userId, outcome.ok ? acknowledgementReply(outcome) : refusalReply(outcome), event.replyToken);
      return;
    }

    // help, and anything we do not recognise
    const branches = identity.scope.branchIds.includes("*") ? ["ทุกสาขา"] : identity.scope.branchIds;
    await reply(userId, helpText(branches, menuLabelsFor(identity.principal)), event.replyToken);
  }

  /** Queue the answer for this user; the webhook returns before it runs. */
  function handleTextEvent(event: LineTextEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return Promise.resolve();
    return enqueue(userId, () => answerOne(event));
  }

  async function handle(rawBody: string, signature: string | undefined): Promise<Response> {
    if (!isValidLineSignature(rawBody, signature)) {
      return new Response(JSON.stringify({ error: "Invalid LINE webhook signature" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    const payload = JSON.parse(rawBody) as { events: LineEvent[] };
    for (const event of payload.events) {
      // Ack the webhook immediately; answers are pushed async because the
      // LLM + tool loop can exceed LINE's 60s reply window.
      if (event.type === "message" && event.message.type === "text") {
        void handleTextEvent(event);
      } else if (event.type === "follow") {
        void handleFollowEvent(event);
      } else if (event.type === "postback") {
        void handlePostbackEvent(event);
      } else if (event.type === "unfollow") {
        // Nothing to say: the user left. Recorded by the absence of a reply,
        // which is the only thing the platform gives us.
        continue;
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  return { handle, handleTextEvent, handleFollowEvent, handlePostbackEvent };
}
