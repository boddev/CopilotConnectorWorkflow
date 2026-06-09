#requires -Version 7.0
<#
.SYNOPSIS
  Build the Ccw.UI MSIX package(s) for one or more architectures via
  single-project MSIX (Phase 7 of the WinUI 3 native port plan).

.DESCRIPTION
  Wraps `dotnet build /p:WindowsPackageType=MSIX`. Per the sibling
  EvalToolkit slice 33 review, explicit RuntimeIdentifier is passed
  alongside Platform so the per-arch self-contained publish produces
  correct native binaries.

  Steps per architecture:
    1. Synthesise placeholder PNG assets if missing (so a fresh clone
       can package without manual asset prep).
    2. Clean the per-arch AppPackages folder to avoid stale package
       pickup.
    3. Invoke `dotnet build` with the MSIX properties.
    4. Locate the produced `.msix` (newest under AppPackages\) and
       copy it to packaging\msix\dist\<arch>\.
    5. Emit SHA-256 + size to the host.

  This script does NOT sign the package; signing is sign-msix.ps1.
  Unsigned MSIX is structurally valid for `makeappx unpack` validation
  but cannot be installed via `Add-AppxPackage` without further signing
  or test-cert setup.

.PARAMETER Arch
  x64, arm64, or both (default).

.PARAMETER Configuration
  MSBuild configuration (default: Release).

.PARAMETER SkipAssets
  Skip placeholder asset synthesis (CCW already ships real PNGs under
  src\Ccw.UI\Assets\Packaging — CI should pass -SkipAssets).

.EXAMPLE
  pwsh .\packaging\msix\build-msix.ps1 -Arch x64
  pwsh .\packaging\msix\build-msix.ps1 -Arch both -Configuration Release -SkipAssets
#>
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64', 'both')]
    [string]$Arch = 'both',

    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [switch]$SkipAssets
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path -Path (Join-Path $PSScriptRoot '..\..')
$projectPath = Join-Path $repoRoot 'src\Ccw.UI\Ccw.UI.csproj'
$assetsDir = Join-Path $repoRoot 'src\Ccw.UI\Assets\Packaging'
$distRoot = Join-Path $repoRoot 'packaging\msix\dist'

if (-not (Test-Path $projectPath)) {
    throw "Project not found: $projectPath"
}

function Get-DotnetPath {
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'dotnet CLI not found. Install the .NET 10 SDK and add it to PATH.'
}

function New-PlaceholderPng {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [int]$Width,
        [Parameter(Mandatory)] [int]$Height,
        [string]$Label = '',
        [string]$BgColor = '#202020',
        [string]$FgColor = '#7CC8FF'
    )

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    } catch {
        throw "System.Drawing is not available in this PowerShell host, so placeholder PNGs cannot be synthesised. Either run this script on a Windows host with the .NET desktop runtime, or pre-commit the required PNGs to '$Path' and rerun with '-SkipAssets'. Underlying error: $($_.Exception.Message)"
    }

    $bg = [System.Drawing.ColorTranslator]::FromHtml($BgColor)
    $fg = [System.Drawing.ColorTranslator]::FromHtml($FgColor)

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.Clear($bg)

            if ($Label) {
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
                $fontSize = [Math]::Max(8, [Math]::Min($Width, $Height) / 6)
                $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
                try {
                    $brush = New-Object System.Drawing.SolidBrush($fg)
                    try {
                        $sf = New-Object System.Drawing.StringFormat
                        $sf.Alignment = [System.Drawing.StringAlignment]::Center
                        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
                        $rect = New-Object System.Drawing.RectangleF(0, 0, $Width, $Height)
                        $g.DrawString($Label, $font, $brush, $rect, $sf)
                    } finally { $brush.Dispose() }
                } finally { $font.Dispose() }
            }
        } finally { $g.Dispose() }

        $dir = Split-Path $Path -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
}

function Initialize-Assets {
    param([string]$AssetsDir)

    $needed = @(
        @{ Name = 'Square44x44Logo.png';   Width =  44; Height =  44; Label = 'CCW' },
        @{ Name = 'Square150x150Logo.png'; Width = 150; Height = 150; Label = 'CCW' },
        @{ Name = 'Wide310x150Logo.png';   Width = 310; Height = 150; Label = 'CCW' },
        @{ Name = 'StoreLogo.png';         Width =  50; Height =  50; Label = 'CCW' },
        @{ Name = 'SplashScreen.png';      Width = 620; Height = 300; Label = 'CCW' },
        @{ Name = 'evalset-logo.png';      Width =  44; Height =  44; Label = 'EVL' },
        @{ Name = 'results-logo.png';      Width =  44; Height =  44; Label = 'CSV' },
        @{ Name = 'report-logo.png';       Width =  44; Height =  44; Label = 'MD'  }
    )

    foreach ($asset in $needed) {
        $path = Join-Path $AssetsDir $asset.Name
        if (-not (Test-Path $path)) {
            Write-Host "  Synthesising placeholder: $($asset.Name) ($($asset.Width)x$($asset.Height))"
            New-PlaceholderPng -Path $path -Width $asset.Width -Height $asset.Height -Label $asset.Label
        }
    }
}

