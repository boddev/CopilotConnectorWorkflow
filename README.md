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
| Generated connector runtime | Azure Functions (TypeScript) using `@microsoft/microsoft-graph-client` |
| Deploy artifact targets | Azure Functions, Azure Container Apps, or both |
| Scoring tool (Step 6) | `@microsoft/m365-copilot-eval` (via `npx` and Microsoft's EvalGen converter) |
| Schema validator | Hardens `schema-suggestion.json` → Graph-Connectors schema with payload sample checks |
| Re-runnability | SHA-256 fingerprint per step input; per-job + per-step force flags |
| UI | Local SPA on `127.0.0.1` + SSE live log stream |

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | Steps 1–5 only need Node 18+. **Node ≥ 22.21.1** is required for Step 6 — `@microsoft/m365-copilot-eval` enforces it. |
| **Python 3.9+** | Required for Step 2 (`enhance_for_copilot.py`). `py -3` and `python` are both probed. |
| **PowerShell** | Built-in on Windows. Used by Step 6 to invoke the EvalGen→m365-copilot-eval converter. |
| **`..\EvaluationCLI`** | `eval-gen` built (`npm install && npm run build` in `eval-gen/`). The Step 6 conversion script `scripts\convert-evalgen-to-m365-copilot-eval.ps1` must also exist. |
| **`..\data-enhancer`** | `enhance_for_copilot.py` on disk. |
| **`..\CopilotConnectorSkill`** | Reference material only — surfaced in the tools probe but not invoked at runtime. |
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

This builds the orchestrator only — you still need the sibling repos (`..\EvaluationCLI`, `..\data-enhancer`, `..\CopilotConnectorSkill`) checked out and `EvaluationCLI/eval-gen` built before the pipeline can run.

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

### Provision + ingest + score with m365-copilot-eval

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

> Provision mode **runs the generated connector's `provision` + `ingest` scripts against your tenant locally**. It does *not* deploy infrastructure to Azure for you — use the emitted `deploy/` artifacts (`deploy.ps1`, Bicep, Dockerfile) for that.

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
| 2 | `enhance` — `enhance_for_copilot.py` | dataset + step 1 sidecar | `02-enhance/enhanced-items.jsonl`, `enhanced-records.csv`, `schema-suggestion.json`, `enhancement-report.json`, `unmatched-eval-items.json` |
| 3 | `schema` — harden + validate Graph schema | `schema-suggestion.json` + a 200-item sample of `enhanced-items.jsonl` | `03-schema/connector-schema.json`, `schema.ts`, `schema-validation.json` |
| 4 | `connector` — scaffold Azure Functions project, `npm install`, `tsc` | step 3 schema + step 2 items | `04-connector/connector/` (full TypeScript project, compiled) |
| 5 | `deploy` — emit Azure deploy artifacts | step 4 project + selected deploy target | `04-connector/connector/deploy/{azure-functions,azure-container-apps}/` + `deploy/README.md` |
| 6 | `m365eval` *(optional, provision only)* — convert eval set → m365-copilot-eval JSON, run `runevals` against the M365 agent | step 1 eval set + agent ID | `06-m365eval/m365-evals.json`, `m365-eval-results.json` |

Each step also writes `step-status.json` (machine-readable: status, exitCode, startedAt/endedAt, inputsHash, outputs, diagnostics) and `step.log` alongside its outputs.

## Build vs provision mode

| Mode | Tenant credentials | Connection created | Items ingested | Step 6 scoring |
|---|---|---|---|---|
| `build` (default) | not required | no | no | no |
| `provision` | required | yes | yes | optional (`@microsoft/m365-copilot-eval`) |

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
| `mode != provision` | Skipped with diagnostic — scoring an unprovisioned/unindexed connector is meaningless |
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
- `src/steps/step3-schema.ts` — schema hardening + Graph constraint validation
- `src/steps/step4-connector.ts` — connector scaffolding + compile verification
- `src/steps/step6-m365eval.ts` — `@microsoft/m365-copilot-eval` integration
- `templates/connector-project/` — Azure Functions TypeScript scaffold (provision, ingest, deprovision, crawl, graphService, JsonlDataSource)
- `templates/deploy/{azure-functions,azure-container-apps}/` — deploy artifacts
- `public/` — local SPA (index.html, app.js, style.css) bound to 127.0.0.1

