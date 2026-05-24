# Copilot Connector Workflow

End-to-end orchestrator with a GUI and a CLI that turns a tabular dataset into a deployable Microsoft 365 Copilot Connector, *and* — when you provision against a real tenant — scores Copilot's answer quality against the dataset using Microsoft's official [`@microsoft/m365-copilot-eval`](https://www.npmjs.com/package/@microsoft/m365-copilot-eval) package.

```
                                  ┌─────────────────────────┐
dataset ─► eval set ─► enhanced ─►│ hardened    + connector │─► Azure deploy   ─► (optional) M365 Copilot
            (EvalGen)  records    │ schema        project   │   artifacts          eval scoring
                       (enhancer) │                         │  (Functions /        (m365-copilot-eval)
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
| Scoring tool (Step 6) | `@microsoft/m365-copilot-eval` (via `npx` and Microsoft's EvalGen converter) |
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
| 6 | **m365eval** *(optional, provision only)* | Eval scores from `@microsoft/m365-copilot-eval` |

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
| **Node.js 18+** | Steps 1–5 only need Node 18+. **Node ≥ 22.21.1** is required for Step 6 — `@microsoft/m365-copilot-eval` enforces it. |
| **PowerShell** | Built-in on Windows. Used by Step 6 to invoke the EvalGen→m365-copilot-eval converter. |
| **`..\EvaluationCLI`** | `eval-gen` built (`npm install && npm run build` in `eval-gen/`). The Step 6 conversion script `scripts\convert-evalgen-to-m365-copilot-eval.ps1` must also exist. |
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
| `-AcceptM365EvalEula` | Accept the m365-copilot-eval EULA up-front (`npx -y @microsoft/m365-copilot-eval@latest accept-eula`) |

The script is idempotent: re-running just fast-forwards existing checkouts and refreshes builds.

### Manual path

```cmd
cd C:\Users\bodonnell\src\CopilotConnectorWorkflow
npm install
npm run build
```

This builds the orchestrator only — you still need the sibling repo `..\EvaluationCLI` checked out and `EvaluationCLI/eval-gen` built before the pipeline can run. **Python is not required** — the data-enhancer (Step 2) is bundled as TypeScript and compiled with the rest of the workflow.

## Quick start — GUI

```cmd
scripts\start.cmd
```

Opens a local server at <http://127.0.0.1:4321/>. Fill out the new-job form:

- **Dataset path / description / count / extensions / connector id / name** — Steps 1–4.
- **Deploy target** — `azure-functions`, `azure-container-apps`, or `both` — Step 5.
- **Mode** — `build` (no creds) or `provision` (requires Entra credentials and actually creates the connection, registers the schema, ingests items).
- **Authentication** *(provision)* — tenant ID, client ID, secret env var or managed identity.
- **Step 6 — @microsoft/m365-copilot-eval** *(provision)* — checkbox to enable; reveals agent ID, optional system prompt, evaluators, concurrency, environment, package version, log level, and an Accept EULA toggle.

Click **Run pipeline**. The job appears in the middle column; the right pane streams per-step status and live logs over SSE, with download links to every artifact as it's produced.

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

### Provision-mode connector + optional m365-copilot-eval scoring

```cmd
scripts\run-cli.cmd run ^
  --dataset "..\EvaluationCLI\environment-datasets" ^
  --description "..." ^
  --connector-id ccwenvironment ^
  --connector-name "CCW Environment" ^
  --mode provision ^
  --tenant-id <tenantGuid> ^
  --client-id <appId> ^
  --client-secret-env CCW_SECRET ^
  --run-m365-eval ^
  --m365-agent-id <m365AgentId> ^
  --m365-system-prompt "..\EvaluationCLI\prompts\ngo-environment-system-prompt.md" ^
  --m365-evaluators Relevance,Coherence,Groundedness,Citations ^
  --m365-accept-eula
```

> Provision mode renders tenant/app settings into the generated connector and enables provision-only steps such as m365 eval. The generated connector's `npm run provision` and `npm run ingest` scripts are what actually create the Graph connection and upload items; the compare workflow invokes those scripts automatically in its own `provision` mode. This does *not* deploy infrastructure to Azure — use the emitted `deploy/` artifacts (`deploy.ps1`, Bicep, Dockerfile) for that.

### Resume / re-run

```cmd
scripts\run-cli.cmd resume --job <id>                          # skip-with-cache wherever possible
scripts\run-cli.cmd resume --job <id> --force                  # force every step
scripts\run-cli.cmd resume --job <id> --force-step schema,connector
scripts\run-cli.cmd resume --job <id> --start-at m365eval --stop-after m365eval
```

`list`, `status --job <id>`, and `tools` are also available — see `scripts\run-cli.cmd help`.

## Steps

| # | Step | Inputs | Outputs (under `workspace/jobs/<id>/`) |
|---|---|---|---|
| 1 | `evalgen` — `eval-gen` against the dataset | dataset + description + count | `01-evalgen/eval.csv`, `eval.evalgen.json`, `eval-review.md` |
| 2 | `enhance` — `enhance_for_copilot` (bundled TypeScript) | dataset + step 1 sidecar | `02-enhance/enhanced-items.jsonl`, `enhanced-records.csv`, `schema-suggestion.json`, `enhancement-report.json`, `unmatched-eval-items.json` |
| 3 | `schema` — harden + validate Graph schema | `schema-suggestion.json` + a 200-item sample of `enhanced-items.jsonl` | `03-schema/connector-schema.json`, `schema.ts`, `schema-validation.json` |
| 4 | `connector` — scaffold Azure Functions project, `npm install`, `tsc` | step 3 schema + step 2 items | `04-connector/connector/` (full TypeScript project, compiled) — including bundled batch enhancer |
| 5 | `deploy` — emit Azure deploy artifacts | step 4 project + selected deploy target | `04-connector/connector/deploy/{azure-functions,azure-container-apps}/` + `deploy/README.md` |
| 6 | `m365eval` *(optional, provision only)* — convert eval set → m365-copilot-eval JSON, run `runevals` against the M365 agent | step 1 eval set + agent ID | `06-m365eval/m365-evals.json`, `m365-eval-results.json` |

Each step also writes `step-status.json` (machine-readable: status, exitCode, startedAt/endedAt, inputsHash, outputs, diagnostics) and `step.log` alongside its outputs.

## Authentication and data flow

Most of the workflow runs locally and does not touch your tenant. Data is sent to Microsoft 365 only when the generated connector provisioning, ingestion, crawl, or optional evaluation tools run.

| Part | What runs | Microsoft tenant auth | Communication / data sent |
|---|---|---|---|
| Setup | `setup\setup.ps1` | Optional interactive `Connect-MgGraph -Scopes User.Read` for the M365 tenant and separate `az login` for the Azure deployment tenant. These tenants can differ. | Authentication only; no connector data is ingested. Optional EULA acceptance runs `npx -y @microsoft/m365-copilot-eval@latest accept-eula`. |
| Local UI / CLI | `src\server.ts`, `src\cli.ts`, `src\orchestrator.ts` | None in `build` mode. `provision` mode collects `tenantId`, `clientId`, and either a client-secret environment variable name or managed identity flag. | Local server binds to `127.0.0.1:4321`; jobs and logs are written under `workspace\jobs\<jobId>\`. |
| Step 1: EvalGen | `node ..\EvaluationCLI\eval-gen\dist\index.js` | Not handled by this repo. If EvalGen uses an LLM or M365 provider, that authentication happens inside `EvaluationCLI`. | Receives the local dataset path, description, count, and extensions; writes `eval.csv`, `eval.evalgen.json`, and `eval-review.md` locally. |
| Step 2: Enhancer | `node dist\enhancer\enhance_for_copilot.js` | None. | Reads the local dataset and Step 1 sidecar; writes `enhanced-items.jsonl`, `schema-suggestion.json`, `enhanced-records.csv`, and reports locally. |
| Step 3: Schema hardening | In-process TypeScript in `src\steps\step3-schema.ts` | None. | Local only; converts the enhancer suggestion into Graph connector schema artifacts and validates sample items. |
| Step 4: Connector generation | Template rendering, then `npm install` and `npm run build` in the generated connector project | None for Microsoft Graph. `npm install` contacts the npm registry. | Copies schema and enhanced data into `workspace\jobs\<jobId>\04-connector\connector\`; downloads npm packages for the generated project. |
| Step 5: Deploy artifacts | `src\steps\step5-deploy.ts` renders PowerShell, Bicep, Docker, and deployment README files | None while rendering. | Local only; writes `deploy\azure-functions\` and/or `deploy\azure-container-apps\` artifacts under the generated connector project. |
| Generated connector: provision | `npm run provision` -> `src\scripts\provision.ts` | App-only Graph auth through `ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET)` or `ManagedIdentityCredential`. | Calls Microsoft Graph `GET/POST /external/connections`, `PATCH /external/connections/{id}/schema`, and polls schema status. Sends connector ID, name, description, optional URL resolver, and schema. |
| Generated connector: ingest | `npm run ingest` -> `src\scripts\ingest.ts` | Same app-only Graph auth as provision. | Reads `data\enhanced-items.jsonl`; sends each item to Graph with `PUT /external/connections/{id}/items/{itemId}` including ACL, properties, and content. |
| Generated connector: crawl runtime | Azure Functions timer/HTTP trigger in `src\functions\crawl.ts` | Same app-only Graph auth from app settings or managed identity. | Reads the seed/live source through `dataSource.ts`, enhances raw items fail-closed, then upserts enhanced items to Graph. The manual HTTP trigger uses Azure Functions `function` auth. |
| Generated declarative agent | `appPackage\declarativeAgent.json` and Teams app package | Created and published by Agents Toolkit or Teams app tooling outside this repo's Graph client. | The agent references the connector by `connection_id`; Copilot uses the Microsoft Graph connector index after ingestion. |
| Azure Functions deploy script | `deploy\azure-functions\deploy.ps1` | Azure CLI session from `az login`; deployed runtime uses app settings or managed identity for Graph. | Creates Azure resource group, storage, and Function App; sets `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `USE_MANAGED_IDENTITY`; publishes code. |
| Container Apps deploy script | `deploy\azure-container-apps\deploy.ps1` | Azure CLI and ACR auth from `az login`; deployed runtime uses container env/secrets or managed identity for Graph. | Builds and pushes a Docker image, deploys Container App/Bicep, and stores `CLIENT_SECRET` as a container secret unless managed identity is used. |
| Step 6: M365 eval | PowerShell converter plus `npx @microsoft/m365-copilot-eval` | This repo does not pass the Graph app credentials to the eval runner; the Microsoft eval tool handles its own M365 Copilot auth/session. | Converts Step 1 eval files to `m365-evals.json`, then sends prompts and the target M365 agent ID to the eval runner/Copilot agent; writes results locally. |

