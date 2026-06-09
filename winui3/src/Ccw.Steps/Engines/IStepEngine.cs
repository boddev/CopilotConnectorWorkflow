// Phase 2 step-engine seam.
//
// Each Ccw.Steps.Engines.Step*Engine owns running a single step end-to-end:
//   1. Receive a StepRunContext (job snapshot + step output dir + log sinks).
//   2. Build a per-step StepInputManifest and serialize it to disk under
//      StepOutDir/.step-input.json.
//   3. Invoke either an in-process engine (Step 3 Schema today; Steps 1/6
//      v2 once EvalToolkit is wired) or a Node "step-pure" subprocess
//      (Steps 1/2/4/5/6 v1).
//   4. Read the StepResultEnvelope back from StepOutDir/.step-result.json.
//   5. Enforce output containment, compute SHA-256 hashes IN C# (never
//      trust shim-provided hashes — GPT NB-6), build a StepRunResult.
//   6. Return — the orchestrator persists via JobStore.SaveJob.
//
// Invariants (Opus B4, GPT BLOCKERs from Phase 2 review):
//   * Ccw.Core JobStore is the SOLE writer of job.json. Step engines
//     NEVER mutate or even read job.json; they receive a JobRecord
//     snapshot via StepRunContext.Job.
//   * The Node `step-pure <step>` entrypoint reads ONLY the input
//     manifest and writes ONLY the result file + artifacts under --out.
//     It MUST NOT touch job.json. A test asserts job.json mtime is
//     unchanged across a step-pure invocation.
//   * Result files reference artifacts by RELATIVE path (under
//     WorkspaceRoot). Containment is enforced: any path that resolves
//     outside WorkspaceRoot is rejected.
//   * Hashes in StepArtifact are computed by Ccw.Core via
//     HashHelpers.FileHash. The shim must not supply hashes; if it
//     does, they are ignored.
//
// Manifest + result file paths are also under StepOutDir so they survive
// alongside the step's artifacts for debugging.

using System.Threading.Channels;
using Ccw.Core.Models;
using Ccw.Core.Process;

namespace Ccw.Steps.Engines;

/// <summary>Inputs and runtime knobs for a single step invocation.</summary>
public sealed record StepRunContext
{
    /// <summary>The job currently being processed (last persisted JobRecord).
    /// Engines treat this as immutable — the orchestrator is the sole writer
    /// of job.json.</summary>
    public required JobRecord Job { get; init; }

    /// <summary>Absolute path to the step's output directory under the workspace
    /// (e.g. <c>{workspace}/02-enhance</c>). Engines create it if missing and
    /// write artifacts + the result file + the input manifest there.</summary>
    public required string StepOutDir { get; init; }

    /// <summary>Optional sink for live log streaming. Forwarded to ProcessRunner
    /// for shim-based steps. In-process engines may also write structured
    /// events here. The channel uses DropOldest semantics by default — see
    /// ProcessRunner.CreateLogChannel.</summary>
    public ChannelWriter<LogLine>? LogSink { get; init; }

    /// <summary>Per-step log file. Engines tee stdout/stderr to it. The log
    /// file is the lossless source of truth for human review; LogSink is the
    /// lossy live-UI stream.</summary>
    public string? LogFile { get; init; }

    /// <summary>Environment overrides forwarded to the child process (Step
    /// 2/4/5/6 shims). A null value REMOVES the variable from the child env.</summary>
    public IReadOnlyDictionary<string, string?>? Env { get; init; }
}

/// <summary>One artifact produced by a step. Path is RELATIVE to the
/// workspace root (forward slashes). Sha256 is the 16-char prefix
/// returned by <see cref="Ccw.Core.Util.HashHelpers.FileHash"/>.</summary>
public sealed record StepArtifact
{
    public required string Path { get; init; }
    public required string Sha256 { get; init; }
    public required long Bytes { get; init; }

    /// <summary>Optional logical name (e.g. "enhancedItems", "schema").
    /// Lets later steps look up inputs by role rather than by hard-coded
    /// relative path.</summary>
    public string? Role { get; init; }
}

/// <summary>Result of a single step run. The orchestrator folds this into
/// the StepRecord and saves via JobStore.SaveJob.</summary>
public sealed record StepRunResult
{
    public required StepStatus Status { get; init; }
    public required int ExitCode { get; init; }
    public string? StartedAt { get; init; }
    public string? EndedAt { get; init; }

    /// <summary>Artifacts produced by this step, in the order the underlying
    /// engine reported them. Hashes computed by Ccw.Core, not the shim.</summary>
    public required IReadOnlyList<StepArtifact> Artifacts { get; init; }

    /// <summary>Optional diagnostics surfaced to the StepRecord (warnings,
    /// validation notes, info messages).</summary>
    public IReadOnlyList<string>? Diagnostics { get; init; }

    public string? ErrorMessage { get; init; }
}

/// <summary>Contract every step engine implements. The orchestrator
/// dispatches by StepName; engines are stateless after construction.</summary>
#pragma warning disable CA1716 // VB.NET keyword conflict — 'Step' is the domain name; no VB consumer.
public interface IStepEngine
{
    StepName Step { get; }
    Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default);
}
#pragma warning restore CA1716
