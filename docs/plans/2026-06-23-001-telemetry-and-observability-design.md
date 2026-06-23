# Telemetry & Observability for Hermes — Design Doc

- **Status:** Draft / RFC
- **Date:** 2026-06-23
- **Owner:** (TBD)
- **Supersedes / consolidates:** the standalone "Hermes Telemetry Plan" narrative
- **Implementation guide:** `2026-06-23-002-telemetry-implementation-guide.md` (the *how* —
  schema, hooks, metric inventory). This doc owns **decisions + phase intent**; the guide
  owns **build mechanics + task breakdown** and defers all decisions to §13 here.
- **Related code:** `agent/insights.py`, `agent/usage_pricing.py`, `hermes_state.py`,
  `agent/redact.py`, `hermes_cli/subcommands/insights.py`

---

## 0. TL;DR

Hermes should ship a **local-first observability layer that the user owns**, then
offer **opt-in, content-free aggregate metrics** to Nous, with a hard wall between
those two and a separately-consented trajectory/training plane. Most of the local
plane already exists in pieces (`state.db`, `InsightsEngine`, `usage_pricing`,
`redact.py`); Phase 1 is **consolidation, not greenfield**.

Three decisions diverge from the earlier narrative plan and are load-bearing here:

1. **Aggregate telemetry is opt-in, no pre-checked box.** Default-opt-out. (Rationale §3.)
2. **The North Star is a reliability proxy, named honestly as such** — it is not a
   measure of user value, because the data plane that could measure value is the one
   we refuse to collect. (§7.)
3. **All telemetry state lives in `config.yaml`, never `.env`.** `.env` is secrets-only
   per the repo rubric. (§4, §9.)

NeMo-Relay is treated as a **pattern donor + optional exporter plugin**, not as the
core substrate. (§8.)

---

## 1. Goals & Non-Goals

### Goals

- Give every user a complete, local, portable record of what their agent did: timing,
  model calls, tool calls, costs, failures, cron/gateway/skill/memory activity.
- Make `/usage`, `/insights`, cost receipts, and the local dashboard all read from
  **one** telemetry store instead of ad-hoc queries.
- Let the team learn, from consenting users, **where Hermes breaks and what gets used**
  — without ever receiving user content.
- Keep Portal service metrics and trajectory/training data as **separate planes** with
  separate consent.
- Preserve the two properties the core is built around: **per-conversation prompt
  caching is sacred**, and **the core is a narrow waist**.

### Non-Goals

- Collecting prompts, completions, file contents, paths, URLs, commands, or any
  freeform user text through the aggregate plane. Ever. (This is a hard invariant, not
  a tunable.)
- Building a second session store. The canonical store is `~/.hermes/state.db`; this
  design extends it, it does not replace or shadow it.
- Adding new **core model tools**. Telemetry is instrumentation + CLI + optional plugin,
  not a tool the model calls. (Rubric: every core tool ships on every API call.)
- Training-data capture. That is Plane C, explicitly out of scope for v1 beyond
  reserving the boundary.

---

## 2. The three planes (and the wall between them)

| Plane | Lives where | Contains | Leaves the machine? | Consent |
|---|---|---|---|---|
| **A — Local observability** | `~/.hermes/` (per-profile) | Full detail incl. content-bearing trajectories | No, unless the user exports it | On by default; it's *their* data |
| **B — Aggregate metrics** | Nous ingest endpoint | Enums, counts, buckets, versions — **no freeform strings** | Only if opted in | **Opt-in**, off by default |
| **C — Trajectory / training** | Separate surface | Content trajectories (ATIF-style) | Only if separately opted in | Separate explicit consent; v1 reserves the seam only |

The wall is the entire design. The single most damaging failure mode is a content
pipeline (Plane A or C) mislabeled and shipped as "telemetry" (Plane B). Every
mechanism below exists to make that failure structurally impossible, not merely
discouraged.

