using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.Core.Process;

namespace Ccw.UI.Services;

/// <summary>
/// Runs a job's pipeline from the WinUI app by shelling the proven Node CCW CLI
/// (<c>ccw resume --job &lt;id&gt;</c>) against the app's own job store. This is the
/// same six-step pipeline the user's working <c>ccw run</c> executes; the .NET
/// port only fully wires Step 3 in-process, so driving the Node CLI is what makes
/// a UI-created job actually run end-to-end instead of failing on the missing
/// in-process <c>step-pure</c> entrypoint.
///
/// <para>The Node CLI is pointed at the WinUI job store via the
/// <c>CCW_WORKSPACE_ROOT</c> environment variable (see <c>src/jobs.ts</c>), so it
/// loads, runs, and persists the very job.json the app reads. Live stdout/stderr is
/// streamed to <paramref name="onLog"/> (the orchestrator emits
/// <c>=== Step &lt;name&gt; ===</c> framing the view-model attributes to stages), and
/// <c>job.json</c> is polled so per-stage status glyphs update as Node saves each
/// transition. Callbacks fire on background threads; view-models marshal to the UI
/// thread themselves.</para>
/// </summary>
public sealed class JobRunner
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(750);

    public async Task<JobRecord> RunAsync(
        JobRecord job,
        Action<LogLine>? onLog,
        Action<JobRecord>? onJobSaved,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(job);

        var cli = NodeCliResolver.Resolve();
        if (cli is null)
        {
            var msg =
                "\n[run error] Could not locate the Node CCW bundle (dist/cli.js).\n" +
                "  Build the Node CLI:  cd %USERPROFILE%\\src\\CopilotConnectorWorkflow && npm install && npm run build\n" +
                "  Or set CCW_NODE_BUNDLE to the full path of dist/cli.js.\n";
            onLog?.Invoke(new LogLine("orchestrator", msg));
            var failed = MarkFailed(job);
            return JobStore.SaveJob(failed);
        }

        var workspaceRoot = JobStore.WorkspaceRoot();
        onLog?.Invoke(new LogLine("orchestrator",
            $"\n=== Launching pipeline ===\n  node {cli.BundlePath}\n  cwd={cli.RepoRoot}\n  CCW_WORKSPACE_ROOT={workspaceRoot}\n  CCW_SRC_ROOT={cli.SrcRoot}\n"));

        var logChannel = ProcessRunner.CreateLogChannel();
        var drainTask = Task.Run(async () =>
        {
            await foreach (var line in logChannel.Reader
                .ReadAllAsync(CancellationToken.None).ConfigureAwait(false))
            {
                onLog?.Invoke(line);
            }
        }, CancellationToken.None);

        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var pollTask = Task.Run(() => PollJobAsync(job.Id, onJobSaved, pollCts.Token), CancellationToken.None);

        RunResult runResult;
        try
        {
            runResult = await ProcessRunner.RunAsync(
                new RunOptions
                {
                    Cmd = cli.NodeExe,
                    Args = new[] { cli.BundlePath, "resume", "--job", job.Id },
                    Cwd = cli.RepoRoot,
                    Env = new Dictionary<string, string?>
                    {
                        ["CCW_WORKSPACE_ROOT"] = workspaceRoot,
                        ["CCW_SRC_ROOT"] = cli.SrcRoot,
                    },
                    LogSink = logChannel.Writer,
                    Label = "orchestrator",
                },
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            await pollCts.CancelAsync().ConfigureAwait(false);
            await SafeAwait(pollTask).ConfigureAwait(false);
            await drainTask.ConfigureAwait(false);
        }

        // Authoritative final state from the store (Node is the writer during the run).
        var final = JobStore.LoadJob(job.Id) ?? job;
        if (!runResult.Ok && final.Status == JobStatus.Running)
        {
            // Node exited non-zero but didn't persist a terminal status (e.g. a hard
            // crash). Surface a clear failure rather than leaving it stuck "running".
            onLog?.Invoke(new LogLine("orchestrator",
                $"\n[run error] Pipeline process exited with code {runResult.ExitCode}.\n"));
            final = JobStore.SaveJob(MarkFailed(final));
        }

        onJobSaved?.Invoke(final);
        return final;
    }

    private static async Task PollJobAsync(string jobId, Action<JobRecord>? onJobSaved, CancellationToken ct)
    {
        var lastSignature = "";
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(PollInterval, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            JobRecord? reloaded;
            try
            {
                reloaded = JobStore.LoadJob(jobId);
            }
            catch (Exception)
            {
                // Transient mid-write read (torn JSON, sharing violation). Retry next tick.
                continue;
            }

            if (reloaded is null)
            {
                continue;
            }

            var signature = BuildSignature(reloaded);
            if (signature != lastSignature)
            {
                lastSignature = signature;
                onJobSaved?.Invoke(reloaded);
            }
        }
    }

    private static string BuildSignature(JobRecord job)
    {
        // Cheap change-detection: job status + each step's status. Avoids spamming
        // the UI thread when job.json hasn't materially changed.
        var parts = new List<string>(job.Steps.Count + 2)
        {
            job.Status.ToString(),
            job.UpdatedAt,
        };
        foreach (var s in job.Steps.Values)
        {
            parts.Add(string.Create(CultureInfo.InvariantCulture, $"{s.Name}:{s.Status}"));
        }

        return string.Join('|', parts);
    }

    private static JobRecord MarkFailed(JobRecord job) => job with
    {
        Status = JobStatus.Failed,
        UpdatedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
    };

    private static async Task SafeAwait(Task t)
    {
        try
        {
            await t.ConfigureAwait(false);
        }
        catch
        {
            // Best-effort; poll loop failures must not mask the run result.
        }
    }
}
