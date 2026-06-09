# CCW MSIX packaging (Phase 7)

Build, sign, and install the single-project MSIX for the WinUI 3 head
(`Ccw.UI`). Adapted from the EvalToolkit sibling
(`eval-ui-winui3/packaging/msix`); convergent reviewer findings are
folded in.

## Layout

```
packaging/msix/
  build-msix.ps1          # dotnet build /p:WindowsPackageType=MSIX
  sign-msix.ps1           # signtool wrapper (SelfSigned + AzureTrustedSigning)
  install-locally.ps1     # one-shot UAC-elevated sideload + verify
  azure-signing/
    metadata.template.json  # copy to metadata.json + fill in
  dist/                   # output (.gitignored)
    <arch>/
      *.msix              # unsigned (from build-msix.ps1)
      signed/
        *.msix            # signed (from sign-msix.ps1)
```

## Quickstart — self-signed local dev flow

```pwsh
# 1. Build (assets are committed; -SkipAssets just skips the placeholder synthesis)
pwsh .\winui3\packaging\msix\build-msix.ps1 -Arch x64 -SkipAssets

# 2. Self-sign + trust the dev cert + verify install (requires elevated terminal)
pwsh .\winui3\packaging\msix\sign-msix.ps1 `
    -MsixPath .\winui3\packaging\msix\dist\x64\CopilotConnectorWorkflow.WinUI_0.1.0.0_x64.msix `
    -Mode SelfSigned -TrustDevCert -VerifyInstall

# 3. Or, install separately on a different developer machine:
pwsh .\winui3\packaging\msix\install-locally.ps1
```

The dev cert lives at `%LOCALAPPDATA%\CcwUI\dev-signing\CcwUI.Dev.pfx`
(DPAPI-bound password sibling at `*.password.txt`). The same dev cert is
reused across runs; pass `-Force` to regenerate.

## Production signing — Azure Trusted Signing

CI uses `Mode=AzureTrustedSigning` with the Microsoft Trusted Signing
service. Setup:

1. Provision a Trusted Signing account and certificate profile (one-time,
   in the Azure portal).
2. Copy `azure-signing/metadata.template.json` to
   `azure-signing/metadata.json` and fill in `Endpoint`,
   `CodeSigningAccountName`, `CertificateProfileName`.
3. Install one of the dlib NuGet packages (current:
   `Microsoft.ArtifactSigning.Client`; legacy fallback:
   `Microsoft.Trusted.Signing.Client`). The signing script auto-discovers
   the `Azure.CodeSigning.Dlib.dll` under `~/.nuget/packages/` (x64).
4. Run from an environment authenticated via `DefaultAzureCredential` —
   typically an OIDC federated workload identity in GitHub Actions, or
   `az login` interactively.

```pwsh
pwsh .\winui3\packaging\msix\sign-msix.ps1 `
    -MsixPath .\winui3\packaging\msix\dist\x64\CopilotConnectorWorkflow.WinUI_0.1.0.0_x64.msix `
    -Mode AzureTrustedSigning `
    -SigningPublisher 'CN=Contoso, O=Contoso Corp, L=Redmond, S=WA, C=US' `
    -TrustedSigningMetadataPath .\winui3\packaging\msix\azure-signing\metadata.json
```

`SigningPublisher` MUST exactly match the Subject DN of your Trusted
Signing certificate profile — the manifest is patched to this Publisher
before signing and the post-sign verify rejects any mismatch. Anything
else produces `Add-AppxPackage` HRESULT `0x80073CF0` at install time.

## Why this is more than a one-liner

- **.NET 10 + VS 2022 MSBuild mismatch** — `dotnet build` (NOT `msbuild`
  from VS 2022) is required for the MSIX target; VS 2022 ships MSBuild
  17.x but .NET 10 needs 18+. The sibling tripped on this for half a day.
- **`System.Security.Permissions` task-host probing** — the
  `WinAppSdkValidateAppxManifestItems` MSBuild task binds to
  `System.Security.Permissions 8.0.0` which is not on the .NET 10 SDK's
  default task host probing path. The `_CcwEnsureMsixTaskSysPerm` target
  in `Ccw.UI.csproj` copies the restored assembly into the task DLL's
  directory before validation runs. Without this, MSIX build fails with
  `MSB4018 FileNotFoundException`.
- **Templates as Content, not EmbeddedResource** — `Ccw.Templates.csproj`
  declares `Content` items with `CopyToPublishDirectory=PreserveNewest`
  and `Link=templates\...` rewriting so the existing file-system-based
  `Templater` works unchanged at the MSIX install location, the
  unpackaged dev build, and the portable CLI ZIP. `TemplatesInfo.TemplatesRoot`
  resolves to `AppContext.BaseDirectory + "templates"` (`CCW_TEMPLATES_ROOT`
  env override for parity tests).
- **`BackgroundColor` in `Package.appxmanifest`** — set to `#202020`, not
  `transparent`; recent versions of `makepri` reject `transparent`.
- **Publisher patching via XML DOM** — `Set-MsixIdentityPublisher` rewrites
  `Package.Identity.Publisher` via `[xml]$xml` + `SetAttribute`, not regex,
  so namespaces, attribute order, and surrounding whitespace are preserved.
  This is the canonical fix for the
  "Publisher derived from the actual cert, not from
  PackageCertificateThumbprint" reviewer finding.

## Cleanup

```pwsh
Get-AppxPackage CopilotConnectorWorkflow.WinUI | Remove-AppxPackage
# To also remove the dev-signing cert from the trust store:
Get-ChildItem Cert:\LocalMachine\TrustedPeople | `
    Where-Object Subject -like 'CN=CcwUI.Dev*' | Remove-Item
```
