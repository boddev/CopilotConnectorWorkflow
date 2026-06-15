using System;
using System.IO;

namespace Ccw.UI.Services;

/// <summary>
/// Locates the proven Node CCW CLI bundle (<c>dist/cli.js</c>) that the WinUI app
/// shells to actually run a pipeline. The .NET port only fully implements Step 3
/// in-process; the complete, battle-tested six-step pipeline lives in the Node CLI
/// at the workflow repo root, so the UI drives that instead of the half-wired
/// in-process engines.
///
/// <para>Tools and sibling repos (EvaluationCLI, CopilotConnectorSkill) are resolved
/// by the Node side relative to the BUNDLE location (<c>__dirname/..</c>), not the
/// process cwd — see <c>src/tools.ts</c>. That is why the conventional main checkout
/// at <c>%USERPROFILE%\src\CopilotConnectorWorkflow</c> is preferred: its siblings
/// resolve under <c>%USERPROFILE%\src</c> exactly as the user's working
/// <c>ccw run</c> already does.</para>
/// </summary>
public static class NodeCliResolver
{
    /// <summary>Resolved Node invocation details.</summary>
    /// <param name="NodeExe">Node executable (relies on PATH by default).</param>
    /// <param name="BundlePath">Absolute path to <c>dist/cli.js</c>.</param>
    /// <param name="RepoRoot">Repo root that contains <c>dist/</c> (used as cwd).</param>
    /// <param name="SrcRoot">Root holding sibling tool repos (EvaluationCLI,
    /// CopilotConnectorSkill); passed to Node as <c>CCW_SRC_ROOT</c>.</param>
    public sealed record Resolved(string NodeExe, string BundlePath, string RepoRoot, string SrcRoot);

    /// <summary>Resolve the Node CLI, or <c>null</c> if no bundle can be found.</summary>
    public static Resolved? Resolve()
    {
        var bundle = ResolveBundle();
        if (bundle is null)
        {
            return null;
        }

        // bundle = <root>\dist\cli.js  ->  root = up two levels.
        var distDir = Path.GetDirectoryName(bundle);
        var repoRoot = distDir is null ? null : Path.GetDirectoryName(distDir);
        if (string.IsNullOrEmpty(repoRoot))
        {
            return null;
        }

        return new Resolved(ResolveNodeExe(), bundle, repoRoot, ResolveSrcRoot());
    }

    /// <summary>Root holding sibling tool repos. Honors <c>CCW_SRC_ROOT</c>;
    /// defaults to <c>%USERPROFILE%\src</c> (matches Ccw.Bootstrap.BootstrapOptions).</summary>
    public static string ResolveSrcRoot()
    {
        var overrideRoot = Environment.GetEnvironmentVariable("CCW_SRC_ROOT");
        if (!string.IsNullOrWhiteSpace(overrideRoot))
        {
            return overrideRoot;
        }

        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "src");
    }

    private static string? ResolveBundle()
    {
        // 1. Explicit override — full path to dist/cli.js (testing / advanced).
        var overridePath = Environment.GetEnvironmentVariable("CCW_NODE_BUNDLE");
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
        {
            return Path.GetFullPath(overridePath);
        }

        // 2. The CCW repo the app itself was built from. Upward search from the
        //    app base directory for an enclosing checkout that has a built
        //    dist/cli.js. This makes the worktree/dev build run its OWN Node
        //    code; sibling tools are located via CCW_SRC_ROOT (set by the caller).
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 12 && !string.IsNullOrEmpty(dir); i++)
        {
            var candidate = Path.Combine(dir, "dist", "cli.js");
            if (File.Exists(candidate) && IsCcwRepo(dir))
            {
                return candidate;
            }

            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }

        // 3. Convention for a packaged/installed app where the exe is not inside a
        //    checkout: %USERPROFILE%\src\CopilotConnectorWorkflow\dist\cli.js.
        //    Matches Ccw.Bootstrap.BootstrapOptions.SrcRoot and the user's working
        //    `ccw run` environment (sibling tools resolve under %USERPROFILE%\src).
        var srcRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "src");
        var conventional = Path.Combine(srcRoot, "CopilotConnectorWorkflow", "dist", "cli.js");
        if (File.Exists(conventional))
        {
            return conventional;
        }

        return null;
    }

    private static bool IsCcwRepo(string dir)
    {
        var pkg = Path.Combine(dir, "package.json");
        if (!File.Exists(pkg))
        {
            return false;
        }

        try
        {
            return File.ReadAllText(pkg).Contains("copilot-connector-workflow", StringComparison.Ordinal);
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string ResolveNodeExe()
    {
        // Allow an explicit override; otherwise rely on PATH.
        var overrideExe = Environment.GetEnvironmentVariable("CCW_NODE_EXE");
        return !string.IsNullOrWhiteSpace(overrideExe) ? overrideExe : "node";
    }
}
