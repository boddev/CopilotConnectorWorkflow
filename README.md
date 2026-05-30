# Copilot Connector Workflow

End-to-end orchestrator with a GUI and a CLI that turns a tabular dataset into a deployable Microsoft 365 Copilot Connector, *and* — when you provision against a real tenant — scores Copilot's answer quality against the dataset using `..\EvaluationCLI\eval-score` (GitHub Copilot judge by default; Work IQ + the bundled `agents/eval-judge` declarative agent as the supported alternative).

```
                                  ┌─────────────────────────┐
dataset ─► eval set ─► enhanced ─►│ hardened    + connector │─► Azure deploy   ─► (optional) M365 Copilot
            (EvalGen)  records    │ schema        project   │   artifacts          eval scoring
                       (enhancer) │                         │  (Functions /        (eval-score)
                                  └─────────────────────────┘   Container Apps)
                                       this repo                this repo            this repo (Step 6)
```

Each run is a self-contained "job" under `workspace/jobs/<jobId>/`. The pipeline is re-runnable per-dataset, per-step, with **content-hash invalidation** (each step records the hash of its inputs; downstream steps invalidate when an upstream hash changes). Use the GUI to monitor progress, or the CLI for headless and scalability runs.

## What's in the box

| | |
|---|---|
| Steps | 6 (1–5 required, 6 optional and provision-only) |
| Generated connector | **Microsoft 365 Agents Toolkit** project — Azure Functions (TypeScript) + declarative agent in `appPackage/` |
| Declarative agent | Auto-generated for every connector; references the connector by `connectionId` as a `GraphConnectors` knowledge source |
| Enhancer integration | `src/custom/enhancer.ts` embedded in generated project; fail-closed: raw data is **never** ingested if enhancement fails |
| Deploy artifact targets | Azure Functions, Azure Container Apps, or both |
| Scoring tool (Step 6) | `..\EvaluationCLI\eval-score` (default judge: GitHub Copilot CLI; alternative: Work IQ + `agents/eval-judge`) |
| Schema validator | Hardens `schema-suggestion.json` → Graph-Connectors schema with payload sample checks |
| Re-runnability | SHA-256 fingerprint per step input; per-job + per-step force flags |
| UI | Local SPA on `127.0.0.1` + SSE live log stream |

### Pipeline stages

| # | Step | Output |
|---|------|--------|
| 1 | **evalgen** — EvalGen against dataset | `eval.csv`, `eval.evalgen.json`, `eval-review.md` |
| 2 | **enhance** — TypeScript data-enhancer (bundled) | `enhanced-items.jsonl`, `schema-suggestion.json` |
| 3 | **schema** — Harden schema + validate items | `connector-schema.json`, `schema.ts` |
| 4 | **connector** — Render Agents Toolkit project | `teamsapp.yml`, `appPackage/declarativeAgent.json`, `src/custom/enhancer.ts`, … |
| 5 | **deploy** — Render deploy artifacts | Azure Functions / Container Apps config |
| 6 | **score** *(provision only)* | Per-job scored report from `eval-score` with deterministic + semantic scores | `06-score/agent-response-scores.{json,md}` |

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

Open this folder in VS Code, press **F5** to provision and start ingesting locally.

Use `--agent-name` and `--agent-instructions` (or `--agent-instructions-file`) to customize the declarative agent.

### Batch enhancer integration

The TypeScript batch enhancer (`batchEnhancer.ts`) from CopilotConnectorSkill is **bundled directly into the generated connector project** (no external dependency). This means you can re-enhance data from within the connector project without referencing the original skill:

```bash
# Re-run batch enhancement when the dataset is updated
cd workspace/jobs/<jobId>/04-connector/connector
npm run build
npm run enhance -- --dataset <path-to-new-dataset>

# Then re-ingest the enhanced items
npm run ingest
```

The `npm run enhance` script (`src/scripts/refresh-data.ts`) calls `batchEnhancer.ts`'s `run()` function directly, writing updated `data/enhanced-items.jsonl` and `data/schema-suggestion.json`. If enhancement fails, the script exits non-zero and ingestion must not be run — this ensures the fail-closed invariant.

