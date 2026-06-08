// Port of src/run.ts.
//
// Spawn a child process, tee combined stdout/stderr to an optional log
// file AND an in-process IObservable<LogLine>, return a RunResult when
// the process exits.
//
// Why IObservable rather than the Node EventEmitter the TS source uses:
//   * WinUI 3 MVVM already binds to IObservable/IAsyncEnumerable sources
//     idiomatically.
//   * Bounded channel under the hood gives backpressure for long Step 6
//     runs (the original SSE bus had no backpressure — a slow consumer
//     would balloon the buffer).
//   * Trivially adapts to IAsyncEnumerable / IObservable later via
//     System.Reactive if we ever pull it in.
//
// PARITY DISCIPLINE:
//   * Log-file format matches Node exactly:
//         "\n$ <cmd> <args>\n  (cwd=<cwd>)\n"   (header)
//         <stdout/stderr bytes>                  (tee)
//         "\n[spawn error] <msg>\n"              (spawn failure)
//         "\n[exit <code>]\n"                    (footer)
//   * Combined stdout+stderr captured into RunResult.Output.
//   * Windows .cmd/.bat shims auto-promote to shell=true.
//   * env is merged on top of the current process environment
//     (callers override; existing vars survive otherwise).
//     A null value REMOVES that variable from the child environment
//     (mirrors Node `spawn({env:{KEY: undefined}})`).
//   * spawn failure -> exitCode = -1, ok = false.
//   * Exit code propagates as-is (no exception thrown for non-zero).
//
// CONCURRENCY DISCIPLINE (GPT review BLOCKER):
//   * stdout + stderr pumps run concurrently. ALL shared-state writes
//     (StringBuilder, log file, channel) are serialized through a
//     single SemaphoreSlim so we never corrupt captured output, race
//     on File.AppendAllTextAsync, or violate the channel's writer
//     contract.
//   * sink.Complete() is unconditionally invoked in `finally` so a
//     cancelled run never leaves a UI consumer hanging on ReadAllAsync.
//
// BACKPRESSURE CONTRACT:
//   * Channel<LogLine> uses BoundedChannelFullMode.Wait. Callers MUST
//     consume the channel concurrently with awaiting RunAsync, or a
//     chatty child will block (filling the channel -> blocking the
//     producer -> blocking stdout drain -> OS pipe buffer fills ->
//     blocking the child). This is the desired semantic for very chatty
//     long-running steps (Step 6 emits hundreds of MB) — it provides
//     real backpressure rather than unbounded buffering.

using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Threading.Channels;

namespace Ccw.Core.Process;

/// <summary>A single log chunk streamed from a child process.</summary>
public sealed record LogLine(string? Label, string Text);

/// <summary>Options for <see cref="ProcessRunner.RunAsync"/>.</summary>
public sealed record RunOptions
{
    public required string Cmd { get; init; }
    public IReadOnlyList<string> Args { get; init; } = [];
    public string? Cwd { get; init; }

    /// <summary>Env vars to merge over the current process environment.
    /// A <c>null</c> value REMOVES that variable from the child env
    /// (matches Node <c>spawn({ env: { KEY: undefined } })</c>).</summary>
    public IReadOnlyDictionary<string, string?>? Env { get; init; }

    /// <summary>Append all stdout/stderr to this file.</summary>
    public string? LogFile { get; init; }

    /// <summary>Optional sink for live log streaming. Backpressure-safe.</summary>
    public ChannelWriter<LogLine>? LogSink { get; init; }

    /// <summary>Optional label prefixed onto emitted log events.</summary>
    public string? Label { get; init; }

    /// <summary>Force shell mode (auto-set for Windows .cmd/.bat shims).</summary>
    public bool Shell { get; init; }
}

/// <summary>Result of a process invocation.</summary>
public sealed record RunResult
{
    public required int ExitCode { get; init; }
    public required bool Ok { get; init; }

    /// <summary>Combined stdout+stderr.</summary>
    public required string Output { get; init; }
}

