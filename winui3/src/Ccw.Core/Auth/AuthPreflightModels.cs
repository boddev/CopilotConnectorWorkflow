namespace Ccw.Core.Auth;

/// <summary>Status of an individual auth-preflight check.
/// Wire-compat with Node <c>AuthCheckStatus</c> in <c>src/auth-preflight.ts</c>:
/// emitted as lowercase strings (<c>"passed" | "failed" | "skipped"</c>) via
/// the converter in <see cref="AuthPreflightJson"/>.</summary>
public enum AuthCheckStatus
{
    Passed,
    Failed,
    Skipped,
}

/// <summary>One row in an <see cref="AuthPreflightResult"/>. Property names
/// and the lowercase status match the Node version byte-for-byte.</summary>
public sealed record AuthPreflightCheck
{
    public required string Name { get; init; }
    public required AuthCheckStatus Status { get; init; }
    public required string Message { get; init; }
}

/// <summary>Top-level preflight result mirroring Node's
/// <c>AuthPreflightResult</c>: <c>{ passed: bool, checks: [...] }</c>.</summary>
public sealed record AuthPreflightResult
{
    public required bool Passed { get; init; }
    public required IReadOnlyList<AuthPreflightCheck> Checks { get; init; }
}

/// <summary>Options for <see cref="AuthPreflightRunner.RunAsync"/>. Mirrors the
/// Node <c>AuthPreflightOptions</c> field names for parity with users coming
/// from the Node CLI. Optional fields default to "skip" — the Node version
/// gates each check independently on its own flag set.</summary>
public sealed record AuthPreflightOptions
{
    public string? TenantId { get; init; }
    public string? ClientId { get; init; }

    /// <summary>Name of the env var whose value is the client secret. We never
    /// take the secret directly — the Node version reads <c>process.env[name]</c>
    /// at call-site so the secret never appears in argv/logs; we follow the
    /// same discipline via <see cref="System.Environment.GetEnvironmentVariable(string)"/>.</summary>
    public string? ClientSecretEnvVar { get; init; }

    public bool UseManagedIdentity { get; init; }
    public bool RunGraph { get; init; }
    public bool RunWorkIq { get; init; }
    public bool RunEvalScoreA2A { get; init; }
}
