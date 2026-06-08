// Phase 1h tests: lock the ProcessRunner contract: exit code, captured
// output, log-file format, and the IObservable-style log streaming sink.

using System.Threading.Channels;
using Ccw.Core.Process;
using Xunit;

namespace Ccw.Core.Tests.Process;

public class ProcessRunnerTests
{
    private static bool OnWindows => OperatingSystem.IsWindows();

    [Fact]
    public async Task RunAsync_SuccessfulCommand_ReturnsExitZero_AndCapturesOutput()
    {
        var opts = OnWindows
            ? new RunOptions { Cmd = "cmd.exe", Args = ["/c", "echo hello-from-cmd"] }
            : new RunOptions { Cmd = "/bin/echo", Args = ["hello-from-cmd"] };

        var result = await ProcessRunner.RunAsync(opts);

        Assert.True(result.Ok);
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("hello-from-cmd", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunAsync_NonZeroExit_ReportsExitCode_OkFalse()
    {
        var opts = OnWindows
            ? new RunOptions { Cmd = "cmd.exe", Args = ["/c", "exit 7"] }
            : new RunOptions { Cmd = "/bin/sh", Args = ["-c", "exit 7"] };

        var result = await ProcessRunner.RunAsync(opts);

        Assert.False(result.Ok);
        Assert.Equal(7, result.ExitCode);
    }

    [Fact]
    public async Task RunAsync_NonExistentExecutable_ReturnsMinusOne_OkFalse()
    {
        var result = await ProcessRunner.RunAsync(new RunOptions
        {
            Cmd = "definitely-not-a-real-binary-12345.exe",
            Args = [],
        });

        Assert.False(result.Ok);
        Assert.Equal(-1, result.ExitCode);
        Assert.Contains("[spawn error]", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunAsync_LogFile_WrittenWithHeaderAndExitTail()
    {
        using var tmp = new TempDir();
        var logPath = Path.Combine(tmp.Path, "step.log");

        var opts = OnWindows
            ? new RunOptions { Cmd = "cmd.exe", Args = ["/c", "echo log-line"], LogFile = logPath }
            : new RunOptions { Cmd = "/bin/echo", Args = ["log-line"], LogFile = logPath };

        var result = await ProcessRunner.RunAsync(opts);

        Assert.True(result.Ok);
        var contents = await File.ReadAllTextAsync(logPath);
        Assert.Contains("$ ", contents, StringComparison.Ordinal);
        Assert.Contains("(cwd=", contents, StringComparison.Ordinal);
        Assert.Contains("log-line", contents, StringComparison.Ordinal);
        Assert.Contains("[exit 0]", contents, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunAsync_LogSink_StreamsLogLines_AndCompletesOnExit()
    {
        var channel = ProcessRunner.CreateLogChannel(capacity: 64);

        var opts = OnWindows
            ? new RunOptions { Cmd = "cmd.exe", Args = ["/c", "echo line-1"], LogSink = channel.Writer, Label = "step1" }
            : new RunOptions { Cmd = "/bin/echo", Args = ["line-1"], LogSink = channel.Writer, Label = "step1" };

        var runTask = ProcessRunner.RunAsync(opts);

        var received = new List<LogLine>();
        await foreach (var line in channel.Reader.ReadAllAsync())
        {
            received.Add(line);
        }

        var result = await runTask;
        Assert.True(result.Ok);

        // At least one chunk with our label and the echoed body, plus the
        // [exit 0] tail.
        Assert.Contains(received, l => l.Label == "step1" && l.Text.Contains("line-1", StringComparison.Ordinal));
        Assert.Contains(received, l => l.Text.Contains("[exit 0]", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RunAsync_CapturesStderrIntoOutput()
    {
        var opts = OnWindows
            ? new RunOptions
            {
                Cmd = "cmd.exe",
                Args = ["/c", "echo to-stderr 1>&2 && exit 0"],
            }
            : new RunOptions
            {
                Cmd = "/bin/sh",
                Args = ["-c", "echo to-stderr 1>&2"],
            };

        var result = await ProcessRunner.RunAsync(opts);
        Assert.True(result.Ok);
        Assert.Contains("to-stderr", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunAsync_EnvOverride_VisibleToChild()
    {
        var opts = OnWindows
            ? new RunOptions
            {
                Cmd = "cmd.exe",
                Args = ["/c", "echo %CCW_TEST_VAR%"],
                Env = new Dictionary<string, string?> { ["CCW_TEST_VAR"] = "from-test" },
            }
            : new RunOptions
            {
                Cmd = "/bin/sh",
                Args = ["-c", "echo $CCW_TEST_VAR"],
                Env = new Dictionary<string, string?> { ["CCW_TEST_VAR"] = "from-test" },
            };

        var result = await ProcessRunner.RunAsync(opts);
        Assert.True(result.Ok);
        Assert.Contains("from-test", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public void SplitInvocation_BasicCase()
    {
        var (cmd, args) = ProcessRunner.SplitInvocation("py -3");
        Assert.Equal("py", cmd);
        Assert.Equal(["-3"], args);
    }

    [Fact]
    public void SplitInvocation_NoArgs()
    {
        var (cmd, args) = ProcessRunner.SplitInvocation("node");
        Assert.Equal("node", cmd);
        Assert.Empty(args);
    }

    [Fact]
    public void SplitInvocation_CollapsesExtraSpaces()
    {
        var (cmd, args) = ProcessRunner.SplitInvocation("py   -3   -u");
        Assert.Equal("py", cmd);
        Assert.Equal(["-3", "-u"], args);
    }

    [Fact]
    public async Task RunAsync_EnvNullValue_RemovesVariableFromChild()
    {
        // GPT review IMPORTANT: Node `spawn({env:{KEY: undefined}})`
        // removes KEY from the child environment. The C# port mirrors
        // this by treating null in opts.Env as a removal.
        Environment.SetEnvironmentVariable("CCW_TEST_PARENT_VAR", "from-parent");
        try
        {
            // cmd.exe IF DEFINED branches reliably on whether a var
            // exists in the child environment, regardless of value.
            var opts = OnWindows
                ? new RunOptions
                {
                    Cmd = "cmd.exe",
                    Args = ["/c", "IF DEFINED CCW_TEST_PARENT_VAR (echo present) ELSE (echo absent)"],
                    Env = new Dictionary<string, string?> { ["CCW_TEST_PARENT_VAR"] = null },
                }
                : new RunOptions
                {
                    Cmd = "/bin/sh",
                    Args = ["-c", "if [ -z \"${CCW_TEST_PARENT_VAR+x}\" ]; then echo absent; else echo present; fi"],
                    Env = new Dictionary<string, string?> { ["CCW_TEST_PARENT_VAR"] = null },
                };

            var result = await ProcessRunner.RunAsync(opts);
            Assert.True(result.Ok);
            Assert.Contains("absent", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("present", result.Output, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("CCW_TEST_PARENT_VAR", null);
        }
    }

    [Fact]
    public async Task RunAsync_Cancellation_CompletesLogSink()
    {
        // GPT review BLOCKER: a cancelled run must complete the sink
        // so awaiting consumers (e.g. UI ReadAllAsync) wake up.
        var channel = ProcessRunner.CreateLogChannel(capacity: 64);
        using var cts = new CancellationTokenSource();

        // A long-running noop process that we cancel almost immediately.
        var opts = OnWindows
            ? new RunOptions
            {
                Cmd = "cmd.exe",
                Args = ["/c", "ping -n 30 127.0.0.1 > NUL"],
                LogSink = channel.Writer,
            }
            : new RunOptions
            {
                Cmd = "/bin/sh",
                Args = ["-c", "sleep 30"],
                LogSink = channel.Writer,
            };

        var runTask = ProcessRunner.RunAsync(opts, cts.Token);
        // Drain the channel in the background so the producer can't
        // block on backpressure while we wait to cancel.
        var drainTask = Task.Run(async () =>
        {
            await foreach (var _ in channel.Reader.ReadAllAsync(CancellationToken.None))
            {
            }
        });

        // Give the process a moment to actually start.
        await Task.Delay(200);
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runTask);

        // The drain task should complete because the sink was completed
        // in `finally`. If it hangs, this Task.WhenAny pattern will
        // surface the bug as a timeout failure.
        var winner = await Task.WhenAny(drainTask, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(drainTask, winner);
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; }

        public TempDir()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "ccw-runner-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch { /* best-effort cleanup */ }
        }
    }
}
