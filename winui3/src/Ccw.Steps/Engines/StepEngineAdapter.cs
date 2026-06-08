// Adapter from Ccw.Steps.Engines.IStepEngine (real interface) to
// Ccw.Core.Models.IStepEngineLike (orchestrator seam). The orchestrator
// lives in Ccw.Core and must not depend on Ccw.Steps. This adapter is
// the wire-up that the CLI / UI both use to register engines with the
// orchestrator.

using System.Text.RegularExpressions;
using Ccw.Core.Models;
using Ccw.Core.Util;

namespace Ccw.Steps.Engines;

/// <summary>Adapts a real <see cref="IStepEngine"/> to the
/// <see cref="IStepEngineLike"/> seam consumed by
/// <see cref="Orchestrator.RunPipelineAsync"/>.</summary>
public sealed class StepEngineAdapter(IStepEngine inner) : IStepEngineLike
{
    private readonly IStepEngine _inner = inner ?? throw new ArgumentNullException(nameof(inner));

    public StepName Step => _inner.Step;

    public async Task<StepRunResultLike> RunAsync(StepRunContextLike context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);

        var realCtx = new StepRunContext
        {
            Job = context.Job,
            StepOutDir = context.StepOutDir,
            LogSink = context.LogSink,
            LogFile = context.LogFile,
            Env = context.Env,
        };
        var realResult = await _inner.RunAsync(realCtx, cancellationToken).ConfigureAwait(false);

        // Compute the outputs map (relative path → SHA-256 short hash) from
        // the engine's artifact list. The orchestrator persists this for
        // cache-hit detection in a future slice.
        IReadOnlyDictionary<string, string>? outputs = null;
        if (realResult.Artifacts is { Count: > 0 } arts)
        {
            var dict = new Dictionary<string, string>(arts.Count);
            foreach (var a in arts)
            {
                if (!dict.ContainsKey(a.Path))
                {
                    dict[a.Path] = a.Sha256;
                }
            }
            outputs = dict;
        }

        return new StepRunResultLike
        {
            Status = realResult.Status,
            ExitCode = realResult.ExitCode,
            StartedAt = realResult.StartedAt,
            EndedAt = realResult.EndedAt,
            Diagnostics = realResult.Diagnostics,
            ErrorMessage = realResult.ErrorMessage,
            ArtifactPaths = realResult.Artifacts.Count == 0 ? null : realResult.Artifacts.Select(a => a.Path).ToList(),
            Outputs = outputs,
        };
    }
}

/// <summary>Builds the default step-engine table the CLI/UI registers with
/// the orchestrator. Today only Step 3 is in-process; the other five are
/// stubbed as TODO and will surface as Failed with a "not yet wired" error
/// (the orchestrator will halt and the user sees a clear message). Slices
/// 2.1/2.2/2.4/2.5/2.6 land the real wire-ups.</summary>
public static class DefaultStepEngines
{
    public static IReadOnlyDictionary<StepName, IStepEngineLike> Build()
    {
        // Wire ALL six engines. Steps 1/2/4/5/6 use the NodeStepShim — they
        // shell to a `node <bundle> step-pure <name>` entrypoint that lives
        // outside this repo today (the Node CLI doesn't yet expose
        // `step-pure`; that's a Phase 2 source-side change). The engines
        // fail with a clear runtime error if the bundle is missing rather
        // than silently no-op'ing the pipeline. Step 3 is fully in-process.
        //
        // The default Node executable name is "node" — relying on PATH. The
        // default bundle path is "dist/cli.js" relative to the job's
        // workspace; in v1, the user's checkout of the Node source is the
        // bundle source (bootstrapper Phase 4.5 clones it). A future
        // overload accepting nodeExe/bundlePath plumbing from the CLI's
        // ToolResolver lands when the source-side step-pure entrypoint is
        // available.
        const string nodeExe = "node";
        const string bundle = NodeStepShim.DefaultBundleRelative;
        return new Dictionary<StepName, IStepEngineLike>
        {
            [StepName.EvalGen] = new StepEngineAdapter(new Step1EvalGenEngine(nodeExe, bundle)),
            [StepName.Enhance] = new StepEngineAdapter(new Step2EnhanceEngine(nodeExe, bundle)),
            [StepName.Schema] = new StepEngineAdapter(new Step3SchemaEngine()),
            [StepName.Connector] = new StepEngineAdapter(new Step4ConnectorEngine(nodeExe, bundle)),
            [StepName.Deploy] = new StepEngineAdapter(new Step5DeployEngine(nodeExe, bundle)),
            [StepName.Score] = new StepEngineAdapter(new Step6ScoreEngine(nodeExe, bundle)),
        };
    }
}

// NotYetWiredEngine retained for parity tests / future seam usage —
// callers (DefaultStepEngines) no longer instantiate it now that every
// engine has a real implementation. Kept internal to allow tests to use
// it as a stand-in when validating orchestrator halt semantics.
internal sealed class NotYetWiredEngine(StepName step, string message) : IStepEngineLike
{
    public StepName Step { get; } = step;

    public Task<StepRunResultLike> RunAsync(StepRunContextLike context, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new StepRunResultLike
        {
            Status = StepStatus.Failed,
            ExitCode = -1,
            ErrorMessage = message,
            EndedAt = DateTimeOffset.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
        });
    }
}
