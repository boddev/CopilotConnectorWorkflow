# Streamlined Connector Evaluation Plan

## Goal

Automate the end-to-end enhanced-vs-non-enhanced Microsoft 365 Copilot Connector evaluation workflow so the same testing performed for the D&B dataset can be repeated across 25 additional datasets with minimal manual intervention.

The target outcome is a single pipeline that runs the same six steps for every connector — enhanced and non-enhanced runs differ only by one flag on Step 2 — and a separate, post-hoc comparator that reads two completed runs and emits a combined report.

## Execution model

There are exactly two execution paths:

1. **The pipeline** (`ccw run`): steps 1–6 run for every connector, in the same order, regardless of whether the source data is being enhanced. Configurable variation is limited to:
   - `--no-enhance` (boolean) — Step 2 branch.
   - `--mode build|provision` — gates the tenant-side substeps. `build` stops the job after the local artifacts (`enhanced-items.jsonl`, schema, connector project, deploy artifacts) are produced; **`build` jobs are not comparable** and Step 6 is skipped with a `requires-provision-mode` diagnostic. `provision` runs the full lifecycle and is required for `ccw compare`.
   - `--reuse-eval-from <jobId>` *or* `--eval-set <path>` — Step 1 reuses an existing eval set verbatim instead of generating a new one. This is the only supported way to feed two paired runs the same prompts (and therefore the only way to compare them). See "Pairing two runs" below.
   - `--judge-provider github-copilot|workiq` — Step 6 only; defaults to `github-copilot`.
   - `--judge-agent-id <id>` — required when `--judge-provider workiq` is set.

   The six steps:
   1. `evalgen` — generate the eval set against the dataset, or reuse the eval set referenced by `--reuse-eval-from` / `--eval-set`.
   2. `enhance` — when `--no-enhance` is not set, run the data enhancer; when `--no-enhance` is set, run an identity transform that still infers a Graph schema from the *shape* of the source data, sanitizes property names, deterministically handles nested JSON, and writes `enhanced-items.jsonl` + `schema-suggestion.json` in the same locations. Steps 3–6 do not know which branch ran.
   3. `schema` — harden and validate the suggested schema.
   4. `connector+agent` — render the Agents Toolkit project and the declarative agent.
   5. `deploy` — render Azure deploy artifacts **and**, in `provision` mode, run the tenant-side lifecycle: create the external connection, register and poll the schema to completion, ingest items and verify item count, install/publish the declarative agent, and discover and persist the deployed agent id. In `build` mode this step is artifact-emission only.
   6. `score` — score the run with `eval-score`. The judge defaults to GitHub Copilot (`--judge-provider github-copilot`); the Work IQ A2A + `agents\eval-judge\` path is the supported alternative when the GitHub Copilot judge is unavailable. Every `provision` run produces one canonical scored report; `build` runs skip this step.
2. **The post-hoc comparator** (`ccw compare --job <id-a> --job <id-b>`): reads the scored reports from two previously completed `ccw run` jobs (both in `provision` mode, both reached Step 6 `done`) and produces a combined enhanced-vs-non-enhanced view. It never renders, builds, provisions, ingests, or calls Copilot itself.

### Pairing two runs

A meaningful `ccw compare` requires that the two runs differ **only** in whether enhancement ran. To enforce that:

1. Run the **first** job normally: `ccw run --dataset <path> --mode provision …`. This generates `01-evalgen/eval.evalgen.json` from EvalGen.
2. Run the **second** job reusing the first job's eval set: `ccw run --dataset <path> --no-enhance --mode provision --reuse-eval-from <firstJobId> …`. Step 1 copies the prior eval set + canaries instead of re-generating, so eval-set hash and canary-prompt set match exactly.
3. Run `ccw compare --job <firstJobId> --job <secondJobId>`.

The two-step pair is the supported unit of comparison. `ccw run` alone is also valid as a single-connector run when no comparison is intended.


## What slowed down the D&B run

The user-observed issues were accurate. The full list of material speed bumps was:

| Area | What happened | Streamlining requirement |
|---|---|---|
| Connector generation | The first generated connector had schema/runtime issues: JSONL records were stored in `.json` files, aliases were invalid for Graph payloads, `duns` mixed searchable and exact-match semantics, local env loading was incomplete, and the ingest path needed clearer raw-vs-enhanced behavior. | Make these generator/template invariants with regression tests so every dataset gets a valid connector on first render. |
| Graph schema registration | Graph schema constraints were easy to violate, and schema registration is asynchronous. Item upserts can fail briefly even after schema creation appears accepted. | Add hard preflight validation, schema polling, and Graph write retry/backoff as first-class pipeline states. |
| RAW baseline | The RAW connector had to be manually created for D&B. | Make `ccw run --no-enhance` produce the same artifacts as a normal run, with Step 2 emitting a shape-derived schema and 1:1 items; pair it with a post-hoc `ccw compare` so two ordinary runs can be diffed without a special "comparison mode". |
| Agent package | The generated app package used an old Teams/declarative-agent manifest shape tied to outdated Teams schema expectations, not the current Copilot declarative agent package format. | Pin and validate the current M365 Copilot declarative agent manifest schema in tests and in the generator. |
| Agent deployment | Agent IDs had to be discovered after deployment. | Automate agent package install/publish and persist agent IDs/title IDs in run state. |
| EvalGen scale | EvalGen would not directly generate 100 questions because `--count` is capped at 25-50, so multiple runs and manual merges were needed. | Automate multi-batch generation with `--avoid-evalsets`, deduplication, and a target-count loop. |
| Copilot response collection | WorkIQ/A2A response collection was slow, hit hourly Copilot request limits, and returned rate-limit messages as normal answers. | Use a resumable response queue with pacing, adaptive retry, backoff, and strict invalid-response detection before scoring. |
| Device-code auth | Device-code auth was repeated many times because no durable WorkIQ delegated token cache existed initially, codes expired, stale codes were entered, and stopped/restarted processes lost the active flow. | Use a durable user-level token cache, one long-lived collector process, active-code tracking, silent refresh, and checkpointed resume after auth failures. |
| Scoring package expectations | `@microsoft/m365-copilot-eval` includes Azure OpenAI LLM-as-judge evaluators. The workflow must not depend on Azure OpenAI, and using two parallel scoring tools (`@microsoft/m365-copilot-eval` for Step 6 plus the deterministic scorer in `src/scoring.ts`) has fragmented output. | Remove `@microsoft/m365-copilot-eval` entirely. Scoring on every run goes through `..\EvaluationCLI\eval-score`. Default judge is GitHub Copilot (`--judge-provider github-copilot`, runs through the local `copilot` CLI). Supported alternative is Work IQ A2A using `agents\eval-judge\` (`--judge-provider workiq --judge-agent-id <id>`). `src/scoring.ts`'s deterministic 80/20 grounding scorer folds into the same Step 6 so each job emits one canonical report carrying both deterministic and semantic scores plus the judge provider that produced them. |
| Scoring validity | Early scores included rate-limit responses, making results invalid. | Block scoring unless both agents have zero blank, error, and rate-limit rows. |
| Index readiness | The D&B run relied on ad hoc waiting/verification. Across 50 connectors, Copilot indexing latency can create false negatives if response collection starts too soon. | Add an explicit indexing-readiness gate using canary prompts and timeout reporting. |

## Pipeline (single execution path)

Every connector goes through the same six steps in the same order. The only configurable variation is `--no-enhance`, which changes the *contents* of Step 2's output but not the file paths, downstream code paths, or per-step contract. Steps 3–6 have no knowledge of whether enhancement ran.

```text
ccw run --dataset <path> [--no-enhance]
  Step 1: evalgen      -> 01-evalgen/eval.csv, eval.evalgen.json, eval-review.md
  Step 2: enhance      -> 02-enhance/enhanced-items.jsonl, schema-suggestion.json
           or identity     (same outputs; --no-enhance produces shape-derived schema + 1:1 items)
  Step 3: schema       -> 03-schema/connector-schema.json, schema.ts, schema-validation.json
  Step 4: connector    -> 04-connector/connector/ (Agents Toolkit project + declarative agent)
  Step 5: deploy       -> 04-connector/connector/deploy/{azure-functions,azure-container-apps}/
  Step 6: score        -> 06-score/agent-response-scores.{json,md}, eval-score-results.json
