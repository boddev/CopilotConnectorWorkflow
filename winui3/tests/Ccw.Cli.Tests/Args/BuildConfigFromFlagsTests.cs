// BuildConfigFromFlags validation tests. These pin the mutually-exclusive
// guards and required-flag errors that match src/cli.ts buildConfigFromFlags.
// They don't construct full pipelines — only the config-building parse step.

using Ccw.Cli;
using Ccw.Cli.Commands;
using Ccw.Core.Models;
using Xunit;

namespace Ccw.Cli.Tests.Args;

public sealed class BuildConfigFromFlagsTests
{
    private static ParsedArgs Parse(params string[] argv) => ArgvParser.Parse(argv);

    [Fact]
    public void Build_MinimalRun_BuildMode()
    {
        var args = Parse("run",
            "--dataset", "C:\\tmp\\data",
            "--description", "d",
            "--connector-id", "cid",
            "--connector-name", "cn");
        var cfg = RunCommand.BuildConfigFromFlags(args);
        Assert.Equal(RunMode.Build, cfg.Mode);
        Assert.Equal(30, cfg.Count);
        Assert.Equal("cid", cfg.ConnectorId);
        Assert.Equal("cn", cfg.ConnectorName);
        Assert.Equal(DeployTarget.AzureFunctions, cfg.DeployTarget);
        Assert.Equal(AclMode.Everyone, cfg.AclMode);
        Assert.Null(cfg.Auth);
    }

    [Fact]
    public void Build_CountClamped_LowAndHigh()
    {
        var low = RunCommand.BuildConfigFromFlags(Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--count", "1"));
        Assert.Equal(5, low.Count);

        var high = RunCommand.BuildConfigFromFlags(Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--count", "5000"));
        Assert.Equal(200, high.Count);
    }

    [Fact]
    public void Build_NoEnhanceAndForceEnhance_AreMutuallyExclusive()
    {
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--no-enhance", "--force-enhance");
        var ex = Assert.Throws<ArgumentException>(() => RunCommand.BuildConfigFromFlags(args));
        Assert.Contains("mutually exclusive", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Build_ReuseEvalFromAndEvalSet_AreMutuallyExclusive()
    {
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--reuse-eval-from", "abc", "--eval-set", "C:\\tmp\\e.json");
        var ex = Assert.Throws<ArgumentException>(() => RunCommand.BuildConfigFromFlags(args));
        Assert.Contains("mutually exclusive", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Build_ProvisionMode_RequiresAuth()
    {
        // No --tenant-id should error.
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--mode", "provision");
        var ex = Assert.Throws<ArgumentException>(() => RunCommand.BuildConfigFromFlags(args));
        Assert.Contains("tenant-id", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Build_WorkIqJudge_RequiresJudgeAgentId()
    {
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--judge-provider", "workiq");
        var ex = Assert.Throws<ArgumentException>(() => RunCommand.BuildConfigFromFlags(args));
        Assert.Contains("judge-agent-id", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Build_GitHubCopilotJudge_OK_WithoutJudgeAgentId()
    {
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--judge-provider", "github-copilot");
        var cfg = RunCommand.BuildConfigFromFlags(args);
        Assert.NotNull(cfg.Score);
        Assert.Equal(JudgeProvider.GitHubCopilot, cfg.Score!.JudgeProvider);
    }

    [Fact]
    public void Build_IndexReadyMinMinutes_StoredAsMinutes_VerbatimFromFlag()
    {
        // Node stores --index-ready-min-minutes raw, as MINUTES, into
        // score.indexReadySettleMinutes (cli.ts:352). The earlier port
        // mistakenly wrote *60 into IndexReadyMinSeconds — both reviewers
        // caught this as a BLOCKER. Pinning the corrected behavior here.
        var args = Parse("run",
            "--dataset", "x", "--description", "d", "--connector-id", "c", "--connector-name", "n",
            "--index-ready-min-minutes", "5");
        var cfg = RunCommand.BuildConfigFromFlags(args);
        Assert.NotNull(cfg.Score);
        Assert.Equal(5, cfg.Score!.IndexReadySettleMinutes);
        Assert.Null(cfg.Score.IndexReadyMinSeconds);
    }
}
