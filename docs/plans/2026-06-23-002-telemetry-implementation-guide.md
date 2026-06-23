# Telemetry & Observability — Implementation Guide

- **Status:** Draft / build-ready
- **Date:** 2026-06-23
- **Companion to:** `2026-06-23-001-telemetry-and-observability-design.md` (the *why*; this is the *how*)
- **Audience:** the engineer(s) building Phase 0 + Phase 1, and the reviewer gating Phase 2
- **Scope of this doc:** module layout, the canonical **metric inventory + instrument
  types**, the SQLite schema DDL, the emitter API, the four instrumentation hook points
  (with real call sites), the Plane-B bucketing rules, and the CI privacy-test harness.

> Read the design doc first for the three-plane model (A=local, B=Nous aggregate,
> C=trajectories), the consent posture (opt-in), and the enterprise model. This guide
> assumes those decisions and does not re-argue them.

---

## 0. The one mental model to hold

There are **two distinct layers**, and the original plan conflated them:

| Layer | What it is | Where it lives | Instrument types |
|---|---|---|---|
| **Events / spans** | one row per occurrence, high-cardinality | Plane A (`state.db` + JSONL) | n/a — they're records |
| **Metrics** | aggregates *rolled up from* events | derived for dashboards; exported via OTLP/Prom (A) and as counters (B) | counters, histograms, gauges |

The build order is **events first, metrics derived from events**. We do not emit OTel
metric instruments at call sites in v1 (see §9, Decision D2). We write spans/events on the
hot path and compute metrics by querying the event log. This keeps one source of truth and
minimal hot-path code.

**The privacy consequence that drives everything in §3 and §4:**

> Plane A gets the full instrument set — real histograms, real gauges, raw values.
> **Plane B gets counters and client-pre-bucketed counters. Nothing else.**
> No raw values, no server-side histogramming, no gauges.

---

## 1. Module layout

New package `agent/telemetry/`. Nothing here is a model tool; it's instrumentation + a CLI.

```
agent/telemetry/
  __init__.py            # public: emit(), span(), Telemetry singleton accessor
  emitter.py             # Telemetry class: async queue, JSONL writer, SQLite indexer
  schema.py              # SQLite DDL + migration registration into state.db
  events.py              # @dataclass event types (RunEvent, ModelCallEvent, ...) — the closed Plane-A schema
  spans.py               # span()/run() context managers, trace/span id propagation (contextvars)
  metrics.py             # derive metric rollups from the event log (counters/histograms/gauges)
  aggregate/
    schema_b.py          # the closed Plane-B event schema (enums, allowlist) — NORMATIVE
    buckets.py           # frozen bucket-boundary definitions (versioned)
    builder.py           # construct a Plane-B event field-by-field from a Plane-A run
    uploader.py          # local queue + batch POST (Phase 2; stubbed in Phase 1)
  export/
    otlp.py              # Plane-A OTLP exporter (spans + derived metrics) — local only
    jsonl.py             # raw export
    bundle.py            # redacted support bundle (uses agent/redact.py + codec-aware redactor)
  redaction/
    codec_aware.py       # §8.1 of design doc — for content planes (A-export, C, bundles) ONLY
  policy.py              # consent state machine + org_policy enforcement (§11 design doc)
hermes_cli/subcommands/
  telemetry.py           # `hermes telemetry ...` parser + handlers
```

**Reuse, do not rebuild:**
- `agent/usage_pricing.py` — cost engine. Add provenance fields (§7 below), don't fork.
- `agent/insights.py::InsightsEngine` — repoint at the new tables; keep the CLI surface.
- `agent/redact.py::redact_sensitive_text` — secret redaction; the new codec-aware
  redactor is *additive* (PII/content), it does not replace secret redaction.
- `hermes_state.py` `SessionDB` — the telemetry tables are migrations *into* `state.db`.

---

## 2. Storage model

### 2.1 Two shapes, one source of truth

1. **JSONL append log** — `~/.hermes/telemetry/events.jsonl` (per-profile under
   `$HERMES_HOME`). This is the **source of truth**. One JSON object per line, one line per
   event. Crash-safe (append-only, fsync-batched), `tail`-able, survives a bad migration.
2. **SQLite index** — tables in the existing `~/.hermes/state.db`. The indexer replays
   JSONL into tables. If the tables are ever corrupt/stale, they are rebuildable from the
   JSONL. **Do not create a second `.sqlite` file** — co-location lets us JOIN to
   `sessions`/`messages` and keeps one transactional store.

### 2.2 Use `get_hermes_home()` for all paths

Never hardcode `~/.hermes`. Profile-safe paths only:

```python
from hermes_constants import get_hermes_home
events_path = get_hermes_home() / "telemetry" / "events.jsonl"
```

