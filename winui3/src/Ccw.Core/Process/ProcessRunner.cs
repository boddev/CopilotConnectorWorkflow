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
//   * spawn failure -> exitCode = -1, ok = false.
//   * Exit code propagates as-is (no exception thrown for non-zero).
//
// Channel<LogLine> uses BoundedChannelFullMode.Wait. A slow consumer
// will pause the producer; in the limit, the child process's stdout
// pipe fills its OS-level buffer and the OS blocks the child until
// drained. This is the desired backpressure semantic for very chatty
// long-running steps (Step 6 can emit hundreds of MB of log output).

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
    /// <summary>Default channel capacity for the live log stream.
    /// 4096 lines is enough for a chatty Step 6 to never starve the
    /// producer in normal conditions; if the UI thread stalls
    /// significantly, backpressure pauses the child process.</summary>
    public const int DefaultLogChannelCapacity = 4096;

    /// <summary>Create a bounded channel suitable for <see cref="RunOptions.LogSink"/>.</summary>
    public static Channel<LogLine> CreateLogChannel(int capacity = DefaultLogChannelCapacity) =>
        Channel.CreateBounded<LogLine>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = true,
        });

    /// <summary>Spawn a child process; tee output to log file + sink; complete when done.</summary>
    public static async Task<RunResult> RunAsync(RunOptions opts, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentException.ThrowIfNullOrEmpty(opts.Cmd);

        var cwd = opts.Cwd ?? Environment.CurrentDirectory;

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
            // Mirror Node's `spawn(cmd, args, { shell: true })` behavior on
            // Windows: cmd.exe /d /s /c "<cmd> <args>".
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
                psi.Environment[key] = value;
            }
        }

        var captured = new StringBuilder();
        var sink = opts.LogSink;

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
            await WriteAsync(opts.LogFile, sink, opts.Label, spawnText, cancellationToken).ConfigureAwait(false);
            sink?.Complete();
            return new RunResult { ExitCode = -1, Ok = false, Output = captured.ToString() };
        }

        var stdoutTask = PumpAsync(child.StandardOutput, captured, opts.LogFile, sink, opts.Label, cancellationToken);
        var stderrTask = PumpAsync(child.StandardError, captured, opts.LogFile, sink, opts.Label, cancellationToken);

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
                }
            }
            catch
            {
                // Best-effort kill; rethrow the cancellation.
            }

            throw;
        }

        await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);

        var exitCode = child.ExitCode;
        var tail = string.Create(CultureInfo.InvariantCulture, $"\n[exit {exitCode}]\n");
        await WriteAsync(opts.LogFile, sink, opts.Label, tail, cancellationToken).ConfigureAwait(false);

        sink?.Complete();

        return new RunResult
        {
            ExitCode = exitCode,
            Ok = exitCode == 0,
            // Node returns the BODY (no spawn-error suffix) and no tail in `output`.
            // Match that: `captured` holds bytes received before the tail write.
            Output = captured.ToString(),
        };
    }

    /// <summary>Split a "py -3" style invocation into command + prefix args.
    /// TS: <c>splitInvocation</c>.</summary>
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
        CancellationToken ct)
    {
        // ReadAsync gives us byte-faithful chunks (matches Node's `data`
        // event semantics, which fires per-chunk not per-line). Reading
        // line-by-line would strip terminators and reformat the log.
        var buf = new char[4096];
        while (!ct.IsCancellationRequested)
        {
            var read = await reader.ReadAsync(buf, ct).ConfigureAwait(false);
            if (read <= 0)
            {
                return;
            }

            var text = new string(buf, 0, read);
            captured.Append(text);
            await WriteAsync(logFile, sink, label, text, ct).ConfigureAwait(false);
        }
    }

    private static async Task WriteAsync(
        string? logFile,
        ChannelWriter<LogLine>? sink,
        string? label,
        string text,
        CancellationToken ct)
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

    private static string GetShellExecutable() =>
        OperatingSystem.IsWindows()
            ? Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe"
            : "/bin/sh";

    private static string BuildShellCommand(string cmd, IReadOnlyList<string> args)
    {
        if (args.Count == 0)
        {
            return cmd;
        }

        var sb = new StringBuilder(cmd);
        foreach (var a in args)
        {
            sb.Append(' ').Append(a);
        }

        return sb.ToString();
    }
}
