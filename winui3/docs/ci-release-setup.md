# CI & release setup

This document covers the two GitHub Actions workflows that build and
release the WinUI port. Both are adapted from the sibling
`eval-ui-winui3` workflows; deltas from that sibling are called out
inline.

## 1. PR-gate workflow — `.github/workflows/build-ccw-winui3.yml`

**Triggers:** pull-request to `main`, push to `main`, manual dispatch.

**Path filters:** `winui3/**`, `templates/**`, *both* workflow files
(so a release-workflow-only PR still gets YAML-parsed by the gate —
GPT Phase 9 IMP6 fix).

**Runner:** `windows-2022` (pinned). The image upgrades happen in
predictable cycles; pinning avoids surprise build-tooling deltas.

**SDK:** `dotnet-version: 10.0.300` (matches `winui3/global.json`).
Pinning prevents feature-band drift while `TreatWarningsAsErrors` is
on — a new feature-band can introduce analyzer warnings that fail the
build silently in CI but pass locally.

**Stages, in order:**

1. **Build** — `dotnet build CopilotConnectorWorkflow.slnx -c Release`,
   warnings-as-errors.
2. **Test** — `dotnet test --no-build -c Release` across all six test
   projects (238 tests as of Phase 9).
3. **MSIX smoke (unsigned)** — `packaging/msix/build-msix.ps1 -Arch x64`
   to verify the single-project MSIX builds end-to-end with the embedded
   `templates/` resources intact. Builds dev-cert signed package and
   uploads as artefact `ccw-msix-x64-pr`.
4. **Portable ZIP smoke** — `packaging/portable/build-cli-zip.ps1
   -Rid win-x64` to verify the single-file `ccw.exe` publishes and
   zips. Unzips it, runs `ccw diagnostics` from the unzipped path,
   asserts exit code 0 AND `allOk: true` in the JSON.
   *(GPT Phase 9 BLOCKER fix: was `-Arch x64`; the script's param is
   `-Rid`, so the previous form failed on every run.)*
5. **Signed-MSIX install + ProcessAlive** — dev-cert signs the MSIX,
   installs via `Add-AppxPackage`, launches via
   `shell:AppsFolder\<AUMID>` (not the raw exe path), polls for the
   real `CcwUI.exe` under the install location, then asserts the
   process is still alive 15s later. *(GPT Phase 9 IMP3 fix.)*

WinAppDriver UI Automation is intentionally deferred — UI Automation
flake rates on hosted runners are high enough that the signal-to-noise
ratio doesn't justify the maintenance burden in v1. The ProcessAlive
check is the floor.

**Hard-fail behaviour:** `ccw diagnostics` returning non-zero is now a
hard PR failure (was soft-fail). GPT Phase 9 IMP2: the rationale "deps
may be missing on the runner" doesn't hold — `windows-2022` images
ship Node + Git + GitHub CLI + Azure CLI. A non-zero from `ccw
diagnostics` on a hosted runner is either a probe regression, a runner
image change requiring workflow updates, or a CLI crash — every case
must surface, not merge silently.

## 2. Release workflow — `.github/workflows/release-ccw-winui3.yml`

**Trigger:** push of a tag matching `ccw-winui3-v*` (e.g.
`ccw-winui3-v0.1.0`).

**Environment:** `release` — requires reviewer approval in the
GitHub UI. The federated identity is scoped to this environment, so a
PR cannot accidentally trigger a signing run by pushing a malicious
tag from a fork.

**Matrix:** `[x64, arm64]`. ARM64 cross-publishes from x64 runners
(`dotnet publish -r win-arm64`); the WinUI MSIX `Platform` is passed
through to `packaging/msix/build-msix.ps1 -Arch`.

**Stages, in order:**

1. **Build** — same as PR gate.
2. **MSIX build** — `build-msix.ps1 -Arch <arch>` per matrix entry.
3. **Verify MSIX structure** — unpacks, asserts
   `ProcessorArchitecture` matches, `Identity.Name ==
   CopilotConnectorWorkflow.WinUI` (Opus Phase 9 IMP8 fix), CcwUI.exe
   + templates\\ present.
4. **Sign MSIX via Azure Trusted Signing** —
   `azure/trusted-signing-action@v0.5.1` (effectively a hand-rolled
   `nuget install Microsoft.ArtifactSigning.Client` + `signtool /dlib
   /dmdf` via `sign-msix.ps1`). Pinned
   `ARTIFACT_SIGNING_VERSION: '1.0.128'` so a Trusted Signing client-
   tools bump doesn't silently break release. Uses OIDC federated
   identity (no client secret).
