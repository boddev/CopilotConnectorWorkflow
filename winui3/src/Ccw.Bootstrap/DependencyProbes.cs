// Dependency probes for the WinUI3 port of CopilotConnectorWorkflow.
//
// Probes the external CLIs the generated connector + Step 4/5 shell to:
//   - Node 22.21.1+ (LTS) — needed by Step 4 (`npm install`, `tsc`) and
//     Step 5 (`atk install`), and by the v1 Step-2-enhancer shim path.
//   - Git — needed by Step 4 (template render commits)
//             and by 4.5c sibling-repo helper.
//   - Azure CLI — needed by Step 5 deploy mode (provision/ingest).
//   - atk (M365 Agents Toolkit) — needed by Step 5 (`atk install`).
//   - gh + gh-copilot extension — required by Step 6's GitHub Copilot judge
//     (the GitHub Copilot CLI is an extension, NOT a top-level binary —
//     installed via `gh extension install github/gh-copilot` after `gh` is
//     on PATH). The probe distinguishes "gh present / extension missing"
//     per Opus N5 in the plan.
//   - Sibling repos: EvaluationCLI + CopilotConnectorSkill (built dist/
//     directories) — needed by the v1 Step 2 enhancer shim and by Step 4
//     vendoring.
//
// SCOPE: this file is pure detection. It does NOT install anything (that's
// 4.5b WinGetDriver) and does NOT clone anything (that's 4.5c
// SiblingRepoHelper). Detection-layer is load-bearing per the plan; install
// is best-effort.

using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

namespace Ccw.Bootstrap;

/// <summary>One row in the probe output. Mirrors the Node
/// <c>ToolStatus</c> shape closely (name + path + ok + note) plus enough
/// extra metadata for the bootstrapper UI to recommend an action.</summary>
public sealed record DependencyProbeResult
{
    public required string Name { get; init; }
    public required string DisplayName { get; init; }
    public required bool Present { get; init; }
    /// <summary>Resolved version string when present (raw output from <c>--version</c>),
    /// trimmed. null if not present.</summary>
    public string? Version { get; init; }
    /// <summary>Whether the version satisfies the minimum requirement (always
    /// true if no minimum is declared). false if Present is false.</summary>
    public bool MeetsMinimumVersion { get; init; }
    public string? ExpectedMinimumVersion { get; init; }
    /// <summary>Full path to the executable / repo root when present.</summary>
    public string? Path { get; init; }
    /// <summary>Action the bootstrapper should suggest. <c>null</c> if no action
    /// is needed.</summary>
    public RequiredAction? RequiredAction { get; init; }
    public string? Note { get; init; }
}

public enum RequiredAction
{
    InstallViaWinget,
    UpgradeViaWinget,
    InstallGhCopilotExtension,
    CloneSiblingRepo,
    ManualInstall,
}

/// <summary>Static catalog of probes. Each probe is a (name, runner) so the
/// UI can show "checking xyz..." progress in a deterministic order.</summary>
public static class DependencyProbes
{
    public const string MinNodeVersion = "22.21.1";

    /// <summary>Run every probe and return results in catalog order.</summary>
    /// <remarks>GPT NIT 9: gh is hoisted out of ProbeGhCopilotExtension to avoid
    /// running it twice — the extension probe accepts a cached result.</remarks>
    public static IReadOnlyList<DependencyProbeResult> ProbeAll(BootstrapOptions? options = null)
    {
        options ??= new BootstrapOptions();
        var gh = ProbeGh();
        return new[]
        {
            ProbeNode(),
            ProbeGit(),
            ProbeAzureCli(),
            ProbeAtk(),
            gh,
            ProbeGhCopilotExtension(gh),
            ProbeEvaluationCli(options),
            ProbeCopilotConnectorSkill(options),
        };
    }

    public static DependencyProbeResult ProbeNode()
    {
        var (ok, path, version) = TryRunForVersion("node", "--version");
        var raw = version?.TrimStart('v');
        var meets = ok && raw is not null && SemverCompare(raw, MinNodeVersion) >= 0;
        return new DependencyProbeResult
        {
            Name = "node",
            DisplayName = "Node.js " + MinNodeVersion + " (LTS) or later",
            Present = ok,
            Version = version,
            ExpectedMinimumVersion = MinNodeVersion,
            MeetsMinimumVersion = meets,
            Path = path,
            RequiredAction = ok
                ? (meets ? null : RequiredAction.UpgradeViaWinget)
                : RequiredAction.InstallViaWinget,
            Note = ok && !meets
                ? "Node " + raw + " is below required " + MinNodeVersion
                : null,
        };
    }

