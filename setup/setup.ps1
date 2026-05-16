<#
.SYNOPSIS
    Copilot Connector Workflow - Automated Setup

.DESCRIPTION
    Installs every dependency needed to run the workflow:
      - Verifies (and optionally installs via winget) Node.js 22+, Python 3,
        Git, PowerShell, and Azure CLI.
      - Clones the three sibling repos required by the pipeline
        (EvaluationCLI, data-enhancer, CopilotConnectorSkill).
      - Builds EvaluationCLI/eval-gen and this workflow.
      - Prompts to sign in to Microsoft 365 (Graph) AND Azure separately so a
        user can authenticate to one tenant for M365 and a different tenant
        for Azure deployment.
      - Optionally accepts the @microsoft/m365-copilot-eval EULA (required
        before the first Step 6 run).
      - Runs the workflow's `tools` health probe and prints next-step guidance.

    Reads optional configuration from setup\.env. Safe to re-run (idempotent
    install + clone + build steps). Each phase can be skipped with a switch.

.PARAMETER EnvFile
    Path to the .env configuration file. Default: setup\.env

.PARAMETER SkipInstall
    Do not attempt to winget-install missing prerequisites (only verify).

.PARAMETER SkipClone
    Do not clone sibling repos (use existing checkouts).

.PARAMETER SkipBuild
    Do not run npm install/build for EvaluationCLI and this workflow.

.PARAMETER SkipM365Login
    Do not prompt to sign in to Microsoft 365 (Connect-MgGraph).

.PARAMETER SkipAzureLogin
    Do not prompt to sign in to Azure (az login).

.PARAMETER AcceptM365EvalEula
    Run `npx -y @microsoft/m365-copilot-eval@latest accept-eula` non-interactively.

.EXAMPLE
    .\setup\setup.ps1
    .\setup\setup.ps1 -EnvFile .\my-config.env -AcceptM365EvalEula
    .\setup\setup.ps1 -SkipInstall -SkipClone
#>

[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [switch]$SkipInstall,
    [switch]$SkipClone,
    [switch]$SkipBuild,
    [switch]$SkipM365Login,
    [switch]$SkipAzureLogin,
    [switch]$AcceptM365EvalEula
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Helpers ----------------------------------------------------------------

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor DarkGray
    Write-Host "  [$Step] $Message" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor DarkGray
}
function Write-Info { param([string]$Msg) Write-Host "  i $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string]$Msg) Write-Host "  + $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  ! $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "  x $Msg" -ForegroundColor Red }

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Read-EnvFile {
    param([string]$Path)
    $vars = @{}
    if (-not (Test-Path $Path)) { return $vars }
    foreach ($line in Get-Content $Path) {
        $line = $line.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -le 0) { continue }
        $key = $line.Substring(0, $eqIdx).Trim()
        $val = $line.Substring($eqIdx + 1).Trim()
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $vars[$key] = $val
    }
    return $vars
}

function Get-EnvValue {
    param([hashtable]$Env, [string]$Key, [string]$Default = "")
    if ($Env.ContainsKey($Key) -and $Env[$Key] -ne "") { return $Env[$Key] }
    return $Default
}

function Get-SemVer {
    param([string]$Raw)
    if (-not $Raw) { return [version]'0.0.0' }
    $clean = $Raw.Trim().TrimStart('v')
    $m = [regex]::Match($clean, '^(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $m.Success) { return [version]'0.0.0' }
    $major = [int]$m.Groups[1].Value
    $minor = [int]$m.Groups[2].Value
    $patch = if ($m.Groups[3].Success) { [int]$m.Groups[3].Value } else { 0 }
    return [version]::new($major, $minor, $patch)
}

function Install-WingetPackage {
    param([string]$Id, [string]$Label)
    if (-not (Test-Command "winget")) {
        Write-Warn "winget not available; cannot auto-install $Label. Install it manually and re-run."
        return $false
    }
    Write-Info "Installing $Label via winget ($Id)..."
    & winget install --id $Id --silent --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "winget install exited $LASTEXITCODE for $Label."
        return $false
    }
    Write-Ok "Installed $Label."
    # Refresh PATH for current session (winget puts new tools on PATH only for new sessions)
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    return $true
}

