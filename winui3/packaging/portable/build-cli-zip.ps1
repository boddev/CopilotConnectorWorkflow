<#
.SYNOPSIS
    Publish Ccw.Cli as a self-contained single-file Windows executable
    and bundle it into a portable distribution ZIP.

.DESCRIPTION
    Phase 7 portable artifact: ship the same orchestration as the WinUI 3
    head, headless, without requiring a .NET 10 runtime install. Unlike
    the EvalToolkit sibling there is exactly one binary (`ccw.exe`); no
    name-based shim dispatch.

    The resulting ZIP is dropped at:
        winui3/packaging/portable/dist/ccw-<version>-<rid>.zip

.PARAMETER Configuration
    Build configuration (Debug or Release). Default: Release.

.PARAMETER Rid
    Runtime identifier. Default: win-x64. Pass `win-arm64` for ARM64
    when the .NET 10 ARM64 runtime is installed.

.PARAMETER Version
    Optional override for the version string used in the ZIP filename.
    Defaults to Ccw.Core.CoreInfo.Version.

.PARAMETER SkipTests
    Skip the test suite before publishing. Default: false. CI should
    NEVER skip; only useful for local iteration.

.EXAMPLE
    pwsh ./build-cli-zip.ps1

.EXAMPLE
    pwsh ./build-cli-zip.ps1 -Configuration Release -Rid win-arm64
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [string]$Rid = 'win-x64',

    [string]$Version,

    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$cliProject = Join-Path $repoRoot 'src/Ccw.Cli/Ccw.Cli.csproj'
$slnx = Join-Path $repoRoot 'CopilotConnectorWorkflow.slnx'
$publishDir = Join-Path $repoRoot "src/Ccw.Cli/bin/$Configuration/net10.0/$Rid/publish"
$distDir = Join-Path $PSScriptRoot 'dist'

Write-Host "==> CCW CLI portable build" -ForegroundColor Cyan
Write-Host "    repo root:    $repoRoot"
Write-Host "    project:      $cliProject"
Write-Host "    rid:          $Rid"
Write-Host "    configuration: $Configuration"
Write-Host ""

if (-not $SkipTests) {
    Write-Host "==> Running full test suite" -ForegroundColor Cyan
    & dotnet test $slnx --nologo --configuration $Configuration -clp:NoSummary
    if ($LASTEXITCODE -ne 0) { throw "Tests failed (exit $LASTEXITCODE)." }
}
elseif ($env:GITHUB_ACTIONS -eq 'true') {
    throw "CI run detected (GITHUB_ACTIONS=true) but -SkipTests was passed. Refusing to publish an untested artifact."
}
else {
    Write-Warning "Skipping tests at user request. CI must NOT pass -SkipTests."
}

if (Test-Path $publishDir) {
    Remove-Item -Recurse -Force $publishDir
}