Two enhancer roles in the generated project:

| File | Role | When runs |
|------|------|-----------|
| `src/custom/batchEnhancer.ts` | Batch off-line enhancement of a dataset | `npm run enhance` / Step 2 re-runs |
| `src/custom/enhancer.ts` | Per-item runtime transformation during live crawls | Every item in `crawl.ts` and `ingest.ts` |

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | All six steps run on Node 18+. |
| **PowerShell** | Built-in on Windows. Used by `scripts\setup-a2a.ps1` (Work IQ A2A setup) and the Azure deploy scripts. |
| **`..\EvaluationCLI`** | `eval-gen` built (`npm install && npm run build` in `eval-gen/`) and `eval-score` built (`cd eval-score\node && npm install && npm run build`). |
| **Entra ID app** *(provision mode only)* | Application permissions `ExternalConnection.ReadWrite.OwnedBy` + `ExternalItem.ReadWrite.OwnedBy`, admin consent granted. |
| **M365 agent ID** *(Step 6 only)* | Step 6 scores a Copilot **agent**, not the connector itself. The connector ID is injected into prompt context for grounding. If you don't have one, build a declarative agent that references your new connector as a `GraphConnectors` knowledge source. |

Verify everything in one go after building:

```cmd
node dist\cli.js tools
```

You'll see one row per dependency with `✓` / `✗` and a fix hint where applicable.

## Install & build

### Easy path — one-command installer

The `setup\setup.cmd` script installs every prerequisite, clones the three sibling repos, builds them, and walks you through Microsoft 365 and Azure sign-in **as two separate steps** (so you can use one tenant for Copilot and a different tenant for Azure deployment).

```cmd
cd C:\Users\bodonnell\src\CopilotConnectorWorkflow
setup\setup.cmd
```