### 2.3 SQLite DDL (register as a `state.db` migration)

Add to the schema-version migration chain in `hermes_state.py` (follow the existing
`CREATE TABLE IF NOT EXISTS` + `schema_version` bump pattern at ~line 519). All times are
unix-nanos INTEGER for OTel alignment.

```sql
-- One workflow (trace). A gateway message, cron run, CLI turn, API call, batch item.
CREATE TABLE IF NOT EXISTS tel_runs (
    run_id            TEXT PRIMARY KEY,
    trace_id          TEXT NOT NULL,
    session_id        TEXT,                 -- FK→sessions.id (Plane A only)
    profile_id        TEXT,
    entrypoint        TEXT NOT NULL,        -- enum: cli|gateway|cron|api|desktop|batch|acp
    platform_category TEXT,                 -- enum: telegram|discord|slack|...|cli
    start_ns          INTEGER NOT NULL,
    end_ns            INTEGER,
    end_reason        TEXT,                 -- enum: completed|failed|interrupted|timeout|max_iterations
    model_call_count  INTEGER DEFAULT 0,
    tool_call_count   INTEGER DEFAULT 0,
    error_count       INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    cost_status       TEXT,
    schema_v          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_tel_runs_trace   ON tel_runs(trace_id);
CREATE INDEX IF NOT EXISTS ix_tel_runs_session ON tel_runs(session_id);
CREATE INDEX IF NOT EXISTS ix_tel_runs_start   ON tel_runs(start_ns);

-- Timed step inside a run.
CREATE TABLE IF NOT EXISTS tel_spans (
    span_id        TEXT PRIMARY KEY,
    trace_id       TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    parent_span_id TEXT,
    name           TEXT NOT NULL,           -- enum-ish: workflow|model_call|tool_call|compression|delegation|...
    kind           TEXT,                    -- internal|client|server|producer|consumer
    start_ns       INTEGER NOT NULL,
    end_ns         INTEGER,
    status         TEXT,                    -- ok|error
    attrs_json     TEXT                     -- Plane-A only; may contain content. NEVER read into Plane B.
);
CREATE INDEX IF NOT EXISTS ix_tel_spans_run   ON tel_spans(run_id);
CREATE INDEX IF NOT EXISTS ix_tel_spans_trace ON tel_spans(trace_id);

-- One model/provider call.
CREATE TABLE IF NOT EXISTS tel_model_calls (
    span_id            TEXT PRIMARY KEY,
    run_id             TEXT NOT NULL,
    provider_family    TEXT,                -- enum
    model_class        TEXT,                -- enum (coarse; see §8 taxonomy)
    model_id           TEXT,                -- Plane A only (raw model string)
    local_runtime      TEXT,                -- ollama|llama_cpp|lm_studio|vllm|other; NULL unless provider_family=local (§8)
    input_tokens       INTEGER DEFAULT 0,
    output_tokens      INTEGER DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens   INTEGER DEFAULT 0,
    latency_ms         INTEGER,
    ttft_ms            INTEGER,             -- time to first token (streaming)
    estimated_cost_usd REAL,
    cost_status        TEXT,                -- known|unknown|estimated
    cost_source        TEXT,                -- official_docs|openrouter|metadata|...
    end_reason         TEXT,                -- completed|error|timeout
    retry_count        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tel_model_run ON tel_model_calls(run_id);

-- One tool call.
CREATE TABLE IF NOT EXISTS tel_tool_calls (
    span_id        TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    tool_name      TEXT,                    -- Plane A only (e.g. "web_search")
    tool_category  TEXT,                    -- enum (Plane B): web|browser|file|terminal|mcp|cron|memory|skills|voice|image|delegation|...
    backend        TEXT,                    -- local|docker|ssh|modal|...
    duration_ms    INTEGER,
    result_class   TEXT,                    -- ok|error|blocked|timeout
    retry_count    INTEGER DEFAULT 0,
    approval       TEXT                     -- none|requested|approved|denied|timeout
);
CREATE INDEX IF NOT EXISTS ix_tel_tool_run ON tel_tool_calls(run_id);

-- Subsystem events. Each is a thin typed row; keep them separate for clean rollups.
CREATE TABLE IF NOT EXISTS tel_gateway_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    platform_category TEXT, direction TEXT, result TEXT, voice INTEGER DEFAULT 0, attachments INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tel_cron_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    kind TEXT, result TEXT                  -- kind: created|run_started|run_completed|missed|disabled
);
CREATE TABLE IF NOT EXISTS tel_skill_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    action TEXT, skill_name TEXT            -- action: loaded|created|reused|patched|archived|pinned|installed; name=Plane A only
);
CREATE TABLE IF NOT EXISTS tel_memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    action TEXT, result TEXT                -- action: write|replace|remove; result: ok|rejected|capacity_pressure
);
CREATE TABLE IF NOT EXISTS tel_feedback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    kind TEXT                               -- retry|correction|undo|rollback|approval_denied|thumb_up|thumb_down
);
CREATE TABLE IF NOT EXISTS tel_error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts_ns INTEGER NOT NULL,
    error_class TEXT, subsystem TEXT, recovery TEXT  -- all enums; NO raw message, NO stack trace
);
```