5. **Build portable ZIP** — `build-cli-zip.ps1 -Rid win-<arch>` per
   matrix entry.
6. **Sign the inner `ccw.exe`** — resolves the Trusted Signing dlib
   via recursive `Get-ChildItem` (Opus Phase 9 IMP2 fix — was a
   hardcoded subpath that could break under future client-tools
   layouts), then signs.
7. **Post-sign verification** — `Get-AuthenticodeSignature` on the
   freshly-signed `ccw.exe`, asserts `Status == Valid`, asserts
   timestamp counter-signature is present, asserts signer subject
   contains the `TRUSTED_SIGNING_PUBLISHER` repo var. *(GPT Phase 9
   IMP5 fix.)*
8. **Repack signed ZIP** — `Compress-Archive` with the signed
   `ccw.exe` in place. Re-extracts the resulting ZIP and re-verifies
   the inner exe's signature to catch corruption during recompression.
9. **Publish release** — uploads signed MSIXes + signed portable ZIPs
   + DSC YAML, plus a `SHA256SUMS.txt` computed over the final
   *signed* artefacts (GPT Phase 9 IMP4 fix). The in-script hashes
   captured during build are stale by this point because signing
   rewrote the MSIX and repacking changed the ZIP bytes.

## 3. Azure Trusted Signing — OIDC federated identity

Setting up Trusted Signing for this repo (one-time):

1. **Create the Trusted Signing account** in Azure (or reuse the one
   the sibling `eval-ui-winui3` uses — same publisher).
2. **Create a certificate profile** under the account. Note the:
   - Tenant ID.
   - Subscription ID.
   - Account name (the Trusted Signing account, not the cert).
   - Profile name.
3. **Create a User-Assigned Managed Identity** in the same subscription
   (e.g. `mi-trusted-signing-ccw`). Grant it the
   `Trusted Signing Certificate Profile Signer` role on the Trusted
   Signing **certificate profile** (not just the account — Opus Phase 9
   troubleshooting note).
4. **Add a federated identity credential** to the managed identity:
   - **Issuer:** `https://token.actions.githubusercontent.com`
   - **Subject:** `repo:boddev/CopilotConnectorWorkflow:environment:release`
   - **Audience:** `api://AzureADTokenExchange`

   Critical: the subject MUST match the form
   `repo:OWNER/REPO:environment:NAME` and the `environment:NAME` segment
   MUST match the GitHub environment in the workflow (here: `release`).
   The federated identity will not exchange tokens otherwise — and the
   failure mode is a 400 from `oauth2/v2.0/token` with `AADSTS70021`,
   which is opaque.
5. **Create the GitHub environment** named `release` (Settings →
   Environments → New environment → `release`). Require reviewers in
   the environment settings. **Important** (Opus Phase 9 IMP4): the
   environment's deployment-protection settings must permit *tag*
   refs (the workflow triggers on tags, not branches). The default
   permits all refs; only set a restriction if you specifically want
   to gate by ref.
6. **Add repo / environment variables:**

   | Scope | Name | Value |
   | --- | --- | --- |
   | Repo (vars) | `AZURE_TENANT_ID` | Tenant ID. |
   | Repo (vars) | `AZURE_CLIENT_ID` | Managed identity client ID. |
   | Repo (vars) | `AZURE_SUBSCRIPTION_ID` | Subscription ID. |
   | Repo (vars) | `TRUSTED_SIGNING_PUBLISHER` | Publisher CN (for post-sign verification). |
   | Environment `release` (vars) | `TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name. |
   | Environment `release` (vars) | `TRUSTED_SIGNING_PROFILE` | Certificate profile name. |
   | Environment `release` (vars) | `TRUSTED_SIGNING_ENDPOINT` | Endpoint URL (e.g. `https://wus.codesigning.azure.net`). |

7. **First release dry-run:** push a `ccw-winui3-v0.0.0-rc1` tag and
   verify the workflow completes through signing without publishing. If
   it fails at "Get token via federated credential", re-check the
   federated identity subject string character-by-character — leading
   `repo:`, slashes around the repo, the literal `:environment:` infix,
   and the environment name.
8. **Verify the pinned client-tools version exists** (Opus Phase 9
   IMP3): before cutting the first real tag, on a Windows box run
   `nuget install Microsoft.ArtifactSigning.Client -Version 1.0.128`
   and confirm the package restores AND that
   `Azure.CodeSigning.Dlib.dll` lands under an `*\x64\*` subpath of
   the package directory. If the package was renamed or the layout
   changed, update `ARTIFACT_SIGNING_VERSION` to a known-good version
   before tagging.

## 4. Deltas from `eval-ui-winui3`

