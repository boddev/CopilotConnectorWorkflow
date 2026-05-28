<#
.SYNOPSIS
  One-shot setup for the Work IQ A2A path used by eval-score
  (--m365-agent-id / --judge-agent-id).

.DESCRIPTION
  Automates every prerequisite documented in agents/eval-judge/README.md:

    1. Provisions the Work IQ first-party service principal in the tenant
       (fdcc1f02-fc51-4226-8753-f668596af7f7). Required to avoid
       AADSTS650052 on subsequent device-code calls.
    2. Acquires a delegated WorkIQAgent.Ask token via the OAuth2
       device-code flow against the Azure PowerShell well-known public
       client. An admin or Copilot-licensed user signs in interactively.
    3. Discovers all declarative agents the signed-in user can reach via
       the A2A gateway and writes them to disk for reuse.
    4. Emits a ready-to-source env-var file so eval-score can be invoked
       directly. Optionally launches an eval-score run immediately.

  This script does NOT need a client secret for the A2A path itself —
  delegated user auth is what the Work IQ gateway requires. The optional
  ClientId / ClientSecret parameters let you reuse an existing app-only
  Graph identity to verify external connectors (Step 0).

.PARAMETER TenantId
  Target Microsoft 365 tenant id (GUID).

.PARAMETER OutputDir
  Directory to write the token + agents JSON + env file into. Defaults
  to .\workspace\a2a-setup.

.PARAMETER ClientId
  Optional. App-only Graph client id (must have
  ExternalConnection.ReadWrite.All). Only used if -VerifyConnectors is
  passed.

.PARAMETER ClientSecret
  Optional. Paired with -ClientId for app-only Graph.

.PARAMETER VerifyConnectors
  If set, lists all external connections in the tenant via app-only
  Graph and writes them to connectors.json. Useful to sanity-check that
  the candidate agents have data to ground on.

.PARAMETER RunEvalScore
  If set, launches eval-score after setup completes. Requires
  -EvalInput, -CandidateAgentId, -JudgeAgentId.

.PARAMETER EvalInput
  Path to the eval CSV / JSON / XLSX file for eval-score --input.

.PARAMETER CandidateAgentId
  agentId for the M365 declarative agent under test.

.PARAMETER JudgeAgentId
  agentId for the Eval Judge declarative agent.

.PARAMETER Concurrency
  eval-score concurrency. Default 3.

.EXAMPLE
  # Just provision SP + get token + list agents
  ./scripts/setup-a2a.ps1 -TenantId 976f427e-0d86-4ecf-ace3-4d1368eb8358

.EXAMPLE
  # End-to-end: provision, list agents, verify connectors, kick off scoring
  ./scripts/setup-a2a.ps1 `
    -TenantId          976f427e-0d86-4ecf-ace3-4d1368eb8358 `
    -ClientId          4bd31653-0e5d-4fe3-bea1-972f4161ed43 `
    -ClientSecret      $env:CCW_GRAPH_SECRET `
    -VerifyConnectors `
    -RunEvalScore `
    -EvalInput         .\eval.csv `
    -CandidateAgentId  'T_9f5aee25-7461-7840-8d79-56ce062eb7db.declarativeAgent' `
    -JudgeAgentId      'T_4856ee09-27df-373e-ebdf-5648bf9df79a.declarativeAgent'

.NOTES
  Reference IDs are baked in at the top of the script. Update them if
  Microsoft ever rotates the Work IQ first-party AppId.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $TenantId,

    [string] $OutputDir = (Join-Path (Get-Location) 'workspace\a2a-setup'),

    [string] $ClientId,
    [string] $ClientSecret,
    [switch] $VerifyConnectors,

    [switch] $RunEvalScore,
    [string] $EvalInput,
    [string] $CandidateAgentId,
    [string] $JudgeAgentId,
    [int]    $Concurrency  = 3,
    [int]    $DelayMs      = 250,
    [string] $EvalOutputDir
)

$ErrorActionPreference = 'Stop'

# ── Well-known IDs ──────────────────────────────────────────────────────
$WorkIqAppId          = 'fdcc1f02-fc51-4226-8753-f668596af7f7'
$WorkIqAskScope       = "$WorkIqAppId/WorkIQAgent.Ask"
$AzPowershellClientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
$A2AGateway           = 'https://workiq.svc.cloud.microsoft/a2a'

function Write-Section ([string]$title) {
    Write-Host ''
    Write-Host "── $title ──" -ForegroundColor Cyan
}

