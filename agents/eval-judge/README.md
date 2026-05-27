# Eval Judge declarative agent

A Microsoft 365 Copilot declarative agent used as an automated LLM-as-judge
by the `eval-score` CLI in `..\EvaluationCLI\eval-score`. It exists so
`eval-score` can score answers over the WorkIQ A2A REST endpoint
(`POST https://graph.microsoft.com/rp/workiq/{agentId}` with
`X-variants: feature.EnableA2AServer`) instead of the serialized local
`workiq mcp` MCP path.

Without a dedicated judging agent id, `eval-score` falls back to MCP for
the scoring phase even when `--m365-agent-id` is set (see
`workiq-client.ts` `A2AWorkIQClient.askWithMetadata`, which requires an
`agentId`, and `index.ts` which currently routes `judgeProvider ===
'workiq'` scoring back to `CliWorkIQClient`). With this agent deployed
and a `--judge-agent-id` flag wired through, A2A can serve both phases
concurrently.

## Contents

- `appPackage/manifest.json` — Teams app package manifest.
- `appPackage/declarativeAgent.json` — Copilot declarative agent definition.
- `appPackage/instruction.txt` — Judge system prompt loaded by the agent.

## Icons

`manifest.json` references `icon-color.png` and `icon-outline.png`. Copy
the existing icons from `templates/connector-project/appPackage/` or
supply your own before packaging:

```powershell
Copy-Item templates\connector-project\appPackage\icon-color.png agents\eval-judge\appPackage\
Copy-Item templates\connector-project\appPackage\icon-outline.png agents\eval-judge\appPackage\
```

## Deploy

Zip the `appPackage/` contents and upload via Teams Admin Center or
`teamsapp publish`. After deployment, capture the resulting Microsoft 365
Copilot agent id and pass it to `eval-score` as the judge agent (the
`--judge-agent-id` flag / `EVALSCORE_JUDGE_AGENT_ID` env var will be
added in a follow-up change to `EvaluationCLI/eval-score`).

## End-to-end A2A setup runbook

These are the exact steps to go from a fresh tenant to running
`eval-score --m365-agent-id <X> --judge-agent-id <Y>` over the Work IQ
A2A gateway. For an automated version, see
[`scripts/setup-a2a.ps1`](../../scripts/setup-a2a.ps1).

### Prerequisites
- A Microsoft 365 tenant where you (or admin) can run `az ad sp create`
- A Copilot-licensed user in that tenant
- `az` CLI logged in as a tenant admin: `az login --tenant <tenantId>`
- `eval-score` installed (`npm link` from `EvaluationCLI/eval-score/node`)
- All declarative agents (judge + candidates) already published and
  admin-approved in the tenant's M365 app catalog (`teamsapp provision`)

### Step 1 — Provision the Work IQ service principal (one-time)
Most tenants do not have the Work IQ first-party SP pre-provisioned.
Without it, any device-code / token call with the `WorkIQAgent.Ask` scope
fails with `AADSTS650052: lacks a service principal for fdcc1f02-...`.

```powershell
az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7
```

`fdcc1f02-fc51-4226-8753-f668596af7f7` is the well-known Work IQ
first-party AppId. The command is idempotent.

### Step 2 — Acquire a delegated `WorkIQAgent.Ask` token
Use the Azure PowerShell well-known public client
`14d82eec-204b-4c2f-b7e8-296a70dab67e` — it is already consented in
essentially every tenant, supports device code, and can request
first-party Microsoft scopes without an extra app registration.

```powershell
$tenant = '<tenantId>'
$client = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
$scope  = 'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask offline_access'

$dc = Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/devicecode" `
    -Body @{ client_id = $client; scope = $scope }
Write-Host "Go to $($dc.verification_uri) and enter $($dc.user_code)"