function Ensure-PsModule {
    param([string]$ModuleName, [version]$MinimumVersion = $null)
    $installed = Get-Module -ListAvailable -Name $ModuleName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending | Select-Object -First 1
    if ($installed) {
        if (-not $MinimumVersion -or $installed.Version -ge $MinimumVersion) {
            Write-Ok "PowerShell module $ModuleName $($installed.Version) is installed."
            return $true
        }
        Write-Info "$ModuleName $($installed.Version) is below required $MinimumVersion."
    } else {
        Write-Info "$ModuleName not installed."
    }
    try {
        Install-Module -Name $ModuleName -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        Write-Ok "Installed PowerShell module $ModuleName."
        return $true
    } catch {
        Write-Warn "Could not auto-install $ModuleName : $($_.Exception.Message)"
        return $false
    }
}

function Clone-OrUpdateRepo {
    param([string]$Url, [string]$Ref, [string]$TargetDir, [string]$Label)
    if (Test-Path (Join-Path $TargetDir ".git")) {
        Write-Info "$Label exists at $TargetDir - fetching latest..."
        Push-Location $TargetDir
        try {
            git fetch --all --quiet 2>$null | Out-Null
            if ($Ref) {
                git checkout $Ref --quiet 2>$null | Out-Null
                git pull --ff-only --quiet 2>$null | Out-Null
            }
            Write-Ok "Updated $Label."
            return $true
        } catch {
            Write-Warn "Could not update $Label (continuing with current checkout): $($_.Exception.Message)"
            return $true
        } finally {
            Pop-Location
        }
    }
    if (Test-Path $TargetDir) {
        Write-Warn "$TargetDir exists but is not a git repo. Skipping clone (leave intact)."
        return $true
    }
    Write-Info "Cloning $Label from $Url..."
    try {
        $args = @('clone', '--quiet', $Url, $TargetDir)
        if ($Ref) { $args = $args + @('--branch', $Ref) }
        git @args 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { throw "git clone exit $LASTEXITCODE" }
        Write-Ok "Cloned $Label -> $TargetDir."
        return $true
    } catch {
        Write-Err "Failed to clone $Label : $($_.Exception.Message)"
        return $false
    }
}

# --- Banner -----------------------------------------------------------------

$banner = @"

  ============================================================
   Copilot Connector Workflow - Automated Setup
  ============================================================
   Installs prerequisites, clones sibling repos, builds the
   tools, signs you in to M365 and Azure (separately), and
   verifies the workflow can run end-to-end.
  ============================================================

"@
Write-Host $banner -ForegroundColor Cyan

# --- Resolve project roots --------------------------------------------------

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir
$siblingsRoot = Split-Path -Parent $projectRoot  # parent of CopilotConnectorWorkflow

