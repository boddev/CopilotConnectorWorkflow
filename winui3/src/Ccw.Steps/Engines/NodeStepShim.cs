// Shared helpers for shim-based step engines (Steps 1/2/4/5/6 in v1).
//
// Contract: writes a StepInputManifest JSON to {StepOutDir}/.step-input.json,
// invokes `node <tsBundle> step-pure <step-name> --manifest <inputPath>
// --result <resultPath>`, then reads back StepResultEnvelope from
// {StepOutDir}/.step-result.json.
//
// HashHelpers.FileHash is computed in C# for every artifact. Containment
// is enforced: every resolved artifact path must live under
// WorkspaceRoot.
//
// The Node `step-pure` CLI entrypoint that satisfies this contract is
// added in a separate commit (see plan §4 Phase 2). Until then, invoking
// these shim engines will fail at runtime with the step-pure exit code;
// the C# side compiles + tests independently against synthetic manifests/
// results.

using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ccw.Core.Models;
using Ccw.Core.Process;
using Ccw.Core.Util;

namespace Ccw.Steps.Engines;

internal static class NodeStepShim
{
    /// <summary>Default name of the Node CLI bundle relative to the locator's resolved path.</summary>
    public const string DefaultBundleRelative = "dist/cli.js";

    /// <summary>Manifest file name (under StepOutDir). Hidden-leader keeps
    /// it out of artifact globs that match common patterns.</summary>
    public const string ManifestFileName = ".step-input.json";

    /// <summary>Result file name (under StepOutDir).</summary>
    public const string ResultFileName = ".step-result.json";

    private static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Run a Node step-pure subprocess for the given step using the
    /// supplied per-step input payload. The orchestrator owns hashing +
    /// containment; the shim owns only "spawn the subprocess and surface
    /// what it produced."</summary>
    public static async Task<StepRunResult> RunStepPureAsync(
        string nodeExe,
        string tsBundlePath,
        StepName step,
        JsonObject inputs,
        StepRunContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(nodeExe);
        ArgumentException.ThrowIfNullOrEmpty(tsBundlePath);
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(context);

        Directory.CreateDirectory(context.StepOutDir);

        var stepKey = StepNameToTs(step);
        var startedAt = DateTimeOffset.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);

        var manifestPath = Path.Combine(context.StepOutDir, ManifestFileName);
        var resultPath = Path.Combine(context.StepOutDir, ResultFileName);

        // Clean stale result so we never read a previous run's envelope on
        // shim crash. Manifest is overwritten in-place.
        if (File.Exists(resultPath)) File.Delete(resultPath);

        var manifest = new StepInputManifest
        {
            Step = stepKey,
            StepOutDir = context.StepOutDir,
            WorkspaceRoot = context.Job.Workspace,
            Job = context.Job,
            Inputs = inputs,
        };
        await File.WriteAllTextAsync(
            manifestPath,
            JsonSerializer.Serialize(manifest, s_jsonOptions),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            cancellationToken).ConfigureAwait(false);

        var args = new List<string>
        {
            tsBundlePath,
            "step-pure",
            stepKey,
            "--manifest", manifestPath,
            "--result", resultPath,
        };

        var run = await ProcessRunner.RunAsync(new RunOptions
        {
            Cmd = nodeExe,
            Args = args,
            Cwd = context.Job.Workspace,
            Env = context.Env,
            LogFile = context.LogFile,
            LogSink = context.LogSink,
            // Orchestrator owns the shared sink lifetime across the pipeline;
            // closing it after the first step would silently drop subsequent
            // logs (GPT BLOCKER on Phase 4 review).
            CompleteLogSinkOnExit = false,
            Label = $"step:{stepKey}",
        }, cancellationToken).ConfigureAwait(false);

