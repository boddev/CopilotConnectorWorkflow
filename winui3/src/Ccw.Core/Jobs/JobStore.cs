// Job persistence ported from src/jobs.ts.
//
// Differences from the TS reference (intentional, documented in plan §3 + §5):
//   - WORKSPACE_ROOT is %LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs (per-user,
//     survives MSIX reinstalls). TS uses repo-relative workspace/jobs.
//   - JobConfig is an init-only record; applyPipelineDetection returns a NEW config
//     rather than mutating in-place. CreateJob composes that new config into the
//     persisted JobRecord.
//   - Single writer for job.json (Opus Q4): Ccw.Core owns ALL job.json IO. Step engines
//     called via Node shim must NEVER touch job.json directly.

using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ccw.Core.Dataset;
using Ccw.Core.Hashing;
using Ccw.Core.Json;
using Ccw.Core.Models;
using Ccw.Core.Util;

namespace Ccw.Core.Jobs;

public static class JobStore
{
    private static string? s_workspaceRootOverride;

    /// <summary>For tests/diagnostics; pass null to reset.</summary>
    public static void SetWorkspaceRootForTesting(string? path) => s_workspaceRootOverride = path;

    /// <summary>%LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\jobs</summary>
    public static string WorkspaceRoot()
    {
        var root = s_workspaceRootOverride
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CopilotConnectorWorkflow", "workspace", "jobs");
        Directory.CreateDirectory(root);
        return root;
    }

    public static string JobDir(string jobId) => Path.Combine(WorkspaceRoot(), jobId);

    public static string NewJobId() => NewJobId(DateTime.Now);

    internal static string NewJobId(DateTime now)
    {
        var stamp = $"{now.Year:D4}{now.Month:D2}{now.Day:D2}-{now.Hour:D2}{now.Minute:D2}{now.Second:D2}";
        var bytes = RandomNumberGenerator.GetBytes(3);
        var suffix = Convert.ToHexStringLower(bytes);
        return $"{stamp}-{suffix}";
    }

    public static JobRecord CreateJob(JobConfig config)
    {
        config = ApplyConfigDefaults(config);
        ValidateConfig(config);
        config = ApplyPipelineDetection(config);
        var id = NewJobId();
        var dir = JobDir(id);
        Directory.CreateDirectory(dir);
        var now = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);

        var steps = new Dictionary<StepName, StepRecord>();
        foreach (var name in StepNames.All)
        {
            steps[name] = new StepRecord { Name = name, Status = StepStatus.Pending };
        }

        string? datasetHash = null;
        try
        {
            datasetHash = CanonicalHash.HashDataset(config.Dataset, config.Extensions).Hash;
        }
        catch
        {
            // dataset hash is best-effort at job creation; jobs created before hashing was added still work.
        }

        var job = new JobRecord
        {
            Id = id,
            CreatedAt = now,
            UpdatedAt = now,
            Status = JobStatus.Pending,
            Config = config,
            Steps = steps,
            Workspace = dir,
            DatasetHash = datasetHash,
        };
        job = SaveJob(job);

        if (config.PipelineDetection is not null)
        {
            var auditDir = Path.Combine(dir, "00-shape-detect");
            Directory.CreateDirectory(auditDir);
            File.WriteAllText(
                Path.Combine(auditDir, "shape-detect.json"),
                JsonSerializer.Serialize(config.PipelineDetection, CcwJsonOptions.Pretty));
        }

