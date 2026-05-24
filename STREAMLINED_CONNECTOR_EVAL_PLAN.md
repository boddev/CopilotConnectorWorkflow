# Streamlined Connector Evaluation Plan

## Goal

Automate the end-to-end enhanced-vs-RAW Microsoft 365 Copilot Connector evaluation workflow so the same testing performed for the D&B dataset can be repeated across 25 additional datasets with minimal manual intervention.

The target outcome is a single resumable batch command that, for each dataset:

1. Generates a 100-question EvalGen set.
2. Creates and provisions an enhanced connector.
3. Creates and provisions a RAW baseline connector.
4. Creates two Copilot declarative agents, each scoped to exactly one connector.
5. Waits until both connector indexes are queryable by Copilot.
6. Collects actual M365 Copilot answers from both agents.
7. Scores answers with both deterministic fact/assertion coverage and required semantic quality judging.
8. Produces per-dataset and aggregate enhanced-vs-RAW comparison reports.

## What slowed down the D&B run

The user-observed issues were accurate. The full list of material speed bumps was:

| Area | What happened | Streamlining requirement |
|---|---|---|
| Connector generation | The first generated connector had schema/runtime issues: JSONL records were stored in `.json` files, aliases were invalid for Graph payloads, `duns` mixed searchable and exact-match semantics, local env loading was incomplete, and the ingest path needed clearer raw-vs-enhanced behavior. | Make these generator/template invariants with regression tests so every dataset gets a valid connector on first render. |
| Graph schema registration | Graph schema constraints were easy to violate, and schema registration is asynchronous. Item upserts can fail briefly even after schema creation appears accepted. | Add hard preflight validation, schema polling, and Graph write retry/backoff as first-class pipeline states. |
| RAW baseline | The RAW connector had to be manually created for D&B. | Generate RAW and enhanced connectors as paired artifacts from the same dataset manifest. |
| Agent package | The generated app package used an old Teams/declarative-agent manifest shape tied to outdated Teams schema expectations, not the current Copilot declarative agent package format. | Pin and validate the current M365 Copilot declarative agent manifest schema in tests and in the generator. |
| Agent deployment | Agent IDs had to be discovered after deployment. | Automate agent package install/publish and persist agent IDs/title IDs in run state. |
| EvalGen scale | EvalGen would not directly generate 100 questions because `--count` is capped at 25-50, so multiple runs and manual merges were needed. | Automate multi-batch generation with `--avoid-evalsets`, deduplication, and a target-count loop. |
| Copilot response collection | WorkIQ/A2A response collection was slow, hit hourly Copilot request limits, and returned rate-limit messages as normal answers. | Use a resumable response queue with pacing, adaptive retry, backoff, and strict invalid-response detection before scoring. |
| Device-code auth | Device-code auth was repeated many times because no durable WorkIQ delegated token cache existed initially, codes expired, stale codes were entered, and stopped/restarted processes lost the active flow. | Use a durable user-level token cache, one long-lived collector process, active-code tracking, silent refresh, and checkpointed resume after auth failures. |
| Scoring package expectations | `@microsoft/m365-copilot-eval` includes Azure OpenAI LLM-as-judge evaluators. Azure OpenAI is not the preferred dependency for this workflow, but semantic quality scoring is still required. | Separate deterministic grounding checks from semantic quality judging. Default to a pluggable M365 Copilot or GitHub Copilot semantic judge, with Azure OpenAI only as an optional provider if explicitly enabled. |
| Scoring validity | Early scores included rate-limit responses, making results invalid. | Block scoring unless both agents have zero blank, error, and rate-limit rows. |
| Index readiness | The D&B run relied on ad hoc waiting/verification. Across 50 connectors, Copilot indexing latency can create false negatives if response collection starts too soon. | Add an explicit indexing-readiness gate using canary prompts and timeout reporting. |

## Proposed automation architecture