        var endedAt = DateTimeOffset.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture);

        StepResultEnvelope? envelope = TryReadResultEnvelope(resultPath);
        return FoldEnvelopeIntoResult(envelope, run, context.Job.Workspace, startedAt, endedAt, stepKey);
    }

    /// <summary>Fold an in-process or shim-produced StepResultEnvelope into a
    /// StepRunResult. Exposed so in-process engines (Step 3 today, Steps 1/6
    /// v2) can reuse the same hashing + containment + status mapping
    /// pipeline.</summary>
    public static StepRunResult FoldEnvelopeIntoResult(
        StepResultEnvelope? envelope,
        RunResult? processResult,
        string workspaceRoot,
        string startedAt,
        string endedAt,
        string stepKey)
    {
        if (envelope is null)
        {
            return new StepRunResult
            {
                Status = StepStatus.Failed,
                ExitCode = processResult?.ExitCode ?? 1,
                StartedAt = startedAt,
                EndedAt = endedAt,
                Artifacts = [],
                ErrorMessage = processResult is { Ok: false }
                    ? $"step-pure {stepKey} failed; see step log"
                    : "step-pure produced no result envelope",
            };
        }

        var artifacts = new List<StepArtifact>(envelope.Artifacts.Count);
        var containmentErrors = new List<string>();
        foreach (var a in envelope.Artifacts)
        {
            if (!TryResolveContained(workspaceRoot, a.Path, out var abs))
            {
                containmentErrors.Add($"artifact '{a.Path}' escapes workspace root");
                continue;
            }
            if (!File.Exists(abs))
            {
                containmentErrors.Add($"artifact '{a.Path}' was declared but is missing on disk");
                continue;
            }
            var info = new FileInfo(abs);
            artifacts.Add(new StepArtifact
            {
                Path = NormalizeRelative(a.Path),
                Role = a.Role,
                Sha256 = HashHelpers.FileHash(abs),
                Bytes = info.Length,
            });
        }

        var status = envelope.Status switch
        {
            // GPT Phase-2 closure BLOCKER #2: require the process to have
            // exited cleanly too. A shim that writes "done" then crashes
            // with exit 1 was previously falsely succeeding. Mark Failed
            // whenever processResult is supplied and !Ok.
            "done" when containmentErrors.Count == 0
                     && envelope.Error is null
                     && (processResult is null || processResult.Ok) => StepStatus.Done,
            _ => StepStatus.Failed,
        };

        IReadOnlyList<string>? diagnostics = null;
        var procDiagnostics = (processResult is { Ok: false } && envelope.Status == "done")
            ? new[] { $"shim exited {processResult.ExitCode} despite reporting 'done'" }
            : Array.Empty<string>();
        if ((envelope.Diagnostics is { Count: > 0 }) || containmentErrors.Count > 0 || procDiagnostics.Length > 0)
        {
            var combined = new List<string>();
            if (envelope.Diagnostics is not null) combined.AddRange(envelope.Diagnostics);
            combined.AddRange(containmentErrors);
            combined.AddRange(procDiagnostics);
            diagnostics = combined;
        }

        return new StepRunResult
        {
            Status = status,
            ExitCode = (processResult is { Ok: false }) ? processResult.ExitCode : envelope.ExitCode,
            StartedAt = startedAt,
            EndedAt = endedAt,
            Artifacts = artifacts,
            Diagnostics = diagnostics,
            ErrorMessage = status == StepStatus.Failed
                ? envelope.Error
                    ?? (containmentErrors.Count > 0 ? string.Join("; ", containmentErrors)
                    : (processResult is { Ok: false } ? $"shim exited {processResult.ExitCode}" : null))
                : null,
        };
    }

    internal static StepResultEnvelope? TryReadResultEnvelope(string resultPath)
    {
        if (!File.Exists(resultPath)) return null;
        try
        {
            var json = File.ReadAllText(resultPath);
            var env = JsonSerializer.Deserialize<StepResultEnvelope>(json, s_jsonOptions);
            if (env is null) return null;
            if (env.SchemaVersion != 1) return null;
            return env;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Resolve <paramref name="relPath"/> against
    /// <paramref name="workspaceRoot"/>, returning false if the result
    /// would escape the workspace (GPT BLOCKER #7).
    ///
    /// <para>Hardened per Opus Phase-2 closure I-4 + NIT (symlinks/junctions
    /// + 8.3/`\\?\` form mismatches): we walk reparse points before the
    /// prefix check so a junction or symlink INSIDE the workspace that
    /// targets a path outside is rejected, and we canonicalize both sides
    /// via <see cref="Path.GetFullPath(string)"/> to normalize directory
    /// separators and casing. We do NOT touch 8.3 short names — those
    /// require a Win32 round-trip that's overkill for our trust model
    /// (the shim is first-party). If a future caller needs 8.3 robustness,
    /// resolve via <c>GetLongPathName</c> before this method.</para></summary>
    internal static bool TryResolveContained(string workspaceRoot, string relPath, out string resolved)
    {
        var rootFull = Path.GetFullPath(workspaceRoot);
        var combined = Path.IsPathRooted(relPath)
            ? relPath
            : Path.Combine(rootFull, relPath);
        var fullCandidate = Path.GetFullPath(combined);

        // Resolve reparse points (junctions, symlinks) on both sides so a
        // junction inside the workspace pointing outside is caught.
        var resolvedCandidate = ResolveReparsePoints(fullCandidate);
        var resolvedRoot = ResolveReparsePoints(rootFull);

        var rootWithSep = resolvedRoot.TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var comp = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!resolvedCandidate.StartsWith(rootWithSep, comp)
            && !string.Equals(resolvedCandidate, resolvedRoot, comp))
        {
            resolved = string.Empty;
            return false;
        }
        // Return the un-resolved candidate so artifact paths stay stable
        // for callers that compute file hashes — the existence + containment
        // check is what matters, not which physical path is hashed.
        resolved = fullCandidate;
        return true;
    }

    /// <summary>Walk a path's last segment as far as the OS will reveal,
    /// resolving any reparse-point hops. If a segment doesn't exist, returns
    /// the path as-is (which is fine for the containment check — the
    /// non-existent leaf can't escape).</summary>
    private static string ResolveReparsePoints(string path)
    {
        try
        {
            // FileInfo.LinkTarget / DirectoryInfo.LinkTarget were added in .NET 6.
            // If the leaf exists and is a reparse point, follow the chain (one hop
            // is enough — the OS resolves chains transparently on most filesystems,
            // but we loop defensively to catch the rare double-hop).
            var current = path;
            for (var hop = 0; hop < 8; hop++)
            {
                FileSystemInfo? info = File.Exists(current)
                    ? new FileInfo(current)
                    : Directory.Exists(current)
                        ? new DirectoryInfo(current)
                        : null;
                if (info is null) return Path.GetFullPath(current);
                var target = info.LinkTarget;
                if (target is null) return Path.GetFullPath(current);
                // Resolve relative link targets against the link's parent.
                var parent = Path.GetDirectoryName(current) ?? string.Empty;
                current = Path.IsPathRooted(target)
                    ? target
                    : Path.GetFullPath(Path.Combine(parent, target));
            }
            return Path.GetFullPath(current);
        }
        catch (IOException)
        {
            return Path.GetFullPath(path);
        }
        catch (UnauthorizedAccessException)
        {
            return Path.GetFullPath(path);
        }
    }

    internal static string NormalizeRelative(string path)
        => path.Replace('\\', '/');

    internal static string StepNameToTs(StepName step) => step switch
    {
        StepName.EvalGen => "evalgen",
        StepName.Enhance => "enhance",
        StepName.Schema => "schema",
        StepName.Connector => "connector",
        StepName.Deploy => "deploy",
        StepName.Score => "score",
        _ => throw new ArgumentOutOfRangeException(nameof(step), step, null),
    };
}
