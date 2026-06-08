// Port of TypeScript interfaces from src/types.ts.
//
// Records mirror TS interface shape. JsonPropertyOrder matches the TS
// declaration order so JSON output stays byte-equivalent to a Node round-trip.
// Optionals (TS `?` properties) become nullable C# properties with
// JsonIgnoreCondition.WhenWritingNull applied at the serializer level
// (see Json/CcwJsonContext.cs) — this matches JSON.stringify omitting
// undefined fields entirely instead of writing `null`.
//
// PARITY DISCIPLINE (Opus B2/B3/B4, Opus I8):
//   - Property order MUST match TS declaration order. Changing order
//     changes JSON output bytes and breaks canonical hashes.
//   - Field name casing is camelCase to match TS (achieved via
//     JsonNamingPolicy.CamelCase on the serializer; record member names
//     in PascalCase per .NET convention).
//   - `Ccw.Core.*` types are the firewall against transitive type leakage
//     from `EvalToolkit.Jobs`/`EvalToolkit.Core` — never alias upstream
//     Job models.

using System.Text.Json.Serialization;

namespace Ccw.Core.Models;

/// <summary>Static collection of all step names in execution order. TS: <c>ALL_STEPS</c>.</summary>
public static class StepNames
{
    public static readonly IReadOnlyList<StepName> All =
    [
        StepName.EvalGen,
        StepName.Enhance,
        StepName.Schema,
        StepName.Connector,
        StepName.Deploy,
        StepName.Score,
    ];
}

/// <summary>TS: <c>AuthConfig</c>.</summary>
public sealed record AuthConfig
{
    [JsonPropertyOrder(0)] public string? TenantId { get; init; }
    [JsonPropertyOrder(1)] public string? ClientId { get; init; }

    /// <summary>Build mode: secret/managed-identity blank is OK. Provision mode: required.</summary>
    [JsonPropertyOrder(2)] public string? ClientSecretEnvVar { get; init; }

    [JsonPropertyOrder(3)] public bool? UseManagedIdentity { get; init; }
}

/// <summary>TS: <c>ScoreConfig</c>.</summary>
public sealed record ScoreConfig
{
    /// <summary>Judge provider. Defaults to <c>github-copilot</c>.</summary>
    [JsonPropertyOrder(0)] public JudgeProvider? JudgeProvider { get; init; }

    /// <summary>Required when judgeProvider is <c>workiq</c>. The eval-judge declarative agent id.</summary>
    [JsonPropertyOrder(1)] public string? JudgeAgentId { get; init; }

    /// <summary>M365 candidate agent id (the agent under evaluation). Required in provision mode.
    /// Discovered/persisted by Step 5; can be supplied here for an existing agent.</summary>
    [JsonPropertyOrder(2)] public string? CandidateAgentId { get; init; }

    /// <summary>Minimum wait floor (seconds) for indexing readiness gate. Default 300 (5 min).</summary>
    [JsonPropertyOrder(3)] public int? IndexReadyMinSeconds { get; init; }

    /// <summary>Maximum wait ceiling (seconds) for indexing readiness gate. Default 5400 (90 min).</summary>
    [JsonPropertyOrder(4)] public int? IndexReadyMaxSeconds { get; init; }

    /// <summary>Max retries per invalid response row before failing the job. Default 3.</summary>
    [JsonPropertyOrder(5)] public int? InvalidRowRetryLimit { get; init; }

    /// <summary>If true, Step 5 will NOT try to auto-publish the agent via <c>atk install</c>;
    /// operator must provide candidateAgentId out-of-band.</summary>
    [JsonPropertyOrder(6)] public bool? SkipAgentPublish { get; init; }

    /// <summary>Comma-separated evaluator names or "all". Defaults to eval-score's "Relevance,Coherence".</summary>
    [JsonPropertyOrder(7)] public string? Evaluators { get; init; }

    /// <summary>Minimum elapsed minutes between Step 5 ingestEndedAt and Step 6 start.
    /// Step 6 sleeps if under threshold. Default 60. Set 0 to disable.</summary>
    [JsonPropertyOrder(8)] public int? IndexReadySettleMinutes { get; init; }
}

/// <summary>Metadata provenance counts. TS: anonymous nested type in <c>ScoredReport.metadataProvenance</c>.</summary>
public sealed record MetadataProvenance
{
    // BLOCKER fix from GPT review: TS `number` here is a 0..1 fraction
    // (round3(itemsWithSourceTitle / itemCount) in identity-transform.ts),
    // not an integer. Using `int` would silently truncate every
    // metadata-provenance count to 0 on round-trip from a real Node
    // ScoredReport.
    [JsonPropertyOrder(0)] public required double TitleFromSource { get; init; }
    [JsonPropertyOrder(1)] public required double UrlFromSource { get; init; }
    [JsonPropertyOrder(2)] public required double IconUrlFromSource { get; init; }
    [JsonPropertyOrder(3)] public required int SchemaPropertiesPromotedToSearchable { get; init; }
    [JsonPropertyOrder(4)] public required int SchemaPropertiesPromotedToRefinable { get; init; }
}