function Invoke-MsixBuild {
    param(
        [Parameter(Mandatory)] [string]$Architecture,
        [Parameter(Mandatory)] [string]$Configuration,
        [Parameter(Mandatory)] [string]$Dotnet,
        [Parameter(Mandatory)] [string]$ProjectPath,
        [Parameter(Mandatory)] [string]$RepoRoot,
        [Parameter(Mandatory)] [string]$DistRoot
    )

    $rid = "win-$Architecture"
    $appPackagesDir = Join-Path $RepoRoot "src\Ccw.UI\AppPackages"
    $distDir = Join-Path $DistRoot $Architecture

    Write-Host ''
    Write-Host "==> Building MSIX: arch=$Architecture configuration=$Configuration rid=$rid"
    Write-Host "    Project:      $ProjectPath"
    Write-Host "    AppPackages:  $appPackagesDir"
    Write-Host "    Dist:         $distDir"

    if (Test-Path $appPackagesDir) {
        Write-Host "    Cleaning stale AppPackages..."
        Remove-Item -Path $appPackagesDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $distDir) {
        Remove-Item -Path $distDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null

    # `dotnet build` (NOT `msbuild` from VS 2022) — the .NET 10 SDK
    # requires MSBuild 18+, and VS 2022 ships 17.x. `dotnet build`
    # uses the SDK-bundled MSBuild, which is correct for .NET 10.
    $dotnetArgs = @(
        'build', $ProjectPath,
        '-c', $Configuration,
        "-p:Platform=$Architecture",
        "-p:RuntimeIdentifier=$rid",
        '-p:WindowsPackageType=MSIX',
        '-p:GenerateAppxPackageOnBuild=true',
        '-p:AppxPackageSigningEnabled=false',
        '-p:AppxBundle=Never',
        '--nologo',
        '-v:m'
    )

    Write-Host "    dotnet $($dotnetArgs -join ' ')"
    & $Dotnet @dotnetArgs
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet build failed for arch=$Architecture (exit code $LASTEXITCODE)"
    }

    if (-not (Test-Path $appPackagesDir)) {
        throw "AppPackages directory not produced: $appPackagesDir"
    }

    $candidates = Get-ChildItem -Path $appPackagesDir -Recurse -Filter '*.msix' -File |
        Where-Object { $_.Name -notlike '*.appxsym' } |
        Sort-Object LastWriteTimeUtc -Descending

    if (-not $candidates) {
        $appxs = Get-ChildItem -Path $appPackagesDir -Recurse -Filter '*.appx' -File -ErrorAction SilentlyContinue
        $bundles = Get-ChildItem -Path $appPackagesDir -Recurse -Filter '*.msixbundle' -File -ErrorAction SilentlyContinue
        $listing = ($appxs + $bundles) | Select-Object -ExpandProperty FullName
        throw "No .msix produced under $appPackagesDir. Other artifacts present: $($listing -join ', ')"
    }

    $produced = $candidates | Select-Object -First 1
    $destPath = Join-Path $distDir $produced.Name
    Copy-Item -Path $produced.FullName -Destination $destPath -Force

    $hash = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash
    $sizeKb = [Math]::Round($produced.Length / 1024, 1)

    Write-Host ''
    Write-Host "    BUILT: $destPath"
    Write-Host "      Size:    $sizeKb KB"
    Write-Host "      SHA256:  $hash"

    return [pscustomobject]@{
        Architecture = $Architecture
        Path = $destPath
        SizeBytes = $produced.Length
        Sha256 = $hash
    }
}

# -------------------- Main ---------------------------------------

Write-Host "CCW MSIX build (Phase 7 native port packaging)"
Write-Host "  Repo root:     $repoRoot"
Write-Host "  Configuration: $Configuration"
Write-Host "  Architecture:  $Arch"

if (-not $SkipAssets) {
    Write-Host ''
    Write-Host '==> Ensuring placeholder assets...'
    Initialize-Assets -AssetsDir $assetsDir
}

$dotnet = Get-DotnetPath
Write-Host ''
Write-Host "Using dotnet: $dotnet"

$targets = switch ($Arch) {
    'both'  { @('x64', 'arm64') }
    default { @($Arch) }
}

$results = @()
foreach ($t in $targets) {
    $results += Invoke-MsixBuild `
        -Architecture $t `
        -Configuration $Configuration `
        -Dotnet $dotnet `
        -ProjectPath $projectPath `
        -RepoRoot $repoRoot `
        -DistRoot $distRoot
}

Write-Host ''
Write-Host '==> Summary'
$results | Format-Table -AutoSize Architecture, Path, SizeBytes, Sha256
exit 0