    public static DependencyProbeResult ProbeGit()
    {
        var (ok, path, version) = TryRunForVersion("git", "--version");
        return new DependencyProbeResult
        {
            Name = "git",
            DisplayName = "Git",
            Present = ok,
            Version = version,
            MeetsMinimumVersion = ok,
            Path = path,
            RequiredAction = ok ? null : RequiredAction.InstallViaWinget,
        };
    }

    public static DependencyProbeResult ProbeAzureCli()
    {
        // Opus NIT 4: az --version is slow-cold (often 8-12s); give it 20s.
        var (ok, path, version) = TryRunForVersion("az", "--version", timeoutMs: 20000);
        return new DependencyProbeResult
        {
            Name = "az",
            DisplayName = "Azure CLI",
            Present = ok,
            Version = version,
            MeetsMinimumVersion = ok,
            Path = path,
            RequiredAction = ok ? null : RequiredAction.InstallViaWinget,
            Note = ok ? null : "Required for Step 5 provision mode (deploy + ingest).",
        };
    }

    public static DependencyProbeResult ProbeAtk()
    {
        var (ok, path, version) = TryRunForVersion("atk", "--version");
        return new DependencyProbeResult
        {
            Name = "atk",
            DisplayName = "Microsoft 365 Agents Toolkit (atk)",
            Present = ok,
            Version = version,
            MeetsMinimumVersion = ok,
            Path = path,
            RequiredAction = ok ? null : RequiredAction.ManualInstall,
            Note = ok ? null : "Install via 'npm install -g @microsoft/m365agentstoolkit-cli'.",
        };
    }

    public static DependencyProbeResult ProbeGh()
    {
        var (ok, path, version) = TryRunForVersion("gh", "--version");
        return new DependencyProbeResult
        {
            Name = "gh",
            DisplayName = "GitHub CLI",
            Present = ok,
            Version = version,
            MeetsMinimumVersion = ok,
            Path = path,
            RequiredAction = ok ? null : RequiredAction.InstallViaWinget,
        };
    }

    /// <summary>The GitHub Copilot CLI is a `gh` extension, not a top-level
    /// binary (Opus N5). Distinguishes 'gh missing' from 'gh present /
    /// extension missing' so the wizard can chain the right install.</summary>
    public static DependencyProbeResult ProbeGhCopilotExtension(DependencyProbeResult? cachedGh = null)
    {
        var ghProbe = cachedGh ?? ProbeGh();
        if (!ghProbe.Present)
        {
            return new DependencyProbeResult
            {
                Name = "gh-copilot",
                DisplayName = "GitHub Copilot CLI extension",
                Present = false,
                MeetsMinimumVersion = false,
                RequiredAction = RequiredAction.InstallViaWinget,
                Note = "Install gh first; then 'gh extension install github/gh-copilot'.",
            };
        }
        var (ok, _, output) = TryRunCapturingOutput("gh", "extension list");
        var hasExt = ok && output is not null && output.Contains("github/gh-copilot", StringComparison.OrdinalIgnoreCase);
        return new DependencyProbeResult
        {
            Name = "gh-copilot",
            DisplayName = "GitHub Copilot CLI extension",
            Present = hasExt,
            MeetsMinimumVersion = hasExt,
            Path = hasExt ? ghProbe.Path : null,
            RequiredAction = hasExt ? null : RequiredAction.InstallGhCopilotExtension,
            Note = hasExt ? null : "Run 'gh extension install github/gh-copilot'.",
        };
    }

