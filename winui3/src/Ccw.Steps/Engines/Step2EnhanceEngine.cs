// Step 2 - enhance / identity-transform. Drives the Node TS-shim per the
// Phase 2.2-a v1 ship plan.
//
// Manifest "inputs" shape (per Opus Q2 — pin in manifest, not positional):
//   {
//     "dataset":      "absolute path",
//     "evalSidecar":  "absolute path to 01-evalgen/eval.evalgen.json",
//     "extensions":   ["md", "json", ...]  (optional),
//     "urlPrefix":    "https://..." | null,
//     "noEnhance":    bool,
//     "aclMode":      "everyone" | "groupIds" | ...
//   }
//
// Outputs (written to context.StepOutDir):
//   - 02-enhance/enhanced-items.jsonl       (one Graph item per row, normalized)
//   - 02-enhance/schema-suggestion.json     (proposed Graph schema)
//   - 02-enhance/metadata-provenance.json   (TitleFromSource / UrlFromSource / IconUrlFromSource)
//   - 02-enhance/identity-transform-report.json (no-enhance branch only)
//
// Opus B4: this engine NEVER invokes `node dist/cli.js step` (the full
// orchestrator). step-pure reads explicit inputs and writes only under
// --out, never touching job.json.

using System.IO;
using System.Text.Json.Nodes;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

public sealed class Step2EnhanceEngine(string nodeExe, string tsBundlePath) : IStepEngine
{
    private readonly string _nodeExe = nodeExe ?? throw new ArgumentNullException(nameof(nodeExe));
    private readonly string _tsBundlePath = tsBundlePath ?? throw new ArgumentNullException(nameof(tsBundlePath));

    public StepName Step => StepName.Enhance;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cfg = context.Job.Config;
        var evalSidecar = Path.Combine(context.Job.Workspace, "01-evalgen", "eval.evalgen.json");
        var inputs = new JsonObject
        {
            ["dataset"] = cfg.Dataset,
            ["evalSidecar"] = evalSidecar,
            ["urlPrefix"] = cfg.UrlPrefix,
            ["noEnhance"] = cfg.NoEnhance ?? false,
            ["aclMode"] = cfg.AclMode.ToString().ToLowerInvariant(),
        };
        if (cfg.Extensions is { Count: > 0 })
        {
            var arr = new JsonArray();
            foreach (var e in cfg.Extensions) arr.Add(e);
            inputs["extensions"] = arr;
        }
        return NodeStepShim.RunStepPureAsync(_nodeExe, _tsBundlePath, Step, inputs, context, cancellationToken);
    }
}
