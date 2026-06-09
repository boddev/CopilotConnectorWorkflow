# CopilotConnectorWorkflow — WinUI 3 (Windows native)

A Windows-native, MSIX-installable port of the
[CopilotConnectorWorkflow][repo] (CCW) Node app. Same on-disk job format,
same 6-step pipeline, same `data/` and `templates/` payloads — running on
.NET 10 and Windows App SDK 2.1.x with no separate Node install required
to *launch* the app.

[repo]: https://github.com/boddev/CopilotConnectorWorkflow

> **Status.** Working set, Phases 0–9 complete and signed off by both
> reviewer models (Claude Opus-4.8 and GPT-5.5) at every phase boundary.
> Phase 10 = this docs set + cutover instructions. v1 ships:
>
> - `CopilotConnectorWorkflow.WinUI` MSIX (`CcwUI.exe` — the GUI head).
> - `ccw-<version>-win-x64.zip` portable archive containing `ccw.exe`
>   (the CLI — shipped separately in v1; bundling inside MSIX deferred
>   to a v2 spike, see [`developer-guide.md`](developer-guide.md)).
> - `ccw-deps.dsc.winget.yaml` Desired State Configuration manifest for
>   pre-launch dependency provisioning (`winget configure --file ...`).

## When to use the WinUI app vs the Node app

| Use case | Recommended |
| --- | --- |
| Local Windows desktop user; wants an installer + GUI | **WinUI MSIX** |
| Already on macOS or Linux | Node app |
| CI / headless build pipeline | Node app *or* `ccw.exe` portable |
| Enterprise endpoint with DSC-managed dependency baseline | **WinUI** + `winget configure` |
| Need parity with existing Node `workspace/jobs/` history | Node app (or use the WinUI app's job-import migration on first run) |

Both surfaces share the on-disk job format ([file-formats.md](file-formats.md)),
so a job can be inspected by either runtime. The WinUI app stores jobs
under `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs\`; the
Node app continues to use the repo-relative `workspace/` directory.

## Docs in this folder

- **[User guide](user-guide.md)** — install, first run, run a job,
  resume, compare.
- **[CLI reference](cli-reference.md)** — every `ccw.exe` command and
  flag, mapped to the Node `ccw` equivalent.
- **[Developer guide](developer-guide.md)** — solution layout, building
  from source, running tests, EvalToolkit consumption, port philosophy.
- **[CI / release setup](ci-release-setup.md)** — GitHub Actions
  workflows, Azure Trusted Signing OIDC, manual release process.
- **[Troubleshooting](troubleshooting.md)** — known issues, diagnostics
  output, workspace recovery.
- **[File formats](file-formats.md)** — on-disk parity contract between
  the WinUI and Node runtimes.

## Where the source lives

Everything in this port is under `winui3/` in the
CopilotConnectorWorkflow repo. The Node app, `templates/`, and `data/`
all stay where they are; the WinUI port consumes the same
`templates/` tree by embedded resource and produces interchangeable
artefacts.
