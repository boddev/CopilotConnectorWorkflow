using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.Steps.Engines;
using Xunit;

namespace Ccw.Steps.Tests.Engines;

public sealed class Step3SchemaEngineTests
{
    [Fact]
    public async Task RunAsync_ProducesValidSchemaAndArtifacts()
    {
        var (workspace, jobRecord) = MakeWorkspace(suggestion:
            "{\"properties\":[" +
            "{\"name\":\"title\",\"type\":\"String\",\"isSearchable\":true,\"isRetrievable\":true,\"semanticLabel\":\"title\"}," +
            "{\"name\":\"url\",\"type\":\"String\",\"isRetrievable\":true,\"semanticLabel\":\"url\"}," +
            "{\"name\":\"author\",\"type\":\"String\",\"isQueryable\":true,\"isRetrievable\":true}" +
            "]}",
            itemsJsonl:
            "{\"id\":\"doc-1\",\"title\":\"hello\",\"url\":\"https://example.com/a\",\"author\":\"jane\"}\n" +
            "{\"id\":\"doc-2\",\"title\":\"world\",\"url\":\"https://example.com/b\",\"author\":\"john\"}\n");

        try
        {
            var stepOutDir = Path.Combine(workspace, "03-schema");
            var engine = new Step3SchemaEngine();
            var result = await engine.RunAsync(new StepRunContext
            {
                Job = jobRecord,
                StepOutDir = stepOutDir,
            });

            Assert.Equal(StepStatus.Done, result.Status);
            Assert.Equal(0, result.ExitCode);
            Assert.Equal(2, result.Artifacts.Count);

            var schemaArtifact = result.Artifacts.First(a => a.Role == "connectorSchema");
            Assert.True(File.Exists(Path.Combine(workspace, schemaArtifact.Path)));
            Assert.Equal(16, schemaArtifact.Sha256.Length);
            Assert.True(schemaArtifact.Bytes > 0);

            var validationArtifact = result.Artifacts.First(a => a.Role == "schemaValidation");
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(workspace, validationArtifact.Path)));
            Assert.True(doc.RootElement.TryGetProperty("issues", out var issues));
            Assert.True(doc.RootElement.TryGetProperty("blockingCount", out var blocking));
            Assert.Equal(0, blocking.GetInt32());
            Assert.True(issues.ValueKind == JsonValueKind.Array);
        }
        finally
        {
            JobStore.SetWorkspaceRootForTesting(null);
            try { Directory.Delete(workspace, true); } catch { /* swallow */ }
        }
    }

    [Fact]
    public async Task RunAsync_FailsWhenSuggestionMissing()
    {
        var (workspace, jobRecord) = MakeWorkspace(suggestion: null, itemsJsonl: null);
        try
        {
            var engine = new Step3SchemaEngine();
            var result = await engine.RunAsync(new StepRunContext
            {
                Job = jobRecord,
                StepOutDir = Path.Combine(workspace, "03-schema"),
            });
            Assert.Equal(StepStatus.Failed, result.Status);
            Assert.Contains("missing input", result.ErrorMessage ?? "", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            JobStore.SetWorkspaceRootForTesting(null);
            try { Directory.Delete(workspace, true); } catch { /* swallow */ }
        }
    }

    private static (string Workspace, JobRecord Job) MakeWorkspace(string? suggestion, string? itemsJsonl)
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-step3-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        JobStore.SetWorkspaceRootForTesting(root);

        var jobId = "test-job";
        var workspace = Path.Combine(root, jobId);
        Directory.CreateDirectory(workspace);
        Directory.CreateDirectory(Path.Combine(workspace, "02-enhance"));

        if (suggestion is not null)
        {
            File.WriteAllText(Path.Combine(workspace, "02-enhance", "schema-suggestion.json"), suggestion);
        }
        if (itemsJsonl is not null)
        {
            File.WriteAllText(Path.Combine(workspace, "02-enhance", "enhanced-items.jsonl"), itemsJsonl);
        }

        var now = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
        var job = new JobRecord
        {
            Id = jobId,
            CreatedAt = now,
            UpdatedAt = now,
            Status = JobStatus.Pending,
            Workspace = workspace,
            Config = new JobConfig
            {
                Dataset = workspace,
                Description = "test job",
                Count = 10,
                ConnectorId = "step3test",
                ConnectorName = "Step 3 Test",
                DeployTarget = DeployTarget.AzureFunctions,
                Mode = RunMode.Build,
                AclMode = AclMode.Everyone,
            },
            Steps = new Dictionary<StepName, StepRecord>(),
        };
        return (workspace, job);
    }
}