    public static DependencyProbeResult ProbeEvaluationCli(BootstrapOptions options)
    {
        var root = options.EvaluationCliRoot ?? Path.Combine(options.SrcRoot, "EvaluationCLI");
        // We deliberately probe the BUILT artifact (eval-gen/dist/index.js)
        // because that's what Step 1 actually shells to in v1. A bare clone
        // without `npm run build` doesn't satisfy the workflow.
        var evalGen = Path.Combine(root, "eval-gen", "dist", "index.js");
        var evalScore = Path.Combine(root, "eval-score", "node", "dist", "index.js");
        var present = File.Exists(evalGen) && File.Exists(evalScore);
        return new DependencyProbeResult
        {
            Name = "evaluation-cli",
            DisplayName = "EvaluationCLI (eval-gen + eval-score)",
            Present = present,
            MeetsMinimumVersion = present,
            Path = present ? root : null,
            RequiredAction = present ? null : RequiredAction.CloneSiblingRepo,
            Note = present
                ? null
                : "Clone github.com/microsoft/EvaluationCLI to " + root
                  + " then run 'npm install && npm run build' in eval-gen and eval-score/node.",
        };
    }

    public static DependencyProbeResult ProbeCopilotConnectorSkill(BootstrapOptions options)
    {
        var root = options.CopilotConnectorSkillRoot
            ?? Path.Combine(options.SrcRoot, "CopilotConnectorSkill", "copilot-connector");
        var marker = Path.Combine(root, "SKILL.md");
        var present = File.Exists(marker);
        return new DependencyProbeResult
        {
            Name = "copilot-connector-skill",
            DisplayName = "CopilotConnectorSkill (skill bundle)",
            Present = present,
            MeetsMinimumVersion = present,
            Path = present ? root : null,
            RequiredAction = present ? null : RequiredAction.CloneSiblingRepo,
            Note = present
                ? null
                : "Clone github.com/microsoft/CopilotConnectorSkill to " + Path.Combine(options.SrcRoot, "CopilotConnectorSkill") + ".",
        };
    }

    // ----- helpers -----------------------------------------------------

    private static (bool Ok, string? Path, string? Version) TryRunForVersion(string fileName, string arg, int timeoutMs = 15000)
    {
        var (ok, path, output) = TryRunCapturingOutput(fileName, arg, timeoutMs);
        if (!ok || string.IsNullOrEmpty(output)) return (ok, path, null);
        // Take the first line of output as version. Most CLIs print
        // "<name> <semver>"; we lose precision but it's fine for display.
        var firstLine = output.Split('\n').First().Trim();
        return (true, path, firstLine);
    }

