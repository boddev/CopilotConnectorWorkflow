using System;
using System.IO;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Xunit;

namespace Ccw.Core.Tests.Jobs;

public sealed class JobStoreTests : IDisposable
{
    private readonly string _tmpRoot;
    private readonly string _tmpDataset;

    public JobStoreTests()
    {
        _tmpRoot = Path.Combine(Path.GetTempPath(), "ccw-jobstore-" + Path.GetRandomFileName());
        Directory.CreateDirectory(_tmpRoot);
        JobStore.SetWorkspaceRootForTesting(_tmpRoot);

        _tmpDataset = Path.Combine(_tmpRoot, "dataset.csv");
        File.WriteAllText(_tmpDataset, "id,title\n1,sample\n");
    }

    public void Dispose()
    {
        JobStore.SetWorkspaceRootForTesting(null);
        try { Directory.Delete(_tmpRoot, recursive: true); } catch { /* swallow */ }
    }

    private JobConfig MakeConfig() => new()
    {
        Dataset = _tmpDataset,
        Description = "round trip",
        Count = 10,
        ConnectorId = "ccwtestconnector",
        ConnectorName = "CCW Test Connector",
        DeployTarget = DeployTarget.AzureFunctions,
        Mode = RunMode.Build,
        AclMode = AclMode.Everyone,
    };

    [Fact]
    public void NewJobId_HasExpectedShape()
    {
        var id = JobStore.NewJobId(new DateTime(2025, 11, 19, 14, 30, 45, DateTimeKind.Utc));
        Assert.StartsWith("20251119-143045-", id, StringComparison.Ordinal);
        Assert.True(id.Length > "20251119-143045-".Length);
    }

    [Fact]
    public void CreateJob_PersistsToDisk_AndLoadJobRoundTrips()
    {
        var created = JobStore.CreateJob(MakeConfig());
        Assert.NotNull(created);

        var loaded = JobStore.LoadJob(created.Id);
        Assert.NotNull(loaded);
        Assert.Equal(created.Id, loaded!.Id);
        Assert.Equal("CCW Test Connector", loaded.Config.ConnectorName);
    }

    [Fact]
    public void ListJobs_ReturnsCreatedJobs()
    {
        var j1 = JobStore.CreateJob(MakeConfig());
        var j2 = JobStore.CreateJob(MakeConfig());

        var listed = JobStore.ListJobs();
        Assert.Contains(listed, j => j.Id == j1.Id);
        Assert.Contains(listed, j => j.Id == j2.Id);
    }

    [Fact]
    public void ValidateConfig_MissingDataset_Throws()
    {
        var cfg = MakeConfig() with { Dataset = "" };
        var ex = Assert.Throws<ArgumentException>(() => JobStore.ValidateConfig(cfg));
        Assert.Contains("dataset", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ApplyPipelineDetection_ForceEnhanceAndNoEnhance_Throws()
    {
        var cfg = MakeConfig() with
        {
            ForceEnhance = true,
            NoEnhance = true,
        };
        Assert.Throws<InvalidOperationException>(() => JobStore.ApplyPipelineDetection(cfg));
    }

    [Fact]
    public void ApplyPipelineDetection_NoEnhanceSet_IsRespected()
    {
        var cfg = MakeConfig() with
        {
            NoEnhance = true,
            AutoDetectPipeline = true,
        };
        var updated = JobStore.ApplyPipelineDetection(cfg);
        Assert.True(updated.NoEnhance);
    }
}
