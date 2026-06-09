using System.Collections.Generic;
using System.IO;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.Steps.Engines;
using Xunit;

namespace Ccw.Steps.Tests.Engines;

// GPT Phase-2 closure follow-up BLOCKER #3: Step 3 must pre-clean stale
// schema.ts (and connector-schema.json, schema-validation.json) so a
// re-run never leaves Step 4 consuming an out-of-sync TypeScript module
// from a previous Node run.
public sealed class Step3SchemaEngineRerunCleanupTests
{
    [Fact]
    public async Task RerunDeletesStaleSchemaTsFromPriorNodeRun()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-step3-clean-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        JobStore.SetWorkspaceRootForTesting(root);
        try
        {
            var workspace = Path.Combine(root, "job-1");
            Directory.CreateDirectory(Path.Combine(workspace, "02-enhance"));
            var stepOutDir = Path.Combine(workspace, "03-schema");
            Directory.CreateDirectory(stepOutDir);

            File.WriteAllText(Path.Combine(workspace, "02-enhance", "schema-suggestion.json"),
                "{\"properties\":[{\"name\":\"title\",\"type\":\"String\",\"semanticLabel\":\"title\"}," +
                "{\"name\":\"url\",\"type\":\"String\",\"semanticLabel\":\"url\"}]}");
            File.WriteAllText(Path.Combine(workspace, "02-enhance", "enhanced-items.jsonl"),
                "{\"id\":\"a\",\"title\":\"t\",\"url\":\"https://x\"}\n");

            // Seed stale artifacts from a prior (Node) run.
            var staleTs = Path.Combine(stepOutDir, "schema.ts");
            var staleSchema = Path.Combine(stepOutDir, "connector-schema.json");
            var staleVal = Path.Combine(stepOutDir, "schema-validation.json");
            File.WriteAllText(staleTs, "// stale Node output\nexport const x = 1;\n");
            File.WriteAllText(staleSchema, "{\"stale\":true}");
            File.WriteAllText(staleVal, "{\"stale\":true}");

            var job = new JobRecord
            {
                Id = "job-1",
                CreatedAt = "2025-01-01T00:00:00Z",
                UpdatedAt = "2025-01-01T00:00:00Z",
                Status = JobStatus.Pending,
                Workspace = workspace,
                Config = new JobConfig
                {
                    Dataset = workspace,
                    Description = "test",
                    Count = 10,
                    ConnectorId = "c",
                    ConnectorName = "C",
                    DeployTarget = DeployTarget.AzureFunctions,
                    Mode = RunMode.Build,
                    AclMode = AclMode.Everyone,
                },
                Steps = new Dictionary<StepName, StepRecord>(),
            };
            var ctx = new StepRunContext { Job = job, StepOutDir = stepOutDir };

            var result = await new Step3SchemaEngine().RunAsync(ctx);

            Assert.Equal(StepStatus.Done, result.Status);
            // Stale schema.ts is GONE so Step 4 can't pick it up.
            Assert.False(File.Exists(staleTs));
            // Fresh artifacts written (not the stale content).
            var schemaText = File.ReadAllText(staleSchema);
            Assert.DoesNotContain("\"stale\":true", schemaText);
        }
        finally
        {
            JobStore.SetWorkspaceRootForTesting(null);
            try { Directory.Delete(root, true); } catch { /* swallow */ }
        }
    }
}