/// <summary>Deterministic-by-category bucket. TS: value type of <c>ScoredReport.deterministicScore.byCategory</c>.</summary>
public sealed record DeterministicCategoryBucket
{
    [JsonPropertyOrder(0)] public required int Count { get; init; }
    [JsonPropertyOrder(1)] public required double Average { get; init; }
}

/// <summary>Aggregated deterministic score. TS: <c>ScoredReport.deterministicScore</c>.</summary>
public sealed record DeterministicScore
{
    [JsonPropertyOrder(0)] public required double Average { get; init; }
    [JsonPropertyOrder(1)] public required int PassCount { get; init; }
    [JsonPropertyOrder(2)] public required int PartialCount { get; init; }
    [JsonPropertyOrder(3)] public required int FailCount { get; init; }
    [JsonPropertyOrder(4)] public required IDictionary<string, DeterministicCategoryBucket> ByCategory { get; init; }
}

/// <summary>Aggregated semantic score. TS: <c>ScoredReport.semanticScore</c>.</summary>
public sealed record SemanticScore
{
    [JsonPropertyOrder(0)] public required double Average { get; init; }
    [JsonPropertyOrder(1)] public required IDictionary<string, double> ByDimension { get; init; }
}

/// <summary>Per-item deterministic detail. TS: <c>ScoredReport.items[].deterministic</c>.</summary>
public sealed record DeterministicItemScore
{
    [JsonPropertyOrder(0)] public required double Score { get; init; }
    [JsonPropertyOrder(1)] public required DeterministicVerdict Status { get; init; }
    [JsonPropertyOrder(2)] public required int AssertionsPassed { get; init; }
    [JsonPropertyOrder(3)] public required int AssertionsTotal { get; init; }
    [JsonPropertyOrder(4)] public required int FactsPassed { get; init; }
    [JsonPropertyOrder(5)] public required int FactsTotal { get; init; }
}

/// <summary>Per-item semantic detail. TS: <c>ScoredReport.items[].semantic</c>.</summary>
public sealed record SemanticItemScore
{
    [JsonPropertyOrder(0)] public required double Score { get; init; }
    [JsonPropertyOrder(1)] public IDictionary<string, double>? ByDimension { get; init; }
    [JsonPropertyOrder(2)] public string? Rationale { get; init; }
}

/// <summary>One scored-prompt row. TS: <c>ScoredReport.items[]</c>.</summary>
public sealed record ScoredItem
{
    [JsonPropertyOrder(0)] public required string Id { get; init; }
    [JsonPropertyOrder(1)] public required string Prompt { get; init; }
    [JsonPropertyOrder(2)] public required string Expected { get; init; }
    [JsonPropertyOrder(3)] public required string Actual { get; init; }
    [JsonPropertyOrder(4)] public string? Category { get; init; }
    [JsonPropertyOrder(5)] public required DeterministicItemScore Deterministic { get; init; }
    [JsonPropertyOrder(6)] public required SemanticItemScore Semantic { get; init; }
    [JsonPropertyOrder(7)] public bool? Citation { get; init; }
}

/// <summary>Canonical Step 6 scored-report shape, persisted to
/// <c>06-score/agent-response-scores.json</c>. TS: <c>ScoredReport</c>.</summary>
public sealed record ScoredReport
{
    [JsonPropertyOrder(0)] public required string JobId { get; init; }
    [JsonPropertyOrder(1)] public required bool NoEnhance { get; init; }
    [JsonPropertyOrder(2)] public required JudgeProvider JudgeProvider { get; init; }
    [JsonPropertyOrder(3)] public string? JudgeModel { get; init; }
    [JsonPropertyOrder(4)] public string? DatasetHash { get; init; }
    [JsonPropertyOrder(5)] public string? EvalSetHash { get; init; }
    [JsonPropertyOrder(6)] public string? IndexReadyAt { get; init; }
    [JsonPropertyOrder(7)] public required int PromptCount { get; init; }
    [JsonPropertyOrder(8)] public required int ValidPromptCount { get; init; }
    [JsonPropertyOrder(9)] public MetadataProvenance? MetadataProvenance { get; init; }
    [JsonPropertyOrder(10)] public required DeterministicScore DeterministicScore { get; init; }
    [JsonPropertyOrder(11)] public required SemanticScore SemanticScore { get; init; }
    [JsonPropertyOrder(12)] public required double CitationRate { get; init; }
    [JsonPropertyOrder(13)] public required int RetryCount { get; init; }
    [JsonPropertyOrder(14)] public required int RateLimitCount { get; init; }
    [JsonPropertyOrder(15)] public required IReadOnlyList<ScoredItem> Items { get; init; }
}