```

### Step 1 — evalgen

Generate the eval set for this job. The eval set must be large enough to drive a meaningful score (target 100 prompts per dataset for the 25-dataset run). Because EvalGen's `--count` is capped at 25–50, this step iterates:

1. Run EvalGen with the maximum allowed count.
2. Run additional batches using `--avoid-evalsets` against prior outputs.
3. Deduplicate by normalized prompt text and source row.
4. Add near-duplicate detection using n-gram similarity so paraphrased duplicates do not inflate the set.
5. Stop when the target count is reached or a configured attempt cap is hit.
6. If fewer than 100 distinct questions are possible, continue with the actual count and persist `actualQuestionCount` in step state.
7. Write the merged `eval.csv`, `eval.evalgen.json`, and review markdown.

Also pick **canary facts** — a small set of high-confidence prompts whose answers should be trivially derivable from a successfully indexed connector. Step 6 uses them as the indexing-readiness gate. Canary prompts are stored alongside the eval set.

### Step 2 — enhance (default) or identity (`--no-enhance`)

Both branches read the source dataset, write the same two files (`enhanced-items.jsonl` and `schema-suggestion.json`), and fail closed on error. They differ only in transform.

**Default (`--no-enhance` not set):** Run the bundled TypeScript enhancer (`src/enhancer/enhance_for_copilot.ts`). It infers a domain, flattens nested JSON, normalizes ISO/year/code fields, pivots long-format indicator tables to wide-form records, adds synthetic properties (`recordId`, `summary`, `recordType`, `lastModified`, `domain`), adds domain-specific property packs, derives semantic title / url / icon, optionally folds matching EvalGen prompts and answers into item content, and optionally emits per-file overview items.

**`--no-enhance` set:** Run an identity-but-shape-aware transform:

- Walk the source rows once to infer field types and the column list.
- Default any CSV/TSV column to `String` unless **every** non-empty row parses as numeric or DateTime *and* the column name does not match any preserve-as-string heuristic. Preserve as `String` at minimum: any column whose name contains or ends with `id`, `code`, `key`, `no`, `num`, `iso`, `zip`, `postal`, `phone`, `fax`, `npi`, `duns`, `taxonomy`, `account`; any column whose name is exactly `year`, `month`, `quarter`, `period`, `fiscal_year`, `week`, `date`, `time`, `timestamp`; any column whose values contain leading zeros, exceed JS safe integer range, or use scientific notation. This list is at least as broad as the enhancer's `PRESERVE_NUMERIC_*` rules in `src/enhancer/enhance_for_copilot.ts:19-25`.
- Sanitize every source column name to a Graph-valid schema property name (`^[A-Za-z][A-Za-z0-9_]{0,31}$`): strip non-alphanumerics, prepend an alphabetical prefix when the leading character is a digit, truncate to 32 chars. When two source columns collide after sanitization, append a deterministic suffix (`_1`, `_2`, …) to preserve uniqueness. Record the (originalColumn → schemaProperty) mapping in `schema-suggestion.json` under `sourceFieldMappings` so the comparator and downstream tooling can recover the raw column name.
- Write `schema-suggestion.json` containing one property per sanitized column with defaults: `isSearchable: true` for textual columns, `isQueryable: true` and `isRetrievable: true` for everything; `isRefinable` left off by default; `isExactMatchRequired` set on columns flagged as identifiers above.
- Auto-inject `title`, `url`, and `iconUrl` semantic labels: prefer matching source columns when present (a sanitized property literally named `title` / `url` / `iconUrl`, or one of `name`, `headline`, `subject` for title; `link`, `permalink`, `sourceUrl` for url; `icon`, `image`, `thumbnail` for iconUrl), otherwise emit deterministic fallbacks (title = best literal match or `<sourceFile> row <n>`, url = `file:///raw/<path>#row-<n>` or the `--url-prefix` variant, iconUrl = default file icon).
- Handle nested JSON deterministically: flatten nested objects to dotted paths (`address.city`, `address.zip`), stringify nested arrays of scalars as comma-joined values, and stringify nested arrays of objects as compact JSON. This is required for Graph property compatibility but adds no enhancer-style enrichment (no semantic field promotion, no domain inference, no alias rewriting).
- Emit one external item per source record with `properties` keyed by the sanitized schema property names (not the raw source column names) and `content.value` containing the rendered record text for full-text search. The raw column names live only in `sourceFieldMappings`.
- Record provenance per item-shaping decision in `schema-suggestion.json` so the canonical scored report can later flag whether `title`/`url`/`iconUrl` came from a real source field or a deterministic fallback. The comparator surfaces this so a non-enhanced loss can be partly attributed to "no source title column" vs. "answer-quality loss".
- Do not invoke any enhancer code paths. Do not pivot long-form tables, do not add synthetic properties (`recordId`, `summary`, `recordType`, `lastModified`, `domain`), do not fold in EvalGen prompts, do not chunk documents, do not run domain inference.

After this change, **the only difference between an enhanced run and a non-enhanced run** is what Step 2 chose to do. Steps 3–6 cannot distinguish them.

### Step 3 — schema hardening

Same code, both branches:

- Reject property names that don't match `^[A-Za-z][A-Za-z0-9_]{0,31}$`.
- Enforce `searchable` and `refinable` mutual exclusivity.
- Enforce `isExactMatchRequired` only on non-searchable properties.
- Enforce ≤128 properties total and exactly one property per semantic label.
- Auto-inject `title` / `url` semantic labels onto existing properties; auto-promote `iconUrl` if a matching property exists.
- Strip Graph-invalid aliases before payload creation.
- Reject reserved property names (`content`).
- Sample-validate 200 items from `enhanced-items.jsonl`: valid JSON, ID present, URL-safe, ≤4 MB, types match, DateTimes ISO-formatted.
- Block on any error-severity finding.

### Step 4 — connector + agent

Render the Agents Toolkit project under `04-connector/connector/` with:

- Programmatically emitted `appPackage/manifest.json` against the pinned current Teams manifest schema (`teams/v1.23/MicrosoftTeams.schema.json`).
- Programmatically emitted `appPackage/declarativeAgent.json` against `copilot/declarative-agent/v1.0/schema.json`, scoped to a single `GraphConnectors` capability containing this connector id and no other external data source.
- `appPackage/instruction.txt` carrying the per-connector system prompt.
- Deterministic agent and package ids derived from the connector id, so re-runs produce the same agent rather than orphaned duplicates.
- `provision.ts` that polls schema registration to completion and retries transient Graph upsert failures.
- `ingest.ts` that fails closed when the enhancer fails on a per-item basis (relevant only when this is a default — non-`--no-enhance` — run with a runtime enhancer).
- `deprovision.ts` that removes the connection and items in reverse order.
- Validate the package before install: manifest schema/version pinned, declarative agent file referenced correctly, exactly one `GraphConnectors` connection, no other capabilities enabled.
- After install / publish, discover and persist the deployed agent id alongside the job record.

### Step 5 — deploy (artifacts + tenant-side lifecycle)

Step 5 has two responsibilities that run in this order, gated by `--mode`:

1. **Always — artifact rendering.** Emit Azure Functions and/or Container Apps deploy artifacts (PowerShell, Bicep, Dockerfile, deploy README) into `04-connector/connector/deploy/{azure-functions,azure-container-apps}/`. No tenant calls. This is what `build` jobs stop after.
2. **`provision` mode only — tenant-side lifecycle.** Run the generated connector's lifecycle in this exact order, with each substep persisted under `05-deploy/`:

   1. `npm install && npm run build` against `04-connector/connector/` (verifies the project compiles before any tenant write).
   2. `npm run provision` — create the external connection, register the schema with `Prefer: respond-async`, and poll until schema registration completes (15-minute ceiling). Persist `connectionId`, `schemaRegisteredAt`.
   3. `npm run ingest` — push items from `enhanced-items.jsonl` and verify the post-ingestion item count matches the JSONL line count within tolerance. Persist `ingestStartedAt`, `ingestEndedAt`, `itemsIngested`.
   4. Validate the app package (manifest schema/version pinned, single `GraphConnectors` capability bound to this connector id, no other capabilities).
   5. Install/publish the declarative agent via the Microsoft 365 Agents Toolkit CLI (`atk install --file-path appPackage.zip`) and discover the deployed `agentId` from the toolkit's `TitleId` output. Persist `appId`, `agentId`, `publishedAt`. **This is automated when `atk` is on `PATH`**: Step 5 zips `04-connector/connector/appPackage/`, invokes `atk install`, parses the `TitleId`, and writes `agentId = "<TitleId>.declarativeAgent"` into `05-deploy/resources.json`. When `atk` is missing or `--skip-agent-publish` (config `score.skipAgentPublish`) is set, Step 5 records a manual-publish marker; the operator runs `atk install` (or publishes via Agents Toolkit UI / `teamsapp publish`) and resumes with `--candidate-agent-id <T_*.declarativeAgent>`.

   If any tenant substep fails, Step 5 fails the job and Step 6 is not run. Step 5's tenant substeps are idempotent: a re-run with the same `connectorId` reuses the existing connection unless `--replace` is set (see "Connector lifecycle and collisions" below).

`build`-mode jobs stop at substep 1 of (1) and are explicitly marked **not comparable**. `ccw compare` refuses to read them.

### Step 6 — score

Step 6 runs on every **`provision`-mode** `ccw run` (build jobs skip it with a `requires-provision-mode` diagnostic). It produces one canonical scored report per job, carrying both deterministic and semantic scores. `@microsoft/m365-copilot-eval` is not used at any point.

**Response collection** always goes through Work IQ A2A: `eval-score` calls the candidate M365 declarative agent (whose id was discovered and persisted in Step 5) via `WorkIQClient` to get the candidate's answer to each eval prompt. There is no other way to reach an M365 Copilot declarative agent programmatically.

**Semantic judging** has a default and a supported alternative:

| Mode | Judge provider | When to use | Requirements |
|---|---|---|---|
| **Default** | `--judge-provider github-copilot` | Normal interactive or supervised runs. The judge runs locally through the `copilot` CLI, so it does not consume per-hour Work IQ rate limit on top of response collection, and it does not require the Work IQ first-party SP to be provisioned. **Important:** `EvaluationCLI/eval-score`'s built-in CLI default is `workiq`; the workflow's Step 6 wrapper must pass `--judge-provider github-copilot` explicitly. | `copilot` (GitHub Copilot CLI) on the PATH and signed in; an interactive session that survives the run's duration; optional `EVALSCORE_GITHUB_COPILOT_MODEL` / `EVALSCORE_GITHUB_COPILOT_COMMAND` overrides. |
| **Alternative** | `--judge-provider workiq --judge-agent-id <eval-judge-agent>` | Long unattended runs, headless CI, when GitHub Copilot CLI is not available, when the operator wants judging to stay inside Microsoft 365 Copilot for compliance / parity reasons, or when calibrating GitHub-judged scores against Work-IQ-judged scores. | The `agents\eval-judge\` declarative agent published in the tenant and discovered through the A2A `/.agents` endpoint; same delegated Work IQ token already used for response collection. |

Step 6 has five sub-stages, identical regardless of which judge is selected:

1. **Judge preflight.** Run a 2-3 prompt canary against the chosen judge (any short response is fine; the canary verifies the judge process is reachable, signed in, and not rate-limited). For GitHub Copilot this confirms `copilot --silent -p <prompt>` returns within a sane timeout. Record the judge model/provider metadata into the report. If preflight fails, Step 6 fails closed — the workflow never silently downgrades to a different provider.
2. **Indexing-readiness gate.** Query the candidate agent with the canary prompts from Step 1 until each returns a non-empty, non-rate-limited answer that includes the expected canary content and preferably a citation. Enforce a minimum wait floor (default 5 minutes) and a maximum wait ceiling (default 90 minutes). Persist `indexReadyAt`, the canary prompts, the canary answers, and the readiness attempts. If readiness never succeeds inside the ceiling, mark the job `not-comparable` and skip the remaining sub-stages. Canary prompts must be selected during Step 1 to favour the dataset's *common case* (not the easiest possible question) so that "ready" implies "comparable for the full eval set".
3. **Response collection + judging.** Invoke `eval-score` against Work IQ A2A for response collection, with the selected judge handling the semantic score:

    ```powershell
    # Default — GitHub Copilot judge
    eval-score `
      --input          <jobWorkspace>\01-evalgen\eval.csv `
      --m365-agent-id  <candidate-agent> `
      --judge-provider github-copilot `
      --tenant-id      <tenant> `
      --output-dir     <jobWorkspace>\06-score

    # Alternative — Work IQ + eval-judge declarative agent
    eval-score `
      --input          <jobWorkspace>\01-evalgen\eval.csv `
      --m365-agent-id  <candidate-agent> `
      --judge-provider workiq `
      --judge-agent-id <eval-judge-agent> `
      --tenant-id      <tenant> `
      --output-dir     <jobWorkspace>\06-score
    ```

    Use a long-lived runner with adaptive exponential backoff and durable per-question checkpointing. Treat blank answers, explicit errors, HTTP 429/503, and any known rate-limit text as invalid (rate-limit detection must be a broader matcher than one exact string). Invalid rows are retried; they never reach scoring. The same rules apply to judge responses regardless of provider.