> **Schema rule:** any column that can hold content or a raw identifier (`attrs_json`,
> `model_id`, `tool_name`, `skill_name`) is **Plane A only** and is annotated as such. The
> Plane-B builder (§4) is forbidden from reading these columns — enforced by test (§6).

---

## 3. The metric inventory (NORMATIVE)

This is the table the design doc was missing. `metrics.py` derives these from the event
log for Plane A; `aggregate/builder.py` emits the Plane-B subset as counters.

Legend — **Instrument:** `C`=counter (monotonic), `H`=histogram (distribution),
`G`=gauge (point-in-time), `UD`=updowncounter. **Plane:** A=local only, B=also aggregate
(as counter / bucketed-counter).

### 3.1 Workflow / run

| Metric | Instr | Unit | Dimensions (Plane A) | Plane B? |
|---|---|---|---|---|
| `workflow_started_total` | C | 1 | entrypoint, platform_category | B (counter) |
| `workflow_completed_total` | C | 1 | entrypoint, end_reason | B (counter) |
| `workflow_failed_total` | C | 1 | entrypoint, error_class | B (counter) |
| `workflow_duration_ms` | H | ms | entrypoint, hermes_version | B (**bucketed**: §4.2) |
| `model_calls_per_workflow` | H | 1 | entrypoint | B (bucketed) |
| `tool_calls_per_workflow` | H | 1 | entrypoint | B (bucketed) |
| `context_window_utilization` | H | ratio | model_class | A only |

### 3.2 Model calls

| Metric | Instr | Unit | Dimensions | Plane B? |
|---|---|---|---|---|
| `model_calls_total` | C | 1 | provider_family, model_class, end_reason | B (counter) |
| `model_call_latency_ms` | H | ms | provider_family, model_class | B (bucketed) |
| `model_ttft_ms` | H | ms | provider_family, model_class | A only (streaming detail) |
| `tokens_total` | C | token | provider_family, model_class, kind=input\|output\|cache_read\|cache_write\|reasoning | B (counter) |
| `model_cost_usd_total` | C | usd | provider_family, model_class | B (**bucketed per-workflow**, not summed raw) |
| `model_retries_total` | C | 1 | provider_family, end_reason | B (counter) |

### 3.3 Tool calls

| Metric | Instr | Unit | Dimensions | Plane B? |
|---|---|---|---|---|
| `tool_calls_total` | C | 1 | tool_category, result_class | B (counter — **category only**, never tool_name) |
| `tool_call_duration_ms` | H | ms | tool_category | B (bucketed) |
| `tool_retries_total` | C | 1 | tool_category | B (counter) |
| `tool_calls_by_name_total` | C | 1 | tool_name | **A only** (cardinality/fingerprint) |
| `approvals_total` | C | 1 | decision=requested\|approved\|denied\|timeout | B (counter) |

### 3.4 Subsystems (gateway / cron / skills / memory / errors)

| Metric | Instr | Unit | Dimensions | Plane B? |
|---|---|---|---|---|
| `gateway_messages_total` | C | 1 | platform_category, direction, result | B (counter) |
| `cron_runs_total` | C | 1 | result | B (counter) |
| `cron_schedules_active` | G | 1 | — | A only (gauge) |
| `skill_events_total` | C | 1 | action | B (counter) |
| `memory_writes_total` | C | 1 | action, result | B (counter) |
| `errors_total` | C | 1 | error_class, subsystem, hermes_version | B (counter) |
| `feedback_total` | C | 1 | kind | B (counter) |

### 3.5 Gauges (Plane A only, never aggregated)

| Metric | Instr | Unit | Why A-only |
|---|---|---|---|
| `active_sessions` | G | 1 | instantaneous host state; meaningless/fingerprinting in aggregate |
| `gateway_connections_active` | UD | 1 | same |
| `background_subagents_active` | UD | 1 | same |
| `queue_depth` | G | 1 | same |
| `context_tokens_current` | G | token | same |

### 3.6 Install census & lifecycle (Plane B — the denominator metrics)

These exist so "how many installs / activation rate / retention" are answerable at all
(§8.2). They carry **no** per-run data — just the install identity + coarse environment.