Optional configuration: copy `setup\.env.example` to `setup\.env` and set `M365_TENANT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, or override the repo URLs. Any value not in the env file is prompted for at the right time.

Available switches:

| Switch | Purpose |
|---|---|
| `-EnvFile <path>` | Use a different env file |
| `-SkipInstall` | Don't winget-install missing tools, only verify |
| `-SkipClone` | Use existing sibling-repo checkouts |
| `-SkipBuild` | Don't run `npm install` + `npm run build` |
| `-SkipM365Login` | Don't run `Connect-MgGraph` |
| `-SkipAzureLogin` | Don't run `az login` |

The script is idempotent: re-running just fast-forwards existing checkouts and refreshes builds.

### Manual path

```cmd
cd C:\Users\bodonnell\src\CopilotConnectorWorkflow
npm install
npm run build
```

This builds the orchestrator only — you still need the sibling repo `..\EvaluationCLI` checked out and `EvaluationCLI/eval-gen` built before the pipeline can run. **Python is not required for the core six-step pipeline** — the data-enhancer (Step 2) is bundled as TypeScript and compiled with the rest of the workflow. The bundled batch driver `scripts\run-all-datasets.ps1` does shell out to Python for one preprocessing helper (`scripts\jsonl-to-csv.py`) when staging the HLS datasets shipped under `data\hls-*`; if you are only running `ccw run` directly against your own datasets, you can ignore that script.

## Quick start — GUI

```cmd
scripts\start.cmd
```

Opens a local server at <http://127.0.0.1:4321/>. The form mirrors the `ccw run` CLI surface one-for-one:

| Section | Maps to |
|---|---|
| Dataset & connector identity | `--dataset`, `--description`, `--count`, `--extensions`, `--connector-id`, `--connector-name`, `--connector-description`, `--deploy-target`, `--mode`, `--acl-mode` |
| Step 2 — enhancement | `--no-enhance` (checkbox) |
| Step 1 — eval set source | `--reuse-eval-from <jobId>` (dropdown of completed scored jobs + paste-id fallback) or `--eval-set <path>` |
| Authentication (provision mode) | `--tenant-id`, `--client-id`, `--client-secret-env`, `--use-managed-identity`; plus a "Validate auth" button (`POST /api/auth-preflight`) |
| Step 6 — score (provision mode) | `--judge-provider github-copilot|workiq`, `--judge-agent-id <id>` (required when `workiq`), `--candidate-agent-id <id>` |
| Declarative agent + URLs | `--agent-name`, `--agent-instructions`, `--url-prefix` |
| Run controls (advanced `<details>`) | `--start-at`, `--stop-after`, `--force-step`, `--force`, `--auth-preflight`, `--skip-workiq-auth` |

`build` jobs stop after Step 5 artifact emission and are **not comparable**; the form shows an inline hint. `provision` jobs run the full Step 5 tenant-side lifecycle and Step 6 scoring. The job list decorates each row with the connector id, `[no-enhance]` / `[judge:*]` badges, and `[legacy]` for jobs created before the `m365eval`→`score` rename.

Click **Run pipeline**. The job appears in the middle column; the right pane streams per-step status and live logs over SSE, with download links to every artifact as it's produced. The detail pane's **Resume / re-run** button accepts the same Run controls.

### Comparing two jobs from the GUI

After both runs complete (`score = done`), the **Compare two jobs** panel at the bottom of the page does the post-hoc diff. Numbered walkthrough:

1. Fill out and submit the **enhanced** job (do not set `--no-enhance`). Wait until its `score` step is `done`.
2. Refresh the form. In the **Step 1 — eval set source** section, choose **Reuse from a completed job** and pick the first job from the dropdown. Tick the **Step 2 — enhancement** checkbox (`Skip enhancement`). Submit. Wait until the second job's `score` step is `done`.
3. Scroll to the **Compare two jobs** panel. Pick the enhanced job in *Job A*; the second dropdown auto-cascades to highlight compatible candidates (jobs with opposite `noEnhance`, matching `datasetHash`, matching `evalSetHash`). Ineligible jobs are shown disabled with the reason in the tooltip.
4. Click **Run compare**. The summary line shows `comparable` / `semanticComparable` flags and any diagnostics. The `comparison-report.md` is rendered inline as escaped text (safe), and the `score-matrix.csv` is available as a download link.

The comparator never renders, builds, provisions, or calls Copilot — it only reads each job's `06-score/agent-response-scores.json`. See [`STREAMLINED_CONNECTOR_EVAL_PLAN.md`](STREAMLINED_CONNECTOR_EVAL_PLAN.md) → "Post-hoc comparator (`ccw compare`)" for the underlying contract.

## Quick start — CLI

### Build only (no tenant access)

```cmd
scripts\run-cli.cmd run ^
  --dataset "..\EvaluationCLI\environment-datasets" ^
  --description "Environmental datasets — OWID CO2/GHG metrics and World Bank climate indicators by country/region and year." ^
  --count 10 ^
  --extensions csv ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --deploy-target both ^
  --mode build
```

To enable URL unfurling in Teams/Copilot (shows inline previews when users share links), add `--url-prefix`:

```cmd
scripts\run-cli.cmd run ^
  --dataset "..\EvaluationCLI\environment-datasets" ^
  --description "..." ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --url-prefix "https://environment.example.com" ^
  --mode build
```

This wires `--url-prefix` through to the data-enhancer (so generated item URLs use the prefix) and activates `urlToItemResolver` in the generated connector's `src/models/connection.ts`.

### Provision-mode connector + scoring

Run the authentication preflight once before the long workflow so Graph app
credentials and delegated Work IQ device-code auth fail fast:

```cmd
set CCW_SECRET=<client-secret>
scripts\run-cli.cmd auth ^
  --tenant-id <tenantGuid> ^
  --client-id <appId> ^
  --client-secret-env CCW_SECRET