4. **Invalid-row gate (normalization wrapper).** `eval-score` today writes empty-answer scores as `0` and on judge errors records score `0` with metadata, rather than failing closed (see `EvaluationCLI/eval-score/node/src/scorer.ts:49-108`). Step 6 must therefore wrap `eval-score`'s output: read the completed eval rows, treat any row with `error`, an `[ERROR:]`-prefixed answer, a blank answer, a fallback-provider judge result, or a malformed/non-JSON judge response as **invalid**, retry it through `eval-score` (up to a configured retry cap), and fail the job if any invalid row remains. The normalization wrapper is also responsible for mapping `eval-score`'s output schema into the canonical per-job report shape below.
5. **Deterministic grounding score.** Fold the deterministic 80/20 assertion + supporting-fact scorer currently in `src/scoring.ts` into the same normalization wrapper so the canonical `agent-response-scores.json` carries both scores alongside the per-question response, citation flag, no-result detection, and per-category averages.

Step 6 fails the job if the judge preflight fails, if the indexing gate never succeeds, if any invalid response remains after retry exhaustion, or if any judge response remains blank, malformed, or non-JSON. If the default judge provider fails outright (e.g. `copilot` CLI is missing on the host), Step 6 fails closed; the operator opts into the Work IQ judge by explicitly setting `--judge-provider workiq` on the next attempt. The workflow never silently downgrades or upgrades providers.

The per-job scored report carries the judge provider that produced it and provenance flags for the comparator:

```json
{
  "jobId": "...",
  "noEnhance": false,
  "judgeProvider": "github-copilot",
  "judgeModel": "...",
  "datasetHash": "sha256:...",
  "evalSetHash": "sha256:...",
  "indexReadyAt": "2026-...",
  "promptCount": 100,
  "validPromptCount": 100,
  "metadataProvenance": {
    "titleFromSource": 0.92,
    "urlFromSource": 0.0,
    "iconUrlFromSource": 0.0,
    "schemaPropertiesPromotedToSearchable": 12,
    "schemaPropertiesPromotedToRefinable": 0
  },
  "deterministicScore": { "average": 0, "passCount": 0, "partialCount": 0, "failCount": 0, "byCategory": {} },
  "semanticScore": { "average": 0, "byDimension": { "relevance": 0, "correctness": 0, "completeness": 0, "groundedness": 0, "citationQuality": 0, "clarity": 0 } },
  "citationRate": 0,
  "retryCount": 0,
  "rateLimitCount": 0,
  "items": [ { "id": "...", "prompt": "...", "expected": "...", "actual": "...", "deterministic": { /* ... */ }, "semantic": { /* ... */ } } ]
}
```

`metadataProvenance` lets the comparator attribute deltas between "real enhancer wins" and "non-enhanced lost because there was no source `title` column", rather than treating both as undifferentiated semantic-score deltas.

