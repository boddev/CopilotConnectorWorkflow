# User guide — CopilotConnectorWorkflow WinUI

## 1. Install

### Option A — MSIX (recommended)

1. Download the latest signed MSIX from the
   [GitHub releases page][releases] (look for
   `CopilotConnectorWorkflow.WinUI_<version>_x64.msix` or `_arm64.msix`).
2. Double-click the `.msix`. Windows App Installer will open and show
   the publisher, version, and required capabilities. Click **Install**.
3. Launch **Copilot Connector Workflow** from the Start menu.

The MSIX bundles the full .NET 10 runtime and Windows App SDK 2.1.x —
no separate runtime install is required. It does **not** install the
external pipeline tools (Node, Git, Azure CLI, M365 Agents Toolkit,
GitHub CLI + Copilot extension) — the in-app first-run wizard handles
those.

[releases]: https://github.com/boddev/CopilotConnectorWorkflow/releases

### Option B — winget configure (enterprise pre-provisioning)

If you want to provision the external dependencies *before* installing
the MSIX (e.g. on a managed image, or in a non-interactive setup
script), download `ccw-deps.dsc.winget.yaml` from the release and run:

```powershell
winget configure --file ccw-deps.dsc.winget.yaml
```

This installs all required external CLIs via WinGet. Then install the
MSIX from Option A.

### Option C — portable CLI only

If you only need `ccw.exe` (no GUI), download
`ccw-<version>-win-x64.zip`, extract it anywhere, and add the folder to
your `PATH`. The portable CLI behaves identically to the in-MSIX CLI;
it does not register file associations or system-tray icons.

## 2. First run

On first launch, `CcwUI.exe` checks for the external pipeline tools and
shows a wizard if anything is missing or out-of-date:

| Tool | Required for | Installed via |
| --- | --- | --- |
| Node.js 22.21.1 LTS or later | Step 4 (`npm install`, `tsc`), Step 2 enhancer shim | WinGet (`OpenJS.NodeJS.LTS`) |
| Git | Sibling-repo bootstrap | WinGet (`Git.Git`) |
| Azure CLI | Step 5 deploy (`az login`, `az ad app create`, ARM deploys) | WinGet (`Microsoft.AzureCLI`) |
| M365 Agents Toolkit (`atk`) | Step 5 deploy (`atk install`) | `npm install -g @microsoft/teamsapp-cli` (wizard) |
| GitHub CLI + `gh-copilot` extension | Step 6 (GitHub Copilot judge) | WinGet (`GitHub.cli`) + `gh extension install github/gh-copilot` |
| EvaluationCLI + CopilotConnectorSkill (sibling repos) | Step 1 evalgen + Step 6 scoring (Node fallback) | `git clone` + `npm install` (wizard, optional) |

Each row has an **Install** button that runs the install non-interactively
and reports progress in the wizard. If WinGet isn't available (Windows
Server / LTSC images), the wizard surfaces the manual install command
for each tool — install is best-effort; the *detection layer* is the
load-bearing piece.

If anything is missing on later launches, the app shows a non-blocking
banner with **Open wizard** rather than blocking startup. You can also
open the wizard at any time from the **Diagnostics** page.

> **PATH visibility caveat.** Tools installed via the in-app wizard
> only become visible to the *currently running* `CcwUI.exe` process
> after it restarts. The wizard prompts you to restart once installs
> complete. Tools installed via `winget configure --file` BEFORE
> launching the app are visible immediately.

### Sign in

The first time you run a job in **Provision** mode (Step 5 deploys the
connector to Azure / Graph), the app prompts for:

- An **Azure AD app registration** with Graph application permissions
  (`ExternalConnection.ReadWrite.OwnedBy` minimum). The app uses MSAL
  with the WAM broker; you'll see the standard Windows account picker.
- An **Azure subscription** for the connector function app.
- Optionally, the **WorkIQ A2A** sign-in if you've enabled the WorkIQ
  judge for Step 6. This shares the same MSAL cache with the
  `eval-ui-winui3` app, so if you've already authorised `WorkIQAgent.Ask`
  there, you won't be prompted again.

## 3. Run a job

The **New Job** page is a direct port of the Node app's form, field for
field. Recommended path for a first run:

1. **Dataset.** Pick a folder under `data/` (e.g. `data/ngo-environment/`).
2. **Description.** A short human-readable label (e.g.
   `"NGO environment build mode smoke"`).
3. **Connector.** Pick or create the connector display name + ID.
4. **Mode.** Start in **Build** mode (no Azure / Graph calls, no deploy).
5. **Step 2 toggles.** Leave the enhancer on for the first run.
6. **Eval source.** *(Optional)* Reuse an existing eval set from a prior
   job for deterministic re-runs.
7. **Run.**

The **Job detail** page streams the same line-for-line log output the
Node app writes to stdout, plus the per-step `step.log` files. Markdown
reports (scored report, schema validation) render inline.

## 4. Resume a job

Jobs that fail mid-pipeline can be resumed from any step boundary. From
the **Jobs list** page, right-click the job → **Resume from step…** →
pick the step. The content-hash cache layer guarantees that if upstream
inputs haven't changed, downstream steps are short-circuited.

## 5. Compare two jobs

The **Compare** page picks two jobs and emits a side-by-side report.
Auto-eligibility filtering only lets you pick jobs with matching
`dataset` + `evalSetHash` and opposite `noEnhance` flag (so you can see
the enhancer's effect on the same dataset deterministically).

## 6. Where things live

- **Workspace.** `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs\<jobId>\`.
  Same `job.json`, `step.log`, `artifacts/`, and `eval/` layout as the
  Node app's `workspace/jobs/<jobId>/`.
- **Settings.** `%LOCALAPPDATA%\CopilotConnectorWorkflow\settings.json`
  — user overrides for tool paths, sibling-repo locations, theme.
- **Logs (app, not job).** Same folder, under `logs\`.
- **MSAL token cache.** Shared with `eval-ui-winui3` at
  `%LOCALAPPDATA%\EvalToolkit\msal-a2a-cache.bin` for WorkIQ; the Graph
  client-credentials token cache is per-app.

## 7. Coexisting with the Node app

If you already have a Node `workspace/jobs/` directory with prior runs,
the WinUI app offers a one-time **Import existing jobs** action from the
**Settings** page. Importing copies each `job.json` (rewriting the
absolute `workspace` path to the new `%LOCALAPPDATA%` location) and
preserves all artefacts. Imported jobs are tagged `legacy/migrated` in
the Jobs list.

The Node app keeps running unchanged — the import is a copy, not a
move, so you can roll back at any time by uninstalling the MSIX.

## 8. Uninstall

**Settings → Apps → Installed apps → CopilotConnectorWorkflow → Uninstall**,
or `winget uninstall CopilotConnectorWorkflow.WinUI`. This removes the
app but **does not** remove the workspace under `%LOCALAPPDATA%` (so
your jobs survive an uninstall + reinstall). To remove everything,
delete `%LOCALAPPDATA%\CopilotConnectorWorkflow\` after uninstalling.