/// <summary>One text-rich field entry. TS: <c>PipelineDetection.textRichFields[]</c>.</summary>
public sealed record TextRichField
{
    [JsonPropertyOrder(0)] public required string Field { get; init; }
    [JsonPropertyOrder(1)] public required double ProseShare { get; init; }
    [JsonPropertyOrder(2)] public required double AverageLength { get; init; }
    [JsonPropertyOrder(3)] public required string SampleValue { get; init; }
}

/// <summary>Result of createJob's optional dataset shape detection.
/// Persisted to <c>job.config.pipelineDetection</c> for auditability.
/// See <c>src/dataset-shape-detect.ts</c> for the classifier.
/// TS: <c>PipelineDetection</c>.</summary>
public sealed record PipelineDetection
{
    /// <summary><c>identity</c> = recommend skip enhance; <c>enhance</c> = recommend enhance; <c>tie</c> = no recommendation.</summary>
    [JsonPropertyOrder(0)] public required PipelineRecommendation Recommendation { get; init; }

    /// <summary>Whether createJob actually flipped noEnhance based on this detection.</summary>
    [JsonPropertyOrder(1)] public required bool AppliedNoEnhance { get; init; }

    [JsonPropertyOrder(2)] public required int RecordsSampled { get; init; }
    [JsonPropertyOrder(3)] public required int FilesScanned { get; init; }
    [JsonPropertyOrder(4)] public required int DistinctSchemas { get; init; }
    [JsonPropertyOrder(5)] public required double DominantSchemaShare { get; init; }
    [JsonPropertyOrder(6)] public required IReadOnlyList<string> DominantSchema { get; init; }
    [JsonPropertyOrder(7)] public required IReadOnlyList<TextRichField> TextRichFields { get; init; }

    /// <summary>Human-readable explanation.</summary>
    [JsonPropertyOrder(8)] public required string Reason { get; init; }
}

/// <summary>Job configuration. TS: <c>JobConfig</c>.</summary>
public sealed record JobConfig
{
    /// <summary>Dataset folder or file.</summary>
    [JsonPropertyOrder(0)] public required string Dataset { get; init; }

    /// <summary>Human description used by eval-gen and as connector description seed.</summary>
    [JsonPropertyOrder(1)] public required string Description { get; init; }

    /// <summary>Number of eval prompts to generate (10-50).</summary>
    [JsonPropertyOrder(2)] public required int Count { get; init; }

    /// <summary>File extensions for eval-gen when dataset is a folder.</summary>
    [JsonPropertyOrder(3)] public IReadOnlyList<string>? Extensions { get; init; }

    /// <summary>Connection ID (3-128 alphanumeric).</summary>
    [JsonPropertyOrder(4)] public required string ConnectorId { get; init; }

    /// <summary>Connector display name shown in M365 Admin Center.</summary>
    [JsonPropertyOrder(5)] public required string ConnectorName { get; init; }

    /// <summary>Optional richer connector description. Falls back to job.description.</summary>
    [JsonPropertyOrder(6)] public string? ConnectorDescription { get; init; }

    /// <summary>Deploy artifacts to emit.</summary>
    [JsonPropertyOrder(7)] public required DeployTarget DeployTarget { get; init; }

    /// <summary><c>build</c> = artifacts only; <c>provision</c> = full lifecycle + scoring.</summary>
    [JsonPropertyOrder(8)] public required RunMode Mode { get; init; }

    /// <summary>ACL strategy for generated items.</summary>
    [JsonPropertyOrder(9)] public required AclMode AclMode { get; init; }

    /// <summary>Authentication for provision mode.</summary>
    [JsonPropertyOrder(10)] public AuthConfig? Auth { get; init; }

    /// <summary>When true, Step 2 runs the identity-but-shape-aware transform instead of the
    /// data enhancer. The schema is still inferred from the source data shape;
    /// properties are 1:1 with sanitized source columns (no synthetic enrichment,
    /// no domain inference, no long-form pivot, no prompt-example folding).
    /// Steps 3-6 are unchanged.</summary>
    [JsonPropertyOrder(11)] public bool? NoEnhance { get; init; }