**Rule:** Plane B is generated from an allowlist schema, not filtered down from Plane A.
You cannot "redact" Plane A into Plane B — redaction is best-effort and the wrong tool
for a hard boundary. Plane B events are constructed field-by-field from enumerated
values. If a value isn't on the allowlist, it does not exist in Plane B.

---

## 3. Consent posture: opt-in, and why

The earlier narrative proposed a pre-checked "Yes, share aggregate metrics.
Recommended." This doc rejects that and specifies **opt-in, default-off, no pre-check.**

Reasons, in priority order:

1. **The asymmetry is brutal.** Upside of opt-out over opt-in is marginally higher
   participation. Downside is one front-page "Hermes phones home by default" thread that
   burns the exact trust the product is built on. Every OSS tool that shipped opt-out
   telemetry (dotnet CLI, Audacity, Homebrew) ate that thread.
2. **Self-consistency.** The plan's own copy says "no dark patterns, no burying the no
   option." A pre-ticked "Recommended" box *is* the dark pattern. Both statements can't
   ship in the same product.
3. **Legal.** Pre-checked consent is invalid under GDPR/ePrivacy (CJEU *Planet49*,
   C-673/17). And we can't claim "anonymous, so GDPR doesn't apply" while also shipping a
   persistent `install_id`, 13-month retention, and `purge-id` — those features only mean
   something if the ID is identifying, which makes the data pseudonymous personal data.
   Assume opt-in is *required* for EU users regardless of what we choose elsewhere;
   confirm with counsel.
4. **Our own safety rule guts the opt-out rationale anyway.** The "no upload before a
   human sees the choice" rule (correct, keep it) means headless installs — Docker, CI,
   gateway/server deploys, a huge share of always-on usage — never see the prompt and
   never upload. So default-yes would only fire for interactive CLI/desktop users, i.e.
   precisely the population most likely to notice and resent a pre-checked box. We'd pay
   the full reputational cost to harvest the people most likely to make us pay it.

**Decision:** opt-in. Make the *value exchange* do the work — ship Plane A so good that
engaged users want to contribute back. "We ask, we don't assume" is itself a trust
feature we can market.

### Consent states

```
unknown   → no choice made, no Plane-B upload, prompt pending
local      → Plane A only (the default after a user declines)
aggregate  → Plane A + Plane B (only after explicit opt-in)
```

Non-interactive installs land in `unknown` and **never upload** until an interactive
`hermes setup` / `hermes chat` / dashboard session surfaces the choice. Enterprise/
self-hosted can pin the state centrally (and pin it to `local` or a self-hosted Plane-B
collector).

---

## 4. What we build on (this is mostly consolidation)

The local plane is not a blank slate. Current state:

| Capability | Today | Gap |
|---|---|---|
| Session store | `state.db` (SQLite + FTS5); `sessions` table already has `input/output/cache_read/cache_write/reasoning_tokens`, `estimated_cost_usd`, `actual_cost_usd`, `cost_status`, `cost_source`, `billing_provider`, `billing_base_url` | No per-**span** / per-**call** granularity; it's per-session aggregates |
| Insights | `agent/insights.py::InsightsEngine`, surfaced via `hermes insights` (`--days`, `--source`) and `/insights` | Reads session aggregates only; no tool-call / failure-class breakdown |
| Cost engine | `agent/usage_pricing.py` (`CanonicalUsage`, `estimate_usage_cost`, `_OFFICIAL_DOCS_PRICING`) | Pricing is a **hardcoded dict with no `pricing_as_of` / `pricing_source` provenance** — receipts aren't defensible (see §8.2) |
| Secret redaction | `agent/redact.py::redact_sensitive_text`, `HERMES_REDACT_SECRETS` | Regex/secret-grade; not codec-aware, not structured for trajectory redaction (see §8.1) |
| Skill telemetry | `~/.hermes/skills/.usage.json` (use/view/patch counts), curator | Lives outside the telemetry store; not joined to runs |