Same Trusted Signing account / profile / managed identity as the
sibling — re-uses the publisher binding. Differences:

- **Tag prefix:** `ccw-winui3-v*` (vs `evaltoolkit-winui3-v*`) so the
  two release streams don't collide in this monorepo.
- **Package identity:** `CopilotConnectorWorkflow.WinUI` (vs
  `EvalToolkit.WinUI`).
- **Portable artefact:** `ccw-<ver>-win-x64.zip` (vs
  `EvalToolkit.Cli-<ver>-win-x64.zip`).
- **DSC YAML:** ships only with CCW (the sibling doesn't have one).
- **Hand-rolled signing instead of `azure/trusted-signing-action`**
  (Opus Phase 9 IMP10): the repo uses `nuget install` + `signtool
  /dlib /dmdf` via `sign-msix.ps1` to keep dlib resolution explicit
  and to centralise post-sign verification. Functionally equivalent;
  the marketplace action wraps the same dll.

## 5. Manual release process (if CI is down)

In order:

```powershell
# 1. Build + test
cd winui3
dotnet build CopilotConnectorWorkflow.slnx -c Release
dotnet test  CopilotConnectorWorkflow.slnx -c Release --no-build

# 2. MSIX (x64 + arm64)
.\packaging\msix\build-msix.ps1 -Configuration Release -Arch x64
.\packaging\msix\build-msix.ps1 -Configuration Release -Arch arm64

# 3. Sign MSIX (requires Azure CLI logged in with cert profile signer role)
.\packaging\msix\sign-msix.ps1 -MsixPath .\packaging\msix\dist\x64\CopilotConnectorWorkflow.WinUI_0.1.0.0_x64.msix
.\packaging\msix\sign-msix.ps1 -MsixPath .\packaging\msix\dist\arm64\CopilotConnectorWorkflow.WinUI_0.1.0.0_arm64.msix

# 4. Portable ZIP
.\packaging\portable\build-cli-zip.ps1 -Configuration Release -Rid win-x64
.\packaging\portable\build-cli-zip.ps1 -Configuration Release -Rid win-arm64

# 5. Compute final SHA-256 manifest
$signed = @() + (Get-ChildItem .\packaging\msix\dist\*\signed\*.msix) +
                (Get-ChildItem .\packaging\portable\dist\signed\*.zip)
$signed | Sort-Object Name | ForEach-Object {
  $h = (Get-FileHash -Algorithm SHA256 $_).Hash.ToLowerInvariant()
  "$h  $($_.Name)"
} | Set-Content SHA256SUMS.txt -Encoding ascii

# 6. Publish to GitHub release
gh release create ccw-winui3-v0.1.0 `
  --title "WinUI 3 v0.1.0" `
  --notes-file release-notes.md `
  .\packaging\msix\dist\*\signed\*.msix `
  .\packaging\portable\dist\signed\*.zip `
  .\packaging\winget-configure\ccw-deps.dsc.winget.yaml `
  .\SHA256SUMS.txt
```

## 6. Troubleshooting CI failures

| Symptom | Likely cause |
| --- | --- |
| `dotnet test` fails on `Ccw.Templates.Tests.EveryTemplateFile_MatchesSourceTree_ByteForByte` | The source-tree `templates/` directory wasn't checked out (CI is supposed to fail closed on this — see Phase 8 fold-ins). Check the `actions/checkout@v4` step. |
| `Add-AppxPackage` fails with `0x80073CFD` ("found in the certificate is not trusted") | Dev cert wasn't installed into `LocalMachine\Trusted People` before install. The install script handles this for elevated callers; CI runs elevated by default. |
| `ProcessAlive` check times out at 30s without finding CcwUI.exe | Packaged activation failed. Likely causes: wrong `EntryPoint` in `Package.appxmanifest` (should be `$targetentrypoint$`), missing runtime dependency in the MSIX, or `AUMID` calculation wrong. |
| Trusted Signing returns `403` | Managed identity missing the `Trusted Signing Certificate Profile Signer` role on the *certificate profile* (not just the account). |
| Trusted Signing returns `AADSTS70021` | Federated identity subject doesn't match `repo:OWNER/REPO:environment:NAME` exactly. |
| `nuget install Microsoft.ArtifactSigning.Client` fails to resolve | The pinned version was yanked or the package was renamed. Check NuGet.org and update `ARTIFACT_SIGNING_VERSION`. |
| `Azure.CodeSigning.Dlib.dll` not found after install | The NuGet package layout changed. The release workflow now uses recursive discovery; if it still fails, inspect the actual package contents under `%USERPROFILE%\.nuget\packages\microsoft.artifactsigning.client\`. |