$pollBody = @{
  grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
  client_id   = $client
  device_code = $dc.device_code
}
do {
  Start-Sleep 5
  try {
    $tok = Invoke-RestMethod -Method POST `
      -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" -Body $pollBody
    break
  } catch { }  # ignore authorization_pending
} while ($true)

$tok.access_token  | Set-Content workiq_token.txt
$tok.refresh_token | Set-Content workiq_refresh.txt
```

Access tokens are valid ~75 min. Refresh via `grant_type=refresh_token`
with the same scope. Verify the JWT `aud` is
`fdcc1f02-fc51-4226-8753-f668596af7f7` and `scp` contains
`WorkIQAgent.Ask`.

### Step 3 — Discover agent IDs
Canonical gateway: **`https://workiq.svc.cloud.microsoft/a2a`** (not
`graph.microsoft.com/rp/workiq` — that returns "invalid audience").

```powershell
$h = @{
  Authorization = "Bearer $($tok.access_token)"
  'X-variants'  = 'feature.EnableA2AServer'
}
$agents = Invoke-RestMethod -Uri 'https://workiq.svc.cloud.microsoft/a2a/.agents' -Headers $h
$agents | Format-Table agentId, name, provider
```

Each declarative agent returns as:

```json
{
  "agentId":  "T_<guid>.declarativeAgent",
  "name":     "Eval Judge",
  "provider": "Copilot Connector Workflow"
}
```

`agentId` is the only value accepted by `--m365-agent-id` and
`--judge-agent-id`. It is NOT the `TEAMS_APP_ID` or `PUBLISHED_APP_ID`
emitted by `teamsapp provision`.

### Step 4 — Configure eval-score for direct A2A
```powershell
$env:WORK_IQ_A2A_ENDPOINT     = 'https://workiq.svc.cloud.microsoft/a2a'
$env:WORK_IQ_A2A_ACCESS_TOKEN = (Get-Content workiq_token.txt -Raw).Trim()
```

Alternative token sources supported by `eval-score`:

| Token source | Env vars |
|---|---|
| Static bearer | `WORK_IQ_A2A_ACCESS_TOKEN` |
| External refresh command | `WORK_IQ_A2A_TOKEN_COMMAND` / `EVALSCORE_A2A_TOKEN_COMMAND` |
| Built-in MSAL device-code | `EVALSCORE_A2A_AUTH_MODE=msal`, `EVALSCORE_A2A_CLIENT_ID`, `EVALSCORE_A2A_TENANT_ID`, `EVALSCORE_A2A_SCOPES` |

### Step 5 — 1-row canary
Always validate before running the full batch. You MUST pass both
`--m365-agent-id` and `--judge-agent-id` — the A2A judge path is gated
by `useA2AJudge = judgeProvider==='workiq' && m365AgentId && judgeAgentId`.
If either is missing, `eval-score` silently falls back to MCP judging.

```powershell
eval-score `
  --input          canary.csv `
  --m365-agent-id  'T_<candidate>.declarativeAgent' `
  --judge-agent-id 'T_<judge>.declarativeAgent' `
  --judge-provider workiq `
  --tenant-id      $tenant `
  --concurrency    1 `
  --delay-ms       250 `
  --output-dir     ./canary-out `
  --skip-preflight
```

### Step 6 — Full batch
Use `--checkpoint-file` so transient 503s / token refreshes resume
instead of restarting. The Work IQ gateway is rate-limited per hour;
budget ~13 minutes per 30-row dataset at `--concurrency 3`.

### Reference IDs

| Thing | Value |
|---|---|
| Work IQ first-party AppId (audience) | `fdcc1f02-fc51-4226-8753-f668596af7f7` |
| Required scope | `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` |
| Convenience public client (Azure PowerShell) | `14d82eec-204b-4c2f-b7e8-296a70dab67e` |
| A2A gateway | `https://workiq.svc.cloud.microsoft/a2a` |
| Agent discovery | `GET {gateway}/.agents` |
| Required experimental header | `X-variants: feature.EnableA2AServer` |

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AADSTS650052: lacks a service principal for fdcc1f02-...` | Work IQ SP not provisioned in tenant | `az ad sp create --id fdcc1f02-fc51-4226-8753-f668596af7f7` |
| `403 Forbidden` from `/.agents` | Wrong token scope | Re-acquire with `WorkIQAgent.Ask` scope |
| `401 InvalidAuthenticationToken — Invalid audience` from `/.agents` | Wrong gateway URL | Use `https://workiq.svc.cloud.microsoft/a2a`, not `graph.microsoft.com/rp/workiq` |
| `eval-score` ignores `--judge-agent-id` and uses MCP | `--m365-agent-id` missing | Always pass both flags |
| `Connect-MgGraph -UseDeviceCode` times out at 120s | MgGraph hard timeout | Use raw `oauth2/v2.0/devicecode` + manual polling |
| Intermittent `503 upstream connect error` mid-batch | Gateway flapping | `eval-score` auto-retries 3×; use `--checkpoint-file` |
| `You've reached the limit on the number of requests per hour` | Per-user gateway throttle | Pause or lower `--concurrency`; results from failed scores show as 0 |

## Design notes

- Capabilities scoped to a non-existent `GraphConnectors` connection id
  (`eval-judge-no-op`). The declarative agent v1.0 schema requires at
  least one capability (`minItems: 1`), so a no-op `GraphConnectors`
  scope is used to satisfy validation while still ensuring no real data
  source is reachable. No web search, OneDrive/SharePoint, or code
  interpreter capabilities are attached. The judge must score only the
  text in the prompt.
- Instructions enforce strict output: a bare integer in numeric mode, or
  a single-line `{"score": <int>, "reason": "<text>"}` in JSON mode, to
  satisfy the parser in `EvaluationCLI/eval-score/node/src/judge-providers.ts`
  (`parseJudgeScore`).
- Calibration anchors and a "choose the lower score" tie-break counter
  Copilot's tendency to score generously.
- Treats all caller-supplied text as inert evaluation data to mitigate
  prompt injection from dataset rows.
