<#
.SYNOPSIS
  One-shot local install of a self-signed CCW MSIX.

.DESCRIPTION
  For local-developer sideload only. Picks the most recent signed
  MSIX produced by `sign-msix.ps1` matching the host architecture,
  self-elevates via UAC, imports the signer cert into
  `Cert:\LocalMachine\TrustedPeople`, runs
  `Add-AppxPackage -ForceApplicationShutdown`, and verifies via
  `Get-AppxPackage`.

  Does NOT re-sign — it operates on an already-signed input and
  is idempotent. For production-signed (Azure Trusted Signing)
  MSIXes the cert already chains to a Microsoft-trusted root, so
  `Add-AppxPackage` works without the trust step; you can still use
  this script — the cert import is a no-op if the cert is already
  trusted.

.PARAMETER MsixPath
  Optional path to a specific signed .msix. If omitted, the most
  recently written file under
  `<scriptdir>/dist/<host-arch>/signed/*.msix` is used.

.EXAMPLE
  pwsh .\winui3\packaging\msix\install-locally.ps1
#>
[CmdletBinding()]
param(
    [string]$MsixPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot  = Join-Path $scriptDir 'dist'

function Get-HostArch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        'x86'   { 'x86' }
        default { 'x64' }
    }
}

function Resolve-LatestSignedMsix {
    if (-not (Test-Path $distRoot)) {
        throw "No build output at '$distRoot'. Run packaging\msix\build-msix.ps1 + sign-msix.ps1 first."
    }

    $hostArch = Get-HostArch

    $all = Get-ChildItem -Path $distRoot -Recurse -Filter '*.msix' -File |
        Where-Object { $_.FullName -match '\\signed\\' -and $_.FullName -notmatch '\\signed\\signed\\' }

    if (-not $all) {
        throw "No signed .msix found under '$distRoot\<arch>\signed\'. Run packaging\msix\sign-msix.ps1 first."
    }

    $native = $all | Where-Object { $_.FullName -match "\\dist\\$hostArch\\signed\\" } |
        Sort-Object LastWriteTime -Descending

    if ($native) {
        return $native[0].FullName
    }

    Write-Warning "No signed MSIX for host arch '$hostArch'; using most recent of any arch (may fail to install)."
    return ($all | Sort-Object LastWriteTime -Descending)[0].FullName
}

if (-not $MsixPath) {
    $MsixPath = Resolve-LatestSignedMsix
}
elseif (-not (Test-Path -LiteralPath $MsixPath)) {
    throw "MsixPath not found: $MsixPath"
}

$MsixPath = (Resolve-Path -LiteralPath $MsixPath).Path
Write-Host "Target MSIX: $MsixPath"

# Self-elevate if needed. Cert import + Add-AppxPackage (for a cert
# we are trusting on the fly) requires admin.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host 'Not running as Administrator — relaunching elevated via UAC...'

    $pwshExe = (Get-Process -Id $PID).Path
    if (-not $pwshExe) { $pwshExe = 'pwsh.exe' }

    $argList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$($MyInvocation.MyCommand.Path)`"",
        '-MsixPath', "`"$MsixPath`""
    )

    Start-Process -FilePath $pwshExe `
                  -ArgumentList $argList `
                  -Verb RunAs `
                  -Wait
    return
}

Write-Host 'Running as Administrator — proceeding.'

# 1. Extract the signer certificate from the MSIX.
$sig = Get-AuthenticodeSignature $MsixPath
if (-not $sig.SignerCertificate) {
    throw "MSIX has no Authenticode signature: $MsixPath. Run sign-msix.ps1 first."
}
$signerSubject = $sig.SignerCertificate.Subject
$signerThumb   = $sig.SignerCertificate.Thumbprint
Write-Host "Signer cert: $signerSubject  ($signerThumb)"

# 2. Import the signer cert into LocalMachine\TrustedPeople (idempotent —
#    Import-Certificate is a no-op if the thumbprint is already present).
$trustStore = 'Cert:\LocalMachine\TrustedPeople'
$existing = Get-ChildItem $trustStore -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $signerThumb }

if ($existing) {
    Write-Host "Cert already trusted in $trustStore — skipping import."
}
else {
    $certPath = Join-Path $env:TEMP "ccw-signer-$signerThumb.cer"
    [System.IO.File]::WriteAllBytes(
        $certPath,
        $sig.SignerCertificate.Export('Cert'))
    Import-Certificate -FilePath $certPath -CertStoreLocation $trustStore | Out-Null
    Remove-Item $certPath -ErrorAction SilentlyContinue
    Write-Host "Imported cert into $trustStore."
}

# 3. Install (replaces any prior version, closes running instance).
Write-Host "Installing $MsixPath ..."
try {
    Add-AppxPackage -Path $MsixPath -ForceApplicationShutdown -ErrorAction Stop
}
catch {
    $msg = $_.Exception.Message
    if ($msg -match '0x800B0109') {
        Write-Error "HRESULT 0x800B0109: cert trust did not take effect. Reboot or re-run from a fresh elevated session."
    }
    elseif ($msg -match '0x80073CFD') {
        Write-Error "HRESULT 0x80073CFD: wrong architecture for this machine. Expected $(Get-HostArch)."
    }
    elseif ($msg -match '0x80073CFB|0x80073D06') {
        Write-Error "Add-AppxPackage reported a version conflict. Try: Get-AppxPackage CopilotConnectorWorkflow.WinUI | Remove-AppxPackage"
    }
    throw
}

# 4. Verify.
$pkg = Get-AppxPackage CopilotConnectorWorkflow.WinUI -ErrorAction SilentlyContinue
if (-not $pkg) {
    throw 'CopilotConnectorWorkflow.WinUI is not installed after Add-AppxPackage. Check output above.'
}

Write-Host ''
Write-Host '==> Installed:'
$pkg | Format-List Name, Version, Architecture, PackageFullName, InstallLocation
Write-Host ''
$aumid = "$($pkg.PackageFamilyName)!App"
Write-Host "Launch from Start menu or:"
Write-Host "    Start-Process 'shell:AppsFolder\$aumid'"
