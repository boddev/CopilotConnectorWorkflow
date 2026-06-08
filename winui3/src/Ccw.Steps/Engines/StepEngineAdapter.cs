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
        return new Dictionary<StepName, IStepEngineLike>
        {
            [StepName.EvalGen] = new NotYetWiredEngine(StepName.EvalGen, "Step 1 evalgen wire-up lands in slice 2.1"),
            [StepName.Enhance] = new NotYetWiredEngine(StepName.Enhance, "Step 2 enhance wire-up lands in slice 2.2-a (Node shim)"),
            [StepName.Schema] = new StepEngineAdapter(new Step3SchemaEngine()),
            [StepName.Connector] = new NotYetWiredEngine(StepName.Connector, "Step 4 connector wire-up lands in slice 2.4"),
            [StepName.Deploy] = new NotYetWiredEngine(StepName.Deploy, "Step 5 deploy wire-up lands in slice 2.5"),
            [StepName.Score] = new NotYetWiredEngine(StepName.Score, "Step 6 score wire-up lands in slice 2.6"),
        };
    }
}

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