Push-Location $projectRoot
try {

# --- Step 0: Load .env ------------------------------------------------------

Write-Step "0/8" "Loading Configuration"

if ($EnvFile -eq "") {
    if (Test-Path (Join-Path $scriptDir ".env")) {
        $EnvFile = Join-Path $scriptDir ".env"
    } elseif (Test-Path (Join-Path $projectRoot ".env")) {
        $EnvFile = Join-Path $projectRoot ".env"
    } else {
        $EnvFile = Join-Path $scriptDir ".env"
    }
}

$envVars = @{}
if (Test-Path $EnvFile) {
    Write-Info "Reading configuration from: $EnvFile"
    $envVars = Read-EnvFile -Path $EnvFile
    Write-Ok "Loaded $($envVars.Count) variables."
} else {
    Write-Info "No .env file found. Using defaults (and prompts where required)."
    Write-Info "Tip: copy setup\.env.example to setup\.env to customize."
}

$evalRepo       = Get-EnvValue $envVars "EVALUATIONCLI_REPO"           "https://github.com/boddev/EvaluationCLI.git"
$evalRef        = Get-EnvValue $envVars "EVALUATIONCLI_REF"            "main"
$enhancerRepo   = Get-EnvValue $envVars "DATA_ENHANCER_REPO"           "https://github.com/boddev/data-enhancer.git"
$enhancerRef    = Get-EnvValue $envVars "DATA_ENHANCER_REF"            "main"
$skillRepo      = Get-EnvValue $envVars "COPILOT_CONNECTOR_SKILL_REPO" "https://github.com/boddev/CopilotConnectorSkill.git"
$skillRef       = Get-EnvValue $envVars "COPILOT_CONNECTOR_SKILL_REF"  "main"

$m365TenantId   = Get-EnvValue $envVars "M365_TENANT_ID"       ""
$azTenantId     = Get-EnvValue $envVars "AZURE_TENANT_ID"      ""
$azSubId        = Get-EnvValue $envVars "AZURE_SUBSCRIPTION_ID" ""

$envInstall     = (Get-EnvValue $envVars "INSTALL_MISSING_TOOLS"   "true") -eq "true"
$envAcceptEula  = (Get-EnvValue $envVars "ACCEPT_M365_EVAL_EULA"   "false") -eq "true"
if ($AcceptM365EvalEula.IsPresent) { $envAcceptEula = $true }

# --- Step 1: Prerequisites --------------------------------------------------

Write-Step "1/8" "Checking Prerequisites"

# Map tool -> winget package id
$wingetIds = @{
    'node'   = 'OpenJS.NodeJS.LTS'
    'python' = 'Python.Python.3.12'
    'git'    = 'Git.Git'
    'az'     = 'Microsoft.AzureCLI'
}

$tools = @(
    @{ Name='node';   Label='Node.js';        Required=$true  },
    @{ Name='npm';    Label='npm';            Required=$true  },
    @{ Name='python'; Label='Python';         Required=$true  },
    @{ Name='git';    Label='Git';            Required=$true  },
    @{ Name='az';     Label='Azure CLI';      Required=$false }
)

$installAttempted = $false
foreach ($tool in $tools) {
    if (Test-Command $tool.Name) {
        $ver = ""
        try { $ver = & $tool.Name --version 2>$null | Select-Object -First 1 } catch {}
        Write-Ok "$($tool.Label): $ver"
        continue
    }
    if ($tool.Required -and -not $SkipInstall -and $envInstall) {
        $pkgId = $wingetIds[$tool.Name]
        if ($pkgId) {
            $installAttempted = $true
            Install-WingetPackage -Id $pkgId -Label $tool.Label | Out-Null
        }
    } elseif (-not $tool.Required) {
        Write-Warn "$($tool.Label) not installed (optional - needed only for actual Azure deploys)."
    } else {
        Write-Err "$($tool.Label) is not installed and auto-install is disabled."
    }
}

# Re-check core required tools after install attempt
if ($installAttempted) {
    Write-Info "Re-checking required tools after winget install..."
}

$missing = @()
foreach ($tool in $tools) {
    if ($tool.Required -and -not (Test-Command $tool.Name)) { $missing += $tool.Label }
}
if ($missing.Count -gt 0) {
    throw "Missing required tools: $($missing -join ', '). Install them and re-run setup."
}

# Node version check (must be >= 22.21.1 for Step 6; >= 18 for the rest)
$nodeRaw = (& node --version) 2>$null
$nodeVer = Get-SemVer $nodeRaw
$nodeMinStep6 = [version]'22.21.1'
$nodeMinBase  = [version]'18.0.0'
if ($nodeVer -lt $nodeMinBase) {
    throw "Node.js $nodeRaw is below minimum 18.0.0. Install Node 22.21.1+."
}
if ($nodeVer -lt $nodeMinStep6) {
    Write-Warn "Node.js $nodeRaw is below $nodeMinStep6. Steps 1-5 will work, but Step 6 (@microsoft/m365-copilot-eval) will fail at runtime until Node is upgraded."
} else {
    Write-Ok "Node.js $nodeRaw meets the >= $nodeMinStep6 bar for Step 6."
}

# Python version
$pyRaw = (& python --version) 2>$null
Write-Ok "$pyRaw detected."

# --- Step 2: Clone sibling repos --------------------------------------------

Write-Step "2/8" "Cloning sibling repositories"

if ($SkipClone) {
    Write-Info "SkipClone set - using existing checkouts at $siblingsRoot."
} else {
    Write-Info "Sibling root: $siblingsRoot"
    $repos = @(
        @{ Label='EvaluationCLI';        Url=$evalRepo;     Ref=$evalRef;     Dir=(Join-Path $siblingsRoot 'EvaluationCLI') },
        @{ Label='data-enhancer';        Url=$enhancerRepo; Ref=$enhancerRef; Dir=(Join-Path $siblingsRoot 'data-enhancer') },
        @{ Label='CopilotConnectorSkill';Url=$skillRepo;    Ref=$skillRef;    Dir=(Join-Path $siblingsRoot 'CopilotConnectorSkill') }
    )
    foreach ($r in $repos) {
        Clone-OrUpdateRepo -Url $r.Url -Ref $r.Ref -TargetDir $r.Dir -Label $r.Label | Out-Null
    }
}

# Sanity-check the files the workflow expects to find.
$expectFiles = @(
    @{ Path = Join-Path $siblingsRoot 'EvaluationCLI\eval-gen\package.json'; Label='eval-gen package.json' },
    @{ Path = Join-Path $siblingsRoot 'EvaluationCLI\scripts\convert-evalgen-to-m365-copilot-eval.ps1'; Label='m365-eval converter script' },
    @{ Path = Join-Path $siblingsRoot 'data-enhancer\enhance_for_copilot.py'; Label='enhance_for_copilot.py' },
    @{ Path = Join-Path $siblingsRoot 'CopilotConnectorSkill\copilot-connector\SKILL.md'; Label='Copilot Connector skill' }
)
foreach ($e in $expectFiles) {
    if (Test-Path $e.Path) { Write-Ok "$($e.Label) found." }
    else { Write-Warn "$($e.Label) not found at $($e.Path)." }
}

# --- Step 3: Build EvaluationCLI/eval-gen -----------------------------------

Write-Step "3/8" "Building EvaluationCLI/eval-gen"

if ($SkipBuild) {
    Write-Info "SkipBuild set - assuming eval-gen is already built."
} else {
    $evalGenDir = Join-Path $siblingsRoot 'EvaluationCLI\eval-gen'
    if (-not (Test-Path $evalGenDir)) {
        Write-Warn "Skipping: $evalGenDir not present (clone failed or SkipClone)."
    } else {
        Push-Location $evalGenDir
        try {
            Write-Info "npm install (eval-gen)..."
            npm install --no-audit --no-fund --loglevel=error
            if ($LASTEXITCODE -ne 0) { throw "npm install (eval-gen) failed." }
            Write-Info "npm run build (eval-gen)..."
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build (eval-gen) failed." }
            Write-Ok "eval-gen built."
        } finally {
            Pop-Location
        }
    }
}

# --- Step 4: Build this workflow --------------------------------------------

Write-Step "4/8" "Building CopilotConnectorWorkflow"

if ($SkipBuild) {
    Write-Info "SkipBuild set - assuming workflow is already built."
} else {
    Push-Location $projectRoot
    try {
        Write-Info "npm install (workflow)..."
        npm install --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm install (workflow) failed." }
        Write-Info "npm run build (workflow)..."
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build (workflow) failed." }
        Write-Ok "Workflow built."
    } finally {
        Pop-Location
    }
}

# --- Step 5: Microsoft 365 sign-in -----------------------------------------

Write-Step "5/8" "Microsoft 365 sign-in"

if ($SkipM365Login) {
    Write-Info "SkipM365Login set - skipping."
} else {
    Write-Info "This sign-in is for the Microsoft 365 tenant whose Copilot the workflow will query (Step 1 LLM provider, Step 6 agent calls)."
    Write-Info "It can be a DIFFERENT tenant than the Azure subscription where you deploy the connector."

    if ($m365TenantId -eq "") {
        $m365TenantId = Read-Host "  -> Enter Microsoft 365 tenant ID (or leave blank to be prompted by the browser)"
    }

    $hasMg = Ensure-PsModule -ModuleName 'Microsoft.Graph.Authentication'
    if ($hasMg) {
        try {
            Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
            $scopes = @('User.Read')
            if ($m365TenantId -ne "") {
                Write-Info "Connect-MgGraph -TenantId $m365TenantId -Scopes $($scopes -join ',') ..."
                Connect-MgGraph -TenantId $m365TenantId -Scopes $scopes -NoWelcome -ErrorAction Stop | Out-Null
            } else {
                Write-Info "Connect-MgGraph -Scopes $($scopes -join ',') ..."
                Connect-MgGraph -Scopes $scopes -NoWelcome -ErrorAction Stop | Out-Null
            }
            $ctx = Get-MgContext
            Write-Ok "Signed in to M365 tenant $($ctx.TenantId) as $($ctx.Account)."
        } catch {
            Write-Warn "M365 sign-in failed or was cancelled: $($_.Exception.Message)"
            Write-Info "You can sign in later via Connect-MgGraph -TenantId <id> -Scopes User.Read."
        }
    } else {
        Write-Warn "Microsoft.Graph.Authentication module not available; skipping M365 sign-in."
        Write-Info "Install manually: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser"
    }
}

# --- Step 6: Azure sign-in -------------------------------------------------

Write-Step "6/8" "Azure sign-in"

if ($SkipAzureLogin) {
    Write-Info "SkipAzureLogin set - skipping."
} elseif (-not (Test-Command "az")) {
    Write-Warn "Azure CLI not installed - skipping. Install via winget (Microsoft.AzureCLI) or https://aka.ms/azcli."
} else {
    Write-Info "This sign-in is for the Azure subscription where you intend to deploy the connector."
    Write-Info "It can be a DIFFERENT tenant than the M365 sign-in above."

    if ($azTenantId -eq "") {
        $azTenantId = Read-Host "  -> Enter Azure tenant ID (or leave blank for default)"
    }
    try {
        $accountJson = & az account show 2>$null
        $account = if ($accountJson) { $accountJson | ConvertFrom-Json } else { $null }
        $needLogin = ($null -eq $account)
        if ($azTenantId -ne "" -and $account -and $account.tenantId -ne $azTenantId) {
            Write-Info "Current az session is on tenant $($account.tenantId); switching to $azTenantId."
            $needLogin = $true
        }
        if ($needLogin) {
            $args = @("login")
            if ($azTenantId -ne "") { $args += @("--tenant", $azTenantId) }
            & az @args | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "az login exit $LASTEXITCODE" }
            $account = (& az account show 2>$null) | ConvertFrom-Json
        }
        Write-Ok "Signed in to Azure as $($account.user.name)."
        Write-Info "Active tenant:        $($account.tenantId)"
        Write-Info "Active subscription:  $($account.name) ($($account.id))"

        if ($azSubId -ne "" -and $account.id -ne $azSubId) {
            Write-Info "Setting subscription to $azSubId..."
            & az account set --subscription $azSubId
            if ($LASTEXITCODE -eq 0) {
                $account = (& az account show 2>$null) | ConvertFrom-Json
                Write-Ok "Active subscription: $($account.name) ($($account.id))"
            } else {
                Write-Warn "Failed to switch subscription."
            }
        }
    } catch {
        Write-Warn "Azure sign-in failed: $($_.Exception.Message)"
        Write-Info "You can sign in later via: az login --tenant <id>"
    }
}

