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

### Verify it is off when it should be

```text
$ docker exec laundrytwin-app-1 printenv OTEL_EXPORTER_OTLP_ENDPOINT   # empty
$ curl -s localhost:8787/health                                        # 200
```

## What this does not do

- It does not evaluate answer quality; it shows where time went.
- It does not replace `chat_turn`: the row is the shop's record, the span is an
  operator's view, and the row survives even when no collector is configured.
