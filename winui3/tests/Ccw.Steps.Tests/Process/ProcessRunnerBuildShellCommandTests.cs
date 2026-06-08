using Ccw.Core.Process;
using Xunit;

namespace Ccw.Steps.Tests.Process;

// GPT Phase-2 closure follow-up BLOCKER #1: cmd path itself must go
// through CRT/CreateProcess quoting (a path with spaces was previously
// only CmdEscape'd — the inner space split the command line).
public sealed class ProcessRunnerBuildShellCommandTests
{
    [Fact]
    public void QuotesCommandPathWithSpaces()
    {
        var cmd = ProcessRunner.BuildShellCommandForTests(
            "C:\\Program Files\\node\\npm.cmd",
            new[] { "install" });
        Assert.StartsWith("\"C:\\Program Files\\node\\npm.cmd\"", cmd);
    }

    [Fact]
    public void CmdMetacharsInArg_EscapedOutsideQuotes()
    {
        var cmd = ProcessRunner.BuildShellCommandForTests(
            "npm",
            new[] { "run", "x&y" });
        Assert.Equal("npm run x^&y", cmd);
    }

    [Fact]
    public void ArgWithSpaces_GetsQuotedAndCmdMetacharsInsideAreNotEscaped()
    {
        var cmd = ProcessRunner.BuildShellCommandForTests(
            "npm",
            new[] { "run", "a & b" });
        // EscapeForCreateProcess → "a & b" (with the spaces); then
        // CmdEscape walks: inside-quote bit is set after first ", so & passes.
        Assert.Equal("npm run \"a & b\"", cmd);
    }

    [Fact]
    public void NoArgs_StillQuotesCommandPathIfNeeded()
    {
        var cmd = ProcessRunner.BuildShellCommandForTests(
            "C:\\Program Files\\foo\\bar.exe",
            Array.Empty<string>());
        Assert.Equal("\"C:\\Program Files\\foo\\bar.exe\"", cmd);
    }
}