| Metric / event | Instr | Emitted | Dimensions | Plane B? |
|---|---|---|---|---|
| `install_activated` | C | once, after setup completes | os_family, arch, hermes_version, entrypoint | B (counter; denominator for activation) |
| `heartbeat` | C | ≤ once per UTC day while running | os_family, arch, hermes_version, entrypoint, platform_category | B (counter; powers DAU/WAU/MAU + D1/D7/D30 over install_id) |
| `telemetry_consent_changed` | C | on opt-in/opt-out | new_state | B (counter; lets us measure opt-in rate itself) |

> `COUNT(DISTINCT install_id)` over `heartbeat` = **opted-in active installs (lower
> bound)**, not total installs (§8.2). Label dashboards accordingly.

---

## 4. Plane-B construction & bucketing

### 4.1 The hard rule

`aggregate/builder.py` takes a **completed `tel_runs` row** and constructs a Plane-B event
**field by field from the allowlist** in `aggregate/schema_b.py`. It does **not** filter a
Plane-A object down. It never reads `attrs_json`, `model_id`, `tool_name`, `skill_name`,
or any free string. If a needed value isn't an enumerated token, a version string, a
count, or a bucket label — it is not emitted.

### 4.2 Frozen bucket boundaries (versioned with the schema)

Because Plane B forbids raw values, histograms become **counters keyed by a pre-binned
bucket label**. The boundaries are **frozen at schema-design time** — you cannot re-bin
server-side later — so they ship in `aggregate/buckets.py` and change only with a
`schema_version` bump.

```python
# aggregate/buckets.py  — schema_version 1.0. DO NOT mutate without a version bump.
DURATION_MS_BUCKETS = [  # right-open; label is the lower edge
    (0, "0_1k"), (1_000, "1k_5k"), (5_000, "5k_15k"), (15_000, "15k_30k"),
    (30_000, "30k_60k"), (60_000, "60k_120k"), (120_000, "120k_300k"), (300_000, "300k_plus"),
]
TOKEN_BUCKETS = [
    (0, "0_1k"), (1_000, "1k_5k"), (5_000, "5k_10k"), (10_000, "10k_50k"),
    (50_000, "50k_100k"), (100_000, "100k_500k"), (500_000, "500k_plus"),
]
COST_USD_BUCKETS = [
    (0.0, "0"), (0.01, "0_01_0_1"), (0.1, "0_1_1"), (1.0, "1_5"), (5.0, "5_20"), (20.0, "20_plus"),
]
COUNT_BUCKETS = [(0, "0"), (1, "1_3"), (4, "4_10"), (11, "11_30"), (31, "31_plus")]
```

### 4.3 The example event (this is what ships)

```json
{
  "schema_version": "1.0",
  "event_name": "workflow_completed",
  "event_time": "2026-06-04T18:22:41Z",
  "anonymous_install_id": "b3f1c2a4-...-stable-per-install",
  "hermes_version": "0.15.2",
  "entrypoint": "gateway",
  "platform_category": "telegram",
  "os_family": "linux",
  "arch": "x86_64",
  "provider_family": "nous_portal",
  "local_runtime": null,
  "model_class": "frontier_reasoning",
  "tool_categories_used": ["web", "browser", "skills"],
  "duration_bucket_ms": "60k_120k",
  "model_call_count": 4,
  "tool_call_count": 7,
  "input_tokens_bucket": "50k_100k",
  "output_tokens_bucket": "5k_10k",
  "estimated_cost_bucket_usd": "1_5",
  "end_reason": "completed"
}
```

---

## 5. The emitter API & the four hook points

### 5.1 Public API

```python
from agent.telemetry import telemetry, span

# Fire-and-forget event (enqueue + return immediately; never raises):
telemetry.emit(ToolCallEvent(run_id=..., tool_category="web", result_class="ok", duration_ms=812))

# Span context manager — sets trace/span ids in contextvars, times the block, writes on exit:
with span("model_call", run_id=run_id, provider_family="anthropic", model_class="frontier_reasoning") as s:
    resp = client.chat.completions.create(**kwargs)
    s.set(input_tokens=..., output_tokens=..., latency_ms=..., ttft_ms=...)
```

### 5.2 Hot-path invariant (Phase-0 acceptance test, not a comment)

> `emit()` and `span.__exit__` MUST: enqueue to an in-memory ring buffer and return in
> O(µs); never block on disk/network; never raise into the caller; never touch the
> message list, prompt prefix, tool schemas, or role alternation. A background thread
> drains the queue to JSONL + SQLite. On queue-full: drop oldest, increment a dropped
> counter. On writer error: log locally, continue.

Test: monkeypatch the writer to raise + sleep 5s; assert the instrumented call path
returns in <5ms and the run result is byte-identical to uninstrumented.