Add a new comparison workflow on top of the existing six-step pipeline:

```text
dataset manifest
  -> normalize dataset
  -> generate/merge eval set
  -> generate enhanced connector
  -> generate RAW connector
  -> provision schemas and ingest both connectors
  -> create enhanced and RAW agents
  -> await Copilot indexing readiness
  -> collect actual responses
  -> local deterministic scoring
  -> per-dataset report
  -> aggregate report
```

## Repository ownership

The automation should be split across three repositories so each layer owns the right responsibility.

| Repository | Owns | Required changes |
|---|---|---|
| `C:\Users\bodonnell\src\CopilotConnectorSkill` | Generic connector and agent artifact guidance/templates used by GitHub Copilot CLI. | Phase 0 and the generic connector/agent artifact portions of Phase 1 should be implemented here so generated artifacts become deterministic across runs. RAW-baseline behavior belongs here only as an optional recipe triggered by the prompt/workflow, not as a default behavior. |
| `C:\Users\bodonnell\src\CopilotConnectorWorkflow` | Batch orchestration, provisioning, response collection, scoring, state, and reporting. | Owns `compare-dataset`, `compare-batch`, run database, WorkIQ REST/A2A runner, semantic judging workflow, and aggregate reports. |
| `C:\Users\bodonnell\src\EvaluationCLI` | EvalGen behavior and reusable eval-set generation utilities. | Only needs changes if EvalGen should natively support target counts above 50, multi-batch generation, stronger deduplication, or stable machine-readable output contracts. Otherwise the workflow can wrap existing EvalGen behavior. |

### Copilot Connector Skill changes

Phase 0 and the generic connector/agent artifact part of Phase 1 should be moved into the Copilot Connector Skill because that skill is what instructs GitHub Copilot CLI how to build connectors.

The skill must remain a **generic Copilot Connector skill**. It should produce connector artifacts based on the prompt and dataset provided. RAW-baseline behavior should not be baked into default connector generation. It should be documented as an optional pattern that is applied only when the user prompt or workflow explicitly requests a RAW baseline, comparison connector, unenhanced control connector, or similar.

Required skill updates:

- Add a deterministic connector-generation checklist to `copilot-connector\SKILL.md`.
- Update Agents Toolkit samples so generated projects use the current M365 Copilot declarative-agent package format, not stale Teams manifest assumptions.
- Add optional sample/template guidance for paired enhanced and RAW connectors, clearly labeled as comparison-workflow guidance rather than the default connector path.
- Add schema hardening rules directly to the skill guidance:
  - strip invalid Graph aliases before Graph payload creation,
  - prevent searchable plus exact-match conflicts,
  - enforce semantic labels for `title`, `url`, and `iconUrl`,
  - require schema polling before ingestion,
  - require retry/backoff for transient Graph upsert failures.
- Add an optional RAW-baseline recipe:
  - identity transform only,
  - no enhancer invocation,
  - deterministic title/URL fallbacks only,
  - raw content preserved for baseline comparison.
- Add validation examples/tests in the skill repo for representative source shapes: CSV, JSON array, JSONL-as-`.json`, nested JSON, and sparse records.
- Add prompt examples that distinguish:
  - normal enhanced connector generation,
  - connector generation where the user opts out of enhancement,
  - comparison workflows where the user explicitly requests enhanced plus RAW baseline artifacts.

The workflow repo should then consume the skill output and validate it. It should not rely on ad hoc manual connector refactoring once the skill has been corrected.

Recommended CLI surface:

```powershell
node dist\cli.js compare-dataset --config .\datasets\dnb.compare.json
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --resume
```

### Batch manifest

Create a manifest-driven batch runner rather than passing dozens of flags per run.

Example:

```json
{
  "tenantId": "976f427e-0d86-4ecf-ace3-4d1368eb8358",
  "authProfile": "boddev-workiq",
  "evalQuestionTarget": 100,
  "promptDelaySeconds": 30,
  "datasets": [
    {
      "slug": "dnb",
      "path": "C:\\Users\\bodonnell\\src\\CopilotConnectorWorkflow\\data\\dnbData",
      "description": "D&B business entity records...",
      "connectorPrefix": "ccwdnb",
      "displayName": "CCW D&B Data"
    }
  ]
}
```

The batch runner should write a single persistent run database, preferably SQLite:

| Table | Purpose |
|---|---|
| `datasets` | Dataset path, slug, description, state, timings, errors. |
| `connectors` | Enhanced/RAW connection IDs, schema status, item counts, ingestion status. |
| `agents` | App IDs, package paths, deployed agent IDs/title IDs, connector binding. |
| `questions` | EvalGen questions, category, expected answer, assertions, source mapping. |
| `responses` | Per-agent actual answer, citations, raw response metadata, retry state. |
| `scores` | Per-agent score, assertion/fact pass counts, pass/partial/fail. |
| `events` | Auditable log of state transitions, auth events, rate-limit events, retries. |

## Connector generation improvements

### Enhanced connector

Make the current D&B fixes default behavior:

- Normalize source files before EvalGen/enhancement, including JSONL records disguised as `.json`.
- Always route full and incremental crawls through the data enhancer before Graph upsert.
- Fail closed if enhancement fails; never silently fall back to raw ingestion.
- Ensure generated items always have `title`, `url`, and `iconUrl` semantic labels or deterministic fallbacks.
- Validate content length and item payloads against Graph limits before ingestion.
- Load local settings consistently from `local.settings.json`, `.env.local`, and `.env.local.user`.
- Poll schema registration until complete before item ingestion.
- Retry transient Graph failures and schema-not-ready item upsert failures.

### RAW connector

Generate the RAW baseline automatically from the same dataset only when the comparison workflow or user prompt explicitly requests it:

- Use an identity transform over source fields.
- Do not call the enhancer.
- Store the original record as raw content where practical.
- Use deterministic title and URL derivation only so the RAW connector remains queryable but not enhanced.
- Generate a safe raw schema that obeys Graph invariants.
- Add tests that assert optional RAW generation invokes zero enhancer code paths.

### Schema hardening

Promote schema issues from runtime failures to build-time validation:

- Reject or strip Graph-invalid aliases before provisioning.
- Enforce `searchable` and `refinable` mutual exclusivity.
- Enforce `isExactMatchRequired` only on non-searchable properties.
- Ensure semantic labels map to exactly one retrievable property.
- Ensure `title`, `url`, and `iconUrl` labels are present.
- Verify collection properties include required `@odata.type` annotations in sample payloads.
- Run generator tests against representative dataset shapes: CSV, JSON array, JSONL-as-`.json`, nested JSON, and sparse records.

## Agent generation and deployment improvements

Replace the old Teams-tied manifest template with a pinned current M365 Copilot declarative-agent package template.

Requirements:

- Generate two app packages per dataset:
  - Enhanced agent bound only to the enhanced connection ID.
  - RAW agent bound only to the RAW connection ID.
- Use deterministic package and manifest IDs derived from dataset slug plus `enhanced`/`raw`.
- Validate each package before install:
  - Current manifest schema/version is pinned.
  - Declarative agent file is referenced correctly.
  - `GraphConnectors` capability has exactly one connection ID.
  - No other external data source/capability is enabled.
- Persist deployed agent IDs/title IDs into the run database.
- Add a tested deprovision path that removes agents and connector connections in reverse order.

Recommended state order:

```text
render connector
  -> provision external connection
  -> register schema and poll completion
  -> ingest items and verify item count
  -> render agent package with final connection ID
  -> validate agent package
  -> install/publish agent
  -> discover and store agent ID
```

## Indexing readiness gate

Do not start response collection immediately after ingestion. Add an `await-indexing` state for both connectors.

Readiness strategy:

1. During EvalGen or enhancement, select one or more canary facts per dataset that should be easy to answer.
2. Query each agent periodically with a canary prompt.
3. Require a non-empty, non-rate-limited answer that includes expected canary content and preferably a citation.
4. Enforce a minimum wait floor and maximum wait ceiling.
5. Persist `indexReadyAt`, canary prompts, canary answers, and readiness attempts.
6. If readiness never succeeds, mark the dataset as not comparable and exclude it from aggregate winner calculations.

This avoids scoring agents against data that has been ingested but is not yet available to Copilot.

## EvalGen automation

EvalGen cannot reliably produce 100 questions in one call because its count range is 25-50. Automate the D&B workaround:

1. Run EvalGen with the maximum allowed count.
2. Run additional batches using `--avoid-evalsets` against prior outputs.
3. Deduplicate by normalized prompt text and source row.
4. Add near-duplicate detection using n-gram similarity so paraphrased duplicates do not inflate the set.
5. Stop when the target count is reached or a configured attempt cap is hit.
6. If fewer than 100 distinct questions are possible, continue with the actual count and report `actualQuestionCount`.
7. Merge `eval.csv`, `eval.evalgen.json`, and review markdown into a canonical `eval-combined` folder.

## Response collection improvements

Replace ad hoc per-run Python scripts with a reusable WorkIQ/A2A response runner.

The D&B collector was already using the WorkIQ REST/A2A endpoint directly:

```text
https://graph.microsoft.com/rp/workiq/{agentId}
```

with the required header:

```text
X-variants: feature.EnableA2AServer
```

So the main issue was not that the CLI was slower than REST. The issues were:

- delegated WorkIQ authentication was not cached at first,
- device codes expired or belonged to stopped processes,
- Copilot returned hourly request-limit messages as normal answers,
- response collection was initially too aggressive for the service limits,
- retries were not fully automated until later.

Using the WorkIQ REST APIs directly is still the right design because it gives full control over token caching, pacing, retries, raw response capture, and queue resume. However, direct REST calls should not be expected to bypass Copilot/WorkIQ service throttles. If the backend returns per-hour request-limit responses, the runner must back off and resume later.

Required behavior:

- One queue item per dataset, agent, and prompt.
- Durable per-question checkpointing.
- Resume without overwriting good answers.
- Retry blank answers, explicit errors, HTTP 429/503, and known rate-limit text.
- Treat rate-limit text as invalid even when returned as a normal answer.
- Use low default concurrency and per-agent pacing.
- Add adaptive exponential backoff with jitter.
- Separate response collection from scoring; scoring must fail if any invalid rows remain.
- Store raw A2A response metadata for troubleshooting.
- Track latency, retries, rate-limit events, and citation presence.

Recommended architecture:

```text
batch orchestrator -> response queue -> long-lived WorkIQ runner -> response store
```

The WorkIQ runner should stay alive across datasets so one delegated auth session can service many response-collection phases.

## Authentication strategy

Use two distinct auth models:

| Need | Recommended auth |
|---|---|
| Connector provision/schema/ingestion | App-only Graph auth with `ExternalConnection.ReadWrite.OwnedBy` and `ExternalItem.ReadWrite.OwnedBy`. |
| Copilot/WorkIQ A2A response collection | Delegated WorkIQ auth, cached securely at user level. |

For WorkIQ:

- Persist MSAL token cache in a secure user-level location, not inside disposable job folders.
- Do not delete the token cache after each run.
- Attempt silent token acquisition before starting device code.
- If device code is required, print and write the active code to a stable file.
- Keep the same process alive while waiting for auth.
- If a code expires, rotate to a new code and update the active-code file.
- If auth fails mid-batch, pause the queue, obtain a new token, and continue from the same question.
- Assume a 25-dataset batch may require more than one delegated login because token lifetimes and Copilot rate limits may stretch the run across days.

Potential future improvement:

- Investigate whether WorkIQ/A2A supports a sanctioned non-interactive or brokered auth flow. If not, design the operator experience around checkpointed device-code renewals rather than trying to eliminate them entirely.

## Scoring strategy

Every evaluated answer must receive two separate scores:

1. **Deterministic grounding score** - local, repeatable fact/assertion coverage.
2. **Semantic quality score** - LLM-judged answer quality against the prompt, expected answer, assertions, and supporting facts.

### Deterministic grounding score

Use the deterministic local scorer as the objective grounding signal:

- 80% EvalGen `must_contain` assertion coverage.
- 20% supporting-fact value coverage.
- Unicode-normalized, punctuation/spacing-tolerant matching.
- Whole-word matching where EvalGen marks assertions as whole-word.
- Explicit no-result detection for expected no-result prompts.
- Pass/partial/fail status based on assertion coverage.

This score answers: **Did the response contain the required facts?**

### Semantic quality score

Add a required semantic judge stage after deterministic scoring. This score answers: **Was the response actually good, complete, relevant, and faithful?**

The semantic judge should score each response on a 1-5 or 0-100 rubric across:

| Dimension | What the judge checks |
|---|---|
| Relevance | The answer directly addresses the prompt. |
| Correctness | The answer agrees with the expected answer and source facts. |
| Completeness | The answer includes the important facts needed for a useful answer. |
| Groundedness | The answer does not introduce unsupported claims. |
| Citation quality | Citations are present and appropriate when expected. |
| Clarity | The answer is understandable and well structured. |

Default provider order:

1. **M365 Copilot semantic judge through WorkIQ/A2A** - preferred because it keeps scoring in the same Microsoft 365 Copilot environment used for response collection.
2. **GitHub Copilot semantic judge** - acceptable fallback when an automatable local judging path is available.
3. **Azure OpenAI judge** - optional fallback only, not the default, because the user does not want this workflow to depend on Azure OpenAI.

The judge prompt must require structured JSON output, for example:

```json
{
  "semanticScore": 0,
  "relevance": 0,
  "correctness": 0,
  "completeness": 0,
  "groundedness": 0,
  "citationQuality": 0,
  "clarity": 0,
  "passedAssertions": [],
  "failedAssertions": [],
  "rationale": ""
}
```

The semantic judging stage must be resumable and rate-limit-aware just like response collection. Judge responses that are blank, malformed, rate-limited, or non-JSON must be retried and must block final reporting until resolved.

Recommended CLI options:

```powershell
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --semantic-judge m365-copilot
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --semantic-judge github-copilot
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --semantic-judge azure-openai
```

Reports must keep deterministic and semantic scores separate. Do not collapse them into one score unless a later calibration proves the weighting is useful. The comparison should show:

- deterministic grounding score,
- semantic quality score,
- semantic dimension breakdown,
- assertion pass/fail details,
- judge rationale,
- enhanced-vs-RAW delta for both score types.

Before scaling to 25 datasets, run one calibration on the completed D&B set comparing deterministic scores to semantic quality scores. If the scores diverge materially, report the divergence explicitly; this is expected because deterministic scoring rewards exact fact coverage while semantic scoring can recognize correct paraphrases and answer quality.

## Reporting

Each dataset should produce:

- `responses\enhanced\eval.csv`
- `responses\raw\eval.csv`
- `responses\actual-responses.json`
- `scores\agent-response-scoring.md`
- `scores\agent-response-scores.json`
- `dataset-summary.json`
- `dataset-summary.md`

The batch should produce:

- `aggregate-summary.md`
- `aggregate-summary.json`
- `score-matrix.csv`
- `failures-and-retries.md`

Aggregate report columns:

| Column | Purpose |
|---|---|
| Dataset | Dataset slug/display name. |
| Enhanced connection / RAW connection | Traceability to Graph connections. |
| Enhanced agent / RAW agent | Traceability to M365 agent IDs. |
| Question count | Actual comparable prompt count. |
| Enhanced deterministic score | Local fact/assertion grounding score. |
| RAW deterministic score | Local fact/assertion grounding score. |
| Deterministic delta | Enhanced minus RAW deterministic score. |
| Enhanced semantic score | LLM-judged answer quality score. |
| RAW semantic score | LLM-judged answer quality score. |
| Semantic delta | Enhanced minus RAW semantic score. |
| Semantic dimensions | Relevance, correctness, completeness, groundedness, citation quality, and clarity. |
| Pass/partial/fail | Quality breakdown per agent. |
| Citation rate | Answers with citations per agent. |
| Retry count | Operational reliability signal. |
| Rate-limit count | Copilot throttling signal. |
| Indexing readiness time | Time from ingest completion to canary success. |
| Comparable? | Exclude invalid datasets from aggregate winner calculations. |

Do not produce aggregate claims for datasets where either connector failed to index, had invalid responses, or had too few valid questions.

## Implementation phases

### Phase 0: Stabilize known failures

Owner: `C:\Users\bodonnell\src\CopilotConnectorSkill`

Deliverables:

- Skill guidance and sample updates for deterministic connector generation.
- Skill sample updates for current M365 Copilot declarative-agent package format.
- Regression tests/examples for dataset normalization and schema hardening.
- Connector template examples for CSV, JSON array, JSONL-as-`.json`, nested JSON, and sparse records.
- Tests/examples that normal enhanced ingestion always uses the enhancer, and optional RAW-baseline ingestion never uses the enhancer when that pattern is explicitly requested.
- Current declarative agent manifest template pinned and validated in the skill sample.
- Graph schema validation guidance that runs before any tenant write.
- Deprovision guidance tested for both connector and agent cleanup.

Exit criteria:

- The skill reliably directs GitHub Copilot CLI to generate generic enhanced connector/agent artifacts without manual refactoring.
- When the prompt explicitly requests a comparison workflow, a dry-run in the workflow repo can render enhanced and RAW connector/agent artifacts for representative datasets using the updated skill guidance.

### Phase 1: Dual connector and agent automation

Owner: split between `CopilotConnectorSkill` and `CopilotConnectorWorkflow`.

Deliverables:

- `compare-dataset` CLI command.
- Deterministic naming for connections, app packages, and agents.
- Automatic enhanced connector provisioning and ingestion from skill-generated artifacts.
- Automatic RAW connector provisioning and ingestion from skill-generated artifacts when comparison mode requests the optional RAW recipe.
- Automatic enhanced and RAW agent package rendering from skill-generated templates when comparison mode requests paired agents.
- Workflow-side validation, install, and agent ID discovery.
- Run database with connector and agent state.

Exit criteria:

- One dataset can be provisioned end-to-end without manual connector/agent edits, and any generic artifact defect is fixed in `CopilotConnectorSkill`, not patched ad hoc in the generated job folder. Comparison-specific orchestration remains in `CopilotConnectorWorkflow`.

### Phase 2: EvalGen, WorkIQ response runner, and local scorer

Owner: primarily `CopilotConnectorWorkflow`, with optional `EvaluationCLI` changes if wrapping EvalGen is not enough.

Deliverables:

- Automated 100-question EvalGen multi-batch generation and merge.
- Indexing readiness canary gate.
- Long-lived WorkIQ REST/A2A response runner with durable token cache.
- Resumable per-question queue with adaptive backoff.
- Local deterministic scorer integrated as the grounding metric.
- Required semantic quality judge integrated with pluggable providers.
- Invalid-response gate before scoring.
- Invalid or malformed semantic-judge output blocks final reporting.

EvaluationCLI change decision:

- If EvalGen can remain capped at 50 and still emits stable `eval.csv` plus `eval.evalgen.json`, keep multi-batch orchestration in `CopilotConnectorWorkflow`.
- If 25 datasets expose repeated EvalGen merge/dedup issues, add first-class `--target-count`, `--avoid-evalsets`, and near-duplicate reporting support in `C:\Users\bodonnell\src\EvaluationCLI`.

Exit criteria:

- One dataset can complete enhanced-vs-RAW response collection and scoring with no manual CSV/script edits.

### Phase 3: Batch runner for 25 datasets

Owner: `C:\Users\bodonnell\src\CopilotConnectorWorkflow`

Deliverables:

- `compare-batch` CLI command.
- Batch manifest support.
- Resume/retry across process restarts.
- Per-dataset and aggregate reports.
- Cost/time estimate printed before starting a full batch.
- `--dry-run` mode that exercises all local steps without Graph writes or Copilot calls.

Exit criteria:

- A 2-3 dataset pilot batch completes unattended except for expected WorkIQ re-auth prompts.

### Phase 4: Operational hardening

Deliverables:

- Dashboard or report viewer for batch state.
- Failure triage report.
- Cleanup/deprovision tooling.
- Required semantic quality score and semantic dimension breakdown.
- Documentation for operator workflow and auth renewal.

Exit criteria:

- 25-dataset run can be launched, monitored, resumed, and reported from documented commands.

## Recommended command flow

Pilot one dataset:

```powershell
npm run build
node dist\cli.js compare-dataset --config .\datasets\dnb.compare.json --dry-run
node dist\cli.js compare-dataset --config .\datasets\dnb.compare.json --confirm
```

Pilot a small batch:

```powershell
node dist\cli.js compare-batch --manifest .\datasets\pilot-3.json --dry-run
node dist\cli.js compare-batch --manifest .\datasets\pilot-3.json --confirm --resume
```

Full 25-dataset batch:

```powershell
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --confirm --resume
```

Resume only response collection:

```powershell
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --start-at responses --resume
```

Generate aggregate reports from existing state:

```powershell
node dist\cli.js compare-batch --manifest .\datasets\batch-25.json --report-only
```

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

## Immediate next implementation tasks

### Current implementation status

| Item | Status | Notes |
|---|---|---|
| Connector skill deterministic guidance | Implemented | Added deterministic generation contract plus detailed reference. |
| Optional RAW-baseline skill recipe | Implemented | Added as explicit prompt/workflow-triggered recipe, not default behavior. |
| Installed Copilot Connector Skill sync | Implemented | Source repo includes `install.ps1`; installed skill was updated from source. |
| Workflow compare state contract | Implemented | `compare-dataset` and `compare-batch` write `compare-state.json` in dry-run/planning mode. |
| Full compare execution | Not started | Provisioning, agent deployment, indexing readiness, response collection, and scoring still need implementation behind the compare state machine. |
| EvaluationCLI native changes | Deferred | Workflow wraps current EvalGen first; EvaluationCLI changes only if target-count/dedup wrapping proves brittle. |

1. Implement full execution for `compare-dataset` and `compare-batch` from the new compare state contract.
2. Add a SQLite run-state layer for datasets, connectors, agents, questions, responses, and scores.
3. Promote the D&B custom RAW connector generator into an optional comparison-mode Step 4 output, not the default connector output.
4. Replace the current agent manifest template with a pinned current Copilot declarative-agent template and validator test.
5. Move the 100-question EvalGen merge logic into TypeScript workflow code.
6. Move the Python WorkIQ collector/scorer logic into reusable workflow modules or package them as maintained scripts invoked by the CLI.
7. Add durable WorkIQ token cache and active-device-code behavior outside individual job folders.
8. Add indexing canary prompts and readiness checks.
9. Add invalid-response gating before scoring.
10. Add semantic quality judging with M365 Copilot as the preferred provider and GitHub Copilot/Azure OpenAI as fallbacks.
11. Build aggregate reporting and pilot with 2-3 datasets before running all 25.