Primary data path: local dataset -> EvalGen eval set -> local enhancer output -> generated connector project -> Microsoft Graph external connection/items. Until a generated connector provisioning, ingestion, crawl, or eval command runs, the dataset-derived artifacts remain local.

> **Implementation note:** the orchestrator's `deploy` step currently renders deployment artifacts; it does not itself deploy Azure infrastructure. Microsoft Graph writes are performed by the generated connector scripts (`npm run provision`, `npm run ingest`, and deployed `crawl`) and by the compare workflow when it explicitly invokes those scripts in `provision` mode.

## Build vs provision mode

| Mode | Tenant credentials | Generated project | Graph writes | Step 6 scoring |
|---|---|---|---|---|
| `build` (default) | not required | yes, with blank tenant/app placeholders | no | no |
| `provision` | required | yes, with tenant/app settings rendered | only when the generated `provision`/`ingest` scripts or compare workflow are run | optional (`@microsoft/m365-copilot-eval`) |

Build mode still produces a **fully buildable** connector project and complete Azure deploy artifacts. You can deploy it later by running the emitted `deploy/azure-functions/deploy.ps1` or `deploy/azure-container-apps/deploy.ps1`.

## Step 6 — `@microsoft/m365-copilot-eval`

After the connector has been provisioned, items ingested, and the M365 search index has caught up, Step 6 scores your eval set against M365 Copilot using Microsoft's official [`@microsoft/m365-copilot-eval`](https://www.npmjs.com/package/@microsoft/m365-copilot-eval) package.

