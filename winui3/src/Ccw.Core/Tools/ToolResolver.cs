// Port of src/tools.ts.
//
// Resolves filesystem paths to the external sibling tools the
// orchestrator hands off to (eval-gen, eval-score node, the Node
// enhancer compiled JS, the Skill bundle, the templates folder).
//
// PARITY DISCIPLINE:
//   * Path resolution order matches the TS source candidate lists
//     exactly. First-existing wins; falls back to the first candidate
//     if none exist (so probeTools surfaces a useful "missing" status
//     instead of a confusing null path — matches TS `?? candidates[0]`).
//   * CompareSemver is byte-equivalent to the TS implementation
//     including its quirks: only the first 3 components considered,
//     missing components treated as 0, `v` prefix stripped on each side.
//   * Probe returns the SAME ToolStatus shape used by the diagnostics
//     panel + ccw.exe tools command.
//
// DEVIATIONS (documented):
//   * `__dirname`/`process.versions.node` have no C# equivalent. The
//     port introduces ToolResolverOptions (workflow repo root + src
//     root override) with env-var fallback so the resolver works
//     identically when CCW_WORKFLOW_REPO + CCW_SRC_ROOT are set, and
//     a sensible MSIX/dev default when they're not.
//   * Node version detection is spawn-based (`node --version`) rather
//     than in-process — there's no static "this process is Node X"
//     property in .NET. CheckNodeMinimumAsync wraps that.

using System.Globalization;
using Ccw.Core.Process;

namespace Ccw.Core.Tools;

/// <summary>Resolved paths to external pipeline tools.</summary>
public sealed record ToolPaths
{
    public required string EvalGen { get; init; }
    public required string EvalScore { get; init; }

    /// <summary>Compiled enhancer JS (dist/enhancer/enhance_for_copilot.js). Used by Step 2 shim path.</summary>
    public required string DataEnhancer { get; init; }

    /// <summary>Enhancer SOURCE TS (vendored into generated connectors by Step 4).</summary>
    public required string TsDataEnhancer { get; init; }

    public required string CopilotConnectorSkill { get; init; }
    public required string TemplatesRoot { get; init; }
}

/// <summary>Probe result for one tool dependency.</summary>
public sealed record ToolStatus
{
    public required string Name { get; init; }
    public required string Path { get; init; }
    public required bool Ok { get; init; }
    public string? Note { get; init; }
}

/// <summary>Overrides for tool resolution.</summary>
public sealed record ToolResolverOptions
{
    /// <summary>Root of the CopilotConnectorWorkflow repo (or MSIX install dir
    /// where templates/ + dist/ live alongside).</summary>
    public string? WorkflowRepoRoot { get; init; }

    /// <summary>Parent of the workflow repo, where sibling EvaluationCLI +
    /// CopilotConnectorSkill clones live.</summary>
    public string? SrcRoot { get; init; }
}

public static class ToolResolver
{
    private const string WorkflowRepoEnvVar = "CCW_WORKFLOW_REPO";
    private const string SrcRootEnvVar = "CCW_SRC_ROOT";

    /// <summary>Resolve tool paths using the given overrides + env fallbacks.</summary>
    public static ToolPaths Resolve(ToolResolverOptions? options = null)
    {
        var workflowRepoRoot = options?.WorkflowRepoRoot
            ?? Environment.GetEnvironmentVariable(WorkflowRepoEnvVar)
            ?? Environment.CurrentDirectory;

        var srcRoot = options?.SrcRoot
            ?? Environment.GetEnvironmentVariable(SrcRootEnvVar)
            ?? Path.GetDirectoryName(workflowRepoRoot)
            ?? workflowRepoRoot;

        return new ToolPaths
        {
            EvalGen = Path.Combine(srcRoot, "EvaluationCLI", "eval-gen", "dist", "index.js"),
            EvalScore = Path.Combine(srcRoot, "EvaluationCLI", "eval-score", "node", "dist", "index.js"),
            DataEnhancer = Path.Combine(workflowRepoRoot, "dist", "enhancer", "enhance_for_copilot.js"),
            TsDataEnhancer = ResolveTsEnhancer(workflowRepoRoot, srcRoot),
            CopilotConnectorSkill = ResolveSkillRoot(srcRoot),
            TemplatesRoot = Path.Combine(workflowRepoRoot, "templates"),
        };
    }

    private static string ResolveTsEnhancer(string workflowRepoRoot, string srcRoot)
    {
        var userHome = GetUserHomeDirectory();
        var candidates = new[]
        {
            Path.Combine(workflowRepoRoot, "src", "enhancer", "enhance_for_copilot.ts"),
            Path.Combine(srcRoot, "CopilotConnectorSkill", "copilot-connector", "sample_codes",
                "data-enhancer", "typescript", "src", "enhance_for_copilot.ts"),
            Path.Combine(userHome, ".copilot", "skills", "copilot-connector", "sample_codes",
                "data-enhancer", "typescript", "src", "enhance_for_copilot.ts"),
        };

        return candidates.FirstOrDefault(File.Exists) ?? candidates[0];
    }