function Decode-Jwt ([string]$token) {
    $payload = $token.Split('.')[1]
    $pad = 4 - ($payload.Length % 4)
    if ($pad -lt 4) { $payload += ('=' * $pad) }
    $payload = $payload.Replace('-', '+').Replace('_', '/')
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
}

# ── 0. Preflight ────────────────────────────────────────────────────────
Write-Section 'Preflight'
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
Write-Host "  Output dir: $OutputDir"

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error 'Azure CLI (az) is required. Install: https://aka.ms/azcli'
    exit 1
}

try { $acct = az account show 2>$null | ConvertFrom-Json } catch { $acct = $null }
if (-not $acct) {
    Write-Host '  Not logged in to az. Running: az login --tenant ' -NoNewline
    Write-Host $TenantId -ForegroundColor Yellow
    az login --tenant $TenantId --only-show-errors | Out-Null
    $acct = az account show | ConvertFrom-Json
}
if ($acct.tenantId -ne $TenantId) {
    Write-Host "  Active az tenant ($($acct.tenantId)) != requested tenant. Switching." -ForegroundColor Yellow
    az login --tenant $TenantId --only-show-errors | Out-Null
}
Write-Host "  az signed in as: $($acct.user.name) (tenant $($acct.tenantId))"

if ($RunEvalScore) {
    foreach ($p in 'EvalInput','CandidateAgentId','JudgeAgentId') {
        if (-not (Get-Variable -Name $p -ValueOnly -Scope Local)) {
            Write-Error "-RunEvalScore requires -$p"
            exit 1
        }
    }
    if (-not (Get-Command eval-score -ErrorAction SilentlyContinue)) {
        Write-Error 'eval-score not on PATH. Run: cd EvaluationCLI/eval-score/node && npm link'
        exit 1
    }
    if (-not (Test-Path $EvalInput)) {
        Write-Error "Eval input not found: $EvalInput"
        exit 1
    }
    if (-not $EvalOutputDir) {
        $EvalOutputDir = Join-Path $OutputDir ('eval-' + (Get-Date -Format 'yyyyMMddHHmmss'))
    }
}

# ── 1. Provision Work IQ SP ─────────────────────────────────────────────
Write-Section "Provisioning Work IQ service principal ($WorkIqAppId)"
$existing = az ad sp show --id $WorkIqAppId 2>$null
if ($existing) {
    Write-Host '  Already provisioned.'
} else {
    Write-Host '  Creating service principal...'
    az ad sp create --id $WorkIqAppId --only-show-errors | Out-Null
    Write-Host '  Done.'
}

# ── 2. Device-code: WorkIQAgent.Ask delegated token ─────────────────────
Write-Section 'Acquiring delegated WorkIQAgent.Ask token'

$body = @{ client_id = $AzPowershellClientId; scope = "$WorkIqAskScope offline_access" }
$dc = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/devicecode" -Body $body

Write-Host ''
Write-Host '  ┌──────────────────────────────────────────────────────────────┐'
Write-Host "  │  Go to: $($dc.verification_uri)"
Write-Host "  │  Code:  $($dc.user_code)"
Write-Host '  └──────────────────────────────────────────────────────────────┘'
Write-Host ''
Write-Host '  Waiting for sign-in...'