**Implication:** Phase 1 is largely "add a span/event layer alongside the existing
session aggregates, and point the existing readers at it" — not "build telemetry from
scratch." Framing it as greenfield risks building a second store that competes with
`state.db`.

---

## 5. Local data model (Plane A)

Extend `state.db` with an event/span layer keyed by the existing session IDs. Two
storage shapes, same data:

1. **Append-only JSONL event log** — `~/.hermes/telemetry/events.jsonl`. Durable,
   inspectable, recoverable if a migration fails, trivial to `tail`.
2. **Queryable tables in `state.db`** — the JSONL is the source of truth; tables are the
   index. (Do **not** spin up a separate `telemetry.sqlite`; co-locating in `state.db`
   keeps one transactional store and lets us JOIN runs to sessions/messages.)

### Identifiers (OTel-aligned span model)

```
trace_id        one workflow
run_id          one top-level execution (gateway msg, cron run, CLI turn, API call, batch item)
span_id         one timed operation
parent_span_id  caller span
session_id      existing state.db session id  (Plane A only — never leaves)
profile_id      existing profile id           (Plane A only — never leaves)
```

These map 1:1 onto OpenTelemetry's span model on purpose (§8.4). Plane B receives **none**
of `session_id` / `profile_id` / names.

### Tables (all Plane A)

`runs`, `spans`, `model_calls`, `tool_calls`, `gateway_events`, `cron_events`,
`skill_events`, `memory_events`, `feedback_events`, `cost_events`, `error_events`.

(Shapes follow the earlier narrative — they're sound. The change is *where* they live:
in `state.db`, joined to existing session rows, not a parallel DB.)

### Hot-path invariant (Phase-0, non-negotiable)

Instrumentation sits next to every model and tool call. Therefore:

> Telemetry writes are async/best-effort and MUST NOT (a) add user-visible latency,
> (b) ever fail a run, (c) touch the conversation message list, prompt prefix, tool
> schemas, or role alternation.

A telemetry write failure is logged locally and dropped. It never propagates. This is
stated as a Phase-0 acceptance test, not an aspiration, because the narrative plan
assumed it silently.

---

## 6. Aggregate model (Plane B)

### Construction rule

