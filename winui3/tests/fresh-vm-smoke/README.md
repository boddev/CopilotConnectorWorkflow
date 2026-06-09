# Fresh-VM end-to-end smoke checklist (Phase 8 last bullet, plan §8)

A scripted manual walkthrough that validates the **user's actual
journey** from a clean Windows image to a successful CCW build-mode
job. Run before every release. Pass/fail logged in
`tests/fresh-vm-smoke/results/<release>.md`.

## Why this exists

xUnit + WinAppDriver covers the C# surface, but the *integration*
between the MSIX install, first-run wizard, winget install of external
deps, sibling-repo clone, and an actual `ccw run` is what end users
experience. This checklist exercises that path end-to-end on a clean
image so we don't ship a "works on the dev box" release.

## Environment

- Fresh Windows 11 Pro x64 VM (Hyper-V or Azure VM), no developer
  tools pre-installed.
- Standard user account (NOT admin) — first-run wizard must work
  without UAC except where it explicitly needs to install MSIX or
  trust dev cert.
- Network: internet access permitted; corporate proxies optional.
- Optional: ARM64 VM for the second pass.

## Pre-flight (build artifacts the smoke consumes)

- [ ] Signed MSIX at `winui3\packaging\msix\dist\x64\signed\CopilotConnectorWorkflow.WinUI_<ver>_x64.msix`
- [ ] Portable ZIP at `winui3\packaging\portable\dist\ccw-<ver>-win-x64.zip`
- [ ] DSC YAML at `winui3\packaging\winget-configure\ccw-deps.dsc.winget.yaml`

## A. MSIX install

- [ ] Copy MSIX to VM.
- [ ] Right-click -> Install (or `Add-AppxPackage` from admin pwsh).
- [ ] Installer accepts without errors.
- [ ] Start menu has "Copilot Connector Workflow" tile.

## B. App first launch + bootstrap wizard

- [ ] Double-click tile; app launches within 5 s.
- [ ] Shell renders MainShell (no dev exceptions in Event Viewer).
- [ ] Banner shows "Dependencies missing - Install" (since the VM has
      no Node/Git/Azure CLI/GitHub CLI).
- [ ] Click "Open setup" -> Wizard page appears with each dep listed
      and X next to each.
- [ ] Click "Install missing" -> winget output streams into the wizard
      log pane; UI does not freeze.
- [ ] Cancel button is enabled while install runs; clicking it stops
      the operation cleanly without leaving the wizard wedged.
- [ ] After install completes, click "Refresh" (or close + reopen the
      wizard) -> all four deps now OK with versions detected.
- [ ] gh-copilot extension: "Install Copilot extension" button works
      after gh appears.

## C. Sibling-repo bootstrap (optional, ON if you opted into clone)

- [ ] In the wizard's Sibling Repos section, click "Clone EvaluationCLI"
      -> progress streams; `%USERPROFILE%\src\EvaluationCLI\` appears
      with `dist\` after npm install + build.
- [ ] Repeat for CopilotConnectorSkill.
- [ ] Both probes show OK after refresh.

## D. Run a sample job (build mode)

Pick the smallest dataset under `data/` (e.g. `data/ngo-environment/`).

- [ ] Go to "New Job" page.
- [ ] Fill in dataset path, description, connector name, mode=build.
- [ ] Click "Run". A new job appears in the Jobs list with progress.
- [ ] Step 1 (evalgen) completes; eval-set artifact appears in the
      job detail view.
- [ ] Step 2 (enhance) completes - either the identity transform path
      (default) or the v1 enhancer shim.
- [ ] Step 3 (schema) completes.
- [ ] Step 4 (connector) renders templates and runs `npm install` +
      `tsc` against the generated TS project. Build succeeds.
- [ ] Step 5 (deploy artifacts) emits `templates/deploy/*` files into
      the job directory.
- [ ] Step 6 (score) runs in-process (`EvalToolkit.EvalScore` -
      Node is NOT required for Step 6 per plan section 5 GPT N1).
- [ ] Final scored report markdown opens in the in-app viewer (Markdig
      -> XAML, NOT WebView2).

## E. Portable CLI parity

- [ ] Extract `ccw-<ver>-win-x64.zip` to `C:\Tools\ccw\`.
- [ ] Add to PATH (per portable README).
- [ ] Open a NEW terminal, run `ccw --help` -> renders.
- [ ] Run `ccw tools` -> all installed CLIs detected.
- [ ] Run `ccw diagnostics` -> JSON report emits; `allOk: true`.
- [ ] Run `ccw run --file ...` on the same dataset; compare scored
      report bytes against the WinUI run from step D (allowlist
      timestamps, paths, IDs - use `ParityDiffer`).

## F. `winget configure` bulk path

On a SECOND fresh VM (or after `winget uninstall` of the four deps):

- [ ] `winget configure --file ccw-deps.dsc.winget.yaml`
- [ ] All four packages install without consent loops beyond what
      winget's normal prompts request.
- [ ] After completion, `ccw diagnostics` from the portable ZIP returns
      `allOk: true`.

## G. Cleanup / uninstall

- [ ] Settings -> Apps -> Copilot Connector Workflow -> Uninstall.
      Removes cleanly.
- [ ] `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\` persists
      (per-user workspace by design, plan section 5 decision row).
- [ ] Optional: `Get-AppxPackage CopilotConnectorWorkflow.WinUI`
      returns nothing.

## H. ARM64 pass (if applicable)

Repeat sections A-G on an ARM64 VM with the ARM64 MSIX + ZIP.

## Logging template

Copy `tests/fresh-vm-smoke/results/_template.md` to
`tests/fresh-vm-smoke/results/<release>.md`, fill in operator name,
date, VM image, and check off each item. Attach any failure logs to
the release issue.

## Known acceptable variations

- Step 4 npm install duration varies wildly with network - anything
  under 5 min is OK.
- First WinGet install of any package on a fresh image takes ~30s extra
  for source agreements.
- VS Code / Visual Studio noise in `npm` output is benign.
