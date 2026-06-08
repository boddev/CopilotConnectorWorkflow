// Sibling-repo helper — clones EvaluationCLI + CopilotConnectorSkill
// into the user's chosen src root and runs the `npm install && npm run
// build` recipe on each so the v1 enhancer shim path (Phase 2.2-a) and
// the Step 4 vendoring paths have something to work with.
//
// Restricted-network fallback (plan §6 risk row): if cloning is
// impossible, the user can point Ccw.Bootstrap.BootstrapOptions at an
// existing pre-built clone via Settings; this helper is best-effort.
//
// Progress reporting goes through IProgress<string> so the wizard
// (Phase 6) can render line-by-line status without coupling to a
// specific UI framework.

using System.Diagnostics;
using System.IO;
using System.Text;

namespace Ccw.Bootstrap;

public sealed record SiblingRepoResult
{
    public required string RepoName { get; init; }
    public required bool Success { get; init; }
    /// <summary>true if the repo was already present + built (no work done).</summary>
    public bool AlreadyPresent { get; init; }
    public string? CloneOutput { get; init; }
    public string? BuildOutput { get; init; }
    public string? Error { get; init; }
}

public static class SiblingRepoHelper
{
    public const string EvaluationCliRemote = "https://github.com/microsoft/EvaluationCLI.git";
    public const string CopilotConnectorSkillRemote = "https://github.com/microsoft/CopilotConnectorSkill.git";

    /// <summary>Subdirectories of EvaluationCLI that need their own
    /// `npm install && npm run build` for the bundled CLIs to work.</summary>
    private static readonly IReadOnlyList<string> EvaluationCliBuildDirs =
        new[]
        {
            Path.Combine("eval-gen"),
            Path.Combine("eval-score", "node"),
        };

    private static readonly string[] s_npmInstall = ["install"];
    private static readonly string[] s_npmRunBuild = ["run", "build"];

    public static async Task<SiblingRepoResult> EnsureEvaluationCliAsync(
        BootstrapOptions options,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new BootstrapOptions();
        var root = options.EvaluationCliRoot ?? Path.Combine(options.SrcRoot, "EvaluationCLI");
        var already = DependencyProbes.ProbeEvaluationCli(options).Present;
        if (already)
        {
            progress?.Report($"EvaluationCLI already present at {root}; skipping.");
            return new SiblingRepoResult
            {
                RepoName = "EvaluationCLI",
                Success = true,
                AlreadyPresent = true,
            };
        }
        Directory.CreateDirectory(options.SrcRoot);
        var cloneOut = new StringBuilder();
        if (!Directory.Exists(root))
        {
            progress?.Report($"git clone {EvaluationCliRemote} {root}");
            var (cloneOk, cloneText) = await RunCapturingAsync(
                "git", new[] { "clone", EvaluationCliRemote, root }, options.SrcRoot,
                progress, cancellationToken).ConfigureAwait(false);
            cloneOut.Append(cloneText);
            if (!cloneOk)
            {
                return new SiblingRepoResult
                {
                    RepoName = "EvaluationCLI",
                    Success = false,
                    CloneOutput = cloneOut.ToString(),
                    Error = "git clone failed (see CloneOutput).",
                };
            }
        }
        var buildOut = new StringBuilder();
        foreach (var sub in EvaluationCliBuildDirs)
        {
            var dir = Path.Combine(root, sub);
            progress?.Report($"npm install in {dir}");
            var (instOk, instText) = await RunCapturingAsync("npm", s_npmInstall, dir,
                progress, cancellationToken).ConfigureAwait(false);
            buildOut.AppendLine(instText);
            if (!instOk)
            {
                return new SiblingRepoResult
                {
                    RepoName = "EvaluationCLI",
                    Success = false,
                    CloneOutput = cloneOut.ToString(),
                    BuildOutput = buildOut.ToString(),
                    Error = $"npm install failed in {dir}",
                };
            }
            progress?.Report($"npm run build in {dir}");
            var (buildOk, buildText) = await RunCapturingAsync("npm", s_npmRunBuild, dir,
                progress, cancellationToken).ConfigureAwait(false);
            buildOut.AppendLine(buildText);
            if (!buildOk)
            {
                return new SiblingRepoResult
                {
                    RepoName = "EvaluationCLI",
                    Success = false,
                    CloneOutput = cloneOut.ToString(),
                    BuildOutput = buildOut.ToString(),
                    Error = $"npm run build failed in {dir}",
                };
            }
        }
        return new SiblingRepoResult
        {
            RepoName = "EvaluationCLI",
            Success = true,
            CloneOutput = cloneOut.ToString(),
            BuildOutput = buildOut.ToString(),
        };
    }

    public static async Task<SiblingRepoResult> EnsureCopilotConnectorSkillAsync(
        BootstrapOptions options,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new BootstrapOptions();
        var parent = Path.Combine(options.SrcRoot, "CopilotConnectorSkill");
        var root = options.CopilotConnectorSkillRoot ?? Path.Combine(parent, "copilot-connector");
        var already = DependencyProbes.ProbeCopilotConnectorSkill(options).Present;
        if (already)
        {
            progress?.Report($"CopilotConnectorSkill already present at {root}; skipping.");
            return new SiblingRepoResult
            {
                RepoName = "CopilotConnectorSkill",
                Success = true,
                AlreadyPresent = true,
            };
        }
        Directory.CreateDirectory(options.SrcRoot);
        var cloneOut = new StringBuilder();
        if (!Directory.Exists(parent))
        {
            progress?.Report($"git clone {CopilotConnectorSkillRemote} {parent}");
            var (cloneOk, cloneText) = await RunCapturingAsync(
                "git", new[] { "clone", CopilotConnectorSkillRemote, parent }, options.SrcRoot,
                progress, cancellationToken).ConfigureAwait(false);
            cloneOut.Append(cloneText);
            if (!cloneOk)
            {
                return new SiblingRepoResult
                {
                    RepoName = "CopilotConnectorSkill",
                    Success = false,
                    CloneOutput = cloneOut.ToString(),
                    Error = "git clone failed (see CloneOutput).",
                };
            }
        }
        // Skill bundle doesn't need a `npm run build` — Step 4 vendors the
        // TS source file directly. Just verifying the SKILL.md marker is
        // present (done by ProbeCopilotConnectorSkill).
        return new SiblingRepoResult
        {
            RepoName = "CopilotConnectorSkill",
            Success = true,
            CloneOutput = cloneOut.ToString(),
        };
    }

    private static async Task<(bool Ok, string Output)> RunCapturingAsync(
        string fileName, string[] args, string workingDir,
        IProgress<string>? progress, CancellationToken ct)
    {
        var resolved = DependencyProbes.WhichOnPath(fileName) ?? fileName;
        var psi = new ProcessStartInfo
        {
            FileName = resolved,
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return (false, "");
            var stdoutTask = p.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct).ConfigureAwait(false);
            var stdout = await stdoutTask.ConfigureAwait(false);
            var stderr = await stderrTask.ConfigureAwait(false);
            var combined = string.IsNullOrEmpty(stderr) ? stdout : stdout + Environment.NewLine + stderr;
            progress?.Report(combined);
            return (p.ExitCode == 0, combined);
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            return (false, ex.Message);
        }
        catch (IOException ex)
        {
            return (false, ex.Message);
        }
    }
}