    /// <summary>GPT BLOCKER #1: replaced the original sync ReadToEnd before
    /// WaitForExit pattern with a concurrent read + WaitForExitAsync race
    /// against a CancellationTokenSource timeout. Kills the process tree on
    /// timeout. Also closes stdin (Opus NIT) so tools that block on input
    /// surface as a quick failure instead of a hang.
    ///
    /// GPT BLOCKER #2: detects .cmd/.bat shims (e.g. npm.cmd) and promotes
    /// to `cmd /c "<path>" <args>` because Process.Start can't launch a
    /// .cmd directly with UseShellExecute=false.</summary>
    internal static (bool Ok, string? Path, string? Output) TryRunCapturingOutput(string fileName, string args, int timeoutMs = 15000)
    {
        try
        {
            var resolved = WhichOnPath(fileName);
            var actual = resolved ?? fileName;
            var ext = Path.GetExtension(actual);
            var isCmdShim = ext.Equals(".cmd", StringComparison.OrdinalIgnoreCase)
                         || ext.Equals(".bat", StringComparison.OrdinalIgnoreCase);
            ProcessStartInfo psi;
            if (isCmdShim)
            {
                psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c \"\"" + actual + "\" " + args + "\"",
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
            }
            else
            {
                psi = new ProcessStartInfo
                {
                    FileName = actual,
                    Arguments = args,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
            }
            using var p = Process.Start(psi);
            if (p is null) return (false, null, null);
            try { p.StandardInput.Close(); } catch { /* best-effort */ }

            // Concurrent reads so a full stderr buffer can't deadlock waiting on stdout.
            var stdoutTask = p.StandardOutput.ReadToEndAsync();
            var stderrTask = p.StandardError.ReadToEndAsync();
            using var cts = new System.Threading.CancellationTokenSource(timeoutMs);
            var waitTask = p.WaitForExitAsync(cts.Token);
            try
            {
                waitTask.GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                try { p.Kill(true); } catch { /* best-effort */ }
                return (false, resolved, null);
            }
            string stdout, stderr;
            try { stdout = stdoutTask.GetAwaiter().GetResult(); } catch { stdout = ""; }
            try { stderr = stderrTask.GetAwaiter().GetResult(); } catch { stderr = ""; }
            if (p.ExitCode != 0) return (false, resolved, null);
            return (true, resolved, string.IsNullOrEmpty(stdout) ? stderr : stdout);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return (false, null, null);
        }
        catch (InvalidOperationException)
        {
            return (false, null, null);
        }
        catch (IOException)
        {
            return (false, null, null);
        }
    }

    /// <summary>PATH lookup with all PATHEXT extensions. Returns null when
    /// nothing matches. Mirrors `where.exe` semantics enough for the probes.</summary>
    internal static string? WhichOnPath(string fileName)
    {
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        var pathExt = Environment.GetEnvironmentVariable("PATHEXT")
            ?? ".COM;.EXE;.BAT;.CMD";
        var exts = pathExt.Split(';', StringSplitOptions.RemoveEmptyEntries);
        var hasExt = Path.GetExtension(fileName).Length > 0;
        foreach (var dir in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            if (hasExt)
            {
                var p = Path.Combine(dir, fileName);
                if (File.Exists(p)) return p;
            }
            else
            {
                foreach (var ext in exts)
                {
                    var p = Path.Combine(dir, fileName + ext);
                    if (File.Exists(p)) return p;
                }
            }
        }
        return null;
    }

    private static readonly Regex s_versionDigits = new(@"\d+(?:\.\d+)*", RegexOptions.Compiled);

    /// <summary>Compare two semver-ish strings. Tolerant of "v" prefixes,
    /// missing patch numbers, and the messy "1.42.0 (extra junk)" formats
    /// some CLIs print. Returns &lt;0, 0, &gt;0 like a comparator.
    ///
    /// Opus + GPT IMPORTANT: when major.minor.patch tie, ranks pre-release
    /// (e.g. "22.21.1-rc.1") strictly lower than the release ("22.21.1").
    /// Build metadata after `+` is dropped entirely per semver spec.</summary>
    public static int SemverCompare(string a, string b)
    {
        var sa = StripBuildMetadata(a ?? "");
        var sb = StripBuildMetadata(b ?? "");
        var ma = s_versionDigits.Match(sa);
        var mb = s_versionDigits.Match(sb);
        var pa = (ma.Success ? ma.Value : "0").Split('.');
        var pb = (mb.Success ? mb.Value : "0").Split('.');
        for (var i = 0; i < 3; i++)
        {
            var ax = i < pa.Length && int.TryParse(pa[i], out var av) ? av : 0;
            var bx = i < pb.Length && int.TryParse(pb[i], out var bv) ? bv : 0;
            if (ax != bx) return ax - bx;
        }
        var preA = ExtractPrerelease(sa, ma);
        var preB = ExtractPrerelease(sb, mb);
        // No prerelease ranks higher than a prerelease per semver.
        if (preA is null && preB is null) return 0;
        if (preA is null) return 1;
        if (preB is null) return -1;
        return string.CompareOrdinal(preA, preB);
    }

    private static string StripBuildMetadata(string v)
    {
        var plus = v.IndexOf('+', StringComparison.Ordinal);
        return plus < 0 ? v : v[..plus];
    }

    private static string? ExtractPrerelease(string version, Match digitsMatch)
    {
        if (!digitsMatch.Success) return null;
        var after = version[(digitsMatch.Index + digitsMatch.Length)..];
        if (after.StartsWith('-'))
        {
            var end = after.IndexOfAny([' ', '\t']);
            return end < 0 ? after[1..] : after[1..end];
        }
        return null;
    }
}

/// <summary>Locations the probes look in. Defaults match the Node version
/// (sibling repos under %USERPROFILE%\src\), but every path is overridable
/// for tests and for the restricted-network "bring your own clone" flow.</summary>
public sealed record BootstrapOptions
{
    public string SrcRoot { get; init; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "src");
    public string? EvaluationCliRoot { get; init; }
    public string? CopilotConnectorSkillRoot { get; init; }
}
