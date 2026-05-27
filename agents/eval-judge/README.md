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