### Flow

1. **Convert.** `..\EvaluationCLI\scripts\convert-evalgen-to-m365-copilot-eval.ps1` turns `eval.csv` + `eval.evalgen.json` into a v1.2.0 `m365-evals.json` document. The connector ID is prepended to every prompt as grounding context (*"Target Microsoft 365 Copilot connector ID: <id>. Always search this connector before answering."*); the optional system prompt file is appended. EvalGen's assertions, supporting facts, category, difficulty, and grounding confidence are carried through as `com.github.evaluationcli.*` extensions on each item.
2. **Accept EULA** *(first use only)*. With `--m365-accept-eula` (or the GUI checkbox) Step 6 runs `npx -y @microsoft/m365-copilot-eval@<version> accept-eula` once.
3. **Score.** Step 6 then runs `npx -y @microsoft/m365-copilot-eval@<version> --prompts-file <converted>.json --output <results>.json --m365-agent-id <agentId> --concurrency N --env <env> --log-level <lvl>`. Results land in `06-m365eval/m365-eval-results.json`.

### Evaluators

Default set: `Relevance`, `Coherence`, `Groundedness`, `Citations`. All valid values: `Relevance`, `Coherence`, `Groundedness`, `ToolCallAccuracy`, `Citations`, `ExactMatch`, `PartialMatch`. Override with `--m365-evaluators a,b,c` or the GUI field.