    /// <summary>Dataset-shape auto-detection. ON by default. When true,
    /// createJob runs the dataset shape detector and may flip noEnhance=true
    /// for text-rich single-schema datasets.</summary>
    [JsonPropertyOrder(12)] public bool? AutoDetectPipeline { get; init; }

    /// <summary>When true, the user explicitly wants the enhancer regardless of any
    /// auto-detection signal. Mutually exclusive with noEnhance. Suppresses autoDetectPipeline.</summary>
    [JsonPropertyOrder(13)] public bool? ForceEnhance { get; init; }

    /// <summary>Populated by createJob when autoDetectPipeline ran.</summary>
    [JsonPropertyOrder(14)] public PipelineDetection? PipelineDetection { get; init; }

    /// <summary>Reuse the eval set from this previously-completed job (Step 1 copies its
    /// eval.csv / eval.evalgen.json verbatim). Required to pair two runs for
    /// post-hoc comparison so they share the same evalSetHash.</summary>
    [JsonPropertyOrder(15)] public string? ReuseEvalFromJobId { get; init; }

    /// <summary>Reuse the eval set from this explicit path (must contain eval.csv +
    /// eval.evalgen.json). Mutually exclusive with reuseEvalFromJobId.</summary>
    [JsonPropertyOrder(16)] public string? EvalSetPath { get; init; }

    /// <summary>Step 6 scoring configuration.</summary>
    [JsonPropertyOrder(17)] public ScoreConfig? Score { get; init; }

    /// <summary>Declarative agent display name. Defaults to "${connectorName} Assistant".</summary>
    [JsonPropertyOrder(18)] public string? AgentName { get; init; }

    /// <summary>Declarative agent system instructions. Defaults to auto-generated from description.</summary>
    [JsonPropertyOrder(19)] public string? AgentInstructions { get; init; }

    /// <summary>Base URL prefix for source items (e.g. <c>https://wiki.example.com</c>).
    /// When set, the data-enhancer uses this prefix for generated item URLs and
    /// the connector's connection model includes an active urlToItemResolver,
    /// enabling URL unfurling in Teams/Copilot.</summary>
    [JsonPropertyOrder(20)] public string? UrlPrefix { get; init; }
}

/// <summary>Per-step record. TS: <c>StepRecord</c>.</summary>
public sealed record StepRecord
{
    [JsonPropertyOrder(0)] public required StepName Name { get; init; }
    [JsonPropertyOrder(1)] public required StepStatus Status { get; init; }
    [JsonPropertyOrder(2)] public string? StartedAt { get; init; }
    [JsonPropertyOrder(3)] public string? EndedAt { get; init; }
    [JsonPropertyOrder(4)] public int? ExitCode { get; init; }

    /// <summary>Hash of inputs (config + upstream artifact hashes + tool versions).</summary>
    [JsonPropertyOrder(5)] public string? InputsHash { get; init; }

    /// <summary>Hashes of produced output files keyed by relative path.</summary>
    [JsonPropertyOrder(6)] public IDictionary<string, string>? Outputs { get; init; }

    [JsonPropertyOrder(7)] public IReadOnlyList<string>? Artifacts { get; init; }
    [JsonPropertyOrder(8)] public IReadOnlyList<string>? Diagnostics { get; init; }
    [JsonPropertyOrder(9)] public string? ErrorMessage { get; init; }
}

/// <summary>Top-level job record persisted to <c>job.json</c>. TS: <c>JobRecord</c>.</summary>
public sealed record JobRecord
{
    [JsonPropertyOrder(0)] public required string Id { get; init; }
    [JsonPropertyOrder(1)] public required string CreatedAt { get; init; }
    [JsonPropertyOrder(2)] public required string UpdatedAt { get; init; }
    [JsonPropertyOrder(3)] public required JobStatus Status { get; init; }
    [JsonPropertyOrder(4)] public required JobConfig Config { get; init; }

    /// <summary>Keyed by <see cref="StepName"/> serialized as its TS string value.
    /// Insertion order matches <see cref="StepNames.All"/>.</summary>
    [JsonPropertyOrder(5)] public required IDictionary<StepName, StepRecord> Steps { get; init; }

    /// <summary>Workspace directory absolute path.</summary>
    [JsonPropertyOrder(6)] public required string Workspace { get; init; }

    /// <summary>Canonical dataset hash (<c>sha256:&lt;hex&gt;</c>). Populated when the job
    /// is created and on first read for legacy jobs.</summary>
    [JsonPropertyOrder(7)] public string? DatasetHash { get; init; }

    /// <summary>Canonical eval-set hash (<c>sha256:&lt;hex&gt;</c>). Populated after Step 1
    /// emits eval.evalgen.json.</summary>
    [JsonPropertyOrder(8)] public string? EvalSetHash { get; init; }
}