$pollBody = @{
    grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
    client_id   = $AzPowershellClientId
    device_code = $dc.device_code
}
$tok = $null
$deadline = (Get-Date).AddSeconds($dc.expires_in)
while ((Get-Date) -lt $deadline) {
    Start-Sleep $dc.interval
    try {
        $tok = Invoke-RestMethod -Method POST `
            -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body $pollBody
        break
    } catch {
        $err = $null
        try { $err = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
        if ($err -and $err.error -ne 'authorization_pending') {
            Write-Error "Device code error: $($err.error) - $($err.error_description)"
            exit 1
        }
    }
}
if (-not $tok) {
    Write-Error 'Device code expired before sign-in completed.'
    exit 1
}

$tokenPath   = Join-Path $OutputDir 'workiq_token.txt'
$refreshPath = Join-Path $OutputDir 'workiq_refresh.txt'
$tok.access_token  | Set-Content $tokenPath -NoNewline
if ($tok.refresh_token) {
    $tok.refresh_token | Set-Content $refreshPath -NoNewline
}

$claims = Decode-Jwt $tok.access_token
Write-Host "  Signed in as:   $($claims.upn ?? $claims.unique_name)"
Write-Host "  Token aud:      $($claims.aud)"
Write-Host "  Token scopes:   $($claims.scp)"
Write-Host "  Token expires:  $([DateTimeOffset]::FromUnixTimeSeconds($claims.exp).ToLocalTime())"
Write-Host "  Saved to:       $tokenPath"

# ── 3. Discover agents ──────────────────────────────────────────────────
Write-Section "Discovering agents from $A2AGateway/.agents"
$h = @{
    Authorization = "Bearer $($tok.access_token)"
    'X-variants'  = 'feature.EnableA2AServer'
}
$agents = Invoke-RestMethod -Method GET -Uri "$A2AGateway/.agents" -Headers $h
$agentsPath = Join-Path $OutputDir 'agents.json'
$agents | ConvertTo-Json -Depth 6 | Set-Content $agentsPath -Encoding UTF8

Write-Host ("  Found {0} agents." -f $agents.Count)
$agents | Sort-Object provider, name | Format-Table @{n='Provider';e={$_.provider}}, name, agentId -Wrap | Out-String | Write-Host
Write-Host "  Saved to: $agentsPath"

# ── 4. Optional: verify external connectors ─────────────────────────────
if ($VerifyConnectors) {
    Write-Section 'Verifying external connectors (app-only Graph)'
    if (-not $ClientId -or -not $ClientSecret) {
        Write-Warning '  -VerifyConnectors requires -ClientId and -ClientSecret. Skipping.'
    } else {
        $appBody = @{
            grant_type    = 'client_credentials'
            client_id     = $ClientId
            client_secret = $ClientSecret
            scope         = 'https://graph.microsoft.com/.default'
        }
        $appTok = Invoke-RestMethod -Method POST `
            -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body $appBody
        $cn = Invoke-RestMethod -Method GET `
            -Uri 'https://graph.microsoft.com/v1.0/external/connections' `
            -Headers @{ Authorization = "Bearer $($appTok.access_token)" }
        $cnPath = Join-Path $OutputDir 'connectors.json'
        $cn.value | ConvertTo-Json -Depth 6 | Set-Content $cnPath -Encoding UTF8
        Write-Host ("  Found {0} external connection(s)." -f $cn.value.Count)
        $cn.value | Format-Table id, name, state -Wrap | Out-String | Write-Host
        Write-Host "  Saved to: $cnPath"
    }
}

# ── 5. Emit env file ────────────────────────────────────────────────────
Write-Section 'Writing env-vars.ps1 (dot-source this before eval-score)'
$envPath = Join-Path $OutputDir 'env-vars.ps1'
@"
# Auto-generated by scripts/setup-a2a.ps1 on $(Get-Date -Format o)
# Dot-source this file to configure the current PowerShell session for eval-score.
`$env:WORK_IQ_A2A_ENDPOINT     = '$A2AGateway'
`$env:WORK_IQ_A2A_ACCESS_TOKEN = (Get-Content '$tokenPath' -Raw).Trim()
"@ | Set-Content $envPath -Encoding UTF8
Write-Host "  $envPath"
Write-Host "  Use:  . `"$envPath`""

# ── 6. Optional: run eval-score ─────────────────────────────────────────
if ($RunEvalScore) {
    Write-Section 'Launching eval-score'
    $env:WORK_IQ_A2A_ENDPOINT     = $A2AGateway
    $env:WORK_IQ_A2A_ACCESS_TOKEN = $tok.access_token
    New-Item -ItemType Directory -Path $EvalOutputDir -Force | Out-Null
    Write-Host "  Input:           $EvalInput"
    Write-Host "  Candidate agent: $CandidateAgentId"
    Write-Host "  Judge agent:     $JudgeAgentId"
    Write-Host "  Output dir:      $EvalOutputDir"
    Write-Host ''
    & eval-score `
        --input          $EvalInput `
        --m365-agent-id  $CandidateAgentId `
        --judge-agent-id $JudgeAgentId `
        --judge-provider workiq `
        --tenant-id      $TenantId `
        --concurrency    $Concurrency `
        --delay-ms       $DelayMs `
        --checkpoint-file (Join-Path $EvalOutputDir 'checkpoint.json') `
        --output-dir     $EvalOutputDir `
        --skip-preflight
}

Write-Section 'Setup complete'
Write-Host '  Next steps:'
Write-Host "    . `"$envPath`""
Write-Host "    eval-score --input <file> ``"
Write-Host "      --m365-agent-id  <agentId from $agentsPath> ``"
Write-Host "      --judge-agent-id <judge agentId> ``"
Write-Host "      --judge-provider workiq --tenant-id $TenantId ``"
Write-Host "      --output-dir <dir> --skip-preflight"
