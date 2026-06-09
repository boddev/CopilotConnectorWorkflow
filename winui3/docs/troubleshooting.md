# Troubleshooting

## Diagnostics: `ccw diagnostics`

`ccw.exe diagnostics` is the first thing to run when something goes
wrong. It prints a single JSON envelope to stdout summarising every
external dependency and internal tool. Exit code 0 = everything green;
exit code 1 = at least one probe failed AND/OR at least one tool is
missing. The JSON envelope is always well-formed — even on probe-layer
exception, the `error` field is populated.

If the GUI is the surface that's failing, the **Diagnostics** page runs
the same probes in-process and surfaces them as a clickable list with
**Install** / **Fix** actions for each failed entry.

## Common failures

### "Node.js not found" — even though `node --version` works

The probe walks PATH for `node.exe` *as the MSIX-installed app's
process* sees it. The MSIX runs with a sanitised PATH that may not
include the user PATH entry for Node. Either:

- Install Node via the wizard's WinGet path — the wizard refreshes the
  in-process PATH after install, BUT the app must be restarted for
  the new PATH to be visible to subprocesses.
- Or set the path explicitly in **Settings → Tools → Node executable**
  to `C:\Program Files\nodejs\node.exe`.

The portable `ccw.exe` (outside the MSIX) does see the full user PATH.

### "Azure CLI version mismatch"

CCW requires Azure CLI 2.61+ (for the `az ad app credential reset
--cert` shape that step 5 uses). The probe shows the installed version
and the required minimum. Fix: `winget upgrade Microsoft.AzureCLI` or
the wizard's **Install** button.

### "M365 Agents Toolkit `atk` not found"

`atk` is installed via `npm install -g @microsoft/teamsapp-cli`. It is
not a WinGet package. The wizard's **Install** button runs the npm
command for you. If you've installed it via `nvm` / `nodist` and switch
Node versions, you may need to re-install `atk` for the new Node
version.

### "GitHub Copilot CLI extension missing"

`gh` is the WinGet package `GitHub.cli`; `gh-copilot` is an extension
installed *after* gh, via `gh extension install github/gh-copilot`. The
probe distinguishes between "gh present, extension missing" and "gh
absent" and the wizard's **Install** button handles whichever subset is
needed.

### "EvaluationCLI / CopilotConnectorSkill sibling repos missing"

Step 1 evalgen calls EvalGen directly when these are at the expected
sibling path (`%USERPROFILE%\src\EvaluationCLI`,
`%USERPROFILE%\src\CopilotConnectorSkill`). If they aren't there, the
wizard offers a one-click clone (uses Git, runs `npm install && npm run
build` in each). Or you can clone manually to any location and point at
them in **Settings → Tools → Sibling repos**.

If you're on a restricted network where `git clone` is gated, clone
once on a workstation that has access, copy the built repos to the
target machine, and set the path in Settings.

### "Step 4 (`npm install`) fails inside the generated connector"

This is npm itself failing inside the rendered connector project at
`%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs\<id>\connector\`.
Cd into that directory and run `npm install` interactively to see the
real error. Common causes: corporate proxy, missing C++ build tools,
npm registry auth misconfiguration. CCW doesn't wrap npm errors — the
output streams to the job log verbatim.

### "Step 5 deploy: `az login` fails silently"

The `az login` shell-out runs non-interactively under CCW. If you've
never logged in, the deploy will fail. Open a terminal, run
`az login --tenant <your tenant id>` once, then re-run the job.

### "Workspace is locked" (exit code 3)

Only one CCW instance can run a job in the same workspace at a time. A
crashed previous run can leave a stale lock at
`%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\.lock`. Delete the
file if you're certain no CCW is running.

### "MSAL: AADSTS50058 — no signed-in user"

Happens in the CLI when the cached token has expired and the device-
code flow hasn't been triggered. Run `ccw auth --device-code` and
complete the device-code prompt in a browser.

### "MSAL: token cache file locked" — GUI and CLI running simultaneously

The shared WorkIQ MSAL cache (`%LOCALAPPDATA%\EvalToolkit\msal-a2a-cache.bin`)
is single-writer. Close the GUI before running `ccw auth --workiq`, or
let the GUI handle the WorkIQ auth (it'll update the shared cache for
you).

## Workspace recovery

### "I want to start over"

```powershell
# WinUI port — wipes only the WinUI workspace, NOT the Node app's
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\CopilotConnectorWorkflow"
```

The MSIX install itself is preserved; only the workspace, settings, and
logs are removed.

### "I want to move my jobs to a different machine"

```powershell
# On source machine
Compress-Archive `
  "$env:LOCALAPPDATA\CopilotConnectorWorkflow\workspace\" `
  -DestinationPath C:\Temp\ccw-workspace.zip

# On target machine — extract under the same %LOCALAPPDATA% path
Expand-Archive C:\Temp\ccw-workspace.zip "$env:LOCALAPPDATA\CopilotConnectorWorkflow\"
```

The job-import migration (in slice 1c) rewrites absolute paths inside
`job.json` files on first launch, so paths from the old machine don't
matter.

### "I imported Node jobs and they show up as `legacy/migrated`"

That's expected — imported Node jobs are tagged so the comparator
knows their `workspace` path was rewritten. They behave identically to
WinUI-native jobs otherwise; you can resume them, compare them, etc.

## Logs

| What | Where |
| --- | --- |
| Per-job step logs | `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs\<id>\step.log` |
| Per-job per-step logs | `%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs\<id>\step<n>.log` |
| App-level (not job) | `%LOCALAPPDATA%\CopilotConnectorWorkflow\logs\app-YYYYMMDD.log` |
| MSIX activation issues (Windows) | Event Viewer → Applications and Services Logs → Microsoft → Windows → AppXDeploymentServer |

## Verifying a release download

Releases ship with a `SHA256SUMS.txt` manifest. To verify:

```powershell
# Download the .msix and SHA256SUMS.txt to the same folder, then:
$expected = (Get-Content SHA256SUMS.txt | Where-Object { $_ -like "*$(Split-Path -Leaf <msix-path>)*" }) -split '\s+' | Select-Object -First 1
$actual   = (Get-FileHash -Algorithm SHA256 <msix-path>).Hash.ToLowerInvariant()
if ($actual -eq $expected) { 'OK' } else { 'MISMATCH' }
```

Authenticode signatures are independently verifiable via:

```powershell
Get-AuthenticodeSignature <msix-path>
# Status should be 'Valid'; SignerCertificate.Subject should contain
# the Trusted Signing publisher CN.
```

## Getting help

When opening an issue at
[boddev/CopilotConnectorWorkflow][repo]/issues, please include:

1. `ccw diagnostics` JSON output (sanitise any paths under your home).
2. The job ID + the contents of the relevant `step.log`.
3. The MSIX version (Settings → About).
4. Windows version (`winver`).

[repo]: https://github.com/boddev/CopilotConnectorWorkflow