The semantic judge prompt must require structured JSON output and must enforce strict parsing regardless of provider. The Work IQ + `agents\eval-judge\` path already ships with calibration anchors and a "choose the lower score" tie-break; the GitHub Copilot judge prompt template lives in `..\EvaluationCLI\eval-score\node\src\judge-providers.ts` (`buildScoringPrompt`). **Rubric alignment is necessary but not sufficient for cross-provider comparability.** Two different judges scoring against the same rubric will still produce different distributions. Before any mixed-provider conclusions are drawn, the workflow must run a calibration set (described under "Calibration" below) and either (a) restrict comparisons to within-provider pairs (the default the comparator enforces), or (b) apply a provider-specific normalization derived from the calibration set.

### Step 6 — semantic rubric

The semantic judge in Step 6 scores each response on a 1-5 or 0-100 rubric across:

| Dimension | What the judge checks |
|---|---|
| Relevance | The answer directly addresses the prompt. |
| Correctness | The answer agrees with the expected answer and source facts. |
| Completeness | The answer includes the important facts needed for a useful answer. |
| Groundedness | The answer does not introduce unsupported claims. |
| Citation quality | Citations are present and appropriate when expected. |
| Clarity | The answer is understandable and well structured. |

Deterministic and semantic scores stay separate in the report. Do not collapse them into one score unless a later calibration proves the weighting is useful.

### Calibration

Cross-provider judge score distributions differ. Before reporting any GitHub-vs-Work-IQ comparison, run the calibration set:

1. Pick one already-completed `provision`-mode job from any dataset.
2. Run Step 6 twice against the same job's existing response set (skipping response collection, only re-judging): once with `--judge-provider github-copilot`, once with `--judge-provider workiq --judge-agent-id <eval-judge>`.
3. Compute mean/stddev of each semantic dimension per provider and persist as `calibration/<jobId>.json`.
4. The comparator reads the calibration file when both inputs to a comparison are absent; if only within-provider pairs are being diffed, calibration is optional and ignored.

Until a dataset has a calibration entry, cross-provider comparisons are reported with raw scores only and a clear `calibrated=false` flag. No claims about "enhanced is x% better" should be published from un-calibrated cross-provider deltas.

## Post-hoc comparator (`ccw compare`)

The comparator is the second — and only other — execution path. It is **strictly post-hoc**: it reads two completed `ccw run` job folders, diffs their `06-score/agent-response-scores.json` files, and emits a combined report. It never renders, builds, provisions, ingests, calls Copilot, or touches a tenant.

```powershell
ccw compare --job <enhancedJobId> --job <nonEnhancedJobId> --output <reportDir>
```

Pre-conditions enforced by the comparator:

- Both jobs ran in `mode=provision` and reached Step 6 with status `done` (`build` jobs and `not-comparable` jobs are rejected).
- Both jobs ran against the same dataset, identified by the canonical **dataset hash** recorded in `job.json` (see "Canonical hashing" below).
- Both jobs scored the same eval set, identified by the canonical **eval set hash** recorded in `01-evalgen/`. The supported way to get matching hashes is to pair runs with `--reuse-eval-from <jobId>`; the comparator does not attempt to recover from drift.
- Exactly one of the two jobs has `noEnhance: true` (the comparator refuses to compare two enhanced or two non-enhanced runs).
- `judgeProvider` match is **not** a hard precondition. If both jobs share a provider, the report includes semantic deltas. If providers differ, the report sets `semanticComparable: false`, omits the semantic delta, and still includes deterministic, citation, retry, rate-limit, and indexing-readiness side-by-side metrics. A clear annotation directs the operator to either re-run with matching providers or run the calibration set described in Step 6.

### Canonical hashing

Hashes must be stable across runs that intentionally match and distinct across runs that intentionally don't. The plan defines two canonical hashes:

- **Dataset hash.** SHA-256 over a normalized manifest: `{ sourceFiles: [ { relativePath, sha256, byteLength }, ... ] }` where `sourceFiles` is the sorted list of dataset files filtered by the `--extensions` filter, with `relativePath` normalized to forward slashes and lower-cased on Windows. Generated artifacts under `evalset/`, `workspace/`, and any path starting with `_` are excluded. The dataset description is **not** part of the hash (so a description tweak between runs doesn't break pairing).
- **Eval set hash.** SHA-256 over the canonicalized eval items: each item reduced to `{ id, prompt, expected_answer, assertions: [...], supporting_facts: [...], category, difficulty }`, sorted by `id`. The raw `eval.evalgen.json` byte stream is **not** the hash — version metadata, generation timestamp, and review markdown are excluded.

Both hashes are recorded in `job.json` and the canonical scored report. The comparator computes them lazily from inputs if they are missing, to support older jobs.

### Response variance acknowledgement

Microsoft 365 Copilot responses are non-deterministic across calls (model temperature, retrieval ordering, indexing freshness, rate-limit-driven retries). A delta between two `provision` runs therefore includes both enhancement effect and response variance. The comparator reports this honestly:

- For pilot datasets, run each pair twice (four jobs total: enhanced-A, enhanced-B, non-enhanced-A, non-enhanced-B) and report per-question score variance alongside per-pair delta so the operator can see when deltas are within noise.
- For the 25-dataset run, run each pair once and tag the aggregate `aggregate-summary.json` with `repeatTrials: 1` and `varianceAcknowledged: true`. Do not claim "enhanced wins on dataset X" when the delta is below a configurable noise threshold (default 5 points on a 0-100 semantic scale; the threshold should be re-estimated from the pilot variance).
- The comparator never randomizes / re-orders prompts (eval sets are fixed by hash) but can run pairs roughly contemporaneously to minimize temporal indexing differences.

Outputs under `<reportDir>/`:

- `comparison-report.md` and `comparison-report.json` — per-question delta, per-dimension semantic delta, citation-rate delta, indexing-readiness delta, retry / rate-limit deltas, `comparable?` and `semanticComparable?` flags, and the underlying job hashes.
- `score-matrix.csv` — one row per question with the deterministic and semantic scores from each job side by side, plus the delta.

### Batch comparison

To produce a batch comparison across the 25 datasets, run the pipeline twice per dataset (once with `--no-enhance --reuse-eval-from <firstJobId>`, once without), then run `ccw compare` once per dataset. An optional `ccw compare-batch --pairs <pairs.json>` driver invokes the comparator across many job pairs and aggregates per-dataset reports into an `aggregate-summary.{md,json}` and a `failures-and-retries.md`. `compare-batch` is a thin post-hoc wrapper — it does not render, build, provision, ingest, or call Copilot, and it never substitutes for `ccw run`.

Aggregate report columns:

| Column | Purpose |
|---|---|
| Dataset | Dataset slug from `job.json`. |
| Enhanced job / Non-enhanced job | Job ids for traceability. |
| Enhanced connection / Non-enhanced connection | Graph connection ids. |
| Enhanced agent / Non-enhanced agent | M365 agent ids. |
| Question count | Actual comparable prompt count. |
| Enhanced deterministic score | Local fact/assertion grounding score. |
| Non-enhanced deterministic score | Local fact/assertion grounding score. |
| Deterministic delta | Enhanced minus non-enhanced. |
| Enhanced semantic score | LLM-judged answer quality score. |
| Non-enhanced semantic score | LLM-judged answer quality score. |
| Semantic delta | Enhanced minus non-enhanced. |
| Semantic dimensions | Relevance, correctness, completeness, groundedness, citation quality, and clarity. |
| Pass/partial/fail | Quality breakdown per job. |
| Citation rate | Answers with citations per job. |
| Retry count | Operational reliability signal. |
| Rate-limit count | Copilot throttling signal. |
| Indexing readiness time | Time from ingest completion to canary success. |
| Judge provider | `github-copilot` or `workiq`. Both jobs in the pair must match (see comparator pre-conditions). |
| Comparable? | Excludes pairs where either job failed indexing, had invalid responses, used different judge providers, or had too few valid questions. |

Do not produce aggregate claims for pairs where `comparable?` is false.

Before scaling to 25 datasets, run one calibration pass on the completed D&B pair comparing deterministic scores to semantic quality scores. If the scores diverge materially, report the divergence explicitly; this is expected because deterministic scoring rewards exact fact coverage while semantic scoring can recognize correct paraphrases and answer quality.

## Authentication

Three distinct auth models, one of which is conditional on the judge provider:

| Need | Auth |
|---|---|
| Connector provision / schema / ingestion (Steps 4 and the generated connector's runtime) | App-only Graph auth with `ExternalConnection.ReadWrite.OwnedBy` and `ExternalItem.ReadWrite.OwnedBy`. |
| Copilot response collection — every Step 6 | Delegated Work IQ auth (`WorkIQAgent.Ask` scope) acquired via the device-code flow against the Azure PowerShell public client (`14d82eec-204b-4c2f-b7e8-296a70dab67e`). Required regardless of judge provider because the candidate is always an M365 Copilot declarative agent reached over Work IQ A2A. |
| Semantic judge — Step 6, default | GitHub Copilot CLI session: the `copilot` binary on the PATH, signed in to a GitHub account with Copilot enabled. No tenant credentials are consumed by the judge in this mode. |
| Semantic judge — Step 6, alternative | Same delegated Work IQ token used for response collection, plus the `agents\eval-judge\` declarative agent published in the tenant and discovered through `https://workiq.svc.cloud.microsoft/a2a/.agents`. |

For Work IQ:

- Persist the MSAL token cache in a secure user-level location, not inside disposable job folders.
- Do not delete the token cache after each run.
- Attempt silent token acquisition before starting device code.
- If device code is required, print and write the active code to a stable file.
- Keep the runner alive while waiting for auth; if a code expires, rotate to a new code and update the active-code file.
- If auth fails mid-run, pause the queue, obtain a new token, and continue from the same question.
- A 25-dataset comparison run almost certainly needs more than one delegated login because token lifetimes and Copilot rate limits will stretch the run across days.

`scripts\setup-a2a.ps1` already provisions the Work IQ first-party SP, runs the device-code flow, and emits a token + agents file for `eval-score`; this should be folded into Step 6's prelude rather than left as a manual one-shot.

If the Work IQ token expires mid-run after the GitHub Copilot judge has already started returning scores, response collection (which still needs Work IQ) stalls but judging does not — Step 6 pauses response collection, refreshes the token via the device-code flow, and resumes from the last checkpoint. The GitHub Copilot judge keeps running independently, so the cost of an auth refresh is one paused response-collection batch, not a re-judge.

## Connector lifecycle and collisions

The 25-dataset pair run produces up to 50 connectors and 50 declarative agents in one tenant. Two interlocking problems must be handled:

- **Re-run collisions.** Re-running a dataset with the same `connectorId` against a tenant that already has that connection / schema / agent must not silently corrupt or partially overwrite the prior state. The workflow exposes:
  - `--reuse-existing` (default): if `GET /external/connections/<connectorId>` returns 200, reuse it and skip provision; re-register schema only if its hash changed; re-ingest only changed items; reuse the published agent id from `workspace\jobs\<priorJobId>\05-deploy\agent.json` if present.
  - `--replace`: deprovision the existing connection + items, uninstall the existing agent, then provision fresh. Refuses to run without an explicit confirmation flag (`--yes`) in non-interactive contexts.
  - `--fail-on-conflict`: hard-fail Step 5 if a same-id connection exists. Useful in CI.
