// Port of TypeScript literal-union types in src/types.ts.
//
// Wire format MUST match the Node CCW byte-for-byte (consumed by jobs.ts
// round-trips, canonical-hash inputs, and the parity test harness).
// JsonStringEnumMemberName maps each enum member to its TS string value
// for hyphenated / camelCased variants. The unhyphenated values still get
// an explicit attribute for stability against future renames.
//
// IMPORTANT (parity contract): never add or rename a member without updating
// the corresponding TS literal union in src/types.ts and the parity fixtures
// under tests/Ccw.Core.Tests/Fixtures/.

using System.Text.Json.Serialization;

namespace Ccw.Core.Models;

/// <summary>Pipeline step name. TS: <c>StepName</c>.</summary>
public enum StepName
{
    [JsonStringEnumMemberName("evalgen")] EvalGen,
    [JsonStringEnumMemberName("enhance")] Enhance,
    [JsonStringEnumMemberName("schema")] Schema,
    [JsonStringEnumMemberName("connector")] Connector,
    [JsonStringEnumMemberName("deploy")] Deploy,
    [JsonStringEnumMemberName("score")] Score,
}

/// <summary>Per-step state. TS: <c>StepStatus</c>.</summary>
public enum StepStatus
{
    [JsonStringEnumMemberName("pending")] Pending,
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
    [JsonStringEnumMemberName("skipped")] Skipped,
}

/// <summary>Job-level state. TS: <c>JobStatus</c>.</summary>
public enum JobStatus
{
    [JsonStringEnumMemberName("pending")] Pending,
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
    [JsonStringEnumMemberName("cancelled")] Cancelled,
}

/// <summary>Run mode. TS: <c>RunMode</c>.</summary>
public enum RunMode
{
    [JsonStringEnumMemberName("build")] Build,
    [JsonStringEnumMemberName("provision")] Provision,
}

/// <summary>Deploy target. TS: <c>DeployTarget</c>.</summary>
public enum DeployTarget
{
    [JsonStringEnumMemberName("azure-functions")] AzureFunctions,
    [JsonStringEnumMemberName("azure-container-apps")] AzureContainerApps,
    [JsonStringEnumMemberName("both")] Both,
    [JsonStringEnumMemberName("local")] Local,
}

/// <summary>Step 6 judge. TS: <c>JudgeProvider</c>.</summary>
public enum JudgeProvider
{
    [JsonStringEnumMemberName("github-copilot")] GitHubCopilot,
    [JsonStringEnumMemberName("workiq")] WorkIQ,
}

/// <summary>ACL strategy. TS: inline literal on <c>JobConfig.aclMode</c>.</summary>
public enum AclMode
{
    [JsonStringEnumMemberName("everyone")] Everyone,
    [JsonStringEnumMemberName("everyoneExceptGuests")] EveryoneExceptGuests,
    [JsonStringEnumMemberName("none")] None,
}

/// <summary>Auto-detect recommendation. TS: <c>PipelineDetection.recommendation</c>.</summary>
public enum PipelineRecommendation
{
    [JsonStringEnumMemberName("identity")] Identity,
    [JsonStringEnumMemberName("enhance")] Enhance,
    [JsonStringEnumMemberName("tie")] Tie,
}

/// <summary>Per-item deterministic verdict. TS: <c>ScoredReport.items[].deterministic.status</c>.</summary>
public enum DeterministicVerdict
{
    [JsonStringEnumMemberName("pass")] Pass,
    [JsonStringEnumMemberName("partial")] Partial,
    [JsonStringEnumMemberName("fail")] Fail,
}
