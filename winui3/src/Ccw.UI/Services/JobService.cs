using System;
using System.Collections.Generic;
using System.Linq;
using Ccw.Core.Compare;
using Ccw.Core.Jobs;
using Ccw.Core.Models;

namespace Ccw.UI.Services;

/// <summary>Thin facade over <see cref="JobStore"/> + <see cref="JobComparer"/>
/// so view-models don't take a hard dependency on the static APIs.</summary>
public sealed class JobService
{
    public IReadOnlyList<JobRecord> ListJobs() => JobStore.ListJobs();

    public JobRecord? Load(string jobId)
    {
        try { return JobStore.LoadJob(jobId); }
        catch { return null; }
    }

    public string WorkspaceRoot() => JobStore.WorkspaceRoot();

    public CompareResult Compare(string jobIdA, string jobIdB, string outputDir)
        => JobComparer.RunCompare(new CompareOptions
        {
            JobIdA = jobIdA,
            JobIdB = jobIdB,
            OutputDir = outputDir,
        });

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
                if (a.DatasetHash is null || b.DatasetHash is null) continue;
                if (!string.Equals(a.DatasetHash, b.DatasetHash, StringComparison.Ordinal)) continue;
                if (a.EvalSetHash is null || b.EvalSetHash is null) continue;
                if (!string.Equals(a.EvalSetHash, b.EvalSetHash, StringComparison.Ordinal)) continue;
                if (a.Config?.NoEnhance == b.Config?.NoEnhance) continue;
                pairs.Add((a, b));
            }
        }
        return pairs;
    }
}
