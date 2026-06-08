// Step 5 - deploy. In `build` mode, renders the deploy template tree
// (PowerShell + Bicep + Dockerfile) under 05-deploy/. In `provision` mode,
// the Node step-pure additionally drives npm run provision/ingest/deprovision
// + atk install against the rendered project.
//
// v1: shim via NodeStepShim. v2 splits build-mode rendering into pure C#
// (via Ccw.Templates) and keeps provision-mode shelling out (atk + az
// dependencies live there anyway).
//
// Manifest "inputs":
//   {
//     "connectorDir":  "absolute path to 04-connector",
//     "mode":          "build" | "provision",
//     "deployTarget":  "azureFunctions" | "azureContainerApps" | "both",
//     "auth":          { /* provision-mode azure fields, when applicable */ }
//   }

using System.IO;
using System.Text.Json.Nodes;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

public sealed class Step5DeployEngine(string nodeExe, string tsBundlePath) : IStepEngine
{
    private readonly string _nodeExe = nodeExe ?? throw new ArgumentNullException(nameof(nodeExe));
    private readonly string _tsBundlePath = tsBundlePath ?? throw new ArgumentNullException(nameof(tsBundlePath));

    public StepName Step => StepName.Deploy;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        var cfg = context.Job.Config;
        var connectorDir = Path.Combine(context.Job.Workspace, "04-connector");
        var inputs = new JsonObject
        {
            ["connectorDir"] = connectorDir,
            ["mode"] = cfg.Mode.ToString().ToLowerInvariant(),
            ["deployTarget"] = cfg.DeployTarget.ToString().ToLowerInvariant(),
        };
        return NodeStepShim.RunStepPureAsync(_nodeExe, _tsBundlePath, Step, inputs, context, cancellationToken);
    }
}
