// Step 4 - connector project rendering + npm install + tsc.
//
// v1: drives the Node step-pure entrypoint. step-pure reads the schema
// from 03-schema/connector-schema.json + the rendered template tree +
// npm/node tools, renders templates/connector-project, runs `npm install`
// + `tsc`, and emits the built JS connector under 04-connector/.
//
// v2 (Phase 4.5 + Phase 5 alignment): render templates entirely in C#
// via the Ccw.Templates tiny renderer, then shell out to npm/tsc
// directly from this engine.
//
// Manifest "inputs":
//   {
//     "schemaPath":     "absolute path to 03-schema/connector-schema.json",
//     "schemaTsPath":   "absolute path to 03-schema/schema.ts" (when produced),
//     "connectorId":    "...",
//     "connectorName":  "...",
//     "deployTarget":   "azureFunctions" | "azureContainerApps" | "both"
//   }

using System.IO;
using System.Text.Json.Nodes;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

public sealed class Step4ConnectorEngine(string nodeExe, string tsBundlePath) : IStepEngine
{
    private readonly string _nodeExe = nodeExe ?? throw new ArgumentNullException(nameof(nodeExe));
    private readonly string _tsBundlePath = tsBundlePath ?? throw new ArgumentNullException(nameof(tsBundlePath));

    public StepName Step => StepName.Connector;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cfg = context.Job.Config;
        var schemaPath = Path.Combine(context.Job.Workspace, "03-schema", "connector-schema.json");
        var schemaTsPath = Path.Combine(context.Job.Workspace, "03-schema", "schema.ts");
        var inputs = new JsonObject
        {
            ["schemaPath"] = schemaPath,
            ["schemaTsPath"] = schemaTsPath,
            ["connectorId"] = cfg.ConnectorId,
            ["connectorName"] = cfg.ConnectorName,
            ["deployTarget"] = cfg.DeployTarget.ToString().ToLowerInvariant(),
        };
        return NodeStepShim.RunStepPureAsync(_nodeExe, _tsBundlePath, Step, inputs, context, cancellationToken);
    }
}
