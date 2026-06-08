// Shim seam contracts (input manifest + result envelope) shared between
// the C# side (Ccw.Steps.Engines) and the Node `step-pure <name>` CLI
// entrypoint (src/cli.ts, added in a follow-up commit; see plan §4 Phase 2).
//
// SchemaVersion is explicit so the C# side can refuse to parse a result
// produced by a mismatched shim, and the shim can refuse to read an
// input manifest from a mismatched orchestrator. Bump on incompatible
// changes.
//
// Why FILE-based rather than stdout-based (GPT BLOCKER #1, #6):
//   * ProcessRunner combines stdout + stderr into RunResult.Output;
//     parsing JSON out of an interleaved log stream is fragile.
//   * Steps 2/4/5 shell out to npm/tsc/atk, which write copious noise
//     to stdout that would clobber any sentinel-delimited final line.
//   * File IO is testable without standing up a real subprocess.
//
// Why C# computes the hashes, not the shim (GPT BLOCKER #6):
//   * Eliminates trust in the shim's hashing implementation — there
//     is one canonical hasher (Ccw.Core.Util.HashHelpers.FileHash).
//   * Lets parity tests run on artifacts produced by either side.
//
// Why containment is enforced (GPT BLOCKER #7):
//   * A buggy or malicious shim could return ../../foo and trick
//     the orchestrator into hashing/persisting files outside the
//     workspace.

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Ccw.Core.Models;

namespace Ccw.Steps.Engines;

/// <summary>Input manifest written by the C# orchestrator and read by the
/// Node step-pure entrypoint. One per step invocation.</summary>
public sealed record StepInputManifest
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("step")]
    public required string Step { get; init; }

    /// <summary>Absolute path to the step's output directory.</summary>
    [JsonPropertyName("stepOutDir")]
    public required string StepOutDir { get; init; }

    /// <summary>Absolute path to the job workspace root. The shim writes
    /// artifacts under StepOutDir and references them as RELATIVE paths
    /// from WorkspaceRoot in the result envelope.</summary>
    [JsonPropertyName("workspaceRoot")]
    public required string WorkspaceRoot { get; init; }

    /// <summary>Snapshot of the job record at the moment the engine
    /// fired. The shim must NOT write this back; it is provided so the
    /// shim can read connectorId, count, judge config, ACL mode, etc.,
    /// without touching job.json directly.</summary>
    [JsonPropertyName("job")]
    public required JobRecord Job { get; init; }

    /// <summary>Per-step typed inputs. Schema documented per step in
    /// the engine that builds the manifest (e.g. Step2EnhanceEngine
    /// pins dataset, evalSidecar, noEnhance, extensions, urlPrefix).</summary>
    [JsonPropertyName("inputs")]
    public JsonObject? Inputs { get; init; }
}

/// <summary>Result envelope written by the shim (or in-process engine)
/// to <c>{StepOutDir}/.step-result.json</c>. The orchestrator reads it,
/// validates containment, computes hashes, and folds into a
/// StepRunResult.</summary>
public sealed record StepResultEnvelope
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("step")]
    public required string Step { get; init; }

    /// <summary>"done" or "failed" (lowercase).</summary>
    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("exitCode")]
    public required int ExitCode { get; init; }

    /// <summary>Artifacts produced by the step. Paths are RELATIVE to
    /// the workspace root, with forward slashes. The Sha256/Bytes
    /// fields on the wire are ignored by the orchestrator — C#
    /// recomputes them. Role is preserved as-is.</summary>
    [JsonPropertyName("artifacts")]
    public IReadOnlyList<StepResultArtifact> Artifacts { get; init; } = [];

    [JsonPropertyName("diagnostics")]
    public IReadOnlyList<string>? Diagnostics { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }
}

/// <summary>Wire-shape for one artifact entry in the result envelope.
/// The Sha256/Bytes fields are accepted for forward compatibility but
/// the orchestrator recomputes them in C# (do not trust the shim).</summary>
public sealed record StepResultArtifact
{
    [JsonPropertyName("path")]
    public required string Path { get; init; }

    [JsonPropertyName("role")]
    public string? Role { get; init; }

    [JsonPropertyName("sha256")]
    public string? Sha256 { get; init; }

    [JsonPropertyName("bytes")]
    public long? Bytes { get; init; }
}