```

The Graph check exchanges the client secret for a token, verifies the required
Graph connector app roles are present, and probes `/external/connections`. The
Work IQ check starts `workiq mcp` and sends one small auth prompt so
EvalGen/EvalScore delegated auth is seeded before the workflow. If EvalScore
direct A2A uses MSAL device code, add `--eval-score-a2a` after
setting `EVALSCORE_A2A_AUTH_MODE=msal`, `EVALSCORE_A2A_CLIENT_ID`,
`EVALSCORE_A2A_TENANT_ID`, and `EVALSCORE_A2A_SCOPES`.

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

> Provision mode renders tenant/app settings into the generated connector and triggers the full tenant-side lifecycle in Step 5 (external connection, schema register + poll, item ingest + verify, app package install/publish, agent id discovery) followed by Step 6 scoring with `eval-score`. The emitted `deploy/` artifacts (`deploy.ps1`, Bicep, Dockerfile) handle Azure infrastructure separately.

### Resume / re-run

```cmd
scripts\run-cli.cmd resume --job <id>                          # skip-with-cache wherever possible
scripts\run-cli.cmd resume --job <id> --force                  # force every step
scripts\run-cli.cmd resume --job <id> --force-step schema,connector
scripts\run-cli.cmd resume --job <id> --start-at score --stop-after score
```

`list`, `status --job <id>`, and `tools` are also available — see `scripts\run-cli.cmd help`.

## Comparison workflow (enhanced vs --no-enhance)

The comparison surface is a **post-hoc** tool: run the pipeline twice against the same dataset (once normally, once with `--no-enhance --reuse-eval-from <firstJobId>`) and then diff the two completed jobs with `ccw compare`. The comparator never renders, builds, provisions, ingests, or calls Copilot — it only reads each job's `06-score/agent-response-scores.json`.

```cmd
:: First job (enhanced)
scripts\run-cli.cmd run --dataset <path> --description "..." ^
  --connector-id ccwenh --connector-name "CCW Enhanced" ^
  --mode provision --tenant-id <t> --client-id <c> --client-secret-env CCW_SECRET ^
  --candidate-agent-id <enhancedAgent>
:: ... captures jobId-A

:: Second job (non-enhanced, paired by --reuse-eval-from)
scripts\run-cli.cmd run --dataset <path> --no-enhance --description "..." ^
  --connector-id ccwraw --connector-name "CCW Raw" ^
  --mode provision --tenant-id <t> --client-id <c> --client-secret-env CCW_SECRET ^
  --reuse-eval-from <jobId-A> --candidate-agent-id <rawAgent>
:: ... captures jobId-B