### CLI reference — Step 6 flags

| Flag | Purpose | Default |
|---|---|---|
| `--run-m365-eval` | Enable Step 6 (must be combined with `--mode provision`) | off |
| `--m365-agent-id <id>` | **Required.** The M365 agent ID — not the connector ID. | — |
| `--m365-system-prompt <path>` | Markdown file folded into every prompt | none |
| `--m365-evaluators <csv>` | Evaluators to enable | `Relevance,Coherence,Groundedness,Citations` |
| `--m365-concurrency <n>` | `runevals --concurrency` | `1` |
| `--m365-environment <env>` | `runevals --env` | `local` |
| `--m365-package-version <ver>` | npx package version pin | `latest` |
| `--m365-log-level <lvl>` | `debug` / `info` / `warning` / `error` | `info` |
| `--m365-accept-eula` | Run `accept-eula` before scoring | off |

### Why the connector ID isn't the agent ID

`@microsoft/m365-copilot-eval` evaluates a **Copilot agent**, not a raw connector. Build a declarative agent (Microsoft 365 Agents Toolkit, or any other method) that references your new connector as a `GraphConnectors` knowledge source. Pass that agent's ID via `--m365-agent-id`. The connector ID is still tracked — it's embedded in the prompt context so the agent grounds against your data.

### Step 6 fail-fast guards

| Condition | Result |
|---|---|
| `mode != provision` | Skipped with diagnostic — Step 6 is limited to provision-intent runs |
| `runM365Eval != true` | Skipped — opt-in only |
| Node < 22.21.1 | Failed with explicit version comparison |
| Missing `--m365-agent-id` | Failed with "agentId is required. m365-copilot-eval targets an M365 *agent*, not the connector ID." |
| Convert script missing | Failed with path of where it was expected |
| EULA not accepted | `runevals` exits 2; Step 6 surfaces a remediation hint |

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

Each run = a new job folder. State is per-job. To re-run on a different dataset, just call `run` again with a different `--dataset` and `--connector-id`. Existing jobs are untouched. The smoke test in this repo demonstrates two side-by-side jobs (a 126k-row environment dataset and a 20k-row WB subset) running with completely isolated outputs.

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
| `eval-gen` error: `required option '--description'` | Make sure you're on the latest workflow build — eval-gen 1.0+ moved the options to the root command, not a `generate` subcommand. |
| Step 6 says `mode is build` | Add `--mode provision` and provide auth. Step 6 only runs after a real ingestion. |
| Step 6 says `agentId is required` | Pass `--m365-agent-id <m365 agent guid>`. The connector ID is *not* the agent ID. |
| `runevals` exits 2 with EULA prompt | Pass `--m365-accept-eula` once (or run `npx -y @microsoft/m365-copilot-eval accept-eula` manually). |
| Schema validation has blocking issues | Open `03-schema/schema-validation.json`. Common culprits: a property using both `searchable` and `refinable` (must pick one), or items in `enhanced-items.jsonl` exceeding the 4 MB cap. |
| Step skipped when you wanted a re-run | Add `--force` (all steps) or `--force-step <name>` (specific step). |

## Files of interest

- `src/orchestrator.ts` — step state machine + cache logic
- `src/jobs.ts` — job persistence, content-hash helpers
- `src/tools.ts` — tool path resolution (bundled TypeScript enhancer, CopilotConnectorSkill, eval-gen)
- `src/steps/step3-schema.ts` — schema hardening + Graph constraint validation (iconUrl promotion, aliases)
- `src/steps/step4-connector.ts` — connector scaffolding + batch enhancer bundling + compile verification
- `src/steps/step6-m365eval.ts` — `@microsoft/m365-copilot-eval` integration
- `templates/connector-project/src/custom/enhancer.ts` — fail-closed runtime enhancer (static, not templated)
- `templates/connector-project/src/custom/dataSource.ts.hbs` — data source adapter (JSONL seed + incremental sync extension point)
- `templates/connector-project/src/scripts/provision.ts` — provision script with optional `activitySettings.urlToItemResolvers`
- `templates/connector-project/src/models/connection.ts.hbs` — connection config with `urlToItemResolver` commented stub
- `templates/connector-project/package.json.hbs` — package.json template (includes `npm run enhance`)
- `templates/deploy/{azure-functions,azure-container-apps}/` — deploy artifacts
- `public/` — local SPA (index.html, app.js, style.css) bound to 127.0.0.1