# --- Step 7: m365-copilot-eval EULA (optional) ----------------------------

Write-Step "7/8" "Microsoft m365-copilot-eval EULA"

if (-not $envAcceptEula) {
    Write-Info "Skipping. Pass -AcceptM365EvalEula (or set ACCEPT_M365_EVAL_EULA=true) to accept now."
    Write-Info "First Step 6 run will prompt for acceptance otherwise."
} elseif ($nodeVer -lt $nodeMinStep6) {
    Write-Warn "Node $nodeRaw is below $nodeMinStep6 - EULA accept skipped. Upgrade Node and re-run."
} else {
    Write-Info "Running: npx -y @microsoft/m365-copilot-eval@latest accept-eula"
    try {
        & npx -y "@microsoft/m365-copilot-eval@latest" accept-eula
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "EULA accepted."
        } else {
            Write-Warn "EULA accept exited $LASTEXITCODE."
        }
    } catch {
        Write-Warn "EULA accept failed: $($_.Exception.Message)"
    }
}

# --- Step 8: Tool health probe + summary ----------------------------------

Write-Step "8/8" "Verifying workflow"

Push-Location $projectRoot
try {
    if (Test-Path (Join-Path $projectRoot 'dist\cli.js')) {
        & node dist\cli.js tools
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Tool probe exited $LASTEXITCODE - some dependencies are still missing."
        }
    } else {
        Write-Warn "dist\cli.js not built; run npm run build."
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "  Setup complete. Next steps:" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "    GUI:" -ForegroundColor White
Write-Host "      scripts\start.cmd" -ForegroundColor Gray
Write-Host "    Headless CLI smoke test:" -ForegroundColor White
Write-Host "      scripts\run-cli.cmd run --dataset `"..\EvaluationCLI\environment-datasets`" ``" -ForegroundColor Gray
Write-Host "        --description `"Environment datasets`" --count 10 --extensions csv ``" -ForegroundColor Gray
Write-Host "        --connector-id ccwenvtest --connector-name `"CCW Env Test`" --mode build" -ForegroundColor Gray
Write-Host ""

} finally {
    Pop-Location
}