    private static string ResolveSkillRoot(string srcRoot)
    {
        var userHome = GetUserHomeDirectory();
        var candidates = new[]
        {
            Path.Combine(srcRoot, "CopilotConnectorSkill", "copilot-connector"),
            Path.Combine(userHome, ".copilot", "skills", "copilot-connector"),
        };

        return candidates.FirstOrDefault(c => File.Exists(Path.Combine(c, "SKILL.md"))) ?? candidates[0];
    }

    /// <summary>Mirrors Node <c>os.homedir()</c>: on Windows prefer the
    /// <c>USERPROFILE</c> env var, then <c>HOMEPATH</c>, finally
    /// <see cref="Environment.SpecialFolder.UserProfile"/>. The env-var
    /// preference makes resolution overridable in tests and CI.</summary>
    private static string GetUserHomeDirectory()
    {
        var p = Environment.GetEnvironmentVariable("USERPROFILE");
        if (!string.IsNullOrEmpty(p)) return p;

        if (OperatingSystem.IsWindows())
        {
            var drive = Environment.GetEnvironmentVariable("HOMEDRIVE");
            var path = Environment.GetEnvironmentVariable("HOMEPATH");
            if (!string.IsNullOrEmpty(drive) && !string.IsNullOrEmpty(path))
            {
                return drive + path;
            }
        }
        else
        {
            var home = Environment.GetEnvironmentVariable("HOME");
            if (!string.IsNullOrEmpty(home)) return home;
        }

        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    /// <summary>Compare semantic version strings using the TS implementation's
    /// rules: first 3 components only, missing components treated as 0,
    /// optional leading "v" stripped, non-numeric segments coerced to 0.</summary>
    public static int CompareSemver(string a, string b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);

        var pa = Parse(a);
        var pb = Parse(b);

        for (var i = 0; i < 3; i++)
        {
            var ai = i < pa.Length ? pa[i] : 0;
            var bi = i < pb.Length ? pb[i] : 0;
            if (ai != bi)
            {
                return ai - bi;
            }
        }

        return 0;

        static int[] Parse(string v)
        {
            var s = v.StartsWith('v') ? v[1..] : v;
            return s.Split('.')
                .Select(p => int.TryParse(p, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0)
                .ToArray();
        }
    }

    /// <summary>Probe the resolved tool paths and report per-tool status.</summary>
    public static IReadOnlyList<ToolStatus> Probe(ToolPaths? paths = null)
    {
        var t = paths ?? Resolve();
        return
        [
            ProbeFile("eval-gen", t.EvalGen,
                @"Build it: cd ..\EvaluationCLI\eval-gen && npm install && npm run build"),
            ProbeFile("eval-score", t.EvalScore,
                @"Build it: cd ..\EvaluationCLI\eval-score\node && npm install && npm run build"),
            ProbeFile("data-enhancer (compiled)", t.DataEnhancer,
                "Build the workflow first: npm run build (in CopilotConnectorWorkflow)"),
            ProbeFile("data-enhancer (typescript src)", t.TsDataEnhancer,
                "Expected at src/enhancer/enhance_for_copilot.ts (bundled) or CopilotConnectorSkill skill"),
            ProbeFile("copilot-connector skill", Path.Combine(t.CopilotConnectorSkill, "SKILL.md"),
                @"Skill expected at CopilotConnectorSkill\copilot-connector or ~/.copilot/skills/copilot-connector"),
        ];
    }

    private static ToolStatus ProbeFile(string name, string path, string fixHint) =>
        new()
        {
            Name = name,
            Path = path,
            Ok = File.Exists(path),
            Note = File.Exists(path) ? null : $"Missing. {fixHint}",
        };

    /// <summary>Spawn `node --version`, parse, and compare against the minimum.</summary>
    public static async Task<NodeVersionCheck> CheckNodeMinimumAsync(string min,
        string nodeExecutable = "node",
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(min);

        var result = await ProcessRunner.RunAsync(new RunOptions
        {
            Cmd = nodeExecutable,
            Args = ["--version"],
        }, cancellationToken).ConfigureAwait(false);

        if (!result.Ok)
        {
            return new NodeVersionCheck(Ok: false, Current: string.Empty);
        }

        var current = result.Output.Trim();
        return new NodeVersionCheck(Ok: CompareSemver(current, min) >= 0, Current: current);
    }
}

/// <summary>Result of <see cref="ToolResolver.CheckNodeMinimumAsync"/>.</summary>
public sealed record NodeVersionCheck(bool Ok, string Current);
