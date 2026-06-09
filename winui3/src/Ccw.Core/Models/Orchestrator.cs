// Pipeline orchestrator ported from src/orchestrator.ts.
//
// Walks the six-step sequence, dispatching to IStepEngine implementations
// registered by step name. Engines are stateless after construction; the
// orchestrator is the sole writer of job.json via JobStore.SaveJob.
//
// PARITY DISCIPLINE:
//   * Step sequence matches src/orchestrator.ts: evalgen, enhance, schema,
//     connector, deploy, score. Step 6 self-skips when mode != provision.
//   * Log labels: orchestrator emits "=== Step <name>(force?) ===\n" and
//     "=== Pipeline <status> ===\n" framing lines on the LogSink, matching
//     the Node emitter shape so scripts that grep the step log stream
//     keep working.
//   * Failure semantics: a single step Failed (or thrown exception) halts
//     the pipeline; the job is persisted with status=Failed and the
//     remaining steps stay Pending. This mirrors the Node behavior
//     (orchestrator.ts lines 63-81).
//   * Force semantics: forceAll OR forceSteps.Contains(name) sets the
//     "force" flag passed to the engine. Engines currently always re-run
//     (cache-hit short-circuiting lives in a future slice — see GPT NB
//     "isCached" port deferred).

using System.Threading.Channels;
using Ccw.Core.Process;

namespace Ccw.Core.Models;

/// <summary>
/// Options driving a single pipeline run. <see cref="StepEngines"/> is
/// injected so the CLI/UI don't have a hard reference on Ccw.Steps from
/// Ccw.Core (preserves the project layering: Core has no knowledge of
/// step engine implementations).
/// </summary>
public sealed record RunPipelineOptions
{
    public required JobRecord Job { get; init; }
    public required IReadOnlyDictionary<StepName, IStepEngineLike> StepEngines { get; init; }

    public ChannelWriter<LogLine>? LogSink { get; init; }
    public bool ForceAll { get; init; }
    public IReadOnlyList<StepName>? ForceSteps { get; init; }
    public StepName? StartAt { get; init; }
    public StepName? StopAfter { get; init; }
}

/// <summary>
/// Minimal step-engine contract Core depends on. Ccw.Steps's
/// <c>IStepEngine</c> matches this shape; the indirection keeps Ccw.Core
/// independent of the Ccw.Steps assembly. The orchestrator dispatches by
/// step name; engines are stateless after construction.
/// </summary>
#pragma warning disable CA1716 // VB.NET keyword conflict — 'Step' is the domain name; no VB consumer.
public interface IStepEngineLike
{
    StepName Step { get; }
    Task<StepRunResultLike> RunAsync(StepRunContextLike context, CancellationToken cancellationToken = default);
}
#pragma warning restore CA1716

/// <summary>Shape-compatible mirror of Ccw.Steps.Engines.StepRunContext for the orchestrator seam.</summary>
public sealed record StepRunContextLike
{
    public required JobRecord Job { get; init; }
    public required string StepOutDir { get; init; }
    public ChannelWriter<LogLine>? LogSink { get; init; }
    public string? LogFile { get; init; }
    public IReadOnlyDictionary<string, string?>? Env { get; init; }
}

/// <summary>Shape-compatible mirror of Ccw.Steps.Engines.StepRunResult for the orchestrator seam.</summary>
public sealed record StepRunResultLike
{
    public required StepStatus Status { get; init; }
    public required int ExitCode { get; init; }
    public string? StartedAt { get; init; }
    public string? EndedAt { get; init; }
    public IReadOnlyList<string>? Diagnostics { get; init; }
    public string? ErrorMessage { get; init; }

    /// <summary>Artifact relative paths, in the order the engine reported them.</summary>
    public IReadOnlyList<string>? ArtifactPaths { get; init; }

    /// <summary>Outputs map: relative path → sha256 hash. Used for cache-hit detection.</summary>
    public IReadOnlyDictionary<string, string>? Outputs { get; init; }
}

/// <summary>Pipeline orchestrator. Pure dispatch + persistence; engines do the work.</summary>
public static class Orchestrator
{
    private static readonly IReadOnlyList<StepName> s_pipelineSequence =
    [
        StepName.EvalGen,
        StepName.Enhance,
        StepName.Schema,
        StepName.Connector,
        StepName.Deploy,
        StepName.Score,
    ];