        return job;
    }

    internal static JobConfig ApplyPipelineDetection(JobConfig config)
    {
        if (config.ForceEnhance == true)
        {
            if (config.NoEnhance == true)
                throw new InvalidOperationException("forceEnhance and noEnhance are mutually exclusive");
            return config with { NoEnhance = false };
        }
        if (config.NoEnhance.HasValue) return config;
        if (config.AutoDetectPipeline != true) return config;

        DatasetShapeDetection detection;
        try
        {
            detection = DatasetShapeDetector.DetectDatasetShape(config.Dataset, config.Extensions);
        }
        catch (Exception ex)
        {
            return config with
            {
                PipelineDetection = new PipelineDetection
                {
                    Recommendation = PipelineRecommendation.Enhance,
                    AppliedNoEnhance = false,
                    RecordsSampled = 0,
                    FilesScanned = 0,
                    DistinctSchemas = 0,
                    DominantSchemaShare = 0,
                    DominantSchema = [],
                    TextRichFields = [],
                    Reason = $"detection failed: {ex.Message}",
                },
            };
        }

        var appliedNoEnhance = detection.Recommendation == PipelineRecommendation.Identity;
        var newDetection = new PipelineDetection
        {
            Recommendation = detection.Recommendation,
            AppliedNoEnhance = appliedNoEnhance,
            RecordsSampled = detection.RecordsSampled,
            FilesScanned = detection.FilesScanned,
            DistinctSchemas = detection.DistinctSchemas,
            DominantSchemaShare = detection.DominantSchemaShare,
            DominantSchema = detection.DominantSchema,
            TextRichFields = detection.TextRichFields,
            Reason = detection.Reason,
        };
        return appliedNoEnhance
            ? config with { NoEnhance = true, PipelineDetection = newDetection }
            : config with { PipelineDetection = newDetection };
    }

    public static JobRecord EnsureEvalSetHash(JobRecord job)
    {
        if (!string.IsNullOrEmpty(job.EvalSetHash)) return job;
        var sidecar = Path.Combine(job.Workspace, "01-evalgen", "eval.evalgen.json");
        if (!File.Exists(sidecar)) return job;
        var hash = CanonicalHash.HashEvalSetFile(sidecar).Hash;
        return SaveJob(job with { EvalSetHash = hash });
    }

    /// <summary>Persist a job record, stamping UpdatedAt at write time, and
    /// return the persisted record so the orchestrator can replace its
    /// in-memory copy (GPT Phase 2 BLOCKER #4 — immutable records make
    /// void-returning save a silent staleness trap).</summary>
    public static JobRecord SaveJob(JobRecord job)
    {
        var updated = job with
        {
            UpdatedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
        };
        var file = Path.Combine(updated.Workspace, "job.json");
        File.WriteAllText(file, JsonSerializer.Serialize(updated, CcwJsonOptions.Pretty));
        return updated;
    }

    public static JobRecord? LoadJob(string jobId)
    {
        var file = Path.Combine(JobDir(jobId), "job.json");
        if (!File.Exists(file)) return null;
        try
        {
            var json = File.ReadAllText(file);
            return JsonSerializer.Deserialize<JobRecord>(json, CcwJsonOptions.Pretty);
        }
        catch (Exception ex)
        {
            AppLogger.Log($"Skipping unreadable job manifest: {file}", ex);
            return null;
        }
    }

    public static IReadOnlyList<JobRecord> ListJobs()
    {
        try
        {
            var root = WorkspaceRoot();
            if (!Directory.Exists(root)) return [];
            var jobs = new List<JobRecord>();
            foreach (var dir in Directory.GetDirectories(root))
            {
                try
                {
                    var id = Path.GetFileName(dir);
                    var job = LoadJob(id);
                    if (job is not null) jobs.Add(job);
                }
                catch (Exception ex)
                {
                    AppLogger.Log($"Skipping unreadable job directory: {dir}", ex);
                }
            }
            // Reverse-chronological by createdAt (ISO-8601 strings sort lexically = chronologically when same precision).
            jobs.Sort((a, b) => string.CompareOrdinal(b.CreatedAt, a.CreatedAt));
            return jobs;
        }
        catch (Exception ex)
        {
            AppLogger.Log("Failed to enumerate jobs", ex);
            return [];
        }
    }

    private static readonly Regex s_connectorIdRe = new("^[a-zA-Z0-9]{3,128}$", RegexOptions.Compiled);

    /// <summary>
    /// Fill in the connector fields the workflow can derive on its own so the GUI can
    /// present them as optional. Description, connectorId, and connectorName are
    /// auto-generated from the dataset folder name when the caller leaves them blank
    /// (or supplies a value too short / malformed to pass validation). Explicit, valid
    /// values are preserved untouched — this only fills gaps, so existing callers and
    /// fixtures that pass all fields are unaffected (no parity drift). Mirrors the TS
    /// applyConfigDefaults in src/jobs.ts. JobConfig is immutable, so a new config is
    /// returned via `with`.
    /// </summary>
    public static JobConfig ApplyConfigDefaults(JobConfig config)
    {
        var datasetBase = string.IsNullOrEmpty(config.Dataset)
            ? ""
            : Path.GetFileName(config.Dataset.TrimEnd('\\', '/'));

        var connectorName = config.ConnectorName;
        if (string.IsNullOrWhiteSpace(connectorName))
        {
            var pretty = Regex.Replace(datasetBase, "[._-]+", " ");
            pretty = Regex.Replace(pretty, "\\s+", " ").Trim();
            connectorName = pretty.Length > 0 ? ToTitleCase(pretty) : "My Connector";
        }

        var connectorId = config.ConnectorId;
        if (string.IsNullOrEmpty(connectorId) || !s_connectorIdRe.IsMatch(connectorId))
        {
            var baseId = FirstNonEmpty(Alnum(config.ConnectorId), Alnum(connectorName), Alnum(datasetBase))
                .ToLowerInvariant();
            if (baseId.Length < 3) baseId += "connector";
            connectorId = baseId.Length > 128 ? baseId[..128] : baseId;
        }

        var description = config.Description;
        if (string.IsNullOrEmpty(description) || description.Trim().Length < 10)
        {
            var subject = !string.IsNullOrEmpty(connectorName) ? connectorName
                : !string.IsNullOrEmpty(connectorId) ? connectorId
                : "this dataset";
            description = $"Copilot connector for the {subject} dataset, auto-generated by the Copilot Connector Workflow.";
        }

        return config with
        {
            ConnectorName = connectorName,
            ConnectorId = connectorId,
            Description = description,
        };
    }

    private static string Alnum(string? s) => Regex.Replace(s ?? "", "[^a-zA-Z0-9]", "");

    private static string ToTitleCase(string s) =>
        Regex.Replace(s, @"\w\S*", m => char.ToUpperInvariant(m.Value[0]) + m.Value[1..]);

    private static string FirstNonEmpty(params string[] values)
    {
        foreach (var v in values)
            if (!string.IsNullOrEmpty(v)) return v;
        return "";
    }

    public static void ValidateConfig(JobConfig c)
    {
        if (string.IsNullOrEmpty(c.Dataset)) throw new ArgumentException("dataset is required");
        if (!File.Exists(c.Dataset) && !Directory.Exists(c.Dataset))
            throw new FileNotFoundException($"dataset not found: {c.Dataset}");
        if (string.IsNullOrEmpty(c.Description) || c.Description.Length < 10)
            throw new ArgumentException("description must be at least 10 characters");
        if (c.Count < 5 || c.Count > 200) throw new ArgumentException("count must be 5-200");
        if (string.IsNullOrEmpty(c.ConnectorId) || !s_connectorIdRe.IsMatch(c.ConnectorId))
            throw new ArgumentException("connectorId must be 3-128 alphanumeric characters (no symbols)");
        if (string.IsNullOrEmpty(c.ConnectorName)) throw new ArgumentException("connectorName is required");

        if (c.Mode == RunMode.Provision)
        {
            if (string.IsNullOrEmpty(c.Auth?.TenantId)) throw new ArgumentException("provision mode requires auth.tenantId");
            if (string.IsNullOrEmpty(c.Auth?.ClientId)) throw new ArgumentException("provision mode requires auth.clientId");
            if (c.Auth.UseManagedIdentity != true && string.IsNullOrEmpty(c.Auth.ClientSecretEnvVar))
                throw new ArgumentException("provision mode requires either useManagedIdentity=true or clientSecretEnvVar");
        }

        if (!string.IsNullOrEmpty(c.ReuseEvalFromJobId) && !string.IsNullOrEmpty(c.EvalSetPath))
            throw new ArgumentException("reuseEvalFromJobId and evalSetPath are mutually exclusive");
        if (!string.IsNullOrEmpty(c.EvalSetPath) && !File.Exists(c.EvalSetPath) && !Directory.Exists(c.EvalSetPath))
            throw new FileNotFoundException($"evalSetPath does not exist: {c.EvalSetPath}");

        if (c.Score?.JudgeProvider is JudgeProvider provider)
        {
            if (provider == JudgeProvider.WorkIQ && string.IsNullOrEmpty(c.Score.JudgeAgentId))
                throw new ArgumentException("score.judgeAgentId is required when score.judgeProvider is 'workiq'");
        }
    }
}
