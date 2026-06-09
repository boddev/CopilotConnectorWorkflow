using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Xunit;

namespace Ccw.Steps.Tests.Jobs;

public sealed class JobStoreSaveReturnsRecordTests
{
    [Fact]
    public void SaveJob_ReturnsRecordWithUpdatedAt()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-save-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        JobStore.SetWorkspaceRootForTesting(root);
        try
        {
            var workspace = Path.Combine(root, "job-1");
            Directory.CreateDirectory(workspace);
            var stale = "2020-01-01T00:00:00.000Z";
            var job = MakeJob("job-1", workspace, stale);

            var saved = JobStore.SaveJob(job);

            Assert.NotEqual(stale, saved.UpdatedAt);
            var onDisk = File.ReadAllText(Path.Combine(workspace, "job.json"));
            using var doc = JsonDocument.Parse(onDisk);
            Assert.Equal(saved.UpdatedAt, doc.RootElement.GetProperty("updatedAt").GetString());
            Assert.Equal(stale, job.UpdatedAt);
        }
        finally
        {
            JobStore.SetWorkspaceRootForTesting(null);
            try { Directory.Delete(root, true); } catch { /* swallow */ }
        }
    }

    private static JobRecord MakeJob(string id, string workspace, string createdAt) => new()
    {
        Id = id,
        CreatedAt = createdAt,
        UpdatedAt = createdAt,
        Status = JobStatus.Pending,
        Workspace = workspace,
        Config = new JobConfig
        {
            Dataset = workspace,
            Description = "test",
            Count = 10,
            ConnectorId = "savetest",
            ConnectorName = "Save Test",
            DeployTarget = DeployTarget.AzureFunctions,
            Mode = RunMode.Build,
            AclMode = AclMode.Everyone,
        },
        Steps = new Dictionary<StepName, StepRecord>(),
    };
}
