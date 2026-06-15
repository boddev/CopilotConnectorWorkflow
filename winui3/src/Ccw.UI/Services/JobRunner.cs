using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.Core.Process;
using Ccw.Steps.Engines;

namespace Ccw.UI.Services;

/// <summary>
/// Runs a job's pipeline in-process from the WinUI app using the same
/// <see cref="Orchestrator.RunPipelineAsync"/> + <see cref="DefaultStepEngines"/>
/// that the <c>ccw run</c> CLI uses. This is what makes a UI-created job actually
/// execute instead of sitting at <c>pending</c> forever.
///
/// <para>The orchestrator streams a lossy live log over a bounded channel and
/// persists <c>job.json</c> after every step transition via the save callback.
/// Both are surfaced to the caller through <paramref name="onLog"/> and
/// <paramref name="onJobSaved"/>; those callbacks fire on background threads, so
/// view-models must marshal to the UI thread themselves.</para>
/// </summary>
public sealed class JobRunner
{
    public async Task<JobRecord> RunAsync(
        JobRecord job,
        Action<LogLine>? onLog,
        Action<JobRecord>? onJobSaved,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(job);

        var logChannel = Channel.CreateBounded<LogLine>(new BoundedChannelOptions(4096)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
        });

        var drainTask = Task.Run(async () =>
        {
            await foreach (var line in logChannel.Reader
                .ReadAllAsync(CancellationToken.None).ConfigureAwait(false))
            {
                onLog?.Invoke(line);
            }
        }, CancellationToken.None);

        JobRecord result;
        try
        {
            result = await Orchestrator.RunPipelineAsync(
                new RunPipelineOptions
                {
                    Job = job,
                    StepEngines = DefaultStepEngines.Build(),
                    LogSink = logChannel.Writer,
                },
                saved =>
                {
                    var persisted = JobStore.SaveJob(saved);
                    onJobSaved?.Invoke(persisted);
                    return persisted;
                },
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            logChannel.Writer.TryComplete();
        }

        await drainTask.ConfigureAwait(false);
        return result;
    }
}