### 5.3 The four call sites (real, verified)

| # | Signal | File:symbol | What to wrap |
|---|---|---|---|
| 1 | **workflow span** (root) | `agent/conversation_loop.py:495` `run_conversation(...)` | open `run`/root span at entry; close in finalizer |
| 2 | **model_call span** | `agent/chat_completion_helpers.py:239` (`chat.completions.create`) and `:208` (`_anthropic_messages_create`) | wrap each provider call; capture tokens/latency/ttft from the response |
| 3 | **tool_call span** | `model_tools.py:901` `handle_function_call(...)` | already receives `session_id`, `turn_id`, `tool_call_id`, `api_request_id` — use them as span linkage; time the dispatch; map `function_name`→`tool_category` |
| 4 | **run finalize + cost** | `agent/turn_finalizer.py:30` `finalize_turn(agent, ...)` | close root span; read `agent.session_estimated_cost_usd` (already computed there at ~:379); write `tel_runs` end fields |

`tool_category` mapping lives next to the registry — each `registry.register(toolset=...)`
already carries the toolset; derive category from `toolset`. Do **not** invent a parallel
map.

### 5.4 ID propagation

`trace_id`/`run_id`/`span_id` live in `contextvars` so subagents and async tool calls
inherit lineage. Reuse the existing `turn_id` / `api_request_id` already threaded through
`handle_function_call` as correlation keys rather than minting parallel ones.

---

## 6. CI privacy-test harness (gates the build)

`tests/telemetry/test_plane_b_privacy.py` — these FAIL the build, not warn:

1. **Schema allowlist:** every field name in `schema_b.py` is in the frozen allowlist set;
   any new field fails until added to the allowlist *and* reviewed (the test message says
   so).
2. **No content columns reachable:** static check that `aggregate/builder.py` never
   references `attrs_json`, `model_id`, `tool_name`, `skill_name`, or `.messages`.
3. **Fuzz the builder:** feed `tel_runs`/`tel_*` rows with adversarial content injected
   into every text column (paths, URLs, emails, `sk-...` keys, JWTs); assert the produced
   Plane-B event contains **none** of it — regex gates for path-like, URL-like,
   email-like, key-like strings.
4. **Bucket-only numerics:** assert every numeric Plane-B field is either a small count
   (≤ COUNT_BUCKETS max) or a bucket label string; no raw ms/token/usd values.
5. **`validate_schema_b()` without activation:** borrow NeMo's diagnostics-without-
   activation pattern — lint a candidate event and return diagnostics; CI asserts a known-
   bad event is rejected.
6. **Round-trip:** every metric in §3 marked "B" has a corresponding builder path; every
   builder field maps to a §3 metric. No orphans either direction.

Plane A has no such gate — it's the user's own data and may contain content by design.

---

## 7. Pricing provenance (steal from NeMo, smallest-footprint win)

`agent/usage_pricing.py`'s `_OFFICIAL_DOCS_PRICING` is a bare dict with **no provenance**.
Add to `PricingEntry`:

```python
@dataclass
class PricingEntry:
    input: Decimal
    output: Decimal
    cache_read: Decimal | None = None
    cache_write: Decimal | None = None
    pricing_as_of: str | None = None      # ISO date — NEW
    pricing_source: str | None = None     # "anthropic_docs_2026_05" | "openrouter_api" — NEW
```

