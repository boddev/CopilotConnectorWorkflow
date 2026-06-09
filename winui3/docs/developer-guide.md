# Developer guide — building the WinUI 3 port

## 1. Prereqs

- Windows 11 22H2+ or Server 2022 (Server LTSC also works, but the
  in-app wizard's WinGet path is disabled).
- **.NET SDK 10.0.300** (pinned in `winui3/global.json`,
  `latestPatch=false`, `allowPrerelease=false`).
- Visual Studio 2022 17.12+ **or** the standalone Windows App SDK 2.1.x
  + MSIX VS Build Tools (CI uses standalone — see
  [`ci-release-setup.md`](ci-release-setup.md)).
- **Sibling EvalToolkit repo** at
  `..\..\copilot-eval-utils\eval-ui-winui3\` (relative to the
  `CopilotConnectorWorkflow` repo root), OR set the `EvalToolkitRoot`
  env var to its path. With neither, the build falls back to NuGet
  using the version pinned in `Directory.Packages.props`.

```powershell
git clone https://github.com/boddev/CopilotConnectorWorkflow
git clone https://github.com/boddev/copilot-eval-utils  # for EvalToolkit ProjectReference
cd CopilotConnectorWorkflow\winui3
dotnet restore CopilotConnectorWorkflow.slnx
dotnet build CopilotConnectorWorkflow.slnx -c Release
```

## 2. Solution layout

See [`winui3/`](..) in the repo. The plan in `~/.copilot/session-state`
is the authoritative source for *why* each project exists; this section
is a fast index.

| Project | Purpose |
| --- | --- |
| `src/Ccw.Core` | Pure logic: types, hashing, jobs, scoring, schema validator, templating, identity transform, dataset utils, comparator, MSAL auth, process runner. **No UI, no subprocess control of pipeline tools.** |
| `src/Ccw.Steps` | Step 1–6 implementations. Step 1 / 6 call EvalGen / EvalScore directly (in-process). Step 4 / 5 shell out to npm / atk / az. Step 2 currently ships the TS-enhancer shim path; C# port behind a feature flag. |
| `src/Ccw.Templates` | Single project that embeds `templates/connector-project/` and `templates/deploy/` as `EmbeddedResource` with `LogicalName` and *raw bytes*. The `.gitattributes` under `templates/` pins EOLs so CRLF / LF drift on the build machine doesn't leak into snapshot tests. |
| `src/Ccw.Bootstrap` | Dependency probes + WinGet driver + sibling-repo helper. Probes are load-bearing, install is best-effort. Used by both the CLI (`ccw tools`, `ccw diagnostics`) and the UI (first-run wizard, Diagnostics page). |
| `src/Ccw.Cli` | `ccw.exe` — System.CommandLine command tree mirroring `src/cli.ts`. Console-only, AOT-friendly publish profile. **Not bundled in v1 MSIX**; ships in portable ZIP only. |
| `src/Ccw.UI` | WinUI 3 head — `CcwUI.exe`. MVVM + CommunityToolkit.Mvvm. Single-project MSIX (`WindowsPackageType=MSIX`), self-contained .NET 10 + Windows App SDK 2.1.x. |
| `tests/Ccw.Core.Tests` | 125 tests. Includes the cross-runtime parity fixtures (locale-compare, JSON.stringify escaping, regex ASCII-vs-Unicode). |
| `tests/Ccw.Bootstrap.Tests` | 25 tests covering probe parsing + WinGet ID resolution. |
| `tests/Ccw.Cli.Tests` | 18 tests covering CLI argument parsing + log-stream output. |
| `tests/Ccw.Parity.Tests` | 27 tests covering the *parity differ* itself (the harness that diffs WinUI vs Node artefacts). |
| `tests/Ccw.Steps.Tests` | 37 tests covering step-by-step orchestration. |
| `tests/Ccw.Templates.Tests` | 6 tests covering byte-exact template propagation from source tree to MSIX/portable output. |

## 3. EvalToolkit consumption

`Directory.Build.props` resolves the EvalToolkit source root by probing
a candidate list (sibling repo at the 4-up path, `$(USERPROFILE)\src\`,
`$(EvalToolkitRoot)` env var). The first existing path wins. If none
exist, the build sets `UseEvalToolkitNuGet=true` and consumes the
pinned NuGet packages from `Directory.Packages.props` instead.

**Local `ProjectReference` is a dev convenience.** Release builds pin
the EvalToolkit version via `<EvalToolkitVersion>` in
`Directory.Packages.props` and use the NuGet path. CI fails the build
if the locally referenced commit doesn't match the pinned NuGet
version, so the MSIX output is bit-for-bit reproducible from the
pinned version.

## 4. Running tests

```powershell
cd winui3
dotnet test CopilotConnectorWorkflow.slnx -c Release
```

Expected: **238 tests pass** (Core 125 + Bootstrap 25 + Cli 18 +
Parity 27 + Steps 37 + Templates 6).

To run a single project:

```powershell
dotnet test winui3/tests/Ccw.Core.Tests -c Release
```

To run a single filter:

```powershell
dotnet test winui3/tests/Ccw.Parity.Tests --filter "FullyQualifiedName~HashDriftIsCaught"
```

## 5. Building the MSIX locally

```powershell
cd winui3
.\packaging\msix\build-msix.ps1 -Configuration Release -Arch x64
.\packaging\msix\install-locally.ps1 -Configuration Release
```

The install script signs the MSIX with the included dev cert and
installs it. The first invocation elevates (UAC prompt) so the dev
cert can be added to `LocalMachine\Trusted People`.

## 6. Building the portable CLI ZIP

```powershell
cd winui3
.\packaging\portable\build-cli-zip.ps1 -Configuration Release -Rid win-x64
```

Output: `winui3\packaging\portable\dist\ccw-<version>-win-x64.zip`. The
zip contains a single-file self-contained `ccw.exe` plus the
`templates/` folder (extracted from `Ccw.Templates` for runtime
discovery).

## 7. CLI parity scope

Per the plan §4 (Phase 4 / Opus I7):

- **The step log stream is parity.** Scripts that scrape Node CCW's
  per-step `ok` / `fail` lines parse the C# CCW's output identically.
- **Help / error / usage text is NOT parity.** System.CommandLine
  formats its own; we don't fight it.
- **Exit codes are parity.** Same numbers for the same outcomes.

The Phase 8 parity test harness (`tests/Ccw.Parity.Tests`) diffs
*artefacts* (job.json, rendered templates, scored reports), not stdout.

## 8. Port philosophy

The port **replicates Node's quirks, not "fixes" them**. The contract
is parity with the upstream Node app, not deviation. Tracked traps:

- **`localeCompare`** — JS uses UCA, .NET defaults vary by culture.
  Port uses `CultureInfo.InvariantCulture.CompareInfo.GetStringComparer`
  (or `JsLocaleCompareComparer`) with a tricky-string fixture.
- **`JSON.stringify` escaping** — JS doesn't HTML-escape `<>&+`, STJ
  does by default. Port uses `JavaScriptEncoder.UnsafeRelaxedJsonEscaping`.
  Property order matters for hashing; STJ source-gen with explicit
  attributes.
- **Regex `\w`, `\d`, `\s`** — JS is ASCII by default, .NET is Unicode
  by default. Every ported regex uses `RegexOptions.ECMAScript` (where
  applicable) or explicit ASCII classes (`[A-Za-z0-9_]`).
- **`InvariantCulture`** — Every `ToString` / parse in `Ccw.Core` is
  `InvariantCulture`. `CA1305` analyzer rule pins this.
- **`displayValue()` no-op preservation** — the enhancer's
  `displayValue()` is a no-op in TS; the C# port (2.2-b) preserves
  the same shape.
- **`${{ENV_VAR}}` preservation** — the templater intentionally leaves
  `${{...}}` syntax alone (M365 Agents Toolkit consumes it). The C#
  templater has an explicit guard against substitution inside a
  `${{...}}` span.

## 9. v2 spike — `ccw.exe` in MSIX with appExecutionAlias

Currently v1 ships the CLI in the portable ZIP only. Bundling `ccw.exe`
inside the single-project MSIX and exposing it via
`windows.appExecutionAlias` is documented in the plan §5 as a v2 spike
(folder `spike/cli-in-msix/`). The risks identified:

1. Single-project MSIX + a second self-contained exe is unproven in
   the sibling `eval-ui-winui3` solution.
2. The two self-contained .NET 10 runtimes would bloat the package by
   ~150 MB unless they share runtime files (which requires careful
   project graph tweaking).
3. `appExecutionAlias` collisions with `ccw` on Windows are a
   late-discovery risk.

The spike has not been implemented; it would land if user telemetry
shows enough demand for PATH-out-of-box.

## 10. Folding new EvalToolkit fixes

When upstream `eval-ui-winui3` ships a fix that also matters here:

1. Update `<EvalToolkitVersion>` in `Directory.Packages.props` to the
   new pinned version.
2. Push the EvalToolkit branch and let its CI publish the new NuGet
   package.
3. Rebuild locally — `dotnet restore` will pick up the new version.
4. Run the full test suite + the Phase 8 parity harness.
5. Commit `Directory.Packages.props` change + any porting deltas in
   `Ccw.Core` / `Ccw.Steps`.