Every Plane-B event is built from a **closed schema of enumerated fields**. The client
constructs the event field-by-field from allowlisted values; unknown fields are dropped
client-side **and** rejected server-side (don't trust the client). No freeform strings
except version strings and enumerated tokens.

### Example event (unchanged from narrative — it's the right shape)

```json
{
  "schema_version": "1.0",
  "event_name": "workflow_completed",
  "event_time": "2026-06-04T18:22:41Z",
  "anonymous_install_id": "rotating_uuid",
  "hermes_version": "0.15.2",
  "entrypoint": "gateway",
  "platform_category": "telegram",
  "os_family": "linux",
  "arch": "x86_64",
  "provider_family": "nous_portal",
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

### The identifier contradiction — resolve it deliberately

The narrative wants both "rotating/resettable install ID" **and** D1/D7/D30 retention +
cross-surface continuity. Those fight: a frequently-rotated ID makes the retention and
continuity metrics unreliable, and those are exactly the metrics the investor section
leans on. **Decision:** one **stable-but-user-resettable** `install_id`, rotated only on
explicit `hermes telemetry purge-id`. Document that retention metrics are computed over
ID lifetime and that resets create new cohorts. Own the tradeoff in writing rather than
implying you get both.

### Re-identification guard at ingestion, not just reporting

`install_id` + OS + arch + version + platform + provider + timing is a fingerprint for
low-population cohorts (the one WeCom-plus-custom-provider user in a region).
**Small-cohort suppression must run at the ingestion/query layer, not only in
investor-facing rollups.** k-anonymity threshold (e.g. k≥20) enforced before any
field-combination is queryable.

---

## 7. North Star — named honestly

Proposed metric: **Weekly successful delegated workflows per active instance.**

The catch: the definition ("completes without timeout, abort, unrecovered tool failure,
provider failure, or immediate retry") measures **harness health, not user value.** A run
can finish clean and be wrong; a run can hit a tool failure, retry, and be exactly what
the user wanted. The plane that could measure *value* (content / explicit feedback) is
the plane we refuse to ship in aggregate.

**Decision:** call it what it is — a **reliability / completion** metric — and stop
implying it measures usefulness. If we want a real value signal, add a lightweight
**explicit** one (thumbs / "did that help?") gated like any other feedback, and compute a
separate `useful_workflow_rate` from it. Do not let an unattainable "useful work"
definition tempt anyone into widening the aggregate allowlist toward content. And watch
the perverse incentive: optimizing a pure completion metric rewards suppressing retries
and swallowing failures — the supporting reliability dashboard (failure rate, retry rate,
timeout rate) must be tracked *alongside* it as a guardrail, never optimized away.

---

## 8. What we take from NeMo-Relay (pattern donor, not substrate)

NeMo-Relay (NVIDIA, Apache-2.0) is an agent-runtime + observability framework. Hermes
already has an integration story with it (CLI wrapper, patch path, and an *external*
`plugins/observability/nemo_relay` plugin referenced from NeMo's docs — note this plugin
is **not in the current hermes-agent checkout**; treat it as an optional/external path,
not wired-in core).

**Stance:** borrow patterns into Hermes's own local plane; keep NeMo as an *optional
exporter plugin* a power user enables to push ATIF/OpenInference into NVIDIA's stack. Do
**not** pull NeMo's Rust runtime into the Hermes core — that's a heavy native dependency
at the narrow waist, against the rubric. Strategic note for leadership: decide
deliberately whether Hermes's observability story *rides on* NeMo or merely *interoperates
with* it via OTLP. This doc assumes interoperate.

Four concrete steals:

### 8.1 Codec-aware redaction (for Planes A-export and C, NOT for B)

NeMo's `pii_redaction` plugin is the best-factored thing in that repo: it understands
provider message shapes (`openai_chat`, `openai_responses`, `anthropic_messages`),
applies at four boundaries (`input`/`output`/`tool_input`/`tool_output`), offers
`remove`/`redact`/`regex_replace`/`hash`/`mask` actions with `unmasked_prefix/suffix`,
and ships a `validate_config()` that returns diagnostics **without activating** (CI-lintable
redaction policy).

Use it for **support bundles and Plane-C trajectory redaction** — the content planes,
where redaction is the right (best-effort) tool. **Explicitly do NOT** treat it as
justification to loosen Plane B; B needs no redaction because it carries no content by
construction. This is the single easiest mistake to make, so it's stated twice.

### 8.2 Pricing catalog *with provenance*

NeMo's `pricing.py` carries `pricing_as_of` + `pricing_source` on every model entry, plus
tiered rate schedules and explicit cache-read accounting modes. Hermes's
`_OFFICIAL_DOCS_PRICING` is a bare dict with **no provenance** — which means a cost receipt
can't answer "as of when, from where?" **Steal the provenance fields and the tiered/cache
accounting schema** and fold them into `usage_pricing.py`. This is what turns
`estimated_cost_bucket_usd` and local receipts from a guess into something defensible.
Smallest-footprint win in the whole doc.

### 8.3 Secrets-by-reference config

NeMo storage configs hold the **env var name** of a credential (`secret_access_key_var`),
not the secret, validated at init. Adopt this for any telemetry **export destination**
(OTLP endpoint headers, S3 bundle upload) so `config.yaml` stays commit-safe and we honor
our own ".env = secrets, config.yaml = behavior" rule without leaking secret material into
config.

### 8.4 Event-vs-trajectory split + OTLP as a *local* export

NeMo separates raw events (ATOF) from a normalized, portable trajectory artifact (ATIF),
and exports OTLP/OpenInference. We already have raw JSONL + a query DB; add the third idea
— a **portable normalized trajectory** for eval/support — and ship **OTLP as a Plane-A
local export only** (`hermes telemetry export --format otlp --endpoint …`) so users can
point their own OpenTelemetry Collector / Grafana / Honeycomb at it. OTLP is bring-your-
own-observability for the *user*; it is **never** the Plane-B upload format (OTel
attributes standardize exactly the `http.url` / `file.path` / `user.id` fields our
"never collected" list forbids — naive OTel adoption would capture the dangerous fields by
default). OTLP stays firmly on the local side of the wall.

Don't take: ATOF `version 0.1` as *our* canonical format (couples us to NVIDIA's pre-1.0
schema churn — borrow the idea, own the storage); and don't take the seven-exporter menu
into core (ship JSONL + SQLite + OTLP in core; DuckDB/Prometheus/CSV are plugins).

---

## 9. Config & CLI surface

All in `config.yaml` (behavior), nothing user-facing in `.env`:

```yaml
telemetry:
  local: true          # Plane A. On by default.
  aggregate: false     # Plane B. Opt-in only. Default false.
  install_id: "<uuid>" # stable, resettable via purge-id
  export:
    otlp:
      endpoint: null
      headers_env: {}  # secrets-by-reference (§8.3)
  retention_days: 90   # local event log rotation
```

Internal env bridges may exist for the mechanism (mirroring how `HERMES_REDACT_SECRETS`
bridges the redaction toggle) but **user docs point at `config.yaml`**, never "set X in
your .env." The redaction toggle precedent is the only reason an env bridge is acceptable
at all — it's a safety control the model shouldn't be able to flip on itself mid-run.

CLI:

```
hermes telemetry status            # plane states, install_id, what's queued
hermes telemetry enable|disable    # toggle Plane B (aggregate)
hermes telemetry preview           # show exactly what a Plane-B batch would contain
hermes telemetry export --format jsonl|sqlite|otlp|duckdb [--since 7d] [--profile X]
hermes telemetry support-bundle --redact
hermes telemetry purge-id          # rotate install_id, start new cohort
```

`preview` is a trust feature: a user (or a journalist) can see the literal bytes before
anything ships. `disable` and `preview` and the docs page MUST exist before any release
sends a single Plane-B event (release gate, §11).

---

## 10. Engineering guardrails (enforced, not promised)

- **Allowlist, not blocklist.** Plane-B fields come from a schema enum. Unknown → dropped
  client-side, rejected server-side.
- **No freeform strings in Plane B** except version strings and enumerated tokens.
  Token/cost/duration are bucketed.
- **Privacy tests that fail the build** when an unsafe field appears in a Plane-B schema
  or payload: no path-like, URL-like, email-like, or key-like strings; model
  prompt/completion fields not serializable into aggregate events; raw exception messages
  rejected by validation. Borrow NeMo's `validate_config()`-style "diagnostics without
  activation" so these run in CI.
- **Hot-path safety** (§5) is a test, not a comment.
- **Cache/alternation safety:** telemetry never mutates context, never injects a synthetic
  message, never rebuilds the system prompt. (Rubric: prompt caching is sacred.)
- **Aggregate is not training data.** Hard wall; Plane C is separate consent + surface.

---

## 11. Enterprise provisioning & data ownership

Enterprises owning their data outright is a **sales unlock**, not merely a privacy
concession: the regulated buyer (bank, hospital, defense, anyone under works-council or
data-residency rules) will not deploy an agent they can't fully observe *and* fully
contain. The same plane separation that protects the individual user is what lets us hand
an enterprise the complete firehose to **their** infrastructure while sending Nous nothing.

The governing idea: **"collect all" is about volume to the org's own collector, never
about a hidden second destination.** An admin can crank every fidelity knob to max; the
destination switches stay independent by construction.

### 11.1 The switch matrix (three independent destinations)

The three planes are orthogonal destinations, not a single dial. An admin sets each
independently:

| Plane | Destination | Typical regulated-enterprise setting | Max setting |
|---|---|---|---|
| **A — local/content** | Org SIEM / OTLP collector / bucket | **Full fidelity** (every span, full `tool_input`/`tool_output`) | Everything, streamed live |
| **B — Nous aggregate** | Nous ingest | **Off / pinned off** (air-gapped) | n/a — never required for A or C |
| **C — trajectories** | Org store (legal hold / eval) | Off, or on to *their* store | Full content trajectories, org-side |

The matrix's load-bearing invariant: **maxing Plane A or C never implies Plane B.** A
reviewer or auditor will check exactly this. Full local capture and Nous egress are
separate switches and the code path that builds a Plane-B event is physically distinct
from the A/C exporters (§2 wall).

The common enterprise configuration is therefore *full A→their SIEM, C→their store, B
hard-off* — which our planes already express. If the only way to get rich aggregate data
were through our pipeline, we'd lose every air-gapped buyer; that's why OTLP and the
self-hosted collector (§8.4, §11.3) are first-class.

### 11.2 "No Nous egress" enforce mode

Beyond "B is off," regulated buyers need a **provable** guarantee that nothing leaves to
Nous. Provide an explicit org-policy mode:

```yaml
telemetry:
  org_policy:
    nous_egress: forbidden    # hard kill-switch; overrides any per-user aggregate=true
    enforce: true             # users cannot override; surfaced read-only in `telemetry status`
```

`nous_egress: forbidden` is a deny that no local user, env var, or config edit in a child
profile can flip on. It is checked at the uploader boundary, not just at config-read time,
so it holds even if a downstream setting drifts. This is the difference between "we set it
off" and "it cannot be on" — and the latter is what passes a security review.

### 11.3 Self-hosted collector & data residency

Enterprise telemetry **does not ride the OSS aggregate pipeline** (which targets Nous).
Instead, the admin points Plane A (and optionally a privacy-preserving *aggregate* roll-up
computed locally) at infrastructure they control:

- **OTLP push** to their OpenTelemetry Collector → Grafana Tempo / Honeycomb / Datadog /
  Splunk — the standard "bring your own observability" path (§8.4).
- **SIEM export** (audit events, approvals, blocked actions, policy hits) to their SIEM.
- **Object-storage bundles** (S3-compatible) for trajectories / support bundles, with
  **secrets-by-reference** credentials (§8.3) so the deployment config stays commit-safe.
- **Residency controls:** all of the above are org-chosen endpoints, so EU-only / on-prem
  / sovereign-cloud residency is the admin's choice, not ours to mediate.

An enterprise can also run their own Plane-B-shaped collector if they want the *aggregate*
analytics internally (cross-department dashboards) without sending raw content anywhere —
the same allowlist schema, pointed at their endpoint.

### 11.4 Getting the data out — bulk & continuous

"Enterprises can get their data if they want it" means both **continuous streaming**
(above) and **bulk extraction on demand**:

```
hermes telemetry export --format jsonl|sqlite|duckdb|otlp [--since …] [--all-profiles]
hermes telemetry support-bundle --redact
hermes telemetry stream --otlp <endpoint>     # continuous push, admin-provisioned
```

- The local store is **portable by construction** (JSONL is the source of truth; SQLite/
  DuckDB are indexes) — there is no Hermes-proprietary lock-in. An admin can lift the
  entire dataset and load it into their own warehouse.
- Exports honor the org's redaction policy (§11.5) — a compliance export can be full and
  unredacted; an analytics export can be PII-stripped.
- Retention is org-controlled (`telemetry.retention_days`, or *unbounded* with external
  rotation when streaming to a SIEM).

### 11.5 Redaction defaults even at max capture (the counterintuitive one)

Even an enterprise that wants *everything* almost never wants **live credentials** in
their SIEM — that just multiplies where the secret exists and makes the SIEM a
higher-value attack target. Therefore:

- **Secret redaction defaults ON even at full fidelity** (reusing `agent/redact.py` /
  `HERMES_REDACT_SECRETS`-grade detection). An admin can override for genuine legal-hold
  scenarios via explicit org policy, but the default is on regardless of capture level.
- **Content/PII redaction is a knob, not a default:** full unredacted for compliance/legal
  hold, or codec-aware redacted (§8.1) for privacy-preserving audit. The org chooses per
  destination — e.g. unredacted to legal-hold bucket, PII-stripped to the analytics
  warehouse.

```yaml
telemetry:
  org_policy:
    redact_secrets: true          # default on even at full capture; override = explicit
    content_redaction: none|pii   # per the org's compliance posture
```

### 11.6 Provisioning mechanism

Admins provision via a **policy config layer**, not by hand-editing every machine:

- An **org policy file** (shipped via MDM / config management / golden image / container
  env) that pins `telemetry.org_policy.*`. Surface is `config.yaml`; the *mechanism* may
  use an internal env bridge for container injection (same precedent as
  `HERMES_REDACT_SECRETS`), but user-facing docs point at the policy file.
- Pinned settings are **read-only** to local users and shown as such in
  `hermes telemetry status` (so an employee sees "managed by your organization," not a
  silently-overridden toggle).
- The consent state machine (§3) already supports central pinning — enterprise just pins
  to `local`, to a self-hosted collector, or to `nous_egress: forbidden`.

### 11.7 Transparency & the employee-monitoring boundary (honest flag)

Full content capture of employee activity **is employee monitoring**, which carries its
own legal regime (EU works-council rules, GDPR employee-monitoring provisions, US
two-party-consent states). That obligation is the **enterprise's**, not ours — but the
product should make compliance *easy* and silent surveillance *hard*:

- When an instance reports full telemetry to an org collector, surface a visible
  **"telemetry managed by your organization"** indicator (CLI banner / desktop status /
  gateway `/status`). This protects employees *and* protects Nous reputationally — we are
  not the vendor that enabled covert monitoring.
- This indicator is non-suppressible by the org policy layer. An enterprise can capture
  everything; it cannot make Hermes *lie* about capturing everything.

That last line is the principled boundary: **we give enterprises total data ownership and
total local fidelity; we do not give them the ability to hide that fact from the people
being recorded.**

---

## 12. Phasing

- **Phase 0 — Contract first (docs + schema, no upload).** Public `What data does Hermes
  collect?` page, onboarding copy, the Plane-B event schema checked into the repo, data-
  minimization rules, the CI privacy-test harness, the hot-path invariant test,
  config/CLI scaffolding. No network code ships in this phase. This is the phase that
  prevents "build first, explain later."
- **Phase 1 — Local plane (consolidation).** Event/span layer in `state.db`; instrument
  runs/model/tool/gateway/cron/skill/memory/approvals; point `/usage` + `/insights` at it;
  local dashboard; export commands; redacted support bundle (§8.1); pricing provenance
  (§8.2). Prove (test) no content lands in Plane-B-shaped tables. High community value,
  no trust cost.
- **Phase 2 — Aggregate plane (opt-in).** Onboarding prompt (default **off**),
  `status/enable/disable/preview/purge-id`, local queue + batch uploader, server-side
  schema validation + allowlist + k-anon suppression, retention policy. **Release gate:**
  do not send a Plane-B event until docs page + consent prompt + `status` + `disable` +
  `preview` all exist.
- **Phase 3 — Portal telemetry.** Account-level service metrics (OAuth funnel, attach
  rate, model/tool-gateway usage, cost/margin, fallback, receipts). Separate plane,
  separate store, not the OSS aggregate pipeline.
- **Phase 4 — Enterprise observability & data ownership (§11).** Org policy layer
  (`telemetry.org_policy.*`), `nous_egress: forbidden` enforce mode, self-hosted OTLP/SIEM
  collector targets, object-storage trajectory bundles, residency controls, bulk +
  continuous export, secret-redaction-on-by-default with legal-hold override, and the
  non-suppressible "managed by your organization" indicator. Does not ride the OSS
  aggregate pipeline.
- **Phase 5 — Trajectory sharing (Plane C).** Separate "share trajectories" consent,
  codec-aware redaction pipeline (§8.1), review/approval, org policy, eval/training
  export. v1 only reserves the seam.

---

## 13. Decisions & open questions

This section is the **single authority** for ratifiable decisions and their status. The
implementation guide (`…-002-…`) references decisions *up* to here and must not re-decide
them; it only spells out their code consequences.

### Decided (ratified — D1–D4)

- **D1 — Tool-name cardinality.** `tool_name` is captured in **Plane A only**; **Plane B
  carries `tool_category` only**. Per-tool reliability is a local/enterprise question, not
  an aggregate one. (Build impact: guide §9.)
- **D2 — Derive metrics, don't emit at call sites.** v1 writes spans/events on the hot
  path and **derives** counters/histograms from the event log; it does not emit OTel
  *metric* instruments per-call. Consequence: live OTLP-metrics export is timer-computed
  from the log, not streamed per-call. Revisit only if a user needs sub-minute metric
  latency.
- **D3 — `install_id` is stable and user-resettable.** One UUID per install, minted once,
  rotated **only** on `hermes telemetry purge-id`. Retention is computed over id lifetime;
  resets create new cohorts. (This is what the example payload's `"rotating_uuid"`
  placeholder got wrong; corrected in guide §4.3/§8.2.)
- **D4 — Dashboard host.** Reuse the desktop app surface in v1; **no** new
  `hermes telemetry serve` server in core (avoids core bloat). This resolves what was
  previously an open question.

### Still open (need a human/leadership call before the phase that depends on them)

1. **NeMo: dependency, donor, or competitor?** This doc assumes *donor + optional OTLP
   interop*. Leadership should confirm before the existing plugin sets the direction by
   inertia. (Blocks: nothing in Phase 0–1; confirm before leaning on the NeMo plugin.)
2. **`model_class` / `provider_family` / `local_runtime` taxonomy.** Coarse enough to be
   non-identifying yet useful. Needs an enumerated list reviewed for cardinality **before
   Phase 2**. (Enumerations drafted in guide §8.)
3. **Counsel sign-off** on opt-in scope (EU-only vs. global) and on the pseudonymous-data
   classification of `install_id`. **Before Phase 2.**
4. **Explicit-feedback signal** (§7): in scope for v1 or deferred? It's the only path to a
   real *value* (not reliability) metric. (Decision shapes the §7 North Star.)
5. **Enterprise policy distribution** (§11.6): first-class org-policy file format +
   MDM/container injection in Phase 4, or lean on existing `config.yaml` layering? Affects
   how "read-only, managed by your org" is enforced and surfaced. **Before Phase 4.**

---

## 14. Summary of decisions vs. the original narrative

| Topic | Narrative plan | This doc |
|---|---|---|
| Aggregate consent | Pre-checked "Yes, Recommended" | **Opt-in, default off, no pre-check** |
| North Star | "successful delegated workflows" implying value | **Named as a reliability/completion proxy**; optional explicit-feedback metric for value |
| Telemetry controls | `config.yaml` + `HERMES_TELEMETRY` env vars | **`config.yaml` only**; env bridges internal, not user-facing |
| Local store | New `telemetry.sqlite` | **Extend `state.db`**; one transactional store |
| Phase 1 | Greenfield build | **Consolidation** of existing insights/pricing/redact infra |
| OTLP | Listed as one of seven exports | **Local-plane only, never the aggregate format**; core ships JSONL+SQLite+OTLP, rest are plugins |
| NeMo-Relay | (not addressed) | **Pattern donor + optional plugin**, not core substrate |
| Pricing | (assumed) | **Add `pricing_as_of`/`pricing_source` provenance** from NeMo |
| Redaction | "redaction is not enough" | **Codec-aware redaction for content planes only**; Plane B carries no content by construction |
| Enterprise | (not addressed) | **Total local/SIEM data ownership** via org policy + self-hosted collectors + `nous_egress: forbidden`; secret-redaction-on-by-default; non-suppressible "managed by your org" indicator (§11) |