Write-Host "==> Publishing $Rid self-contained single-file binary" -ForegroundColor Cyan
& dotnet publish $cliProject `
    --configuration $Configuration `
    --runtime $Rid `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:PublishReadyToRun=false `
    --nologo `
    -clp:NoSummary

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $publishDir)) { throw "Publish directory not found: $publishDir" }

$primaryExe = Join-Path $publishDir 'ccw.exe'
if (-not (Test-Path $primaryExe)) { throw "Published binary not found: $primaryExe" }

if (-not $Version) {
    $coreInfoPath = Join-Path $repoRoot 'src/Ccw.Core/CoreInfo.cs'
    $coreInfoContent = Get-Content $coreInfoPath -Raw
    # Match the Version constant specifically (not SchemaVersion).
    if ($coreInfoContent -match 'public\s+const\s+string\s+Version\s*=\s*"([^"]+)"') {
        $Version = $Matches[1]
    }
    else {
        throw "Could not parse CoreInfo.Version from $coreInfoPath. Pass -Version explicitly if you intend to override."
    }
}

$stagingDir = Join-Path $env:TEMP "ccw-cli-$Version-$Rid-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$stagingPayload = Join-Path $stagingDir "ccw-$Version"
New-Item -ItemType Directory -Path $stagingPayload -Force | Out-Null

Write-Host "==> Staging payload at $stagingPayload" -ForegroundColor Cyan

# Copy the single-file binary and any side-by-side runtime config / pdbs.
Get-ChildItem -Path $publishDir -File |
    Where-Object { $_.Extension -ne '.pdb' -or $Configuration -eq 'Debug' } |
    ForEach-Object { Copy-Item -Path $_.FullName -Destination $stagingPayload -Force }

# Templates ship beside the binary so the file-system-based Templater
# resolves them via AppContext.BaseDirectory at runtime.
$templatesSrc = Join-Path $publishDir 'templates'
if (Test-Path $templatesSrc) {
    Copy-Item -Path $templatesSrc -Destination $stagingPayload -Recurse -Force
    Write-Host "    templates\ subdir copied"
} else {
    Write-Warning "templates\ subdir not present under publish output; CCW will not find runtime templates."
}

$readmePath = Join-Path $stagingPayload 'README.txt'
@"
CopilotConnectorWorkflow native CLI (Phase 7 portable ZIP)
==========================================================

Version:        $Version
Runtime ID:     $Rid
Configuration:  $Configuration
Built:          $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))

Contents
--------
  ccw.exe                   - primary CLI binary.
  templates\                - connector / deploy templates (read at runtime).
  README.txt                - this file.

Requirements
------------
This is a self-contained single-file build - no .NET runtime install
required on the target machine. Windows 10 1809 (build 17763) or later
on the matching architecture ($Rid) is sufficient.

You also need (CCW shells out to these):
  node                      - Node.js >= 22 (LTS).
  git                       - any recent version.
  az                        - Azure CLI 2.x.
  gh                        - GitHub CLI; install the github/gh-copilot
                              extension for the Step 6 GitHub Copilot judge.

These external dependencies match the existing Node-based ccw CLI.

Installing on PATH
------------------
This ZIP unpacks into a single top-level directory (ccw-$Version\) so it
cannot overwrite existing tooling when extracted into a shared folder. To
put ccw.exe on PATH:

  1. Extract into a dedicated folder, e.g. C:\Tools\ccw\.
  2. Add the extracted folder to your user PATH:
       setx PATH "%PATH%;C:\Tools\ccw\ccw-$Version"
     (Replace with wherever you actually extracted.)
  3. Open a NEW terminal so the updated PATH takes effect.
  4. Verify:
       ccw --help

DO NOT rename ccw.exe. The Node-based ccw CLI also installs as ccw on
PATH; install only one or the other, or extract this ZIP into a folder
that comes BEFORE / AFTER the Node install on PATH depending on which
one you want to prefer.

Quick start
-----------
  ccw new --evalset .\my-eval.json --workflow auto
  ccw status
  ccw run --job <jobId>
  ccw compare --a <jobIdA> --b <jobIdB>

For full usage:
  ccw --help
  ccw <command> --help
"@ | Set-Content -Path $readmePath -Encoding UTF8

# Copy LICENSE if available.
$licenseSrc = Join-Path $repoRoot '../LICENSE'
if (Test-Path $licenseSrc) {
    Copy-Item -Path $licenseSrc -Destination (Join-Path $stagingPayload 'LICENSE') -Force
}

# Zip it.
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$zipPath = Join-Path $distDir "ccw-$Version-$Rid.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Write-Host ""
Write-Host "==> Compressing $zipPath" -ForegroundColor Cyan
# Zip the parent payload directory so the archive unpacks into a single
# ccw-<ver>\ directory rather than spraying files into the destination.
Compress-Archive -Path $stagingPayload -DestinationPath $zipPath -CompressionLevel Optimal

$zipInfo = Get-Item $zipPath
Write-Host ""
Write-Host "ZIP built: $zipPath" -ForegroundColor Green
Write-Host "   Size:     $([math]::Round($zipInfo.Length / 1MB, 2)) MB"
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host "   SHA256:   $hash"

Remove-Item -Recurse -Force $stagingDir
