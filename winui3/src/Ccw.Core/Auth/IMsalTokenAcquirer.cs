namespace Ccw.Core.Auth;

/// <summary>Acquirer seam — the only surface Phase 5 (UI head) and Phase 4
/// (CLI) implement against. The interface stays IDENTICAL across host-specific
/// implementations so the orchestrator can be wired with whichever one the
/// host provides.
///
/// <para>Two implementations are planned:</para>
/// <list type="bullet">
///   <item><b>UI head</b> — WAM broker via
///   <c>Microsoft.Identity.Client.Broker</c>, parent-HWND bound to the active
///   window, redirect URI <c>ms-appx-web://microsoft.aad.brokerplugin/{client_id}</c>.
///   Lives under <c>Ccw.UI</c> (Phase 5). The HWND MUST be fetched at acquire
///   time, not cached at startup (Opus Phase-2 closure NIT: stale HWND from
///   prior window = silent broker failures).</item>
///   <item><b>CLI / headless</b> — device-code via <c>Microsoft.Identity.Client</c>,
///   prompt printed to console. Lives under <c>Ccw.Cli</c> (Phase 4).</item>
/// </list>
///
/// <para>WHY this lives in Ccw.Core anyway:</para>
/// The orchestrator + preflight need to take a dependency on the SEAM
/// without taking a dependency on either implementation's package set.
/// Adding the heavy MSAL packages only where they're used keeps Ccw.Core
/// clean and unit-testable without spinning up a full Windows broker stack.</summary>
public interface IMsalTokenAcquirer
{
    /// <summary>Returns an access token for the requested scopes. Throws on
    /// failure (cancellation, missing consent, broker unavailable, etc.).
    /// Implementations MUST be re-entrant and SHOULD use silent acquisition
    /// where possible.</summary>
    Task<MsalAcquireResult> AcquireAsync(
        MsalAcquireRequest request,
        CancellationToken cancellationToken = default);
}

/// <summary>Inputs to <see cref="IMsalTokenAcquirer.AcquireAsync"/>.</summary>
public sealed record MsalAcquireRequest
{
    public required string ClientId { get; init; }
    /// <summary>Authority URL, e.g. <c>https://login.microsoftonline.com/{tenant}</c>
    /// or <c>https://login.microsoftonline.com/organizations</c> for multi-tenant.</summary>
    public required string Authority { get; init; }
    public required IReadOnlyList<string> Scopes { get; init; }

    /// <summary>Hint of the username/UPN — implementations may use it to skip
    /// the account picker when only one cached account matches.</summary>
    public string? LoginHint { get; init; }

    /// <summary>If true (default), the acquirer is permitted to prompt
    /// interactively (broker UI in UI host; device-code in CLI). When false,
    /// only the silent cache lookup is attempted; failure surfaces as a
    /// thrown exception.</summary>
    public bool AllowInteractive { get; init; } = true;
}

/// <summary>Output of <see cref="IMsalTokenAcquirer.AcquireAsync"/>.</summary>
public sealed record MsalAcquireResult
{
    public required string AccessToken { get; init; }
    public required DateTimeOffset ExpiresOn { get; init; }
    public string? Username { get; init; }
    public string? TenantId { get; init; }

    /// <summary>True when the token came from the silent cache, false when an
    /// interactive flow was triggered. Surfaced for diagnostics so the UI can
    /// note "signed in silently" vs "consent requested".</summary>
    public required bool FromSilentCache { get; init; }
}