Thread `pricing_as_of`/`pricing_source` into `CostResult` so `cost_events` and local
receipts can answer "as of when, from where?" This is what makes a receipt defensible
instead of a guess. (Schema seam mirrors NeMo's `pricing.py` `ModelPricing.pricing_as_of`
/ `pricing_source` + tiered `rate_schedule`; adopt the tiered/cache accounting shape too
while you're in there.)

---

## 8. Enumerations (own mini-spec — review for cardinality before Phase 2)

Each must be **coarse enough to be non-identifying**. Ship as frozen sets in
`aggregate/schema_b.py`:

- `entrypoint`: `cli | tui | gateway | cron | api | desktop | batch | acp`
  (**`tui` is distinct from `cli`** — `source='tui'` is already a first-class session
  source in `state.db`; collapsing it into `cli` would undercount the Ink TUI. Map from
  the existing session `source` tag, don't re-derive.)
- `platform_category`: `cli | telegram | discord | slack | whatsapp | signal | matrix | email | sms | teams | feishu | wecom | other`
- `provider_family`: `nous_portal | openrouter | anthropic | openai | google | deepseek | xai | local | custom | other`
- `local_runtime`: `ollama | llama_cpp | lm_studio | vllm | other` — **emitted only when
  `provider_family=local`.** This is what makes "popularity of ollama vs llama.cpp vs LM
  Studio" answerable. Hermes already detects this locally (`is_local_endpoint()`,
  `query_ollama_num_ctx`, port-11434 probing in `agent/agent_init.py`); without this
  dimension that signal is discarded at the `local` collapse. `null` for non-local.
- `model_class`: `frontier_reasoning | frontier | mid | small | local | aux` (a coarse class, **not** the model id — needs a model→class map reviewed for cardinality)
- `tool_category`: `web | browser | file | terminal | mcp | cron | memory | skills | voice | image | video | delegation | vision | other`
- `error_class`: `provider_timeout | provider_error | rate_limit | tool_error | file_permission | network | auth | context_overflow | user_abort | unknown`
- `end_reason`: `completed | failed | interrupted | timeout | max_iterations`

> **Cardinality guard (design doc §6):** `install_id` + os + arch + version + platform +
> provider is a fingerprint. k-anonymity (k≥20) is enforced at the ingestion/query layer
> server-side, not just in reporting. That's a server concern but the client keeps the
> field set minimal to make it achievable. Note `local_runtime` adds one low-cardinality
> dimension (≤5 values) — safe.

### 8.1 Sanity check — questions the inventory must answer

These are the product questions the enums above are designed to support. If a question
isn't answerable from the allowlisted fields, the enum is wrong, not the question.

| Question | Answerable from | Status |
|---|---|---|
| What OS / arch are users on? | `os_family` × `arch` | ✅ |
| Desktop vs CLI vs TUI vs gateway? | `entrypoint` (incl. `tui`) | ✅ (after §8 fix) |
| Distribution of messaging platforms? | `platform_category` | ✅ |
| Popularity of ollama vs other local runtimes? | `local_runtime` (when `provider_family=local`) | ✅ (after §8 fix) |
| Which providers dominate? | `provider_family` | ✅ |
| How many installs do we have? | `COUNT(DISTINCT install_id)` | ⚠️ opt-in lower bound — see §8.2 |

### 8.2 The install-count signal — `install_id` semantics (read carefully)

There **is** a single UUID that answers "how many installs": `anonymous_install_id`
(`telemetry.install_id` in config). But three properties bound what it can honestly tell
you, and all three must be stated on any dashboard built from it:

1. **It must be STABLE to count.** One UUID per install, minted once at first run, rotated
   **only** on explicit `hermes telemetry purge-id` (design §13-D3). The earlier example
   payload's `"rotating_uuid"` placeholder is **wrong/misleading** — a frequently-rotating
   id would inflate the install count and destroy retention math. Corrected in §4.3.
2. **It only counts OPT-IN installs.** Aggregate is opt-in/default-off (design §3), so
   `COUNT(DISTINCT install_id)` =  *installs that opted in AND phoned home*, never total
   installs in the world. **Every install number from Plane B is a lower bound.** This is
   the deliberate, accepted cost of the opt-in posture — surface it as "opted-in active
   installs," not "installs."
3. **Idle installs are invisible without a heartbeat.** As specced, an install first
   appears in Plane B only when it *completes a workflow*. A configured-but-idle install
   never shows. To separate "installs" from "active installs" you need two explicit
   lightweight events (counted, content-free, same allowlist):

   - `install_activated` — emitted once after setup completes (gives a denominator:
     installs that reached a working config).
   - `heartbeat` — emitted at most once per UTC day per install while Hermes runs (gives
     DAU/WAU/MAU and lets you compute D1/D7/D30 retention over `install_id` lifetime).

   Without these, you have "weekly active installs that ran a workflow" but not "total
   installs" or "activation rate." **Recommendation: include both in Phase 2** — they're
   the difference between a usage metric and an install census. Add them to the
   `event_name` enum and the §6 privacy harness like any other event.

> **Net:** yes, one UUID answers it — but the honest headline metric is *"opted-in active
> installs (lower bound),"* and you need `install_activated` + `heartbeat` to make
> activation and retention answerable at all.

### 8.3 Adversarial pass — reliability & cost questions

Same exercise as §8.1, aimed at the reliability and cost dashboards. Each question is
checked against the actual fields; ✅ = answerable as specced, ⚠️ = answerable only with a
fix/caveat noted, ❌ = not answerable from OSS client telemetry (Plane-A-only or Portal).

#### Reliability

| Question | Field path | Status |
|---|---|---|
| Which tool *categories* are unreliable? | `tool_calls_total{tool_category, result_class}` | ✅ |
| Which *specific tool* is flaky? | `tool_calls_by_name_total{tool_name}` | ⚠️ **Plane A only** — `tool_name` never leaves; in aggregate you get category, not "web_search vs browser_navigate" |
| Which providers time out? | `model_calls_total{provider_family, end_reason=timeout}` | ✅ |
| Gateway delivery failures? | `gateway_messages_total{result}` | ✅ |
| Cron missed runs? | `cron_runs_total{result=missed}` | ✅ |
| Retry / abort / timeout rate? | `model_retries_total`, `errors_total`, `end_reason` | ✅ |
| **Which release regressed p95 latency?** | `workflow_duration_ms` grouped by `hermes_version` | ⚠️ needs **two fixes** — see (A) and (C) below |
| Error class by release? | `errors_total{error_class, subsystem}` grouped by `hermes_version` | ⚠️ needs `hermes_version` group-by (C) |

#### Cost

| Question | Field path | Status |
|---|---|---|
| Cost per *successful* workflow? | `workflow_completed` event with `estimated_cost_bucket_usd` (cost + `end_reason` on the same event) | ✅ (distribution, not exact — see A) |
| Cost distribution by provider / model class? | `model_cost_usd_total{provider_family, model_class}` | ✅ (distribution) |
| **Total $ spend across the fleet?** | — | ❌ **not from Plane B** — bucketed costs cannot be summed (A) |
| Cache hit rate / cache savings? | `tokens_total{kind=cache_read}` vs `input` | ✅ — cache tokens *are* captured (verified in `conversation_loop`/`turn_finalizer`) |
| Frontier vs aux model usage share? | `model_calls_total{model_class}` | ✅ |
| **Gross margin / unit economics?** | needs provider-*reported* cost | ❌ **Portal only** — see (B) |

#### The three structural findings (state these on every dashboard)

**(A) Bucketed Plane-B metrics give distributions and rates — never totals or exact
percentiles.** Because Plane B forbids raw values (§4), a "histogram" is a counter keyed
by a frozen bucket label. Consequences:
- You **cannot sum** bucketed costs/durations into a fleet total. "Total spend,"
  "total tokens burned" → **Plane A** (the user's / enterprise's own full-fidelity data)
  or **Portal**, never the OSS aggregate.
- p50/p90/p95 from buckets are **bucket-edge approximations**, not exact percentiles. Good
  enough for "did 0.17 shift the distribution right?"; not good enough for an SLA number.
- Exact percentiles and exact totals live in Plane A, where real histograms and raw values
  exist. This is the deliberate price of the privacy boundary, not a defect.

**(B) `actual_cost_usd` is never populated by the client — only `estimated_cost_usd`.**
Verified: nothing in `agent/*` writes a provider-*reported* cost; the `actual_cost_usd`
column in `state.db` exists but stays null. So **margin, true unit economics, and
estimate-vs-actual drift are not answerable from OSS client telemetry** — they require the
provider's billed number, which only **Portal** sees (Phase 3, design §11/Portal plane).
Correct by design; just never promise margin on an OSS-telemetry dashboard. If we later
want estimate-accuracy from the client, OpenRouter's `/generation` endpoint returns a
post-hoc actual cost — but that's a separate, opt-in lookup, not free.

**(C) Per-release questions need `hermes_version` as an explicit group-by on the duration
and error metrics.** `hermes_version` is in the event envelope (verified available:
`hermes_cli/__init__.py::__version__`, currently `0.17.0`) — but the metric inventory must
declare it a **queryable dimension** on `workflow_duration_ms` and `errors_total`, not just
an envelope field, or "which release regressed" silently can't group. **Fix:** add
`hermes_version` to the dimension list of those two metrics in §3.1/§3.4. Low cardinality
(one value per release), so no fingerprinting cost.

> **The one-line summary of the boundary:** Plane B answers *"what's the shape and which
> way did it move"* (rates, distributions, regressions, mix). It does **not** answer
> *"what's the exact total"* (spend, p95, margin) — those are Plane A (local/enterprise
> full capture) or Portal. Label dashboards so nobody reads a distribution tile as a total.

---

## 9. Build implications of the ratified decisions

> **Authority:** the decisions themselves are ratified in **design doc §13 (D1–D4)**. This
> section does not decide anything — it states what each decision means for the code. If a
> decision needs to change, change it in §13, then update here.

- **D1 — tool cardinality** → capture `tool_name` in `tel_tool_calls.tool_name` +
  `tool_calls_by_name_total` (Plane A); the Plane-B builder reads **only** `tool_category`.
  Enforced by the §6 privacy test that forbids `tool_name` in the builder.
- **D2 — derive, don't emit** → no OTel metric instruments at call sites; `metrics.py`
  computes every §3 metric by querying the event log. Live OTLP-metrics export (§1
  `export/otlp.py`) runs on a timer over the log, not per-call. Keeps hot-path code to a
  single enqueue (§5.2).
- **D3 — stable install_id** → mint once, persist in `config.yaml` (`telemetry.install_id`),
  rotate only on `hermes telemetry purge-id`. The example payload uses a stable id (§4.3),
  not `"rotating_uuid"`; install-count semantics in §8.2.
- **D4 — desktop dashboard host** → no `telemetry serve` server in core; the dashboard
  reads the `state.db` tables from the desktop app surface.

---

## 10. Work breakdown & acceptance criteria

> **Phase *intent* and gating rationale live in design doc §12.** This section is the
> *task breakdown* for the same phases — checkboxes and acceptance criteria only. If the
> phase boundaries themselves change, change them in §12 first.

### Phase 0 — contract (no network, no hot-path writes yet)
- [ ] `schema.py` DDL + migration registered in `state.db`; `schema_version` bumped.
- [ ] `events.py` typed Plane-A events; `aggregate/schema_b.py` + `buckets.py` frozen.
- [ ] CI privacy harness (§6) green, with a deliberately-failing fixture proving it bites.
- [ ] Hot-path invariant test (§5.2) green.
- [ ] `config.yaml` keys + `policy.py` consent state machine (no uploader yet).
- [ ] Public `What data does Hermes collect?` page + example payload.
- **Done when:** schema + tests merged, zero behavior change for users, no network code.

### Phase 1 — local plane (consolidation)
- [ ] Emitter (queue→JSONL→SQLite indexer) with rebuild-from-JSONL.
- [ ] Four hook points (§5.3) wired; spans nest correctly (verify a real gateway run
      produces one trace with model+tool children).
- [ ] `metrics.py` derivations for every §3 metric.
- [ ] Repoint `InsightsEngine` / `hermes insights` / `/usage` at the new tables.
- [ ] Pricing provenance (§7).
- [ ] Exports: `jsonl`, `sqlite`, `otlp` (local); redacted support bundle.
- [ ] Codec-aware redactor (`redaction/codec_aware.py`) for bundles.
- **Done when:** a real run writes a complete trace; `hermes insights` reads it;
      `export --format otlp` lands in a local Collector; **test proves no content in any
      `tel_*` column that the Plane-B builder can read.**

### Phase 2 — aggregate plane (opt-in) — release-gated
- [ ] `aggregate/builder.py` + `uploader.py` (queue + batch POST + retry/backoff +
      partial-success).
- [ ] `hermes telemetry status|enable|disable|preview|purge-id`.
- [ ] Server-side allowlist validation + k-anon suppression (server work).
- **Release gate (hard):** no Plane-B event ships until docs page + consent prompt +
      `status` + `disable` + `preview` all exist and the §6 harness is green in CI.

Phases 3–5 (Portal, enterprise §11, trajectory) per the design doc — out of scope for the
first build.

---

## 11. Pitfalls (read before you start)

- **Don't emit on the hot path synchronously.** Enqueue only. The writer is a background
  thread. A blocked disk must never stall a model call.
- **Don't read Plane-A content columns in the Plane-B builder.** The test will catch it,
  but design so it's impossible: the builder takes a typed `RunSummary` that *structurally
  lacks* the content fields, not the raw row.
- **Don't break prompt caching.** Telemetry never mutates context/system-prompt/tools.
- **Don't add a model tool.** There is no `telemetry_*` tool. It's instrumentation + CLI.
- **Don't fork the cost engine.** Extend `usage_pricing.py`.
- **Don't put telemetry toggles in `.env`.** `config.yaml` only; internal env bridge is
  acceptable for the *mechanism* (precedent: `HERMES_REDACT_SECRETS`) but user docs point
  at config.
- **`.tsx`/`.ts` line-ending trap** (if you touch the desktop dashboard): this repo's
  `.gitattributes` has no EOL rule for TS/TSX, so editing via tools can introduce CRLF and
  produce whole-file diffs. After editing, `git ls-files --eol <file>` and
  `sed -i 's/\r$//' <file>` to normalize back to LF before committing.
- **Windows test runner:** use the repo venv (`venv/Scripts/python.exe`) after
  `ensurepip`; run `pytest tests/telemetry -q -n 0` with `PYTHONPATH="$(pwd)"`. System
  Python (3.14) lacks repo deps and yields bogus failures.

---

## 12. Quick reference — what each layer collects

| | Plane A (local) | Plane B (aggregate, opt-in) |
|---|---|---|
| **Granularity** | per span / per call | per workflow (rolled up) |
| **Instruments** | counters, histograms, gauges (real) | counters + pre-bucketed counters only |
| **Values** | raw (ms, tokens, usd) | bucket labels + small counts |
| **Identifiers** | session_id, profile_id, model_id, tool_name | install_id + coarse enums only |
| **Content** | may contain (it's the user's) | never, by construction |
| **Export** | JSONL / SQLite / OTLP / bundle | batch POST to Nous |
| **Default** | on | **off (opt-in)** |
