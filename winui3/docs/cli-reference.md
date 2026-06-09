# `ccw.exe` CLI reference

The portable CLI ships in `ccw-<version>-win-x64.zip`. Unzip anywhere
and add to PATH, or invoke by absolute path. All commands mirror the
Node `ccw` CLI's *log-stream output* line for line (so scripts that
parsed Node CCW output keep working). The help / usage text is
intentionally divergent because System.CommandLine formats its own;
see the [developer guide](developer-guide.md#cli-parity-scope) for the
parity rules.

## Commands

```text
ccw run [options]
ccw resume <jobId> [options]
ccw compare <jobIdA> <jobIdB>
ccw status <jobId>
ccw list [--all] [--mode build|provision|deprovision]
ccw tools
ccw auth [--graph] [--workiq] [--device-code]
ccw diagnostics [--src-root <path>]
```

### `ccw run`

Start a new job from a dataset folder.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dataset <path>` | *required* | Dataset folder (e.g. `data/ngo-environment/`). |
| `--description <text>` | `""` | Short human-readable label. |
| `--connector-id <id>` | derived | Microsoft Graph external connection id. |
| `--connector-display-name <name>` | derived | Display name. |
| `--mode <build\|provision\|deprovision>` | `build` | Pipeline mode. |
| `--no-enhance` | off | Skip Step 2 enhancer; use identity transform. |
| `--judge <copilot\|workiq\|both>` | `copilot` | Step 6 judge. |
| `--reuse-eval-from <jobId>` | none | Re-use the eval set from a prior job (skips Step 1 regeneration). |
| `--eval-set <path>` | none | Use a pre-built eval set file. |
| `--acl-mode <everyone\|users>` | `everyone` | Step 5 ACL setup. |
| `--src-root <path>` | derived | Override sibling-repo parent directory. |

The log stream to stdout matches the Node app exactly. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | All 6 steps succeeded; `scored-report.md` written. |
| `1` | One or more steps failed; `step.log` has details. |
| `2` | Pre-flight failed (auth, missing dependency, dataset invalid). |
| `3` | Workspace lock taken by another `ccw.exe`. |

### `ccw resume`

Resume a job from a step boundary. The content-hash cache short-
circuits unchanged upstream steps automatically.

```text
ccw resume <jobId> [--from <step1..step6>]
```

If `--from` is omitted, resume from the earliest failed step.

### `ccw compare`

Compare two completed jobs (build-mode against build-mode, etc.). Both
jobs must have the same `dataset` + `evalSetHash` and opposite
`noEnhance` flag.

```text
ccw compare <jobIdA> <jobIdB>
```

Writes `compare-<jobIdA>-vs-<jobIdB>.md` under the workspace `compare/`
subdir.

### `ccw status`

Print the current state of a job (step grid + last 10 log lines per
step).

```text
ccw status <jobId>
```

### `ccw list`

List jobs in the workspace. Default lists only the most recent 25;
`--all` lists every job. `--mode` filters by pipeline mode.

```text
ccw list [--all] [--mode build|provision|deprovision]
```

### `ccw tools`

Probe the local pipeline tooling. Reports paths and OK/FAIL for:

- The CCW MSIX install dir or repo root (templates root).
- The vendored TS enhancer (source + compiled).
- The sibling EvaluationCLI repo (`eval-gen`, `eval-score`).
- The sibling CopilotConnectorSkill repo.

Exit code 0 iff every tool resolves OK.

### `ccw auth`

Pre-flight Microsoft Graph and WorkIQ authentication for the next
provision-mode run.

| Flag | Effect |
| --- | --- |
| `--graph` | Acquire / refresh Graph token, probe `/external/connections`. |
| `--workiq` | Acquire / refresh WorkIQ A2A token. |
| `--device-code` | Force device-code flow (default in CLI). |

The CLI always uses **device-code** flow; WAM broker is GUI-only.
Tokens are cached in the shared MSAL cache at
`%LOCALAPPDATA%\EvalToolkit\msal-a2a-cache.bin` (WorkIQ) and a per-app
cache for Graph.

### `ccw diagnostics`

Headless probe — emits a single JSON envelope to stdout summarising:

- CLI version + schema version.
- OS version, process architecture, process path.
- Every external dependency (Node, Git, Azure CLI, atk, gh, gh-copilot,
  sibling repos) — `present`, `version`, `meetsMinimumVersion`,
  `requiredAction`.
- Every internal tool (templates root, EvalGen, EvalScore, enhancer
  paths) — `path`, `ok`, `note`.

Exit code:

- `0` — every dependency present AND meets minimum version AND every
  tool OK.
- `1` — anything missing / outdated / not OK. The JSON envelope is
  still well-formed (the `error` field is populated on probe-layer
  exception, otherwise omitted).

This command is the contract that CI smoke jobs consume. The output
schema is versioned (`schemaVersion: "1"`); a consumer should refuse
to parse an unfamiliar version.

Example output (truncated):

```json
{
  "schemaVersion": "1",
  "cli": {
    "version": "0.1.0",
    "schemaVersion": "0.1.0",
    "processPath": "C:\\Tools\\ccw\\ccw.exe",
    "osVersion": "Microsoft Windows NT 10.0.26100.0",
    "processArchitecture": "X64"
  },
  "dependencies": [
    {
      "name": "node",
      "displayName": "Node.js 22.21.1 (LTS) or later",
      "present": true,
      "version": "v22.21.1",
      "expectedMinimumVersion": "22.21.1",
      "meetsMinimumVersion": true,
      "path": "C:\\Program Files\\nodejs\\node.EXE"
    }
  ],
  "tools": [
    {
      "name": "eval-gen",
      "path": "C:\\Users\\me\\src\\EvaluationCLI\\eval-gen\\dist\\index.js",
      "ok": true
    }
  ],
  "allOk": true
}
```

## Differences from the Node CLI

Where the Node app has loose argv parsing (`parseArgs` with no typing,
unknown flags ignored, `--flag value` vs trailing boolean tolerated),
the C# CLI uses System.CommandLine — which is stricter and emits its
own help. The contract is:

- **Log-stream output is identical.** Scripts that parsed Node CCW
  `step1 ok`, `step6 done`, etc. lines work unchanged.
- **Exit codes are identical** for the same outcomes.
- **Help / usage text is intentionally different.** Don't parse it.
- **Unknown flags are rejected** in C# (Node ignored them). Migrating
  scripts may need to drop unrecognised flags.

If you need bit-exact argv compatibility (e.g. a wrapper script that
shells out to either CLI), prefer driving `ccw` via JSON config files
(`--config <file.json>`) — that's identical between the two runtimes.