public static class ProcessRunner
{
    /// <summary>Default channel capacity for the live log stream.</summary>
    public const int DefaultLogChannelCapacity = 4096;

    /// <summary>Create a bounded channel suitable for <see cref="RunOptions.LogSink"/>.
    /// Defaults to <see cref="BoundedChannelFullMode.DropOldest"/> per Opus review I2:
    /// the live UI sink is intentionally LOSSY. A stalled UI consumer must never
    /// block the child process — a 60-minute Step 6 cannot be held hostage to a
    /// blocked window. The lossless source of truth is the log file (always written)
    /// and the <see cref="RunResult.Output"/> string (always captured). Pass
    /// <see cref="BoundedChannelFullMode.Wait"/> if you genuinely need backpressure
    /// (test harnesses, deterministic captures).</summary>
    public static Channel<LogLine> CreateLogChannel(
        int capacity = DefaultLogChannelCapacity,
        BoundedChannelFullMode fullMode = BoundedChannelFullMode.DropOldest) =>
        Channel.CreateBounded<LogLine>(new BoundedChannelOptions(capacity)
        {
            FullMode = fullMode,
            // Two pump tasks (stdout + stderr) both write through the
            // serializing semaphore — SingleWriter would be a lie even
            // though only one task is inside the semaphore at a time,
            // because the channel's invariant is about distinct callers,
            // not serialized callers. Keep this honest.
            SingleReader = false,
            SingleWriter = false,
        });

