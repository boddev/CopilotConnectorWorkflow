using System.Globalization;

namespace Ccw.Core.Auth;

/// <summary>Orchestrates the auth preflight checks; matches the JSON output
/// shape of Node <c>runAuthPreflight</c> + <c>formatAuthPreflightResult</c> so
/// scripts and CI consumers can drop in the C# binary in place of the Node
/// CLI's <c>ccw auth</c> path.
///
/// <para>V1 SCOPE:</para>
/// <list type="bullet">
///   <item><b>Graph client-credentials check</b> — fully ported, pure HTTP.</item>
///   <item><b>WorkIQ MCP auth check</b> — emits <c>skipped</c> with
///   <c>"Not yet ported - run `ccw auth` from the Node CLI for this check."</c>.
///   Wiring lands alongside <c>EvalToolkit.WorkIQ</c> in Phase 5 / Phase 8.</item>
///   <item><b>EvalScore A2A MSAL check</b> — same skip-with-defer message.</item>
/// </list>
/// The skipped checks are still REPORTED (not omitted) so the JSON shape
/// matches Node byte-for-byte — only the <c>status</c> + <c>message</c> change.
/// </summary>
public sealed class AuthPreflightRunner
{
    private readonly GraphClientCredentialsProbe _graphProbe;
    private readonly Func<string, string?> _envLookup;

    public AuthPreflightRunner(
        GraphClientCredentialsProbe? graphProbe = null,
        Func<string, string?>? envLookup = null)
    {
        _graphProbe = graphProbe ?? new GraphClientCredentialsProbe();
        _envLookup = envLookup ?? Environment.GetEnvironmentVariable;
    }

    public async Task<AuthPreflightResult> RunAsync(
        AuthPreflightOptions options,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        var checks = new List<AuthPreflightCheck>(3);

        checks.Add(options.RunGraph
            ? await RunGraphCheckAsync(options, cancellationToken).ConfigureAwait(false)
            : new AuthPreflightCheck { Name = "Graph connector app auth", Status = AuthCheckStatus.Skipped, Message = "Not requested" });

        checks.Add(options.RunWorkIq
            ? new AuthPreflightCheck
            {
                Name = "WorkIQ MCP auth",
                Status = AuthCheckStatus.Skipped,
                Message = "Not yet ported to the WinUI auth-preflight - run 'ccw auth --run-workiq' from the Node CLI for this check.",
            }
            : new AuthPreflightCheck { Name = "WorkIQ MCP auth", Status = AuthCheckStatus.Skipped, Message = "Not requested" });

        checks.Add(options.RunEvalScoreA2A
            ? new AuthPreflightCheck
            {
                Name = "EvalScore A2A MSAL auth",
                Status = AuthCheckStatus.Skipped,
                Message = "Not yet ported to the WinUI auth-preflight - run 'ccw auth --run-evalscore-a2a' from the Node CLI for this check.",
            }
            : new AuthPreflightCheck { Name = "EvalScore A2A MSAL auth", Status = AuthCheckStatus.Skipped, Message = "Not requested" });

        // OPUS I-3 / GPT I-4 — a user who explicitly asks for a WorkIQ /
        // EvalScore check and gets a deferral-skip should NOT see the result
        // flip from passed=true (Node) to passed=false (here) just because
        // those engines aren't ported yet. The CLI exit-code contract is what
        // scripts gate on. Treat the run as "passed" when no check FAILED,
        // even if no check actually ran (the message stream still signals
        // skip-with-deferral; consumers needing strict pass-only semantics
        // can inspect Checks[].Status directly).
        var passed = !checks.Any(c => c.Status == AuthCheckStatus.Failed);
        // Preserve the Node-faithful semantic where "nothing executed AND
        // nothing failed" is reported via Passed=false ONLY when the user
        // didn't actually ask for anything (RunGraph/RunWorkIq/RunEvalScoreA2A
        // all false). That path matches Node where empty-execution is the
        // "no checks were executed; remove a skip-* option" failure mode.
        var anythingRequested = options.RunGraph || options.RunWorkIq || options.RunEvalScoreA2A;
        if (!anythingRequested) passed = false;
        return new AuthPreflightResult { Passed = passed, Checks = checks };
    }

    private async Task<AuthPreflightCheck> RunGraphCheckAsync(
        AuthPreflightOptions options,
        CancellationToken ct)
    {
        if (options.UseManagedIdentity)
        {
            return new AuthPreflightCheck
            {
                Name = "Graph connector app auth",
                Status = AuthCheckStatus.Skipped,
                Message = "Managed identity selected; local client-secret validation is not applicable.",
            };
        }

        var missing = new List<string>();
        if (string.IsNullOrEmpty(options.TenantId)) missing.Add("tenant ID");
        if (string.IsNullOrEmpty(options.ClientId)) missing.Add("client ID");
        if (string.IsNullOrEmpty(options.ClientSecretEnvVar)) missing.Add("client secret env var name");
        var secret = string.IsNullOrEmpty(options.ClientSecretEnvVar) ? null : _envLookup(options.ClientSecretEnvVar);
        if (!string.IsNullOrEmpty(options.ClientSecretEnvVar) && string.IsNullOrEmpty(secret))
        {
            missing.Add(string.Format(CultureInfo.InvariantCulture, "environment variable {0}", options.ClientSecretEnvVar));
        }
        if (missing.Count > 0)
        {
            return new AuthPreflightCheck
            {
                Name = "Graph connector app auth",
                Status = AuthCheckStatus.Failed,
                Message = string.Format(CultureInfo.InvariantCulture, "Missing {0}.", string.Join(", ", missing)),
            };
        }

        try
        {
            var outcome = await _graphProbe.RunAsync(options.TenantId!, options.ClientId!, secret!, ct).ConfigureAwait(false);
            if (!outcome.Ok)
            {
                return new AuthPreflightCheck
                {
                    Name = "Graph connector app auth",
                    Status = AuthCheckStatus.Failed,
                    Message = outcome.FailureMessage ?? "Graph preflight failed.",
                };
            }
            return new AuthPreflightCheck
            {
                Name = "Graph connector app auth",
                Status = AuthCheckStatus.Passed,
                Message = string.Format(
                    CultureInfo.InvariantCulture,
                    "Client credentials validated for tenant {0} and client {1}.",
                    options.TenantId,
                    options.ClientId),
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new AuthPreflightCheck
            {
                Name = "Graph connector app auth",
                Status = AuthCheckStatus.Failed,
                Message = SanitizeError(ex.Message),
            };
        }
    }

    /// <summary>Mirrors Node <c>sanitizeError</c>: redact client_secret values.
    /// Covers both form-urlencoded <c>client_secret=value</c> (Node's only
    /// case — that's what the AAD token endpoint echoes in 400s) AND JSON
    /// shaped <c>"client_secret":"value"</c> (which .NET HttpClient may
    /// surface in exception messages when callers log the request body —
    /// a divergence from Node that errs on the safe side).</summary>
    internal static string SanitizeError(string message)
    {
        var s = System.Text.RegularExpressions.Regex.Replace(
            message,
            @"client_secret=[^&\s]+",
            "client_secret=<redacted>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        s = System.Text.RegularExpressions.Regex.Replace(
            s,
            @"""client_secret""\s*:\s*""[^""]*""",
            @"""client_secret"":""<redacted>""",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return s;
    }
}