- **Cleanup after a batch.** A batch produces a manifest of every resource it created: `workspace\jobs\<jobId>\05-deploy\resources.json` per job, aggregated into `workspace\compare-runs\<batchId>\resources.json`. A `ccw deprovision --batch <batchId>` command iterates that manifest and removes connections, schemas, items, and agents in reverse order, with a dry-run mode that prints what would be deleted. Operators should run `ccw deprovision` after every 25-dataset pair run.

Naming is deterministic from `connectorId` + the `noEnhance` flag:

- Enhanced: connection id = `<connectorId>`, agent app id = `<connectorId>-agent`, agent display name = `<connectorName> Assistant`.
- Non-enhanced: connection id = `<connectorId>-raw`, agent app id = `<connectorId>-raw-agent`, agent display name = `<connectorName> RAW Assistant`.

Re-running the same dataset always lands on the same ids, so `--reuse-existing` is the default and is safe.

## Run state and reporting

Per job (under `workspace\jobs\<jobId>\`):

- `job.json` — config + dataset hash + per-step status.
- `01-evalgen\` through `06-score\` — per-step inputs, outputs, and `step.log` / `step-status.json`.
- `06-score\agent-response-scores.{json,md}` — canonical per-job scored report.
- `06-score\eval-score-results.json` — raw `eval-score` output for troubleshooting.

Per comparison (under `<reportDir>/`):

- `comparison-report.{md,json}` — per-question + per-dimension delta.
- `score-matrix.csv` — side-by-side question rows.

When `compare-batch` is used:

- `aggregate-summary.{md,json}` — per-dataset summary across all comparison pairs.
- `failures-and-retries.md` — operational triage.

A SQLite run-state layer should back these JSON artifacts so cross-job queries, resume logic, and rate-limit / retry analytics don't require re-parsing every `step-status.json`. Tables:

| Table | Purpose |
|---|---|
| `jobs` | One row per `ccw run` — dataset slug + hash, `noEnhance` flag, `judgeProvider`, step statuses, timings. |
| `connectors` | Graph connection id, schema status, item count per job. |
| `agents` | Deployed agent id and binding to its job. |
| `questions` | EvalGen questions per job — category, expected answer, assertions, source mapping. |
| `responses` | Per-question actual answer, citations, raw response metadata, retry state. |
| `scores` | Per-question deterministic + semantic scores per job. |
| `comparisons` | Pair of job ids, comparator config, output report path, per-dataset summary. |
| `events` | Auditable log of state transitions, auth events, rate-limit events, retries. |

## Repository ownership

| Repository | Owns | Required changes |
|---|---|---|
| `C:\Users\bodonnell\src\CopilotConnectorSkill` | Generic connector and agent artifact guidance / templates used by GitHub Copilot CLI. | Keep the skill **generic**. Document an optional "no-enhance shape-inferred connector" recipe so a user prompting GitHub Copilot CLI directly can ask for a non-enhanced build. Do not bake comparison behaviour into the skill — the workflow's `--no-enhance` flag is what drives the second of the two runs that feed the comparator. |
| `C:\Users\bodonnell\src\CopilotConnectorWorkflow` | The six-step pipeline (`ccw run`), the post-hoc comparator (`ccw compare` / `ccw compare-batch`), run state, reporting. | Owns everything described in the pipeline and comparator sections above. |
| `C:\Users\bodonnell\src\EvaluationCLI` | EvalGen and `eval-score`. | `eval-score` is the only scorer the workflow calls. Native `--target-count` / `--avoid-evalsets` / near-duplicate handling in EvalGen are nice-to-haves; the workflow wraps current EvalGen first and only escalates if the wrapping proves brittle. |

## Opus 4.7 cross-reference

This plan was reviewed against Opus 4.7. The review confirmed the overall direction and identified the following important gaps, which have been incorporated above:

1. Add an explicit Copilot indexing-readiness gate; do not assume Graph ingestion means Copilot can answer.
2. Do not assume one delegated WorkIQ login will last for all 25 datasets; design for resumable re-auth.
3. Define deterministic connector and agent identity/naming to avoid collisions and orphaned resources.
4. Add required semantic quality judging and calibrate it against the deterministic local scorer on at least one dataset before making broad claims.
5. Add near-duplicate handling and attempt caps to EvalGen multi-batch generation.
6. Define RAW as an optional true no-enhancement baseline recipe with tests that prevent accidental enhancer use when that recipe is requested.
7. Make rate-limit detection broader than one exact response string.
8. Add a comparability flag in aggregate reporting so invalid or not-yet-indexed datasets are excluded from summary conclusions.
9. Add regression tests for each schema/template failure encountered during the D&B run.
10. Consider SQLite run state, a long-lived WorkIQ runner, dry-run mode, pinned manifest schema validation, and cost/time estimates before launching a 25-dataset run.

## GPT-5.5 cross-reference

This plan was also reviewed against GPT-5.5 after the single-pipeline rewrite. GPT-5.5 identified the following findings, all of which were adopted in the sections above unless noted otherwise.

**Must-fix (adopted):**

1. The six-step model was missing the actual tenant-side lifecycle that Step 6 depends on. Step 5 in this plan and `src/steps/step5-deploy.ts` both only emit deploy artifacts. Step 5 has been expanded to run provision → schema register + poll → ingest + verify count → app package validate → agent install/publish → agent id discover under `05-deploy/` in `provision` mode. `build`-mode jobs are now explicitly marked not-comparable.
2. "Step 6 runs on every `ccw run`" contradicted `build` mode. Step 6 is now scoped to `provision`-mode jobs only, with a `requires-provision-mode` diagnostic on `build` jobs and a hard refusal by the comparator to read them.
3. Two independent `ccw run` invocations were not guaranteed to share the same eval set or canary set. Added `--reuse-eval-from <jobId>` (and `--eval-set <path>`) and the explicit two-step "Pairing two runs" recipe. `evalSetHash` is computed canonically and must match.
4. No-enhance "1:1 source columns" conflicted with Graph's `^[A-Za-z][A-Za-z0-9_]{0,31}$` property-name constraint and Step 3 sanitization. Step 2 now sanitizes column names to Graph-valid form, records a `sourceFieldMappings` table on `schema-suggestion.json`, and emits item properties keyed by the sanitized names so Step 3 never has to drop columns silently.
5. Current `eval-score` does not fail-closed: empty answers and judge errors are silently scored as 0 (`EvaluationCLI/eval-score/node/src/scorer.ts:49-108`). Added an explicit Step 6 sub-stage (`Invalid-row gate / normalization wrapper`) that reads `eval-score` output, treats blank / `[ERROR:]` / fallback-provider / malformed-judge rows as invalid, retries them, and fails the job if any remain. The same wrapper produces the canonical `agent-response-scores.json` rather than expecting `eval-score` to emit it directly.
6. The canonical scored-report shape was not aligned with what `eval-score` writes today. The normalization wrapper above is now explicitly the producer of `06-score/agent-response-scores.json`.

**Should-fix (adopted):**

7. Type-inference preserve rules were too narrow. Broadened the preserve-as-String list to cover `id` / `code` / `key` / `no` / `num` / `iso` / `zip` / `postal` / `phone` / `fax` / `npi` / `duns` / `taxonomy` / `account` suffixes, leading-zero values, scientific notation, and integers beyond JS safe range — at least as broad as the enhancer's existing `PRESERVE_NUMERIC_*` rules. The default for any CSV/TSV column is now `String` unless **every** non-empty row parses as numeric or DateTime *and* no preserve heuristic matches.
8. Nested JSON handling was under-specified. The no-enhance branch now deterministically flattens nested objects (dotted paths), comma-joins arrays of scalars, and stringifies arrays of objects as compact JSON. This is identity-compatible (no semantic enrichment) but produces Graph-valid items. Without it, JSON datasets would fail Step 3 validation.
9. Fallback `title` / `url` / `iconUrl` could bias the comparison. Added a `metadataProvenance` block to the canonical report so the comparator can attribute deltas to "no source title column" vs. "answer-quality loss".
10. Hard refusal of mismatched-judge pairs was softened. The comparator now sets `semanticComparable: false`, omits the semantic delta, and still reports deterministic and operational metrics for cross-provider pairs.
11. Hashing needed a canonical definition. Added the "Canonical hashing" section with explicit input shape for `datasetHash` and `evalSetHash` so generated artifacts under `evalset/` / `workspace/` and irrelevant metadata can't cause false mismatches or false matches.
12. Response variance was not acknowledged. Added the "Response variance acknowledgement" section: pilot datasets run paired-twice for variance estimation; the 25-dataset run reports per-pair delta against a configurable noise threshold and never claims a win when the delta is below noise.
13. GitHub Copilot CLI judge may be fragile for unattended runs. Added an explicit judge preflight as Step 6 sub-stage (1), and reframed the default/alternative table to recommend `workiq` for long unattended / headless CI runs even though `github-copilot` remains the in-process default.
14. Rubric alignment is not the same as score comparability. Added the "Calibration" sub-section and the `ccw calibrate` driver. Cross-provider deltas are reported with `calibrated=false` until a calibration entry exists; rubric alignment is necessary but no longer claimed as sufficient.
15. Implementation order had unsafe dependencies (deleting `src/raw-connector.ts` before `compare-executor.ts` was removed would break the build). Order rewritten end-to-end: the no-enhance Step 2 and the new Step 6 driver land first, the post-hoc comparator lands eighth, and the entire old compare path (`src/compare.ts` + `src/compare-executor.ts` + `src/raw-connector.ts` + old CLI handlers) is deleted in a single ninth change. Gates and preflight ship with the Step 6 driver, not after.

**Nice-to-have (adopted):**

16. The plan's execution model said "two execution paths" but later referenced `ccw compare-batch`. The "Batch comparison" subsection now makes `compare-batch` explicitly a thin post-hoc wrapper around `ccw compare` with no orchestrator behaviour.
17. Connector id collision and 25-dataset cleanup were unaddressed. Added the "Connector lifecycle and collisions" section: `--reuse-existing` (default), `--replace`, `--fail-on-conflict`, deterministic naming, and a `ccw deprovision --batch <id>` command backed by per-job `resources.json` manifests.
18. Updated the small fact about `eval-score`'s built-in default: `EvaluationCLI/eval-score`'s CLI default judge provider is currently `workiq`, not `github-copilot`. The Step 6 wrapper explicitly passes `--judge-provider github-copilot` when that is the workflow's default; the plan no longer implies eval-score already matches.

**Set aside, with reasoning:** none. All 18 findings landed in the plan in some form.

## Immediate next implementation tasks

### Current implementation status

| Item | Status | Notes |
|---|---|---|
| Connector skill deterministic guidance | Implemented | Added deterministic generation contract plus detailed reference. |
| Installed Copilot Connector Skill sync | Implemented | Source repo includes `install.ps1`; installed skill was updated from source. |
| Single-pipeline `--no-enhance` flag on `ccw run` | Not started | Today the only way to produce a non-enhanced connector is the parallel `compare-dataset` / `compare-batch` path. `src/cli.ts::buildConfigFromFlags` and `src/types.ts::JobConfig` do not yet expose a `noEnhance` (or equivalent) boolean. |
| Step 2 identity branch that infers schema from source shape | Not started | The intended behavior is: when `--no-enhance` is set, Step 2 still walks the source rows, infers field types and the column list, writes a Graph-shaped `schema-suggestion.json` reflecting those columns (with deterministic `title`/`url`/`iconUrl` fallbacks), and emits one external item per source record whose `properties` are the source columns 1:1 — *not* a fixed `rawJson`/`rawText` catch-all schema. Steps 3–6 then run unchanged. |
| Step 6 = `eval-score` only (GitHub Copilot judge default, Work IQ judge alternative) | Not started | Scoring should run on every `ccw run` via `..\EvaluationCLI\eval-score`. Default judge is `--judge-provider github-copilot` (runs locally through the `copilot` CLI). Supported alternative is `--judge-provider workiq --judge-agent-id <agents\eval-judge\ agent id>` for operators without GitHub Copilot CLI or wanting to keep judging inside M365 Copilot. Response collection is always over Work IQ A2A regardless of judge. Today Step 6 is `@microsoft/m365-copilot-eval` (`src/steps/step6-m365eval.ts`), and the alternate deterministic scorer lives in `src/scoring.ts` reachable only from `compare-executor.ts`. |
| Remove `@microsoft/m365-copilot-eval` | Not started | Delete `src/steps/step6-m365eval.ts`, the `runM365Eval` / `m365Eval` config surface in `src/types.ts`, the `--run-m365-eval` / `--m365-*` CLI flags in `src/cli.ts`, the GUI fields in `public/`, the M365 EvalGen converter path in `src/tools.ts`, the EULA-accept hop in `src/auth-preflight.ts`, and all "Step 6 — `@microsoft/m365-copilot-eval`" prose in `README.md`. The Node ≥ 22.21.1 requirement (`src/tools.ts::M365_EVAL_MIN_NODE`) goes away with it. |
| Post-hoc comparator (`ccw compare --job <a> --job <b>`) | Not started | Replaces `compare-dataset` / `compare-batch`. Reads the canonical scored report from each job's `06-score/` folder, emits an enhanced-vs-non-enhanced delta report, refuses mismatched `judgeProvider` pairs, and never renders/builds/provisions/ingests/calls Copilot. |
| Retire parallel `compare-dataset` / `compare-batch` execution | Not started | `src/compare.ts`, `src/compare-executor.ts`, and `src/raw-connector.ts` need to be deleted or reduced: any inference logic worth keeping (e.g. shape-derived items) belongs in Step 2's no-enhance branch, not in a parallel RAW renderer. |
| Current Copilot declarative agent + manifest format | Implemented | `src/steps/step4-connector.ts:85-127` programmatically emits the agent against `copilot/declarative-agent/v1.0/schema.json` and the Teams manifest against `teams/v1.23/MicrosoftTeams.schema.json`. |
| In-process target-count eval set builder | Implemented | `src/evalset-builder.ts` reads any seed `eval.evalgen.json`, deterministically materializes additional items from source records up to the target count, deduplicates by prompt and id, and writes `eval.csv`, `eval.evalgen.json`, and `eval-review.md`. |
| EvalGen multi-batch (`--avoid-evalsets`) generation + near-duplicate detection | Not started | The builder above does not yet call EvaluationCLI `eval-gen` in a multi-batch loop; LLM-generated prompts past the seed are still single-shot. |
| Indexing-readiness canary gate | Not started | No canary prompts or `indexReadyAt` persistence exists. Belongs as a sub-step of Step 6 (before scoring kicks off). |
| `eval-score` integration as Step 6 | Not started | Today `eval-score` is invoked by hand or via `scripts\setup-a2a.ps1`. It needs to become an in-process Step 6 driver that: (a) waits on the canary gate, (b) calls `eval-score --m365-agent-id <candidate>` with `--judge-provider github-copilot` by default or `--judge-provider workiq --judge-agent-id <eval-judge>` when the operator opted into the alternative, (c) writes the canonical scored report into `06-score/` tagged with the `judgeProvider` that produced it. |
| Deterministic grounding score | Implemented but mis-located | `src/scoring.ts::scoreResponseSet` correctly produces the deterministic 80/20 grounding score, citation flag, no-result detection, and per-category averages — but it is only reachable from `compare-executor.ts`. It needs to move into Step 6 alongside `eval-score`'s semantic score, so every `ccw run` emits both. |
| Invalid-response gate before scoring | Not started | Scoring runs whenever both response CSVs exist; rate-limit / blank detection is not enforced. |
| Aggregate / comparison report | Not started | After `ccw compare` exists, it should emit `comparison-report.{md,json}` with per-question delta, per-dimension semantic delta, citation-rate delta, retry counts, and a `comparable?` flag that excludes datasets where either job failed indexing or had invalid responses. |
| SQLite run database | Not started | All state still lives in JSON (`job.json`, per-step `step-status.json`). |
| WorkIQ durable token cache (this repo) | Partial | `src/auth-preflight.ts` seeds Work IQ MCP tokens and EvalScore A2A device-code tokens before a run, and `scripts\setup-a2a.ps1` persists a delegated `WorkIQAgent.Ask` token + refresh token to disk. A workflow-owned cache outside individual job folders is not yet a first-class feature. |
| EvaluationCLI native changes | Deferred | Workflow wraps current EvalGen first; EvaluationCLI changes only if target-count/dedup wrapping proves brittle. |

### Implementation order

The order below is dependency-safe: nothing is deleted before its successor exists, and gates are added *before* the Step 6 driver that depends on them.

1. **Plumb the new shape into types and CLI.** Add `JobConfig.noEnhance: boolean`, `JobConfig.reuseEvalFromJobId?: string`, `JobConfig.evalSetPath?: string`, `JobConfig.judgeProvider: 'github-copilot' | 'workiq'`, `JobConfig.judgeAgentId?: string`. Wire matching flags into `src/cli.ts` and the GUI in `public/`. No behavior change yet — the flags are accepted and ignored.
2. **Implement the canonical hash helpers** (`datasetHash`, `evalSetHash`) and start recording them in `job.json`. Backfill existing jobs lazily on read so the post-hoc comparator can later operate on them.
3. **Step 2 identity branch (`--no-enhance`).** Implement the type inference rules, the Graph-safe name sanitization with `sourceFieldMappings`, the deterministic nested-JSON handling, and the title/url/iconUrl provenance flags. Add unit tests for: leading-zero identifiers, >53-bit integers, nested JSON, sparse rows, colliding sanitized names, and a missing-title-column fallback. **Do not** delete `src/raw-connector.ts` yet — it is still imported by `src/compare-executor.ts`.
4. **Eval-set reuse.** Implement `--reuse-eval-from <jobId>` and `--eval-set <path>` in Step 1. Step 1 copies the source eval set verbatim (including `eval.csv`, `eval.evalgen.json`, `eval-review.md`, and any canary file) and recomputes the eval-set hash to confirm it matches the source job. Add tests that pair two `ccw run` jobs and assert identical `evalSetHash`.
5. **Expand Step 5 to the tenant-side lifecycle.** Add the provision/ingest/publish/discover substeps under `05-deploy/`, with idempotent `--reuse-existing` semantics and persisted `resources.json` per job. Keep `mode=build` as artifact-only with an explicit `requires-provision-mode` diagnostic so downstream Step 6 has a clean signal to skip.
6. **Step 6 driver.** Add the indexing-readiness canary gate, judge preflight, `eval-score` invocation with `--judge-provider github-copilot` default and `--judge-provider workiq --judge-agent-id <id>` alternative, the invalid-row gating + normalization wrapper, and the deterministic-scorer fold-in. Emit the canonical `06-score/agent-response-scores.json` with `judgeProvider`, `judgeModel`, `datasetHash`, `evalSetHash`, and `metadataProvenance` populated. Gates and preflight ship together with the driver — no half-step where the driver exists without invalid-row protection.
7. **Remove `@microsoft/m365-copilot-eval`.** Delete `src/steps/step6-m365eval.ts`, the `runM365Eval` / `m365Eval` config surface, the `--run-m365-eval` / `--m365-*` CLI flags, the GUI fields, the M365 EvalGen converter path in `src/tools.ts`, the EULA-accept hop in `src/auth-preflight.ts`, the `M365_EVAL_MIN_NODE` constant, and all related prose. The new Step 6 from task 6 is now the only Step 6.
8. **Post-hoc comparator.** Implement `ccw compare --job <a> --job <b>` reading `06-score/agent-response-scores.json` from each job, applying the pre-conditions (modes, dataset hash, eval-set hash, `noEnhance` complement), and emitting `comparison-report.{md,json}` + `score-matrix.csv`. Soft-degrade to deterministic-only output when `judgeProvider` differs (do not hard-refuse).
9. **Delete the obsolete compare path in one change.** Remove `src/compare.ts`, `src/compare-executor.ts`, `src/raw-connector.ts`, the `compare-runs/` workspace conventions, and the old `compare-dataset` / `compare-batch` CLI handlers. This must follow task 8 because tasks 3-8 depend on `src/raw-connector.ts` continuing to exist while the new code paths are being built. Add `ccw compare-batch --pairs <pairs.json>` in its post-hoc-only form alongside this deletion.
10. **EvalGen multi-batch loop.** Add the `--avoid-evalsets` / target-count / near-duplicate loop inside `src/evalset-builder.ts` for datasets where the deterministic builder cannot reach the prompt target.
11. **Connector lifecycle tooling.** Implement `--replace`, `--fail-on-conflict`, and `ccw deprovision --batch <batchId>` against the `resources.json` manifests written in task 5. Required before the full 25-dataset run; not strictly required to ship the pilot.
12. **SQLite run-state layer.** Migrate jobs, items, responses, scores, comparisons, and events to SQLite while preserving the JSON artifacts as the source-of-truth on disk. Largely a query-performance / resume-logic improvement; not a behavioral change.
13. **Calibration set.** Add the `ccw calibrate --job <id>` driver that re-runs Step 6 against an existing job's response set with both providers and writes `calibration/<jobId>.json`. Required before any published cross-provider claim.
14. **Aggregate report and pilot.** Build the aggregate / comparison report and run the 2-3 dataset pilot, including the variance-control double-run for at least one pilot dataset, before kicking off the 25-dataset batch.