:: Diff
scripts\run-cli.cmd compare --job <jobId-A> --job <jobId-B> --output reports\enh-vs-raw
```

The retired `compare-dataset` / `compare-batch` commands now print a migration hint and exit non-zero.

### Where response collection and semantic judging fit

Step 6's `eval-score` driver always uses Work IQ A2A to collect candidate responses (because the candidate is an M365 declarative agent). The judge surface is configurable:

| Artifact | Purpose |
|---|---|
| [`agents\eval-judge\`](agents/eval-judge/README.md) | Pre-built Microsoft 365 Copilot **declarative judge agent** package. Required for `--judge-provider workiq`. |
| `scripts\setup-a2a.ps1` | One-shot setup: provisions the Work IQ first-party SP, acquires a `WorkIQAgent.Ask` delegated token via device code, discovers candidate + judge agent ids from `https://workiq.svc.cloud.microsoft/a2a/.agents`, and emits a ready-to-source env-var file for `eval-score`. |
| `scripts\run-all-datasets.ps1` | Batch driver that runs the six-step pipeline (`--mode build`) against every dataset folder under `data\` and copies the per-job artifacts into `output\<dataset-name>\`. Uses `scripts\jsonl-to-csv.py` to stage the HLS datasets, which ship as `records.jsonl` rather than CSV. |

### Bundled datasets

`data\` ships 24 sample datasets (1 D&B, 7 HLS, 16 NGO) consumed by `run-all-datasets.ps1` and by the comparison plan in `STREAMLINED_CONNECTOR_EVAL_PLAN.md`. Pointing `--dataset` at any of these folders is the fastest path to a working end-to-end build.

## Steps

| # | Step | Inputs | Outputs (under `workspace/jobs/<id>/`) |
|---|---|---|---|
| 1 | `evalgen` — `eval-gen` against the dataset | dataset + description + count | `01-evalgen/eval.csv`, `eval.evalgen.json`, `eval-review.md` |
| 2 | `enhance` — `enhance_for_copilot` (bundled TypeScript) | dataset + step 1 sidecar | `02-enhance/enhanced-items.jsonl`, `enhanced-records.csv`, `schema-suggestion.json`, `enhancement-report.json`, `unmatched-eval-items.json` |
| 3 | `schema` — harden + validate Graph schema | `schema-suggestion.json` + a 200-item sample of `enhanced-items.jsonl` | `03-schema/connector-schema.json`, `schema.ts`, `schema-validation.json` |
| 4 | `connector` — scaffold Azure Functions project, `npm install`, `tsc` | step 3 schema + step 2 items | `04-connector/connector/` (full TypeScript project, compiled) — including bundled batch enhancer |
| 5 | `deploy` — emit Azure deploy artifacts | step 4 project + selected deploy target | `04-connector/connector/deploy/{azure-functions,azure-container-apps}/` + `deploy/README.md` |
| 6 | `score` *(provision only)* — `eval-score` with deterministic + semantic scoring | step 1 eval set + Step 5 agent id | `06-score/agent-response-scores.{json,md}` |

Each step also writes `step-status.json` (machine-readable: status, exitCode, startedAt/endedAt, inputsHash, outputs, diagnostics) and `step.log` alongside its outputs.

## Authentication and data flow

Most of the workflow runs locally and does not touch your tenant. Data is sent to Microsoft 365 only when the generated connector provisioning, ingestion, crawl, or optional evaluation tools run.

| Part | What runs | Microsoft tenant auth | Communication / data sent |
|---|---|---|---|
| Setup | `setup\setup.ps1` | Optional interactive `Connect-MgGraph -Scopes User.Read` for the M365 tenant and separate `az login` for the Azure deployment tenant. These tenants can differ. | Authentication only; no connector data is ingested. |
| Local UI / CLI | `src\server.ts`, `src\cli.ts`, `src\orchestrator.ts` | None in `build` mode. `provision` mode collects `tenantId`, `clientId`, and either a client-secret environment variable name or managed identity flag. | Local server binds to `127.0.0.1:4321`; jobs and logs are written under `workspace\jobs\<jobId>\`. |
| Step 1: EvalGen | `node ..\EvaluationCLI\eval-gen\dist\index.js` | Not handled by this repo. If EvalGen uses an LLM or M365 provider, that authentication happens inside `EvaluationCLI`. | Receives the local dataset path, description, count, and extensions; writes `eval.csv`, `eval.evalgen.json`, and `eval-review.md` locally. |
| Step 2: Enhancer | `node dist\enhancer\enhance_for_copilot.js` | None. | Reads the local dataset and Step 1 sidecar; writes `enhanced-items.jsonl`, `schema-suggestion.json`, `enhanced-records.csv`, and reports locally. |
| Step 3: Schema hardening | In-process TypeScript in `src\steps\step3-schema.ts` | None. | Local only; converts the enhancer suggestion into Graph connector schema artifacts and validates sample items. |
| Step 4: Connector generation | Template rendering, then `npm install` and `npm run build` in the generated connector project | None for Microsoft Graph. `npm install` contacts the npm registry. | Copies schema and enhanced data into `workspace\jobs\<jobId>\04-connector\connector\`; downloads npm packages for the generated project. |
| Step 5: Deploy artifacts | `src\steps\step5-deploy.ts` renders PowerShell, Bicep, Docker, and deployment README files | None while rendering. | Local only; writes `deploy\azure-functions\` and/or `deploy\azure-container-apps\` artifacts under the generated connector project. |
| Generated connector: provision | `npm run provision` -> `src\scripts\provision.ts` | App-only Graph auth through `ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET)` or `ManagedIdentityCredential`. | Calls Microsoft Graph `GET/POST /external/connections`, `PATCH /external/connections/{id}/schema`, and polls schema status. Sends connector ID, name, description, optional URL resolver, and schema. |
| Generated connector: ingest | `npm run ingest` -> `src\scripts\ingest.ts` | Same app-only Graph auth as provision. | Reads `data\enhanced-items.jsonl`; sends each item to Graph with `PUT /external/connections/{id}/items/{itemId}` including ACL, properties, and content. |
| Generated connector: crawl runtime | Azure Functions timer/HTTP trigger in `src\functions\crawl.ts` | Same app-only Graph auth from app settings or managed identity. | Reads the seed/live source through `dataSource.ts`, enhances raw items fail-closed, then upserts enhanced items to Graph. The manual HTTP trigger uses Azure Functions `function` auth. |
| Generated declarative agent | `appPackage\declarativeAgent.json` and Teams app package | Published from Step 5 via the Microsoft 365 Agents Toolkit CLI (`atk install --file-path appPackage.zip`) when `atk` is on `PATH`; otherwise out-of-band via Agents Toolkit UI or `teamsapp publish`. | The agent references the connector by `connection_id`; Copilot uses the Microsoft Graph connector index after ingestion. Step 5 parses the `TitleId` from the Agents Toolkit output and persists `agentId = "<TitleId>.declarativeAgent"` to `05-deploy/resources.json`. Use `--skip-agent-publish` to opt out. |
| Azure Functions deploy script | `deploy\azure-functions\deploy.ps1` | Azure CLI session from `az login`; deployed runtime uses app settings or managed identity for Graph. | Creates Azure resource group, storage, and Function App; sets `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `USE_MANAGED_IDENTITY`; publishes code. |
| Container Apps deploy script | `deploy\azure-container-apps\deploy.ps1` | Azure CLI and ACR auth from `az login`; deployed runtime uses container env/secrets or managed identity for Graph. | Builds and pushes a Docker image, deploys Container App/Bicep, and stores `CLIENT_SECRET` as a container secret unless managed identity is used. |
| Step 6: score | `eval-score` over Work IQ A2A | Delegated `WorkIQAgent.Ask` token for response collection; GitHub Copilot CLI session for the default judge, or the same delegated token + `agents\eval-judge\` agent for the workiq judge. | Sends prompts to the candidate M365 declarative agent, captures answers, judges them, and writes the canonical `06-score/agent-response-scores.{json,md}` report locally. |

Primary data path: local dataset -> EvalGen eval set -> local enhancer output -> generated connector project -> Microsoft Graph external connection/items. Until a generated connector provisioning, ingestion, crawl, or eval command runs, the dataset-derived artifacts remain local.

> **Implementation note:** the orchestrator's `deploy` step currently renders deployment artifacts; it does not itself deploy Azure infrastructure. Microsoft Graph writes are performed by the generated connector scripts (`npm run provision`, `npm run ingest`, and deployed `crawl`) and by the compare workflow when it explicitly invokes those scripts in `provision` mode.

## Build vs provision mode

| Mode | Tenant credentials | Generated project | Graph writes | Step 6 scoring |
|---|---|---|---|---|
| `build` (default) | not required | yes, with blank tenant/app placeholders | no | no |
| `provision` | required | yes, with tenant/app settings rendered | Step 5 runs the full lifecycle: provision, schema register + poll, ingest + verify, app package install, agent id discovery | Step 6 runs `eval-score` (GitHub Copilot judge default) and emits the canonical report. |

Build mode still produces a **fully buildable** connector project and complete Azure deploy artifacts. You can deploy it later by running the emitted `deploy/azure-functions/deploy.ps1` or `deploy/azure-container-apps/deploy.ps1`.

## Step 6 — `score` (eval-score driver)

After the connector has been provisioned, items ingested, and the M365 search index has caught up, Step 6 scores your eval set against M365 Copilot using `..\EvaluationCLI\eval-score`. Every `provision`-mode run produces one canonical scored report at `06-score/agent-response-scores.json` containing both deterministic grounding scores and semantic judge scores. `@microsoft/m365-copilot-eval` is **not** used.

### Judge providers

| Mode | Flag | When to use | Requirements |
|---|---|---|---|
| **Default** | `--judge-provider github-copilot` | Interactive/supervised runs. Runs locally through the `copilot` CLI, no Work IQ rate limit on top of response collection. | `copilot` CLI on PATH and signed in. |
| **Alternative** | `--judge-provider workiq --judge-agent-id <id>` | Long unattended runs, CI, when GitHub Copilot CLI is unavailable, or for calibration. | The `agents/eval-judge` declarative agent published in the tenant. |

### Flow

1. **Judge preflight.** Short probe to verify the chosen judge surface is reachable. Fail-closed if it isn't.
2. **Indexing-readiness gate.** Query the candidate agent with canary prompts from Step 1 until results return; persist `indexReadyAt`. (Full canary loop is scaffolded; the underlying contract is in place.)
3. **Response collection + judging.** `eval-score` calls the candidate agent over Work IQ A2A and routes each response through the selected judge.
4. **Invalid-row gate.** Rows with blank answers, `[ERROR:]`, rate-limit text, fallback-provider judge results, or malformed judge JSON are treated as invalid and fail the job. The workflow never silently accepts a zero-score row.
5. **Deterministic grounding score** (80% assertion + 20% supporting-fact coverage) is folded into the same canonical report.

### Step 6 fail-fast guards

| Condition | Result |
|---|---|
| `mode != provision` | Skipped with `requires-provision-mode` diagnostic; build-mode jobs are not comparable. |
| `judgeProvider=workiq` but no `--judge-agent-id` | Failed with explicit error. |
| `--judge-provider github-copilot` but `copilot` CLI not reachable | Failed with remediation hint to install/sign in or switch to `--judge-provider workiq`. |
| No candidate agent id resolvable | Failed — supply `--candidate-agent-id` or have Step 5 discover it. |
| Eval set missing | Failed — Step 1 must have produced `eval.csv` + `eval.evalgen.json`. |
| Any invalid response row remains after retries | Failed — never produces a "scored" report with hidden zero rows. |

### Comparing two jobs

To produce an enhanced-vs-non-enhanced comparison:

```cmd
:: Enhanced job
scripts\run-cli.cmd run --dataset <path> --mode provision ... --candidate-agent-id <enhAgent>
:: ... captures jobId-A

