# File formats — on-disk parity between WinUI and Node CCW

This is the **contract** that makes WinUI jobs and Node jobs
interchangeable. Both runtimes read and write the same shapes, hash
the same way, and lay out artefacts in the same tree. Any deviation
here is a parity bug.

## 1. Workspace root

| Runtime | Root |
| --- | --- |
| WinUI | `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\` |
| Node | `<repo root>\workspace\` |

Roots differ deliberately so the two runtimes don't fight over a
single directory (different MSAL caches, different .NET vs Node
process tree, etc.). The *structure under the root* is identical.

```text
workspace/
├── .lock                       # single-writer lock for the workspace
├── jobs/
│   └── <jobId>/
│       ├── job.json            # canonical job record (see §3)
│       ├── step.log            # combined log
│       ├── step1.log .. step6.log
│       ├── artifacts/
│       │   ├── connector/      # rendered TS Agents Toolkit project (Step 4)
│       │   ├── deploy/         # rendered deploy scripts (Step 5)
│       │   ├── schema-validation.json
│       │   └── ...
│       └── eval/
│           ├── eval.evalgen.json
│           ├── agent-responses.json
│           └── agent-response-scores.json
└── compare/
    └── compare-<jobIdA>-vs-<jobIdB>.md
```

## 2. Job ID

A 12-hex-character lower-case string. Generated as the first 12 chars
of a SHA-256 over `(timestamp_unix_ms || dataset_path || random_bytes(8))`.
Identical algorithm in both runtimes; the only non-deterministic input
is the random tail, so collisions are vanishingly unlikely. **Do not
truncate further** — 12 chars is the wire format.

## 3. `job.json`

The canonical job record. Both runtimes emit byte-equivalent files
once the canonicalisation rules below are applied. **Property order
matters for hashing** — STJ source-gen with explicit attributes in the
WinUI port matches the TS literal property order exactly.

Field reference (truncated; see `Ccw.Core/JobRecord.cs` for the
authoritative list):

| Field | Type | Notes |
| --- | --- | --- |
| `jobId` | string (12 hex) | See §2. |
| `schemaVersion` | string | Currently `"0.1.0"`. |
| `createdAt` | string (ISO 8601 UTC, `Z` suffix) | Hash input; *not* allowlisted in parity diffs. |
| `description` | string | User-supplied. |
| `mode` | `"build"` \| `"provision"` \| `"deprovision"` | |
| `dataset` | string | Absolute path (per workspace). |
| `datasetHash` | string (64 hex SHA-256) | See §4. |
| `evalSetHash` | string (64 hex SHA-256) | See §4. |
| `inputsHash` | string (64 hex SHA-256) | Composite hash; see §4. |
| `connector` | object | `{id, displayName, schema, transform}`. |
| `noEnhance` | boolean | If `true`, Step 2 used the identity transform. |
| `judge` | `"copilot"` \| `"workiq"` \| `"both"` | Step 6. |
| `evalToolkitCommit` | string (8 hex prefix) | Pinned EvalToolkit commit. |
| `steps` | array of step records | See §5. |
| `tags` | array of strings | E.g. `["legacy/migrated"]` for Node-imported jobs. |

### 3.1 Canonicalisation rules for parity

When the WinUI parity harness (`tests/Ccw.Parity.Tests`) diffs WinUI
`job.json` against a Node `job.json`, it canonicalises both before
comparison:

- **Sort keys recursively.** Property order in `job.json` is the
  property declaration order in the TS literal; the parity harness
  normalises to lex-sorted to absorb any future ordering drift.
- **`UnsafeRelaxedJsonEscaping`.** Do not HTML-escape `<>&+`; preserve
  non-ASCII bytes. JS `JSON.stringify` doesn't escape these by
  default; STJ does unless you use this encoder.
- **Numeric formatting under `InvariantCulture`.** Both runtimes use
  invariant culture (Node `JSON.stringify` is locale-independent
  always; C# is by convention here).
- **Allowlist (replace with stable placeholder before diff):**
  - Timestamps (`createdAt`, `updatedAt`, `step[].startedAt`, etc.)
    → `<TS>`.
  - Absolute workspace paths under the workspace root → `<WS>`.
  - GUIDs → `<GUID>`.
  - Epoch ms (13-digit) → `<EPOCHMS>`.
- **NOT allowlisted (drift here is a real bug — the harness MUST
  detect it):**
  - `datasetHash`, `evalSetHash`, `inputsHash` — these are 64-hex
    SHA-256 fields, and the whole point of the parity harness per
    plan §4.8 is to diff them.
  - `evalToolkitCommit` — 8-char commit SHA, intentionally pinned for
    reproducibility (plan §5).
  - Any other hash field that ends in `Hash`.

## 4. Hashes

All hashes are **SHA-256, hex-encoded, lower-case, 64 characters**.

### 4.1 `datasetHash`

```text
SHA-256(
  sorted-by-relative-path concat of (
    relative_path || "\n" || SHA-256(file_bytes)
  ) for each file under dataset/
)
```

Sort is invariant-ordinal on the *relative path* (forward slashes).
`localeCompare` in the Node implementation is normalised to invariant-
ordinal for parity (the underlying `localeCompare` is UCA-based, and
the C# port uses `InvariantCulture.CompareInfo.GetStringComparer`).

### 4.2 `evalSetHash`

```text
SHA-256(canonical-JSON-bytes(eval.evalgen.json))
```

Canonical-JSON-bytes here means: sorted keys recursively,
`UnsafeRelaxedJsonEscaping`, no indentation, no trailing whitespace.

### 4.3 `inputsHash`

```text
SHA-256(
  datasetHash || "|" ||
  evalSetHash || "|" ||
  noEnhance ? "1" : "0" || "|" ||
  judge || "|" ||
  connector.schema_canonical_json
)
```

The composite hash determines cache hits when resuming. Two jobs with
the same `inputsHash` reuse each other's artefacts; differing
`inputsHash` re-runs from Step 1.

## 5. Step records

Each step in `job.json[steps]`:

| Field | Type | Notes |
| --- | --- | --- |
| `step` | int (1..6) | |
| `name` | string | E.g. `"evalgen"`, `"enhance"`, `"schema"`. |
| `status` | `"pending"` \| `"running"` \| `"ok"` \| `"failed"` \| `"skipped"` | |
| `startedAt` | string (ISO 8601 UTC) | Allowlisted in parity diffs. |
| `finishedAt` | string (ISO 8601 UTC) | Allowlisted in parity diffs. |
| `durationMs` | int | Allowlisted in parity diffs. |
| `cacheHit` | boolean | If `true`, the step's outputs came from a prior job's `inputsHash` match. |
| `outputs` | object | Per-step output manifest; the `*Hash` fields inside are NOT allowlisted. |

## 6. Templates and rendered artefacts

The connector project written to `artifacts/connector/` is a verbatim
render of `templates/connector-project/` with the templater's tiny
`{{key}}` substitution applied. The deploy scripts under
`artifacts/deploy/` follow the same rule with
`templates/deploy/`. Both subtrees are **byte-exact** between WinUI and
Node — the parity harness diffs raw bytes, no normalisation, including
CRLF / LF.

The `.gitattributes` under `templates/` pins EOLs so build-machine
encoding settings don't leak into the rendered output. The WinUI port
embeds these as `EmbeddedResource` with `LogicalName` and ships raw
bytes.

**Files that are NOT byte-diff'd** (npm rewrites them, so they're
canonical-JSON diff'd instead):

- `artifacts/connector/package.json`
- `artifacts/connector/tsconfig*.json` (any tsconfig)

`node_modules/` and `package-lock.json` are **skipped entirely** —
neither runtime pins npm and they're effectively non-deterministic.

## 7. Scored report — `agent-response-scores.json`

Step 6 output. Property order matches the Node implementation
(score-fields-first, then per-row breakdowns). Parity diff is canonical
JSON, all `*Hash` fields preserved exact.

## 8. Comparator output — `compare-<a>-vs-<b>.md`

Markdown report. Diff'd as plain text in the parity harness with the
following lines allowlisted:

- Any line starting with `_Run timestamp:`.
- Any line ending in an ISO timestamp.

## 9. Schemas published to the connector

The Microsoft Graph external-connection schema written by Step 3 is in
`artifacts/connector-schema.json`. Per the Graph constraint validator
in `Ccw.Steps`, every property name matches `^[A-Za-z][A-Za-z0-9]{0,31}$`
(no underscores, no digits-at-start, max 32 chars) and every required
property is listed in `requiredProperties`. The validator runs in both
runtimes; mismatched validation between the two would be a port bug.
