// Step 1 - eval-gen. The Node side reads dataset + description and emits:
//   01-evalgen/eval.csv             (the eval prompts in CSV)
//   01-evalgen/eval.evalgen.json    (the metadata sidecar with evalSetHash)
//
// v1 ships as a Node TS-shim driven through NodeStepShim. The plan's v2
// path wires EvalToolkit.EvalGen in-process (no Node) — drops in here when
// the sibling EvalToolkit package is verified.
//
// When config.ReuseEvalFromJobId or config.EvalSetPath is set, the shim
// copies the existing eval set verbatim and re-uses its hash; the engine
// does NOT regenerate. JobStore.EnsureEvalSetHash handles the
// sidecar -> JobRecord lift.
//
// Manifest "inputs" shape (per Opus Q2 — pin in manifest, not positional):
//   {
//     "dataset":          "absolute path",
//     "description":      "...",
//     "count":            <int>,
//     "reuseEvalFromJob": "<jobId>?" | null,
//     "evalSetPath":      "absolute path?" | null
//   }

using System.Text.Json.Nodes;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

public sealed class Step1EvalGenEngine(string nodeExe, string tsBundlePath) : IStepEngine
{
    private readonly string _nodeExe = nodeExe ?? throw new ArgumentNullException(nameof(nodeExe));
    private readonly string _tsBundlePath = tsBundlePath ?? throw new ArgumentNullException(nameof(tsBundlePath));

    public StepName Step => StepName.EvalGen;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cfg = context.Job.Config;
        var inputs = new JsonObject
        {
            ["dataset"] = cfg.Dataset,
            ["description"] = cfg.Description,
            ["count"] = cfg.Count,
            ["reuseEvalFromJob"] = cfg.ReuseEvalFromJobId,
            ["evalSetPath"] = cfg.EvalSetPath,
        };
        return NodeStepShim.RunStepPureAsync(_nodeExe, _tsBundlePath, Step, inputs, context, cancellationToken);
    }
}