:: Non-enhanced job (paired by --reuse-eval-from so eval sets match)
scripts\run-cli.cmd run --dataset <path> --no-enhance --mode provision ^
  --reuse-eval-from <jobId-A> ... --candidate-agent-id <rawAgent>
:: ... captures jobId-B

:: Diff them
scripts\run-cli.cmd compare --job <jobId-A> --job <jobId-B> --output <reportDir>
```

The comparator (`ccw compare`) reads each job's `06-score/agent-response-scores.json`, validates pre-conditions (same datasetHash, same evalSetHash, exactly one job has `noEnhance=true`), and emits `comparison-report.{md,json}` plus `score-matrix.csv`. When `judgeProvider` differs between the two jobs, the comparator omits the semantic delta but still reports deterministic and operational metrics.

## Schema validation (Step 3)

| Rule | Severity |
|---|---|
| Property names match `^[A-Za-z][A-Za-z0-9_]{0,31}$` | error |
| `searchable` + `refinable` mutually exclusive | error |
| Properties with semantic labels must be `retrievable` | error |
| ≤128 properties total | error |
| One property per semantic label | error |
| `title` and `url` labels both present | error (auto-injected if a `title`/`url` property exists) |
| `iconUrl` label present (visual identifier in search results) | warning (auto-promoted if a property named `iconUrl` / `icon_url` exists) |
| Reserved `content` property name not declared | error |
| Item sample (200 lines from `enhanced-items.jsonl`) — valid JSON, ID present, URL-safe, ≤4 MB, types match | error / warning |
| DateTime values are ISO-formatted | warning |

All findings are written to `03-schema/schema-validation.json` with `blockingCount`. Any blocking issue fails Step 3.

## Scaling to other datasets

Each run = a new job folder. State is per-job. To re-run on a different dataset, just call `run` again with a different `--dataset` and `--connector-id`. Existing jobs are untouched. The bundled `scripts\run-all-datasets.ps1` demonstrates this against the 24 sample datasets under `data\` (1 D&B + 7 HLS + 16 NGO), copying each per-job output into `output\<dataset-name>\` with a per-run summary at `output\_run-summary.csv`.

## Security defaults

- Server binds to `127.0.0.1` only. On startup the local browser is opened to the URL automatically. Set environment variable `CCW_NO_OPEN=1` to disable, or `CCW_PORT=<n>` to change the port.
- Default ACL on generated items is `everyone` — **revise before connecting non-public data** (`--acl-mode everyoneExceptGuests` or `none`).
- The generated connector reads credentials from environment variables. In production:
  - Set `USE_MANAGED_IDENTITY=true` and assign the managed identity the Graph permissions.
  - Move `CLIENT_SECRET` to Key Vault (`@Microsoft.KeyVault(...)` references) — never check it in.
- The generated `crawlHttp` Function trigger uses `authLevel: 'function'`. Treat its function key like a secret.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `spawn EINVAL` on npm | Resolved — the orchestrator detects `.cmd`/`.bat` on Windows and switches to shell mode automatically. |
| Auth fails late in EvalGen, EvalScore, or connector provisioning | Run `scripts\run-cli.cmd auth --tenant-id <tenantGuid> --client-id <appId> --client-secret-env <envName>` first, or add `--auth-preflight` to `run`/`resume`. Use `--skip-workiq` only when EvalGen is configured for a non-WorkIQ provider. |
| Graph auth preflight reports missing app roles | Grant admin consent for `ExternalConnection.ReadWrite.OwnedBy` and `ExternalItem.ReadWrite.OwnedBy` on the app registration, then rerun `ccw auth`. |
| `eval-gen` error: `required option '--description'` | Make sure you're on the latest workflow build — eval-gen 1.0+ moved the options to the root command, not a `generate` subcommand. |
| Step 6 says `mode is build` | Add `--mode provision` and provide auth. Step 6 only runs after a real ingestion. |
| Step 6 says `agentId is required` | Pass `--m365-agent-id <m365 agent guid>`. The connector ID is *not* the agent ID. |
| Step 6 reports no candidate agent id | Pass `--candidate-agent-id <T_*.declarativeAgent>` or let Step 5 discover it and persist to `05-deploy/resources.json`. |
| Schema validation has blocking issues | Open `03-schema/schema-validation.json`. Common culprits: a property using both `searchable` and `refinable` (must pick one), or items in `enhanced-items.jsonl` exceeding the 4 MB cap. |
| Step skipped when you wanted a re-run | Add `--force` (all steps) or `--force-step <name>` (specific step). |

## Files of interest

- `src/orchestrator.ts` — step state machine + cache logic
- `src/jobs.ts` — job persistence, content-hash helpers
- `src/tools.ts` — tool path resolution (bundled TypeScript enhancer, CopilotConnectorSkill, eval-gen)
- `src/steps/step3-schema.ts` — schema hardening + Graph constraint validation (iconUrl promotion, aliases)
- `src/steps/step4-connector.ts` — connector scaffolding + batch enhancer bundling + compile verification
- `src/steps/step6-score.ts` — Step 6 `eval-score` driver (GitHub Copilot judge default, Work IQ alternative) with invalid-row gating and deterministic-scorer fold-in
- `src/compare-jobs.ts` — post-hoc `ccw compare` implementation (reads two scored reports, emits delta)
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
- `scripts/run-all-datasets.ps1` — batch driver over the bundled `data\` folder (24 datasets)
- `scripts/setup-a2a.ps1` — one-shot Work IQ A2A setup for `eval-score --m365-agent-id` / `--judge-agent-id`
- `data/` — 24 sample datasets (D&B + HLS + NGO) consumed by the batch driver and comparison plan
- `public/` — local SPA (index.html, app.js, style.css) bound to 127.0.0.1
