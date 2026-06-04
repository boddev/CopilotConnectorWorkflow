# Copilot Connector Workflow

An end-to-end orchestrator that turns a tabular or document dataset into a deployable Microsoft 365 Copilot Connector — and (optionally) scores Copilot's answer quality against that dataset using an LLM judge.

Each run is a self-contained "job" under `workspace/jobs/<jobId>/`. Steps are individually re-runnable with content-hash-based cache invalidation. Use the GUI for interactive monitoring or the CLI for headless, scriptable runs.

```
                                  ┌─────────────────────────┐
dataset ─► eval set ─► enhanced ─►│ hardened    + connector │─► Azure deploy   ─► (optional) M365 Copilot
            (EvalGen)  records    │ schema        project   │   artifacts          eval scoring
                       (enhancer  │                         │  (Functions /        (eval-score)
                       or identity)└─────────────────────────┘   Container Apps)
                                       this repo                this repo            this repo (Step 6)
```

---

## Table of contents

- [What it does (the six steps)](#what-it-does-the-six-steps)
- [Prerequisites](#prerequisites)
- [Install & build](#install--build)
- [CLI examples](#cli-examples)
  - [Build only (no tenant)](#build-only-no-tenant)
  - [Build with URL unfurling](#build-with-url-unfurling)
  - [Authentication preflight](#authentication-preflight)
  - [Provision-mode (full deploy + scoring)](#provision-mode-full-deploy--scoring)
  - [Resume / re-run](#resume--re-run)
  - [Comparing two jobs (enhancer vs identity transform)](#comparing-two-jobs-enhancer-vs-identity-transform)
  - [Overriding the pipeline auto-detector](#overriding-the-pipeline-auto-detector)
- [Quick start — GUI](#quick-start--gui)
- [Reference](#reference)
  - [What's in the box](#whats-in-the-box)
  - [Pipeline auto-detector](#pipeline-auto-detector)
  - [Build vs provision mode](#build-vs-provision-mode)
  - [Step 6 — score (`eval-score` driver)](#step-6--score-eval-score-driver)
  - [Schema validation (Step 3)](#schema-validation-step-3)
  - [Agents Toolkit project (Step 4 output)](#agents-toolkit-project-step-4-output)
  - [Batch enhancer integration](#batch-enhancer-integration)
  - [Comparison workflow](#comparison-workflow)
  - [Authentication and data flow](#authentication-and-data-flow)
  - [Scaling to other datasets](#scaling-to-other-datasets)
  - [Security defaults](#security-defaults)
  - [Troubleshooting](#troubleshooting)
  - [Files of interest](#files-of-interest)

---

## What it does (the six steps)

Given a dataset folder (CSV, TSV, JSON, or JSONL — the bundled enhancer also accepts `txt`, `md`, `html` files when run directly), the orchestrator runs six steps in order. Steps 1–5 produce a fully deployable connector project + Azure artifacts; Step 6 is optional and runs only in `provision` mode against a real tenant.

| # | Step | What happens | Outputs (under `workspace/jobs/<jobId>/`) |
|---|---|---|---|
| 1 | **evalgen** | Generates an evaluation set from the dataset via `..\EvaluationCLI\eval-gen`. | `01-evalgen/eval.csv`, `eval.evalgen.json`, `eval-review.md` |
| 2 | **enhance** | Runs either the data enhancer or the identity-transform (auto-picked by dataset shape — see [Pipeline auto-detector](#pipeline-auto-detector)). | `02-enhance/enhanced-items.jsonl`, `schema-suggestion.json` (+ enhancer reports) |
| 3 | **schema** | Hardens `schema-suggestion.json` into a Microsoft Graph connector schema; validates a 200-item sample. | `03-schema/connector-schema.json`, `schema.ts`, `schema-validation.json` |
| 4 | **connector** | Renders a complete Microsoft 365 Agents Toolkit project (Azure Functions + declarative agent + bundled batch enhancer), runs `npm install` + `tsc`. | `04-connector/connector/` |
| 5 | **deploy** | In `build` mode renders Azure Functions / Container Apps deploy artifacts. In `provision` mode also runs the full Step 5 lifecycle: create connection, register schema + poll, ingest items + verify, publish app package, discover agent id. | `04-connector/connector/deploy/…`, `05-deploy/resources.json` |
| 6 | **score** *(provision only)* | Runs `..\EvaluationCLI\eval-score` against the published M365 declarative agent with the GitHub Copilot CLI as the default LLM judge. | `06-score/agent-response-scores.{json,md}` |

Every step also writes `step-status.json` (machine-readable) and `step.log` next to its outputs.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | Steps 1–5 run on Node 18+. `setup\setup.ps1` will additionally provision Node 22.21.1+ for Step 6's `eval-score` runtime when needed. |
| **PowerShell** | Built-in on Windows. Used by `scripts\setup-a2a.ps1` and the Azure deploy scripts. |
| **`..\EvaluationCLI`** | `eval-gen` built (`npm install && npm run build`) and `eval-score` built (`cd eval-score\node && npm install && npm run build`). |
| **Entra ID app** *(provision mode only)* | Application permissions `ExternalConnection.ReadWrite.OwnedBy` + `ExternalItem.ReadWrite.OwnedBy`, admin consent granted. |
| **Work IQ A2A delegated auth** *(Step 6, every judge)* | `eval-score` collects candidate responses over Work IQ A2A regardless of judge choice. Run `scripts\setup-a2a.ps1` once to mint the `WorkIQAgent.Ask` delegated token. |
| **GitHub Copilot CLI** *(Step 6, default judge)* | `copilot` on `PATH`, signed in. Skip if using `--judge-provider workiq`. |
| **M365 candidate agent** *(Step 6 only)* | A declarative agent that references your new connector as a `GraphConnectors` knowledge source. Step 5 publishes one automatically when `atk` is on `PATH`. |

Verify in one go after building:

```cmd
node dist\cli.js tools
```

You'll see one row per dependency with `✓` / `✗` and a fix hint where applicable.

---

## Install & build

### Easy path — one-command installer

```cmd
cd C:\Users\bodonnell\src\CopilotConnectorWorkflow
setup\setup.cmd
```

`setup\setup.cmd` installs every prerequisite, clones the three sibling repos, builds them, and walks you through Microsoft 365 and Azure sign-in as **two separate steps** (so you can use one tenant for Copilot and a different one for Azure deployment). Optional configuration: copy `setup\.env.example` to `setup\.env` and set `M365_TENANT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, or override repo URLs.

Available switches: `-EnvFile <path>`, `-SkipInstall`, `-SkipClone`, `-SkipBuild`, `-SkipM365Login`, `-SkipAzureLogin`. The script is idempotent.

### Manual path

```cmd
cd C:\Users\bodonnell\src\CopilotConnectorWorkflow
npm install
npm run build
```

This builds the orchestrator only — you still need `..\EvaluationCLI` checked out and `eval-gen` built. Python is not required for the core six-step pipeline; the only Python use is in `scripts\jsonl-to-csv.py` which the batch driver (`run-all-datasets.ps1`) uses to stage the HLS sample datasets shipped under `data\hls-*`.

---

## CLI examples

All `ccw` invocations below use the `scripts\run-cli.cmd` wrapper, which is equivalent to `node dist\cli.js`.

### Build only (no tenant)

Produces a fully buildable connector project and Azure deploy artifacts without contacting your tenant. Good for first runs and for CI smoke tests.

```cmd
scripts\run-cli.cmd run ^
  --dataset "data\ngo-environment" ^
  --description "Environmental datasets — OWID CO2/GHG metrics and World Bank climate indicators by country/region and year." ^
  --count 10 ^
  --extensions csv ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --deploy-target both ^
  --mode build
```

### Build with URL unfurling

Add `--url-prefix` so links to your source items show inline previews in Teams/Copilot.

```cmd
scripts\run-cli.cmd run ^
  --dataset "data\ngo-environment" ^
  --description "..." ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --url-prefix "https://environment.example.com" ^
  --mode build
```

This wires `--url-prefix` through to the data enhancer (so generated item URLs use the prefix) and activates `urlToItemResolver` in the generated `src/models/connection.ts`.

### Authentication preflight

Run this once before any long provision-mode workflow so credentials fail fast.

```cmd
:: cmd.exe
set CCW_SECRET=<client-secret>
scripts\run-cli.cmd auth ^
  --tenant-id <tenantGuid> ^
  --client-id <appId> ^
  --client-secret-env CCW_SECRET
```

```powershell
# PowerShell
$Env:CCW_SECRET = "<client-secret>"
scripts\run-cli.cmd auth `
  --tenant-id <tenantGuid> `
  --client-id <appId> `
  --client-secret-env CCW_SECRET
```

The Graph check exchanges the client secret for a token, verifies the required Graph connector app roles are present, and probes `/external/connections`. The Work IQ check starts `workiq mcp` to seed delegated auth before the workflow.

### Provision-mode (full deploy + scoring)

Add `--auth-preflight` and the provision-mode flags to do everything — render the project, deploy artifacts, provision the connection, ingest items, publish the agent, and score against M365 Copilot.

```cmd
scripts\run-cli.cmd run ^
  --dataset "data\ngo-environment" ^
  --description "..." ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --mode provision ^
  --tenant-id <tenantGuid> ^
  --client-id <appId> ^
  --client-secret-env CCW_SECRET ^
  --judge-provider github-copilot ^
  --candidate-agent-id <T_*.declarativeAgent> ^
  --auth-preflight
```

Provision mode renders tenant/app settings into the generated connector and triggers the full Step 5 tenant-side lifecycle (external connection, schema register + poll, item ingest + verify, app package install/publish, agent id discovery) followed by Step 6 scoring with `eval-score`.

### Resume / re-run

```cmd
scripts\run-cli.cmd resume --job <id>                          # skip steps with cache hits
scripts\run-cli.cmd resume --job <id> --force                  # force every step
scripts\run-cli.cmd resume --job <id> --force-step schema,connector
scripts\run-cli.cmd resume --job <id> --start-at score --stop-after score
```

### Comparing two jobs (enhancer vs identity transform)

Run the same dataset twice with paired eval sets, then diff.

```cmd
:: First job — enhancer (default for mixed-shape sources)
scripts\run-cli.cmd run --dataset <path> --description "..." ^
  --connector-id ccwenh --connector-name "CCW Enhanced" ^
  --mode provision --tenant-id <t> --client-id <c> --client-secret-env CCW_SECRET ^
  --force-enhance --candidate-agent-id <enhAgent>
:: ... captures jobId-A

:: Second job — identity transform, paired by --reuse-eval-from
scripts\run-cli.cmd run --dataset <path> --no-enhance --description "..." ^
  --connector-id ccwraw --connector-name "CCW Raw" ^
  --mode provision --tenant-id <t> --client-id <c> --client-secret-env CCW_SECRET ^
  --reuse-eval-from <jobId-A> --candidate-agent-id <rawAgent>
:: ... captures jobId-B

:: Diff
scripts\run-cli.cmd compare --job <jobId-A> --job <jobId-B> --output reports\enh-vs-raw
```

The comparator reads each job's `06-score/agent-response-scores.json`, validates pre-conditions (same `datasetHash`, same `evalSetHash`, exactly one job has `noEnhance=true`), and emits `comparison-report.{md,json}` plus `score-matrix.csv`.

### Overriding the pipeline auto-detector

`ccw run` auto-picks between the enhancer and the identity transform based on dataset shape (see [Pipeline auto-detector](#pipeline-auto-detector) for the rules). Override with:

```cmd
scripts\run-cli.cmd run --dataset <path> --force-enhance ...           # always enhancer
scripts\run-cli.cmd run --dataset <path> --no-enhance ...              # always identity transform
scripts\run-cli.cmd run --dataset <path> --no-auto-detect-pipeline ... # historical default (enhancer)
```

---

## Quick start — GUI

```cmd
scripts\start.cmd
```

Opens a local server at <http://127.0.0.1:4321/>. The form covers the common `ccw run` options:

| Section | Maps to |
|---|---|
| Dataset & connector identity | `--dataset`, `--description`, `--count`, `--extensions`, `--connector-id`, `--connector-name`, `--connector-description`, `--deploy-target`, `--mode`, `--acl-mode` |
| Step 2 — enhancement | `--no-enhance` (checkbox) |
| Step 1 — eval set source | `--reuse-eval-from <jobId>` or `--eval-set <path>` |
| Authentication (provision mode) | `--tenant-id`, `--client-id`, `--client-secret-env`, `--use-managed-identity`; plus a "Validate auth" button (`POST /api/auth-preflight`) |
| Step 6 — score (provision mode) | `--judge-provider github-copilot|workiq`, `--judge-agent-id <id>`, `--candidate-agent-id <id>` |
| Declarative agent + URLs | `--agent-name`, `--agent-instructions`, `--url-prefix` |
| Run controls (advanced) | `--start-at`, `--stop-after`, `--force-step`, `--force`, `--auth-preflight`, `--skip-workiq-auth` |

> **CLI-only flags** (not exposed by the GUI form): `--force-enhance`, `--no-auto-detect-pipeline`, `--skip-agent-publish`, `--evaluators`, `--index-ready-min-minutes`, `--agent-instructions-file`. Use the CLI directly for those.

`build` jobs stop after Step 5 artifact emission and are **not comparable**. `provision` jobs run the full lifecycle + Step 6. The job list decorates each row with the connector id, `[no-enhance]` / `[judge:*]` badges, and `[legacy]` for jobs created before the `m365eval`→`score` rename.

Click **Run pipeline**. The job appears in the middle column; the right pane streams per-step status and live logs over SSE, with download links to every artifact as it's produced. The detail pane's **Resume / re-run** button accepts the same Run controls.

To compare two completed jobs from the GUI, scroll to the **Compare two jobs** panel at the bottom:

1. Run an enhanced job to completion (`--force-enhance` if you want to override the auto-detector).
2. Run a paired non-enhanced job against the same dataset with `--no-enhance --reuse-eval-from <firstJobId>` so they share the same eval set.
3. Pick the first job in the **Job A** dropdown. The **Job B** dropdown auto-cascades to compatible candidates (matching `datasetHash` + `evalSetHash`, opposite `noEnhance`); ineligible jobs are disabled with a reason in the tooltip.
4. Click **Run compare** to produce a side-by-side report at `workspace/compare-runs/<datasetHash>-<evalSetHash>/<timestamp>.md`.

---

## Reference

### What's in the box

| | |
|---|---|
| Steps | 6 (1–5 required, 6 optional and provision-only) |
| Generated connector | **Microsoft 365 Agents Toolkit** project — Azure Functions (TypeScript) + declarative agent in `appPackage/` |
| Declarative agent | Auto-generated for every connector; references the connector by `connectionId` as a `GraphConnectors` knowledge source |
| Enhancer integration | `src/custom/enhancer.ts` embedded in generated project; fail-closed: raw data is **never** ingested if enhancement fails |
| Deploy artifact targets | Azure Functions, Azure Container Apps, or both |
| Scoring tool (Step 6) | `..\EvaluationCLI\eval-score` (default judge: GitHub Copilot CLI; alternative: Work IQ + `agents/eval-judge`) |
| Pipeline auto-detector | Picks between enhancer and identity transform based on dataset shape (see below) |
| Schema validator | Hardens `schema-suggestion.json` → Graph-Connectors schema with payload sample checks |
| Re-runnability | SHA-256 fingerprint per step input; per-job + per-step force flags |
| UI | Local SPA on `127.0.0.1` + SSE live log stream |

### Pipeline auto-detector

`ccw run` auto-picks between two Step 2 pipelines based on the **shape of the source data**. The detector samples up to 1000 records (100 per file) and chooses:

| Detected shape | Pipeline | Rationale |
|---|---|---|
| Mixed-schema (multiple file shapes per dataset) | enhancer | Schema unification gives the LLM one consistent search surface. |
| Single-schema + text-rich (e.g. JSONL with prose `title`/`summary` fields) | identity transform | Preserves verbatim entity names — LLM grounds better on exact tokens than on a paraphrased narrative. |
| Single-schema + numeric/short (e.g. pure tabular OWID) | enhancer (conservative default) | Either pipeline scores about the same; the enhancer is the historical default. |
| Borderline / inconclusive | enhancer (`tie` verdict) | Detector returns `tie` and `applyPipelineDetection` only flips to identity on an explicit `identity` recommendation, so ambiguous datasets enhance. |

The decision is logged to the console at job creation and persisted to `workspace/jobs/<jobId>/00-shape-detect/shape-detect.json` and `job.json` under `config.pipelineDetection.reason`.

| Override flag | Effect |
|---|---|
| `--force-enhance` | Always run the enhancer (suppress detector). |
| `--no-enhance` | Always run the identity transform (suppress detector). |
| `--no-auto-detect-pipeline` | Disable the detector; fall back to the historical "always run the enhancer" default. Use for deterministic CI. |

Evidence behind the detector lives in `workspace/compare-runs/cross-dataset-analysis-rerun.md` (two-run paired study across ngo-energy, ngo-agriculture, and hls-clinicaltrials-50k).

### Build vs provision mode

| Mode | Tenant credentials | Generated project | Graph writes | Step 6 scoring |
|---|---|---|---|---|
| `build` (default) | not required | yes, with blank tenant/app placeholders | no | no |
| `provision` | required | yes, with tenant/app settings rendered | Step 5 runs the full lifecycle: provision, schema register + poll, ingest + verify, app package install, agent id discovery | Step 6 runs `eval-score` (GitHub Copilot judge default) and emits the canonical report |

Build mode still produces a fully buildable connector project and complete Azure deploy artifacts. You can deploy it later by running `deploy/azure-functions/deploy.ps1` or `deploy/azure-container-apps/deploy.ps1`.

### Step 6 — `score` (`eval-score` driver)

After the connector has been provisioned, items ingested, and the M365 search index has caught up, Step 6 scores your eval set against M365 Copilot using `..\EvaluationCLI\eval-score`. Every `provision`-mode run produces one canonical scored report at `06-score/agent-response-scores.json` containing both deterministic grounding scores and semantic judge scores. `@microsoft/m365-copilot-eval` is **not** used.

#### Judge providers

| Mode | Flag | When to use | Requirements |
|---|---|---|---|
| **Default** | `--judge-provider github-copilot` | Interactive/supervised runs. Runs locally through the `copilot` CLI; no Work IQ rate limit on top of response collection. | `copilot` CLI on PATH and signed in. |
| **Alternative** | `--judge-provider workiq --judge-agent-id <id>` | Long unattended runs, CI, when GitHub Copilot CLI is unavailable, or for calibration. | The `agents/eval-judge` declarative agent published in the tenant. |

#### Flow

1. **Judge preflight.** Short probe to verify the chosen judge surface is reachable. Fail-closed if it isn't.
2. **Index-settle window.** Sleep until at least `score.indexReadySettleMinutes` (default **60 min**, override with `--index-ready-min-minutes`, `0` to disable) have elapsed since Step 5's `ingestEndedAt`. This is usually the longest phase on first provision runs — the log shows a single `slept Nm to reach 60m settle window` line rather than per-prompt activity.
3. **Indexing-readiness gate.** Query the candidate agent with canary prompts from Step 1 until results return; persist `indexReadyAt`.
4. **Response collection + judging.** `eval-score` calls the candidate agent over Work IQ A2A and routes each response through the selected judge.
5. **Invalid-row gate.** Rows with blank answers, `[ERROR:]`, rate-limit text, fallback-provider judge results, or malformed judge JSON are recorded as invalid in `diagnostics`. Step 6 fails only if invalid rows exceed **50%** of the eval set (`INVALID_ROW_FRACTION_MAX = 0.5` in `step6-score.ts`); otherwise the canonical report is still emitted with the invalid count surfaced.
6. **Deterministic grounding score** (80% assertion + 20% supporting-fact coverage) is folded into the same canonical report.

#### Step 6 fail-fast guards

| Condition | Result |
|---|---|
| `mode != provision` | Skipped with `requires-provision-mode` diagnostic; build-mode jobs are not comparable. |
| `judgeProvider=workiq` but no `--judge-agent-id` | Failed with explicit error. |
| `--judge-provider github-copilot` but `copilot` CLI not reachable | Failed with remediation hint to install/sign in or switch to `--judge-provider workiq`. |
| No candidate agent id resolvable | Failed — supply `--candidate-agent-id` or have Step 5 discover it. |
| Eval set missing | Failed — Step 1 must have produced `eval.csv` + `eval.evalgen.json`. |
| Invalid response rows exceed 50% of the eval set | Failed — the canonical report is not written; the diagnostic message includes the invalid count and a list of reasons. |

### Schema validation (Step 3)

| Rule | Severity |
|---|---|
| Property names match `^[A-Za-z][A-Za-z0-9]{0,31}$` (no underscores; snake_case / kebab-case names are auto-sanitized to camelCase upstream) | error |
| `searchable` + `refinable` mutually exclusive | error |
| Properties with semantic labels must be `retrievable` | error |
| ≤128 properties total | error |
| One property per semantic label | error |
| `title` and `url` labels both present | error (synthetic `title` / `url` properties are auto-injected if missing) |
| `iconUrl` label present | warning (auto-promoted if a property named `iconUrl` / `icon_url` exists) |
| Reserved `content` property name not declared | error |
| Item sample (200 lines from `enhanced-items.jsonl`) — valid JSON, ID present, URL-safe, ≤4 MB, types parseable (`DateTime` values pass `Date.parse`) | error for hard failures / warning for type-mismatch |

All findings are written to `03-schema/schema-validation.json` with `blockingCount`. Any blocking issue fails Step 3.

### Agents Toolkit project (Step 4 output)

Step 4 generates a complete Microsoft 365 Agents Toolkit project under `workspace/jobs/<jobId>/04-connector/connector/`:

```
connector/
├── teamsapp.yml               # Agents Toolkit lifecycle (provision → deploy)
├── teamsapp.local.yml         # F5 local debug lifecycle
├── appPackage/
│   ├── manifest.json          # M365 app manifest
│   ├── declarativeAgent.json  # Declarative agent (uses connector as knowledge source)
│   └── instruction.txt        # Agent instructions (auto-generated, editable)
├── src/
│   ├── models/connection.ts   # Connection ID, name, description, urlToItemResolver stub
│   ├── references/schema.ts   # Generated schema (from Step 3)
│   ├── custom/
│   │   ├── enhancer.ts        # Fail-closed runtime enhancer (schema-driven)
│   │   ├── batchEnhancer.ts   # TypeScript batch enhancer (from CopilotConnectorSkill)
│   │   └── dataSource.ts      # Data source adapter (JSONL seed + live extension point)
│   ├── functions/crawl.ts     # Azure Functions crawl trigger (fail-closed)
│   ├── scripts/
│   │   ├── provision.ts       # Create connection, register schema, poll completion
│   │   ├── ingest.ts          # Ingest pre-enhanced items to Graph
│   │   ├── deprovision.ts     # Delete connection and all items
│   │   └── refresh-data.ts    # Re-run batch enhancement against a new dataset
│   └── services/graphService.ts
└── data/enhanced-items.jsonl  # Seed data from Step 2
```

Open this folder in VS Code, press **F5** to provision and start ingesting locally. Use `--agent-name` and `--agent-instructions` (or `--agent-instructions-file`) to customize the declarative agent.

### Batch enhancer integration

The TypeScript batch enhancer (`batchEnhancer.ts`) is **bundled directly into the generated connector project** (no external dependency). This means you can re-enhance data from within the connector project without referencing the original skill:

```bash
# Re-run batch enhancement when the dataset is updated
cd workspace/jobs/<jobId>/04-connector/connector
npm run build
npm run enhance -- --dataset <path-to-new-dataset>

# Then re-ingest the enhanced items
npm run ingest
```

The `npm run enhance` script (`src/scripts/refresh-data.ts`) calls `batchEnhancer.ts`'s `run()` function directly, writing updated `data/enhanced-items.jsonl` and `data/schema-suggestion.json`. If enhancement fails, the script exits non-zero and ingestion must not be run — this preserves the fail-closed invariant.

Two enhancer roles in the generated project:

| File | Role | When runs |
|------|------|-----------|
| `src/custom/batchEnhancer.ts` | Batch off-line enhancement of a dataset | `npm run enhance` / Step 2 re-runs |
| `src/custom/enhancer.ts` | Per-item runtime transformation during live crawls | Every item in `crawl.ts` and `ingest.ts` |

### Comparison workflow

The comparison surface is a **post-hoc** tool: run the pipeline twice against the same dataset (once with `--force-enhance`, once with `--no-enhance --reuse-eval-from <firstJobId>`) and then diff the two completed jobs with `ccw compare`. The comparator never renders, builds, provisions, ingests, or calls Copilot — it only reads each job's `06-score/agent-response-scores.json`. The retired `compare-dataset` / `compare-batch` commands now print a migration hint and exit non-zero.

See the CLI example in [Comparing two jobs](#comparing-two-jobs-enhancer-vs-identity-transform).

#### Where response collection and semantic judging fit

Step 6's `eval-score` driver always uses Work IQ A2A to collect candidate responses (because the candidate is an M365 declarative agent). The judge surface is configurable:

| Artifact | Purpose |
|---|---|
| [`agents\eval-judge\`](agents/eval-judge/README.md) | Pre-built Microsoft 365 Copilot **declarative judge agent** package. Required for `--judge-provider workiq`. |
| `scripts\setup-a2a.ps1` | One-shot setup: provisions the Work IQ first-party SP, acquires a `WorkIQAgent.Ask` delegated token via device code, discovers candidate + judge agent ids from `https://workiq.svc.cloud.microsoft/a2a/.agents`, and emits a ready-to-source env-var file for `eval-score`. |
| `scripts\run-all-datasets.ps1` | Batch driver that runs the six-step pipeline (`--mode build`) against a curated, hard-coded list of 23 of the bundled datasets and copies per-job artifacts into `output\<dataset-name>\`. Use `-Only` / `-Skip` to narrow the list. |

#### Bundled datasets

`data\` ships 25 sample datasets (1 D&B, 8 HLS, 16 NGO). Pointing `--dataset` at any of these folders is the fastest path to a working end-to-end build. Note that `scripts\run-all-datasets.ps1` processes a curated subset (23) of these, not the full list — use `-Only` / `-Skip` to pick a different subset.

#### Comparator behavior notes

- The comparator pairs jobs by matching `datasetHash` + `evalSetHash` and opposite `noEnhance`.
- When `judgeProvider` differs between the two jobs, the comparator omits the semantic delta but still reports deterministic and operational metrics — so a `github-copilot`-judged job and a `workiq`-judged job can still be compared on grounding.

### Authentication and data flow

Most of the workflow runs locally and does not touch your tenant. Data is sent to Microsoft 365 only when the generated connector's provisioning, ingestion, crawl, or optional evaluation tools run.

| Part | What runs | Microsoft tenant auth | Communication / data sent |
|---|---|---|---|
| Setup | `setup\setup.ps1` | Optional interactive `Connect-MgGraph -Scopes User.Read` for the M365 tenant and separate `az login` for the Azure deployment tenant. These tenants can differ. | Authentication only; no connector data is ingested. |
| Local UI / CLI | `src\server.ts`, `src\cli.ts`, `src\orchestrator.ts` | None in `build` mode. `provision` mode collects `tenantId`, `clientId`, and either a client-secret env-var name or a managed-identity flag. | Local server binds to `127.0.0.1:4321`; jobs and logs are written under `workspace\jobs\<jobId>\`. |
| Step 1: EvalGen | `node ..\EvaluationCLI\eval-gen\dist\index.js` | Not handled by this repo. If EvalGen uses an LLM or M365 provider, that authentication happens inside `EvaluationCLI`. | Receives the local dataset path, description, count, and extensions; writes `eval.csv`, `eval.evalgen.json`, and `eval-review.md` locally. |
| Step 2: Enhancer / identity transform | `node dist\enhancer\enhance_for_copilot.js` or `src\identity-transform.ts` | None. | Reads the local dataset and Step 1 sidecar; writes `enhanced-items.jsonl`, `schema-suggestion.json`, and reports locally. |
| Step 3: Schema hardening | In-process TypeScript in `src\steps\step3-schema.ts` | None. | Local only; converts the enhancer suggestion into Graph connector schema artifacts and validates sample items. |
| Step 4: Connector generation | Template rendering, then `npm install` and `npm run build` in the generated connector project | None for Microsoft Graph. `npm install` contacts the npm registry. | Copies schema and enhanced data into `workspace\jobs\<jobId>\04-connector\connector\`; downloads npm packages. |
| Step 5: Deploy artifacts | `src\steps\step5-deploy.ts` renders PowerShell, Bicep, Docker, and deploy README files | None while rendering. | Local only; writes `deploy\azure-functions\` and/or `deploy\azure-container-apps\` artifacts under the generated connector project. |
| Generated connector: provision | `npm run provision` → `src\scripts\provision.ts` | App-only Graph auth via `ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET)` or `ManagedIdentityCredential`. | Calls Microsoft Graph `GET/POST /external/connections`, `PATCH /external/connections/{id}/schema`, polls schema status. Sends connector ID, name, description, optional URL resolver, and schema. |
| Generated connector: ingest | `npm run ingest` → `src\scripts\ingest.ts` | Same app-only Graph auth as provision. | Reads `data\enhanced-items.jsonl`; sends each item to Graph with `PUT /external/connections/{id}/items/{itemId}` including ACL, properties, and content. |
| Generated connector: crawl runtime | Azure Functions timer/HTTP trigger in `src\functions\crawl.ts` | Same app-only Graph auth from app settings or managed identity. | Reads the seed/live source through `dataSource.ts`, enhances raw items fail-closed, then upserts enhanced items to Graph. The manual HTTP trigger uses Azure Functions `function` auth. |
| Generated declarative agent | `appPackage\declarativeAgent.json` and Teams app package | Published from Step 5 via the Microsoft 365 Agents Toolkit CLI (`atk install --file-path appPackage.zip`) when `atk` is on `PATH`; otherwise out-of-band via Agents Toolkit UI or `teamsapp publish`. | The agent references the connector by `connection_id`; Copilot uses the Microsoft Graph connector index after ingestion. Step 5 parses the `TitleId` from atk output and persists `agentId = "<TitleId>.declarativeAgent"` to `05-deploy/resources.json`. Use `--skip-agent-publish` to opt out. |
| Azure Functions deploy script | `deploy\azure-functions\deploy.ps1` | Azure CLI session from `az login`; deployed runtime uses app settings or managed identity for Graph. | Creates Azure resource group, storage, and Function App; sets `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `USE_MANAGED_IDENTITY`; publishes code. |
| Container Apps deploy script | `deploy\azure-container-apps\deploy.ps1` | Azure CLI and ACR auth from `az login`; deployed runtime uses container env/secrets or managed identity for Graph. | Builds and pushes a Docker image, deploys Container App/Bicep, and stores `CLIENT_SECRET` as a container secret unless managed identity is used. |
| Step 6: score | `eval-score` over Work IQ A2A | Delegated `WorkIQAgent.Ask` token for response collection; GitHub Copilot CLI session for the default judge, or the same delegated token + `agents\eval-judge\` agent for the workiq judge. | Sends prompts to the candidate M365 declarative agent, captures answers, judges them, and writes `06-score/agent-response-scores.{json,md}` locally. |

Primary data path: local dataset → EvalGen eval set → local Step 2 output → generated connector project → Microsoft Graph external connection/items. Until the generated connector's provisioning, ingestion, crawl, or eval commands run, the dataset-derived artifacts remain local.

> **Build vs provision recap:** In `build` mode the `deploy` step only *renders* deployment artifacts (PowerShell, Bicep, Docker, deploy READMEs) — no Azure infrastructure is touched. In `provision` mode the same step additionally executes the generated `npm run provision`, `npm run ingest` (twice, with retry), and `atk install` against your tenant — this is what creates the Graph connection, registers the schema, ingests items, and publishes the declarative agent.

### Scaling to other datasets

Each run = a new job folder. State is per-job. To re-run on a different dataset, just call `run` again with a different `--dataset` and `--connector-id`. Existing jobs are untouched. Use `node dist\cli.js list` to enumerate prior jobs and `node dist\cli.js status --job <id>` to inspect a specific one. The bundled `scripts\run-all-datasets.ps1` demonstrates this against a curated subset of the 25 sample datasets under `data\`, copying each per-job output into `output\<dataset-name>\` with a per-run summary at `output\_run-summary.csv`.

### Security defaults

- Server binds to `127.0.0.1` only. On startup the local browser is opened to the URL automatically. Set `CCW_NO_OPEN=1` to disable, or `CCW_PORT=<n>` to change the port.
- Default ACL on generated items is `everyone` — **revise before connecting non-public data** (`--acl-mode everyoneExceptGuests` or `none`).
- The generated connector reads credentials from environment variables. In production:
  - Set `USE_MANAGED_IDENTITY=true` and assign the managed identity the Graph permissions.
  - Move `CLIENT_SECRET` to Key Vault (`@Microsoft.KeyVault(...)` references) — never check it in.
- The generated `crawlHttp` Function trigger uses `authLevel: 'function'`. Treat its function key like a secret.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Auth fails late in EvalGen, EvalScore, or connector provisioning | Run `scripts\run-cli.cmd auth --tenant-id <tenantGuid> --client-id <appId> --client-secret-env <envName>` first, or add `--auth-preflight` to `run`/`resume`. Use `--skip-workiq` only when EvalGen is configured for a non-WorkIQ provider. |
| Graph auth preflight reports missing app roles | Grant admin consent for `ExternalConnection.ReadWrite.OwnedBy` and `ExternalItem.ReadWrite.OwnedBy` on the app registration, then rerun `ccw auth`. |
| `eval-gen` error: `required option '--description'` | Make sure you're on the latest workflow build — eval-gen 1.0+ moved the options to the root command, not a `generate` subcommand. |
| Step 6 says `mode is build` | Add `--mode provision` and provide auth. Step 6 only runs after a real ingestion. |
| Step 6 says `agentId is required` | Pass `--candidate-agent-id <T_*.declarativeAgent>`. The connector ID is *not* the agent ID. |
| Step 6 reports no candidate agent id | Pass `--candidate-agent-id <T_*.declarativeAgent>` or let Step 5 discover it and persist to `05-deploy/resources.json`. |
| Step 6 "stalls" for ~an hour after Step 5 with no canary activity | Expected — the index-settle gate (default 60 min) is waiting since `ingestEndedAt`. Override with `--index-ready-min-minutes 0` for retries on already-indexed connectors. |
| Step 6 emits a report but flags invalid rows | Invalid rows under the 50% threshold are surfaced in `06-score/agent-response-scores.json` `diagnostics`; above 50% the step fails outright. Re-run Step 6 with `--force-step score` if you've fixed the root cause. |
| Schema validation has blocking issues | Open `03-schema/schema-validation.json`. Common culprits: a property using both `searchable` and `refinable` (must pick one), a property name with underscores (snake_case is auto-sanitized upstream but a hand-edited schema may still leak through), or items in `enhanced-items.jsonl` exceeding the 4 MB cap. |
| Step skipped when you wanted a re-run | Add `--force` (all steps) or `--force-step <name>` (specific step). |
| Auto-detector picked the wrong pipeline | Override with `--force-enhance` or `--no-enhance`. See [Pipeline auto-detector](#pipeline-auto-detector). |

### Files of interest

- `src/orchestrator.ts` — step state machine + cache logic
- `src/jobs.ts` — job persistence, content-hash helpers, auto-detector glue
- `src/dataset-shape-detect.ts` — pipeline auto-detector (text-rich + single-schema → identity)
- `src/tools.ts` — tool path resolution (bundled TypeScript enhancer, CopilotConnectorSkill, eval-gen)
- `src/scoring.ts` — deterministic 80/20 grounding scorer folded into Step 6
- `src/server.ts` — local SPA backend (SSE log streaming, REST endpoints)
- `src/steps/step1-evalgen.ts` — EvalGen driver and eval-set reuse logic
- `src/steps/step2-enhance.ts` — enhancer / identity-transform dispatch
- `src/steps/step3-schema.ts` — schema hardening + Graph constraint validation (iconUrl promotion, aliases)
- `src/steps/step4-connector.ts` — connector scaffolding + batch enhancer bundling + compile verification
- `src/steps/step5-deploy.ts` — deploy-artifact rendering + provision-mode tenant lifecycle
- `src/steps/step6-score.ts` — Step 6 `eval-score` driver with index-settle gate, invalid-row gating, deterministic-scorer fold-in
- `src/compare-jobs.ts` — post-hoc `ccw compare` implementation
- `src/identity-transform.ts` — `--no-enhance` Step 2 branch (shape-derived schema, 1:1 items)
- `src/canonical-hash.ts` — canonical dataset + eval-set hashes consumed by Step 1 reuse and `ccw compare`
- `src/enhancer/enhance_for_copilot.ts` — bundled TypeScript batch enhancer (source vendored into generated connector projects as `src/custom/batchEnhancer.ts`)
- `templates/connector-project/src/custom/enhancer.ts` — fail-closed runtime enhancer (static, not templated)
- `templates/connector-project/src/custom/dataSource.ts.hbs` — data source adapter (JSONL seed + incremental sync extension point)
- `templates/connector-project/src/scripts/provision.ts` — provision script with optional `activitySettings.urlToItemResolvers`
- `templates/connector-project/src/models/connection.ts.hbs` — connection config with `urlToItemResolver` commented stub
- `templates/connector-project/package.json.hbs` — package.json template (includes `npm run enhance`)
- `templates/deploy/{azure-functions,azure-container-apps}/` — deploy artifacts
- `agents/eval-judge/` — declarative judge agent package used by `EvaluationCLI/eval-score` over Work IQ A2A
- `scripts/run-all-datasets.ps1` — batch driver over a curated subset of the bundled `data\` folder
- `scripts/setup-a2a.ps1` — one-shot Work IQ A2A setup for `eval-score --m365-agent-id` / `--judge-agent-id`
- `data/` — 25 sample datasets (1 D&B + 8 HLS + 16 NGO)
- `workspace/compare-runs/` — comparator output + cross-dataset analysis reports (the evidence behind the auto-detector)
- `public/` — local SPA (index.html, app.js, style.css) bound to 127.0.0.1
