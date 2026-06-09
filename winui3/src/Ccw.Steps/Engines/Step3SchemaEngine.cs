// Step 3 - schema. Pure C# (no Node, no subprocess). Reads the upstream
// schema suggestion from Step 2, hardens it via SchemaValidator, runs
// item-sample validation, and writes the canonical schema + validation
// report artifacts.
//
// Inputs:
//   - {workspace}/02-enhance/schema-suggestion.json
//       Shape: { "properties": [ { name, type, isSearchable, ... }, ... ] }
//   - {workspace}/02-enhance/enhanced-items.jsonl
//       Item sample drawn for sample validation (200 lines).
//
// Outputs (written to context.StepOutDir = {workspace}/03-schema):
//   - 03-schema/connector-schema.json   (hardened Graph schema, canonical JSON)
//   - 03-schema/schema-validation.json  (issues array + blockingCount,
//                                        deduped on (severity, normalized-message))
//   The Node version also emits schema.ts (TypeScript module) — that's
//   tracked as a follow-up; downstream connector rendering in Step 4
//   reads connector-schema.json today.
//
// Status:
//   - Done   : no issue with severity == "error".
//   - Failed : one or more errors (writes validation.json regardless so
//              the user can inspect what failed).
// Diagnostics carry every issue (warnings + errors) formatted as
// "[severity] message".

using System.Globalization;
using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using Ccw.Core.Models;
using Ccw.Core.Util;
using Ccw.Steps.Schema;

namespace Ccw.Steps.Engines;

public sealed class Step3SchemaEngine : IStepEngine
{
    private static readonly JsonSerializerOptions s_jsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public StepName Step => StepName.Schema;

    public Task<StepRunResult> RunAsync(StepRunContext context, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        Directory.CreateDirectory(context.StepOutDir);

        // GPT Phase-2 closure BLOCKER #3: pre-clean stale outputs so a
        // re-run after a previous (possibly Node) run doesn't leave Step 4
        // consuming a schema.ts file that's out-of-sync with the new
        // connector-schema.json this engine is about to write.
        foreach (var stale in new[] { "connector-schema.json", "schema-validation.json", "schema.ts" })
        {
            var p = Path.Combine(context.StepOutDir, stale);
            if (File.Exists(p))
            {
                try { File.Delete(p); } catch (IOException) { /* best effort */ }
            }
        }

        var startedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);

        var enhanceDir = Path.Combine(context.Job.Workspace, "02-enhance");
        var suggestionPath = Path.Combine(enhanceDir, "schema-suggestion.json");
        var itemsPath = Path.Combine(enhanceDir, "enhanced-items.jsonl");

        if (!File.Exists(suggestionPath))
        {
            return Task.FromResult(Fail(startedAt, $"missing input: {suggestionPath}"));
        }
        if (!File.Exists(itemsPath))
        {
            return Task.FromResult(Fail(startedAt, $"missing input: {itemsPath}"));
        }

        IReadOnlyList<JsonElement> suggestionProps;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(suggestionPath));
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("properties", out var propsElem)
                || propsElem.ValueKind != JsonValueKind.Array)
            {
                return Task.FromResult(Fail(startedAt, $"{suggestionPath}: missing 'properties' array"));
            }
            suggestionProps = propsElem.EnumerateArray().Select(e => e.Clone()).ToList();
        }
        catch (JsonException ex)
        {
            return Task.FromResult(Fail(startedAt, $"{suggestionPath}: invalid JSON ({ex.Message})"));
        }

        var schema = SchemaValidator.HardenSchema(suggestionProps);
        var schemaIssues = SchemaValidator.ValidateSchema(schema);
        var sampleIssues = SchemaValidator.ValidateItemSample(itemsPath, schema, sampleSize: 200);

        var allIssues = new List<ValidationIssue>(schemaIssues.Count + sampleIssues.Count);
        allIssues.AddRange(schemaIssues);
        allIssues.AddRange(sampleIssues);
        var blocking = allIssues.Count(i => string.Equals(i.Severity, "error", StringComparison.Ordinal));

        var schemaJsonPath = Path.Combine(context.StepOutDir, "connector-schema.json");
        File.WriteAllText(schemaJsonPath, JsonSerializer.Serialize(schema, s_jsonOptions));

        var validationPath = Path.Combine(context.StepOutDir, "schema-validation.json");
        File.WriteAllText(validationPath, JsonSerializer.Serialize(new
        {
            issues = allIssues.Select(i => new { severity = i.Severity, message = i.Message }).ToList(),
            blockingCount = blocking,
        }, s_jsonOptions));

        var endedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);

        var artifacts = new List<StepArtifact>
        {
            BuildArtifact(context.Job.Workspace, schemaJsonPath, role: "connectorSchema"),
            BuildArtifact(context.Job.Workspace, validationPath, role: "schemaValidation"),
        };

        var diagnostics = allIssues
            .Select(i => string.Create(CultureInfo.InvariantCulture, $"[{i.Severity}] {i.Message}"))
            .ToList();

        var status = blocking == 0 ? StepStatus.Done : StepStatus.Failed;

        return Task.FromResult(new StepRunResult
        {
            Status = status,
            ExitCode = status == StepStatus.Done ? 0 : 1,
            StartedAt = startedAt,
            EndedAt = endedAt,
            Artifacts = artifacts,
            Diagnostics = diagnostics.Count > 0 ? diagnostics : null,
            ErrorMessage = status == StepStatus.Failed
                ? string.Create(CultureInfo.InvariantCulture, $"schema validation failed: {blocking} blocking issue(s)")
                : null,
        });
    }

    private static StepArtifact BuildArtifact(string workspaceRoot, string absPath, string? role)
    {
        var rel = Path.GetRelativePath(workspaceRoot, absPath).Replace('\\', '/');
        var info = new FileInfo(absPath);
        return new StepArtifact
        {
            Path = rel,
            Sha256 = HashHelpers.FileHash(absPath),
            Bytes = info.Length,
            Role = role,
        };
    }

    private static StepRunResult Fail(string startedAt, string message) => new()
    {
        Status = StepStatus.Failed,
        ExitCode = 1,
        StartedAt = startedAt,
        EndedAt = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
        Artifacts = [],
        ErrorMessage = message,
    };
}