    /// <summary>Spawn a child process; tee output to log file + sink; complete when done.</summary>
    public static async Task<RunResult> RunAsync(RunOptions opts, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentException.ThrowIfNullOrEmpty(opts.Cmd);

        var cwd = opts.Cwd ?? Environment.CurrentDirectory;
        var sink = opts.LogSink;
        // Single semaphore serializes ALL shared-state writes across
        // the two pump tasks (stdout + stderr).
        using var writeGate = new SemaphoreSlim(1, 1);
        var captured = new StringBuilder();

        try
        {
            if (!string.IsNullOrEmpty(opts.LogFile))
            {
                var logDir = Path.GetDirectoryName(opts.LogFile);
                if (!string.IsNullOrEmpty(logDir))
                {
                    Directory.CreateDirectory(logDir);
                }

                var header = string.Create(CultureInfo.InvariantCulture,
                    $"\n$ {opts.Cmd} {string.Join(' ', opts.Args)}\n  (cwd={cwd})\n");
                await File.AppendAllTextAsync(opts.LogFile, header, Encoding.UTF8, cancellationToken)
                    .ConfigureAwait(false);
            }

            var isWindowsShim = OperatingSystem.IsWindows()
                && (opts.Cmd.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                    || opts.Cmd.EndsWith(".bat", StringComparison.OrdinalIgnoreCase));

            var useShell = opts.Shell || isWindowsShim;

            var psi = new ProcessStartInfo
            {
                FileName = useShell ? GetShellExecutable() : opts.Cmd,
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            if (useShell)
            {
                psi.ArgumentList.Add("/d");
                psi.ArgumentList.Add("/s");
                psi.ArgumentList.Add("/c");
                psi.ArgumentList.Add(BuildShellCommand(opts.Cmd, opts.Args));
            }
            else
            {
                foreach (var arg in opts.Args)
                {
                    psi.ArgumentList.Add(arg);
                }
            }

            if (opts.Env is not null)
            {
                foreach (var (key, value) in opts.Env)
                {
                    if (value is null)
                    {
                        // Null = remove. Mirrors Node.
                        psi.Environment.Remove(key);
                    }
                    else
                    {
                        psi.Environment[key] = value;
                    }
                }
            }

            using var child = new System.Diagnostics.Process { StartInfo = psi };

            try
            {
                if (!child.Start())
                {
                    throw new InvalidOperationException("Process.Start returned false.");
                }
            }
            catch (Exception ex)
            {
                var spawnText = $"\n[spawn error] {ex.Message}\n";
                captured.Append(spawnText);
                await WriteAsync(opts.LogFile, sink, opts.Label, spawnText, writeGate, cancellationToken)
                    .ConfigureAwait(false);
                return new RunResult { ExitCode = -1, Ok = false, Output = captured.ToString() };
            }

            var stdoutTask = PumpAsync(child.StandardOutput, captured, opts.LogFile, sink, opts.Label, writeGate, cancellationToken);
            var stderrTask = PumpAsync(child.StandardError, captured, opts.LogFile, sink, opts.Label, writeGate, cancellationToken);

            try
            {
                await child.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try
                {
                    if (!child.HasExited)
                    {
                        child.Kill(entireProcessTree: true);
                        // Wait without the cancellation token; we just
                        // need the OS to reap. Bounded grace period.
                        await child.WaitForExitAsync(CancellationToken.None)
                            .WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None)
                            .ConfigureAwait(false);
                    }
                }
                catch
                {
                    // Best-effort cleanup; cancellation rethrow below.
                }

                await SafeAwait(stdoutTask).ConfigureAwait(false);
                await SafeAwait(stderrTask).ConfigureAwait(false);

                throw;
            }

            await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);

            var exitCode = child.ExitCode;
            var tail = string.Create(CultureInfo.InvariantCulture, $"\n[exit {exitCode}]\n");
            await WriteAsync(opts.LogFile, sink, opts.Label, tail, writeGate, cancellationToken)
                .ConfigureAwait(false);

            return new RunResult
            {
                ExitCode = exitCode,
                Ok = exitCode == 0,
                Output = captured.ToString(),
            };
        }
        finally
        {
            // Always complete the sink so awaiting consumers wake up,
            // even on cancellation or unexpected exception
            // (GPT BLOCKER fix). TryComplete is a no-op if already done.
            sink?.TryComplete();
        }
    }

    /// <summary>Split a "py -3" style invocation into command + prefix args.</summary>
    public static (string Cmd, string[] PrefixArgs) SplitInvocation(string invocation)
    {
        ArgumentException.ThrowIfNullOrEmpty(invocation);
        var parts = invocation.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return (parts[0], parts.Length > 1 ? parts[1..] : []);
    }

    private static async Task PumpAsync(
        StreamReader reader,
        StringBuilder captured,
        string? logFile,
        ChannelWriter<LogLine>? sink,
        string? label,
        SemaphoreSlim writeGate,
        CancellationToken ct)
    {
        var buf = new char[4096];
        while (!ct.IsCancellationRequested)
        {
            var read = await reader.ReadAsync(buf, ct).ConfigureAwait(false);
            if (read <= 0)
            {
                return;
            }

            var text = new string(buf, 0, read);
            await writeGate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                captured.Append(text);

                if (!string.IsNullOrEmpty(logFile))
                {
                    await File.AppendAllTextAsync(logFile, text, Encoding.UTF8, ct).ConfigureAwait(false);
                }

                if (sink is not null)
                {
                    await sink.WriteAsync(new LogLine(label, text), ct).ConfigureAwait(false);
                }
            }
            finally
            {
                writeGate.Release();
            }
        }
    }

    private static async Task WriteAsync(
        string? logFile,
        ChannelWriter<LogLine>? sink,
        string? label,
        string text,
        SemaphoreSlim writeGate,
        CancellationToken ct)
    {
        await writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!string.IsNullOrEmpty(logFile))
            {
                await File.AppendAllTextAsync(logFile, text, Encoding.UTF8, ct).ConfigureAwait(false);
            }

            if (sink is not null)
            {
                await sink.WriteAsync(new LogLine(label, text), ct).ConfigureAwait(false);
            }
        }
        finally
        {
            writeGate.Release();
        }
    }

    private static async Task SafeAwait(Task t)
    {
        try { await t.ConfigureAwait(false); }
        catch { /* drained on cancellation */ }
    }

    private static string GetShellExecutable() =>
        OperatingSystem.IsWindows()
            ? Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe"
            : "/bin/sh";

    private static string BuildShellCommand(string cmd, IReadOnlyList<string> args)
    {
        // Windows shell-mode quoting (GPT Phase 2 BLOCKER #5, plus Phase-2
        // closure follow-up BLOCKER #1 — cmd itself must go through
        // CRT/CreateProcess quoting too, otherwise a path like
        // "C:\Program Files\node\npm.cmd" splits on the space inside the
        // shell-composed command line).
        //
        // KNOWN GOTCHA (Opus Phase-2 closure I-3): `^%` does NOT suppress
        // %VAR% expansion under `cmd /c`. Caret can't escape percent, and
        // `%%` only works inside batch files. If a caller passes an argument
        // containing a defined env-var token (e.g. a path with `%TEMP%`), it
        // will silently expand. The mitigation in Phase 4+ is to call node
        // directly (not via the cmd shim path) whenever possible, and to
        // document this for any path that DOES go through here.
        //
        // We pass `cmd.exe /d /s /c "<cmdline>"` and rely on .NET to
        // double-quote the whole `<cmdline>` block (because we add it
        // via ArgumentList). Inside that block, each token needs:
        //   1. CreateProcess-style quoting so the child program's
        //      own argv parser sees one argument per token.
        //   2. Caret-escaping of cmd.exe metacharacters
        //      (&, |, <, >, ^, %) outside the quoted runs.
        if (args.Count == 0)
        {
            return CmdEscape(EscapeForCreateProcess(cmd));
        }

        var sb = new StringBuilder();
        sb.Append(CmdEscape(EscapeForCreateProcess(cmd)));
        foreach (var arg in args)
        {
            sb.Append(' ');
            sb.Append(CmdEscape(EscapeForCreateProcess(arg)));
        }
        return sb.ToString();
    }

    /// <summary>Builds a Windows shell command line. Public for tests so
    /// they can pin the full composed command, not just the individual
    /// helpers (GPT Phase-2 closure follow-up).</summary>
    internal static string BuildShellCommandForTests(string cmd, IReadOnlyList<string> args)
        => BuildShellCommand(cmd, args);

    /// <summary>Windows CreateProcess command-line quoting per the canonical
    /// rule set (also documented as "C runtime command-line argument" rules):
    /// quote if the arg contains whitespace, tab, or a literal quote; double
    /// any backslashes that precede a literal quote OR the closing quote.
    /// Internal so tests can pin behavior.</summary>
    internal static string EscapeForCreateProcess(string arg)
    {
        if (arg.Length == 0) return "\"\"";

        var needsQuote = false;
        foreach (var c in arg)
        {
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"')
            {
                needsQuote = true;
                break;
            }
        }
        if (!needsQuote) return arg;

        var sb = new StringBuilder(arg.Length + 2);
        sb.Append('"');
        for (var i = 0; i < arg.Length; i++)
        {
            var backslashes = 0;
            while (i < arg.Length && arg[i] == '\\')
            {
                backslashes++;
                i++;
            }

            if (i == arg.Length)
            {
                // Trailing backslashes — double them so they don't escape the closing quote.
                sb.Append('\\', backslashes * 2);
                break;
            }
            if (arg[i] == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(arg[i]);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary>Caret-escape cmd.exe metacharacters that appear OUTSIDE of
    /// double-quoted runs. The simple defensive rule: walk the string,
    /// flip an "inside-quotes" bit on each unescaped quote, and prefix
    /// metachars outside quotes with ^.</summary>
    internal static string CmdEscape(string s)
    {
        if (s.Length == 0) return s;
        var sb = new StringBuilder(s.Length + 8);
        var inQuote = false;
        foreach (var c in s)
        {
            if (c == '"') inQuote = !inQuote;
            if (!inQuote && (c == '&' || c == '|' || c == '<' || c == '>' || c == '^' || c == '%'))
            {
                sb.Append('^');
            }
            sb.Append(c);
        }
        return sb.ToString();
    }
}
