# Observability for the assistant

Written 2026-11-10, after researching Langfuse, LangSmith, Arize Phoenix, Helicone and
LangChain for this deployment. The question was not "which tool is best" but "which one
this shop can run, and what it is allowed to send".

## What exists today, without any new tool

| where | what it holds |
|---|---|
| `chat_turn` | every answered message: model, steps, tool calls, latency, delivered (reply/push), the text |
| `audit_log` | who changed what, including every AI-settings edit |
| `ai_chat` messages | the owner console's own test threads |
| Airflow | every alert sweep and digest run, with its summary line |
| `alert_notification` / `alert_sent` | what LINE actually accepted, and what it refused |

That covers "what happened" and "how much it cost in messages". What it does not cover
is the shape of a slow answer — which step, which tool, how many tokens — because the
answer arrives as one row.

## The candidates

| tool | licence / hosting | what it needs | verdict here |
|---|---|---|---|
| **Langfuse** | MIT core; cloud Hobby free (50k units/month, 30-day retention, 2 users) | self-host = 6 containers: web, worker, Postgres, ClickHouse, Redis/Valkey, S3 | **use via OTLP**, cloud or a later self-host |
| **LangSmith** | closed source; self-hosting is enterprise-only | SaaS | no: traces of a Thai laundry's revenue on someone else's SaaS is a decision the owner has not made |
| **Arize Phoenix** | free to self-host (Elastic Licence 2.0) | one container + a database; OTLP | good fallback if a second collector is ever wanted |
| **Helicone** | Apache 2.0, proxy-based | all model traffic goes through it | no: a proxy in front of the gateway is another moving part, and it sees every prompt |
| **LangChain / LangGraph** | framework, not observability | — | not applicable: this app's tool loop is the Vercel AI SDK, so adopting LangChain would be a rewrite that buys nothing an OTLP span does not |

Measured on the target host (`uunw@10.10.0.117`), 2026-11-10:

```
$ free -g          total 11   used 6   available 5
$ df -h /          79G        used 69G   avail 6.7G  (92%)
$ nproc            4
```

Langfuse's own self-host guidance is 4 cores / 16 GiB RAM / 100 GiB disk for the
full stack. **It does not fit this VM today** — the honest answer is not "install it
anyway". Two paths fit:

1. **Langfuse Cloud Hobby** — free, 50k units/month, no infrastructure. Turns per day
   here are in the single digits, so the limit is not close.
2. **Phoenix or Langfuse later** — after the disk situation is resolved; the app does
   not change, only `OTEL_EXPORTER_OTLP_ENDPOINT`.

## What was added

`apps/api/src/telemetry.ts`:

- **OTLP/HTTP export, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** No endpoint
  means no SDK started and no OpenTelemetry import — a deployment that does not want
  tracing pays nothing for it.
- **Spans are ours, not the SDK's.** `withAnswerSpan` opens `chat.answer` around each
  answer and records `llm.model`, `llm.steps`, `llm.tool_calls`, `llm.prompt_version`,
  `chat.role`, and errors. The AI SDK's own telemetry is deliberately *not* registered:
  it records prompts and completions by default, which is exactly the data this shop
  should not ship to a collector by accident.
- **Content stays local** unless `OTEL_RECORD_CONTENT=1`. Even then only the question is
  attached, and that is an explicit choice.
- **Never fatal.** A missing package or a wrong endpoint is logged; the answer is more
  important than the trace of it.

### Enable it

```bash
# in /opt/laundrytwin/.env
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(publicKey:secretKey)>
OTEL_SERVICE_NAME=laundrytwin-api
# OTEL_RECORD_CONTENT=1   # only if questions may leave the box
```

Restart the app; the log says `[telemetry] OTLP export enabled -> … (content: off)`.
Traces appear as `chat.answer` spans with the attributes above and no text.

### What was configured (2026-11-11)

Langfuse Cloud, region JP (`https://jp.cloud.langfuse.com`), project "My Project". The
three values live in `/opt/laundrytwin/.env` (mode 600) as

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://jp.cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(publicKey:secretKey)>
OTEL_SERVICE_NAME=laundrytwin-api
```

Verified by reading the trace back out of Langfuse's API, not by watching the log:

```text
chat.answer   GENERATION  4.791s
model        nemotron-3-ultra-550b-a55b
usage        input 6468 · output 195 · total 6663      (identical to chat_turn)
session      set (salted pseudonym, not the LINE id)
tool.get_revenue_daily   SPAN  0.013s
```

Two attribute bugs were found this way and fixed: the span opened with the role label
as its model (`owner`), and the token keys were still `llm.*` so Langfuse read zeros.
Both are now `gen_ai.*` plus `langfuse.observation.*`.

**Deploy gotcha, learned the hard way.** `docker compose up -d app` without an
`APP_IMAGE=` override uses the value in `/opt/laundrytwin/.env` — which was still naming
an image from the previous day, so recreating the container silently rolled the API
back a day. The env file now holds the tag that is actually running, and that is the
line to update on every deploy.

### Verify it is off when it should be

```text
$ docker exec laundrytwin-app-1 printenv OTEL_EXPORTER_OTLP_ENDPOINT   # empty
$ curl -s localhost:8787/health                                        # 200
```

## L1 and L2, as built (`d3f758b`)

**L1 — where the time went.** `ai_trace` holds one row per span: the answer and every
tool call inside it, with duration, status and metadata (model, steps, tool count,
input/output tokens, prompt version, salted session pseudonym). `chat_turn` gained
`input_tokens` / `output_tokens`, read from the stream's `totalUsage` — 0 when the
gateway omits it, never invented.

Measured on production, one real question:

```text
tool.get_revenue_daily   16ms
tool.get_cycles_daily    59ms
chat.answer          11,173ms    12,961 input tokens / 1,094 output
```

The tools are not the slow part. Before L1 the only number was "23 seconds".

**L2 — did the change help.** `eval_case` / `eval_run` / `eval_result` replay five
canonical questions through the same `answerForMessage` production uses, scored by
rules (answered, grounded, mentions, timely). `POST /api/internal/eval/run` runs it with
the machine token; `/admin/ai` lists the last ten runs. First production run
(`84d9c3ab`): 2 cases, 2 passed, average score 100, average latency 11.6s.

A run is a regression alarm, not a truth oracle: a confident wrong number passes
"grounded". What it catches is "the model stopped using tools", "every answer is an
apology", "the date is wrong" — the failures that actually shipped on 2026-11-10.

## What this does not do

- It does not evaluate answer quality; it shows where time went.
- It does not replace `chat_turn`: the row is the shop's record, the span is an
  operator's view, and the row survives even when no collector is configured.
