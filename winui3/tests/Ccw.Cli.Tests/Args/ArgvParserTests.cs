// Argv parser unit tests pinning the lax-Node-semantics contract from
// src/cli.ts parseArgs. Each test mirrors a Node behavior we want to
// preserve. If any of these flip we'll silently regress every existing
// CI script that invokes ccw.
//
// Reference: src/cli.ts parseArgs (lines 19-32) and the special
// compare-twice handling.

using Ccw.Cli;
using Xunit;

namespace Ccw.Cli.Tests.Args;

public sealed class ArgvParserTests
{
    [Fact]
    public void EmptyArgv_DefaultsToHelp()
    {
        var p = ArgvParser.Parse([]);
        Assert.Equal("help", p.Cmd);
        Assert.Empty(p.Flags);
        Assert.Empty(p.Booleans);
    }

    [Fact]
    public void FirstArg_IsCmd()
    {
        var p = ArgvParser.Parse(["run", "--dataset", "x"]);
        Assert.Equal("run", p.Cmd);
        Assert.Equal("x", p.Flag("dataset"));
    }

    [Fact]
    public void FlagThenValue_IsParsedAsKv()
    {
        var p = ArgvParser.Parse(["run", "--connector-id", "abc"]);
        Assert.Equal("abc", p.Flag("connector-id"));
        Assert.False(p.Bool("connector-id"));
    }

    [Fact]
    public void TrailingFlagWithNoValue_IsBoolean()
    {
        var p = ArgvParser.Parse(["run", "--force"]);
        Assert.True(p.Bool("force"));
        Assert.Null(p.Flag("force"));
    }

    [Fact]
    public void FlagFollowedByAnotherFlag_IsBoolean()
    {
        // Mirrors Node: --force --dataset x → force is boolean, dataset=x.
        var p = ArgvParser.Parse(["run", "--force", "--dataset", "x"]);
        Assert.True(p.Bool("force"));
        Assert.Equal("x", p.Flag("dataset"));
    }

    [Fact]
    public void RepeatedFlag_LastWins_InNormalizedDict()
    {
        var p = ArgvParser.Parse(["run", "--dataset", "a", "--dataset", "b"]);
        Assert.Equal("b", p.Flag("dataset"));
    }

    [Fact]
    public void UnknownFlag_IsAccepted_NoError()
    {
        var p = ArgvParser.Parse(["run", "--never-heard-of-this", "v"]);
        Assert.Equal("v", p.Flag("never-heard-of-this"));
    }

    [Fact]
    public void CollectRepeatedJobIds_ReturnsBothInOrder()
    {
        // Compare command needs --job twice. Verify both ids are recovered
        // in argv order so report file names are deterministic.
        var p = ArgvParser.Parse(["compare", "--job", "a-id", "--job", "b-id", "--output", "out"]);
        var ids = ArgvParser.CollectRepeatedJobIds(p.Tail);
        Assert.Equal(2, ids.Count);
        Assert.Equal("a-id", ids[0]);
        Assert.Equal("b-id", ids[1]);
    }

    [Fact]
    public void CollectRepeatedJobIds_OnSingleJob_ReturnsOne()
    {
        var p = ArgvParser.Parse(["compare", "--job", "only"]);
        var ids = ArgvParser.CollectRepeatedJobIds(p.Tail);
        Assert.Single(ids);
        Assert.Equal("only", ids[0]);
    }
}
