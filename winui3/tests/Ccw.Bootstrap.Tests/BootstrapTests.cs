// Unit tests for the dependency-probe logic that DOES NOT require external
// CLIs (semver compare + sibling-repo path resolution + gh-copilot
// distinguishing). The actual `node --version` probe is integration-tested
// only when a Node is present; CI runs these.

using System.IO;
using Ccw.Bootstrap;
using Xunit;

namespace Ccw.Bootstrap.Tests;

public sealed class DependencyProbeCommandLineTests
{
    [Fact]
    public void SplitCommandLine_ParsesQuotedArguments()
    {
        var args = DependencyProbes.SplitCommandLine("\"C:\\Program Files\\GitHub CLI\\gh.exe\" extension list");

        Assert.Equal(3, args.Length);
        Assert.Equal("C:\\Program Files\\GitHub CLI\\gh.exe", args[0]);
        Assert.Equal("extension", args[1]);
        Assert.Equal("list", args[2]);
    }

    // Regression: az.cmd / atk.cmd (npm/Azure shims) were falsely reported as
    // "not installed" because the cmd.exe invocation built the command via
    // ArgumentList with embedded quotes, which .NET escaping + cmd parsing
    // mangled into an immediate exit-1. The shim path here contains a space to
    // reproduce the exact quoting failure; the fix must run it and capture the
    // echoed token. Windows-only (cmd.exe).
    [Fact]
    public void TryRunCapturingOutput_RunsCmdShim_WithSpacesInPath()
    {
        if (!OperatingSystem.IsWindows()) return;

        var dir = Path.Combine(Path.GetTempPath(), "ccw probe test " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var shim = Path.Combine(dir, "fake-cli.cmd");
        try
        {
            File.WriteAllText(shim, "@echo off\r\necho SHIM_OK_%1\r\n");

            var (ok, resolved, output) = DependencyProbes.TryRunCapturingOutput(shim, "1.2.3");

            Assert.True(ok, $"expected cmd shim to run; output={output ?? "<null>"}");
            Assert.Equal(shim, resolved);
            Assert.Contains("SHIM_OK_1.2.3", output ?? "", StringComparison.Ordinal);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* best-effort */ }
        }
    }
}

public sealed class SemverCompareTests
{
    [Theory]
    [InlineData("22.21.1", "22.21.1", 0)]
    [InlineData("22.21.2", "22.21.1", 1)]
    [InlineData("22.21.0", "22.21.1", -1)]
    [InlineData("v22.21.1", "22.21.1", 0)]
    [InlineData("22.21.1 (some junk)", "22.21.1", 0)]
    [InlineData("23.0.0", "22.21.1", 1)]
    [InlineData("21.0.0", "22.21.1", -1)]
    public void SemverCompare_OrdersAsExpected(string a, string b, int expectedSign)
    {
        var result = DependencyProbes.SemverCompare(a, b);
        Assert.Equal(Math.Sign(expectedSign), Math.Sign(result));
    }

    [Fact]
    public void SemverCompare_MissingPatch_TreatedAsZero()
    {
        Assert.Equal(0, DependencyProbes.SemverCompare("22.21", "22.21.0"));
        Assert.True(DependencyProbes.SemverCompare("22.21.1", "22.21") > 0);
    }

    [Theory]
    [InlineData("22.21.1-rc.1", "22.21.1", -1)]
    [InlineData("22.21.1", "22.21.1-rc.1", 1)]
    [InlineData("22.21.1-alpha", "22.21.1-beta", -1)]
    [InlineData("22.21.1+build.7", "22.21.1+build.99", 0)]
    [InlineData("22.21.1-rc.1+build.7", "22.21.1-rc.1", 0)]
    public void SemverCompare_PrereleaseRanksLower(string a, string b, int expectedSign)
    {
        var result = DependencyProbes.SemverCompare(a, b);
        Assert.Equal(Math.Sign(expectedSign), Math.Sign(result));
    }
}

public sealed class SiblingRepoProbeTests
{
    [Fact]
    public void ProbeEvaluationCli_Missing_WhenDistAbsent()
    {
        var temp = Directory.CreateTempSubdirectory();
        try
        {
            var options = new BootstrapOptions
            {
                SrcRoot = temp.FullName,
                EvaluationCliRoot = Path.Combine(temp.FullName, "EvaluationCLI"),
            };
            var result = DependencyProbes.ProbeEvaluationCli(options);
            Assert.False(result.Present);
            Assert.Equal(RequiredAction.CloneSiblingRepo, result.RequiredAction);
        }
        finally
        {
            temp.Delete(true);
        }
    }

    [Fact]
    public void ProbeEvaluationCli_Present_WhenDistFilesExist()
    {
        var temp = Directory.CreateTempSubdirectory();
        try
        {
            var root = Path.Combine(temp.FullName, "EvaluationCLI");
            Directory.CreateDirectory(Path.Combine(root, "eval-gen", "dist"));
            Directory.CreateDirectory(Path.Combine(root, "eval-score", "node", "dist"));
            File.WriteAllText(Path.Combine(root, "eval-gen", "dist", "index.js"), "// stub");
            File.WriteAllText(Path.Combine(root, "eval-score", "node", "dist", "index.js"), "// stub");
            var options = new BootstrapOptions
            {
                SrcRoot = temp.FullName,
                EvaluationCliRoot = root,
            };
            var result = DependencyProbes.ProbeEvaluationCli(options);
            Assert.True(result.Present);
            Assert.Null(result.RequiredAction);
        }
        finally
        {
            temp.Delete(true);
        }
    }

    [Fact]
    public void ProbeCopilotConnectorSkill_Present_WhenSkillMdExists()
    {
        var temp = Directory.CreateTempSubdirectory();
        try
        {
            var root = Path.Combine(temp.FullName, "CopilotConnectorSkill", "copilot-connector");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "SKILL.md"), "# skill");
            var options = new BootstrapOptions
            {
                SrcRoot = temp.FullName,
                CopilotConnectorSkillRoot = root,
            };
            var result = DependencyProbes.ProbeCopilotConnectorSkill(options);
            Assert.True(result.Present);
        }
        finally
        {
            temp.Delete(true);
        }
    }
}

public sealed class WinGetDriverTests
{
    [Theory]
    [InlineData("node", "OpenJS.NodeJS.LTS")]
    [InlineData("git", "Git.Git")]
    [InlineData("az", "Microsoft.AzureCLI")]
    [InlineData("gh", "GitHub.cli")]
    public void GetWinGetIdFor_KnownDeps_MapsCorrectly(string name, string expectedId)
    {
        Assert.Equal(expectedId, WinGetDriver.GetWinGetIdFor(name));
    }

    [Theory]
    [InlineData("atk")]
    [InlineData("gh-copilot")]
    [InlineData("unknown-thing")]
    public void GetWinGetIdFor_UnmappedDeps_ReturnsNull(string name)
    {
        Assert.Null(WinGetDriver.GetWinGetIdFor(name));
    }

    [Fact]
    public void ManualInstallCommands_ForUnmappedDeps_AreProvided()
    {
        Assert.Contains("npm install", WinGetDriver.ManualInstallCommands["atk"], StringComparison.OrdinalIgnoreCase);
        Assert.Contains("gh extension install", WinGetDriver.ManualInstallCommands["gh-copilot"], StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ManualInstallLinks_AreProvidedForEveryDep()
    {
        foreach (var dep in new[] { "node", "git", "az", "gh", "atk", "gh-copilot" })
        {
            Assert.True(WinGetDriver.ManualInstallLinks.ContainsKey(dep), $"missing manual install link for {dep}");
        }
    }
}
