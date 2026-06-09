using Ccw.Core.Process;
using Xunit;

namespace Ccw.Steps.Tests.Process;

public sealed class ProcessRunnerEscapeTests
{
    [Theory]
    [InlineData("simple", "simple")]
    [InlineData("with space", "\"with space\"")]
    [InlineData("with\ttab", "\"with\ttab\"")]
    [InlineData("with\"quote", "\"with\\\"quote\"")]
    [InlineData("trailing\\", "trailing\\")]
    [InlineData("a b\\", "\"a b\\\\\"")]
    [InlineData("a\\\\b", "a\\\\b")]
    [InlineData("c:\\Program Files\\node\\node.exe", "\"c:\\Program Files\\node\\node.exe\"")]
    [InlineData("", "\"\"")]
    public void EscapeForCreateProcess_FollowsCommandLineRules(string input, string expected)
    {
        var actual = ProcessRunner.EscapeForCreateProcess(input);
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData("npm install", "npm install")]
    [InlineData("npm&install", "npm^&install")]
    [InlineData("a|b", "a^|b")]
    [InlineData("safe&within\"quotes&here\"end", "safe^&within\"quotes&here\"end")]
    [InlineData("100%done", "100^%done")]
    public void CmdEscape_OnlyEscapesOutsideQuotes(string input, string expected)
    {
        var actual = ProcessRunner.CmdEscape(input);
        Assert.Equal(expected, actual);
    }
}
