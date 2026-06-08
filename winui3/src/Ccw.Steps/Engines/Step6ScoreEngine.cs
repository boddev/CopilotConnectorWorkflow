// Step 6 - score. Runs the Step 6 scoring pipeline against the ingested
// connector + the eval prompts.
//
// v1: Node TS-shim (drives the existing src/steps/step6-score.ts via
// step-pure). v2: EvalToolkit.EvalScore in-process (no Node, no
// subprocess) — drops in here when the sibling EvalToolkit package
// is wired and byte-equivalence of agent-response-scores.json is
// verified against the Node baseline (Opus NB-4).
//
// Manifest "inputs":
//   {
//     "evalSetPath":         "absolute path to 01-evalgen/eval.csv",
//     "candidateAgentId":    "...",
//     "judgeProvider":       "deterministic" | "github-copilot" | "workiq",
//     "judgeAgentId":        "...?",
//     "evaluators":          "Relevance,Coherence" | "all" | null,
//     "indexReadyMinSeconds": <int?>,
//     "indexReadyMaxSeconds": <int?>,
//     "indexReadySettleMinutes": <int?>,
//     "invalidRowRetryLimit": <int?>,
//     "skipAgentPublish":    <bool?>
//   }
//
// Outputs (written to context.StepOutDir = {workspace}/06-score):
//   - 06-score/agent-response-scores.json (the canonical ScoredReport)
//   - 06-score/agent-response-scores.md   (human report)
//   - 06-score/agent-responses.jsonl      (raw responses + judge transcript)

using System.IO;
using System.Text.Json.Nodes;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

public sealed class Step6ScoreEngine(string nodeExe, string tsBundlePath) : IStepEngine
{
    private readonly string _nodeExe = nodeExe ?? throw new ArgumentNullException(nameof(nodeExe));
    private readonly string _tsBundlePath = tsBundlePath ?? throw new ArgumentNullException(nameof(tsBundlePath));

    public StepName Step => StepName.Score;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cfg = context.Job.Config;
        var evalSetPath = Path.Combine(context.Job.Workspace, "01-evalgen", "eval.csv");
        var score = cfg.Score;
        var inputs = new JsonObject
        {
            ["evalSetPath"] = evalSetPath,
            ["candidateAgentId"] = score?.CandidateAgentId,
            ["judgeProvider"] = score?.JudgeProvider?.ToString().ToLowerInvariant(),
            ["judgeAgentId"] = score?.JudgeAgentId,
            ["evaluators"] = score?.Evaluators,
            ["indexReadyMinSeconds"] = score?.IndexReadyMinSeconds,
            ["indexReadyMaxSeconds"] = score?.IndexReadyMaxSeconds,
            ["indexReadySettleMinutes"] = score?.IndexReadySettleMinutes,
            ["invalidRowRetryLimit"] = score?.InvalidRowRetryLimit,
            ["skipAgentPublish"] = score?.SkipAgentPublish,
        };
        return NodeStepShim.RunStepPureAsync(_nodeExe, _tsBundlePath, Step, inputs, context, cancellationToken);
    }
}