    public static async Task<JobRecord> RunPipelineAsync(
        RunPipelineOptions options,
        Func<JobRecord, JobRecord> saveJob,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(saveJob);

        var job = options.Job;
        var steps = s_pipelineSequence;
        var forceSet = new HashSet<StepName>(options.ForceSteps ?? []);

        var startIdx = options.StartAt is { } s ? steps.ToList().IndexOf(s) : 0;
        var stopIdx = options.StopAfter is { } e ? steps.ToList().IndexOf(e) : steps.Count - 1;
        if (startIdx < 0) startIdx = 0;
        if (stopIdx < 0) stopIdx = steps.Count - 1;

        job = saveJob(job with { Status = JobStatus.Running });

        for (var i = startIdx; i <= stopIdx; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var name = steps[i];
            var force = options.ForceAll || forceSet.Contains(name);

            EmitLog(options.LogSink, "orchestrator", $"\n=== Step {NameLiteral(name)}{(force ? " (force)" : "")} ===\n");

            if (!options.StepEngines.TryGetValue(name, out var engine))
            {
                // No engine registered: stamp Failed and stop.
                job = saveJob(job.WithStep(name, _ => new StepRecord
                {
                    Name = name,
                    Status = StepStatus.Failed,
                    ErrorMessage = $"No engine registered for step '{NameLiteral(name)}'.",
                    EndedAt = NowIso(),
                }) with { Status = JobStatus.Failed });
                EmitLog(options.LogSink, "orchestrator",
                    $"Step {NameLiteral(name)} failed: no engine registered\n");
                return job;
            }

            var outDir = Path.Combine(job.Workspace, StepOutDirName(name));
            Directory.CreateDirectory(outDir);

            // GPT IMPORTANT #8 (Phase 5 readiness): persist Running state BEFORE
            // invoking the engine so the UI can show "current step" by reading
            // job.json. The Node app does the same.
            var stepStartIso = NowIso();
            job = saveJob(job.WithStep(name, prev => new StepRecord
            {
                Name = name,
                Status = StepStatus.Running,
                StartedAt = stepStartIso,
            }));

            var ctx = new StepRunContextLike
            {
                Job = job,
                StepOutDir = outDir,
                LogSink = options.LogSink,
                LogFile = Path.Combine(outDir, "step.log"),
            };

            StepRunResultLike result;
            try
            {
                result = await engine.RunAsync(ctx, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                job = saveJob(job.WithStep(name, _ => new StepRecord
                {
                    Name = name,
                    Status = StepStatus.Failed,
                    StartedAt = stepStartIso,
                    ErrorMessage = ex.Message,
                    EndedAt = NowIso(),
                }) with { Status = JobStatus.Failed });
                EmitLog(options.LogSink, "orchestrator",
                    $"Step {NameLiteral(name)} threw: {ex.Message}\n");
                return job;
            }

            job = saveJob(job.WithStep(name, _ => new StepRecord
            {
                Name = name,
                Status = result.Status,
                StartedAt = result.StartedAt ?? stepStartIso,
                EndedAt = result.EndedAt ?? NowIso(),
                ExitCode = result.ExitCode,
                Outputs = result.Outputs is null ? null : new Dictionary<string, string>(result.Outputs),
                Artifacts = result.ArtifactPaths,
                Diagnostics = result.Diagnostics,
                ErrorMessage = result.ErrorMessage,
            }));

            if (result.Status == StepStatus.Failed)
            {
                job = saveJob(job with { Status = JobStatus.Failed });
                EmitLog(options.LogSink, "orchestrator",
                    $"Step {NameLiteral(name)} failed: {result.ErrorMessage ?? ""}\n");
                return job;
            }
        }

        // Mirror Node orchestrator.ts:85-89: requiredDone checks the FULL
        // 6-step sequence, not just the executed subrange. A run with
        // --stop-after deploy leaves `score` pending → final status is
        // failed. This is observable through the `=== Pipeline <status> ===`
        // framing line which IS in the step-log stream parity contract
        // (plan §4 Opus I7). Both reviewers (Opus I2, GPT B2) flagged the
        // earlier subrange-only check as a parity drift.
        var requiredDone = true;
        foreach (var sn in steps)
        {
            var st = job.Steps[sn].Status;
            if (st != StepStatus.Done && st != StepStatus.Skipped) { requiredDone = false; break; }
        }
        job = saveJob(job with { Status = requiredDone ? JobStatus.Done : JobStatus.Failed });
        EmitLog(options.LogSink, "orchestrator",
            $"\n=== Pipeline {NameLiteral(job.Status)} ===\n");
        return job;
    }

    private static string NowIso() =>
        DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);

    private static string NameLiteral(StepName n) => n switch
    {
        StepName.EvalGen => "evalgen",
        StepName.Enhance => "enhance",
        StepName.Schema => "schema",
        StepName.Connector => "connector",
        StepName.Deploy => "deploy",
        StepName.Score => "score",
        _ => n.ToString(),
    };

    private static string NameLiteral(JobStatus s) => s switch
    {
        JobStatus.Done => "done",
        JobStatus.Failed => "failed",
        JobStatus.Running => "running",
        JobStatus.Pending => "pending",
        _ => s.ToString(),
    };

    private static string StepOutDirName(StepName n) => n switch
    {
        StepName.EvalGen => "01-evalgen",
        StepName.Enhance => "02-enhance",
        StepName.Schema => "03-schema",
        StepName.Connector => "04-connector",
        StepName.Deploy => "05-deploy",
        StepName.Score => "06-score",
        _ => NameLiteral(n),
    };

    private static void EmitLog(ChannelWriter<LogLine>? sink, string label, string text)
    {
        if (sink is null) return;
        // Best-effort; bounded channel may DropOldest. Caller picks the channel policy.
        sink.TryWrite(new LogLine(label, text));
    }
}

/// <summary>Extension to produce a JobRecord copy with one step replaced.</summary>
internal static class JobRecordStepExtensions
{
    public static JobRecord WithStep(this JobRecord job, StepName name, Func<StepRecord, StepRecord> mutator)
    {
        var steps = new Dictionary<StepName, StepRecord>(job.Steps);
        var existing = steps.TryGetValue(name, out var s) ? s : new StepRecord { Name = name, Status = StepStatus.Pending };
        steps[name] = mutator(existing);
        return job with { Steps = steps };
    }
}
