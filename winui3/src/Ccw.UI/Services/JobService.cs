using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Ccw.Core.Compare;
using Ccw.Core.Jobs;
using Ccw.Core.Models;

namespace Ccw.UI.Services;

/// <summary>Thin facade over <see cref="JobStore"/> + <see cref="JobComparer"/>
/// so view-models don't take a hard dependency on the static APIs.
///
/// Phase 5 reviewer fold-in (Opus I2 + GPT IMPORTANT #1): every method
/// that touches disk (list/load/compare) has an async variant that
/// offloads to <see cref="Task.Run"/> so the UI thread never blocks on
/// `%LOCALAPPDATA%` I/O. The synchronous variants remain for back-compat
/// with command-line callers and the diagnostics path.</summary>
public sealed class JobService
{
    public IReadOnlyList<JobRecord> ListJobs() => JobStore.ListJobs();

    public Task<IReadOnlyList<JobRecord>> ListJobsAsync()
        => Task.Run(() => (IReadOnlyList<JobRecord>)JobStore.ListJobs());

    public JobRecord? Load(string jobId)
    {
        try { return JobStore.LoadJob(jobId); }
        catch { return null; }
    }

    public Task<JobRecord?> LoadAsync(string jobId)
        => Task.Run(() => Load(jobId));

    public string WorkspaceRoot() => JobStore.WorkspaceRoot();

    public CompareResult Compare(string jobIdA, string jobIdB, string outputDir)
        => JobComparer.RunCompare(new CompareOptions
        {
            JobIdA = jobIdA,
            JobIdB = jobIdB,
            OutputDir = outputDir,
        });

    public Task<CompareResult> CompareAsync(string jobIdA, string jobIdB, string outputDir)
        => Task.Run(() => Compare(jobIdA, jobIdB, outputDir));

    /// <summary>Find pairs of jobs eligible for the comparator: matching dataset+evalSetHash,
    /// opposite noEnhance setting (one with enhancement on, one off).</summary>
    public IReadOnlyList<(JobRecord A, JobRecord B)> EligibleComparePairs()
    {
        var jobs = ListJobs();
        var pairs = new List<(JobRecord, JobRecord)>();
        for (var i = 0; i < jobs.Count; i++)
        {
            for (var j = i + 1; j < jobs.Count; j++)
            {
                var a = jobs[i]; var b = jobs[j];
                if (!ArePairEligible(a, b)) continue;
                pairs.Add((a, b));
            }
        }
        return pairs;
    }

    /// <summary>Test a single (A, B) pair against the eligibility rules
    /// so view-models can filter the Job-B combobox by the current
    /// Job-A selection without rebuilding the full pair list.</summary>
    public static bool ArePairEligible(JobRecord a, JobRecord b)
    {
        if (a is null || b is null) return false;
        if (string.Equals(a.Id, b.Id, StringComparison.Ordinal)) return false;
        if (a.DatasetHash is null || b.DatasetHash is null) return false;
        if (!string.Equals(a.DatasetHash, b.DatasetHash, StringComparison.Ordinal)) return false;
        if (a.EvalSetHash is null || b.EvalSetHash is null) return false;
        if (!string.Equals(a.EvalSetHash, b.EvalSetHash, StringComparison.Ordinal)) return false;
        if (a.Config?.NoEnhance == b.Config?.NoEnhance) return false;
        return true;
    }
}
