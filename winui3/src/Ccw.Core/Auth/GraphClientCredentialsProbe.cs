using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Ccw.Core.Auth;

/// <summary>Pure-HTTP client-credentials acquirer for the Graph preflight.
/// Matches Node <c>acquireClientCredentialsToken</c> in
/// <c>src/auth-preflight.ts</c> — POST <c>application/x-www-form-urlencoded</c>
/// to <c>/oauth2/v2.0/token</c>, parse <c>access_token</c>.
///
/// <para>WHY HttpClient and not MSAL:</para>
/// MSAL's confidential-client flow does the same thing under the hood plus
/// adds binary token caching, retries, telemetry — none of which we want for
/// a one-shot preflight. The Node version uses raw <c>fetch</c>; this stays
/// matching. MSAL is reserved for Phase 5 UI (WAM broker) and Phase 4 CLI
/// (device-code), where caching and broker matter.
///
/// <para>NOTE (Opus Phase-2 closure I-1):</para>
/// When MSAL DOES land in Phase 4/5, the EvalToolkit cache-reuse story
/// needs an empirical round-trip test (a `.bin` file written by EvalToolkit's
/// `@azure/msal-node-extensions` DPAPI envelope is NOT guaranteed to decrypt
/// via .NET's `Microsoft.Identity.Client.Extensions.Msal` DPAPI envelope —
/// two DPAPI wrappers over the same plaintext can disagree). This is irrelevant
/// for THIS class (no MSAL, no cache) but is captured here so the next person
/// to wire MSAL doesn't assume cache interop works.</summary>
public sealed class GraphClientCredentialsProbe
{
    private const string DefaultGraphScope = "https://graph.microsoft.com/.default";
    private const string GraphConnectionsUrl = "https://graph.microsoft.com/v1.0/external/connections?$top=1";

    private readonly HttpMessageHandler? _handlerOverride;
    private readonly string _tokenAuthority;
    private readonly string _scope;
    private readonly string _connectionsUrl;

    public GraphClientCredentialsProbe(
        HttpMessageHandler? handlerOverride = null,
        string tokenAuthority = "https://login.microsoftonline.com",
        string scope = DefaultGraphScope,
        string connectionsUrl = GraphConnectionsUrl)
    {
        _handlerOverride = handlerOverride;
        _tokenAuthority = tokenAuthority.TrimEnd('/');
        _scope = scope;
        _connectionsUrl = connectionsUrl;
    }

    /// <summary>Acquires a token then probes <c>/external/connections</c>.
    /// Mirrors Node <c>graphClientSecretCheck</c> flow (token → role check
    /// → connections probe). Throws on any failure; <see cref="AuthPreflightRunner"/>
    /// catches and converts to a "failed" check.</summary>
    public async Task<GraphPreflightOutcome> RunAsync(
        string tenantId,
        string clientId,
        string clientSecret,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(tenantId);
        ArgumentException.ThrowIfNullOrEmpty(clientId);
        ArgumentException.ThrowIfNullOrEmpty(clientSecret);

        using var http = new HttpClient(_handlerOverride ?? new HttpClientHandler(), disposeHandler: _handlerOverride is null);
        var token = await AcquireTokenAsync(http, tenantId, clientId, clientSecret, cancellationToken).ConfigureAwait(false);
        var roleCheck = GraphRoleChecker.Check(token);
        if (!roleCheck.Ok)
        {
            return new GraphPreflightOutcome
            {
                Ok = false,
                FailureMessage = string.Format(
                    CultureInfo.InvariantCulture,
                    "Token is missing required app role(s): {0}. Grant admin consent for the Graph connector app permissions.",
                    string.Join(", ", roleCheck.Missing)),
                Roles = roleCheck.Roles,
            };
        }
        await ProbeConnectionsAsync(http, token, cancellationToken).ConfigureAwait(false);
        return new GraphPreflightOutcome { Ok = true, FailureMessage = null, Roles = roleCheck.Roles };
    }

    private async Task<string> AcquireTokenAsync(
        HttpClient http,
        string tenantId,
        string clientId,
        string clientSecret,
        CancellationToken ct)
    {
        var url = string.Format(
            CultureInfo.InvariantCulture,
            "{0}/{1}/oauth2/v2.0/token",
            _tokenAuthority,
            Uri.EscapeDataString(tenantId));
        var form = new List<KeyValuePair<string, string>>
        {
            new("client_id", clientId),
            new("client_secret", clientSecret),
            new("grant_type", "client_credentials"),
            new("scope", _scope),
        };
        using var content = new FormUrlEncodedContent(form);
        using var response = await http.PostAsync(new Uri(url), content, ct).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(string.Format(
                CultureInfo.InvariantCulture,
                "Token endpoint returned HTTP {0}: {1}",
                (int)response.StatusCode,
                SummarizeJsonError(text)));
        }
        using var doc = JsonDocument.Parse(text);
        if (!doc.RootElement.TryGetProperty("access_token", out var tokenEl) || tokenEl.ValueKind != JsonValueKind.String)
        {
            throw new InvalidOperationException("Token endpoint did not return an access token.");
        }
        return tokenEl.GetString()!;
    }

    private async Task ProbeConnectionsAsync(HttpClient http, string accessToken, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_connectionsUrl));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden)
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException(string.Format(
                CultureInfo.InvariantCulture,
                "Graph external connections probe returned HTTP {0}: {1}",
                (int)response.StatusCode,
                SummarizeJsonError(text)));
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(string.Format(
                CultureInfo.InvariantCulture,
                "Graph external connections probe returned HTTP {0}.",
                (int)response.StatusCode));
        }
    }

    /// <summary>Mirrors Node <c>summarizeJsonError</c>: tries JSON-parse, picks
    /// <c>error</c> + <c>error_description</c> (or <c>message</c>), joins with
    /// " - "; falls back to truncated raw text on parse failure.</summary>
    internal static string SummarizeJsonError(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            string? code = null;
            string? description = null;
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
                {
                    code = err.GetString();
                }
                if (root.TryGetProperty("error_description", out var desc) && desc.ValueKind == JsonValueKind.String)
                {
                    description = desc.GetString();
                }
                else if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
                {
                    description = msg.GetString();
                }
            }
            var parts = new List<string>(2);
            if (!string.IsNullOrEmpty(code)) parts.Add(code);
            if (!string.IsNullOrEmpty(description)) parts.Add(description);
            return parts.Count == 0 ? "No error details returned." : string.Join(" - ", parts);
        }
        catch (JsonException)
        {
            return text.Length > 500 ? text[..500] : text;
        }
    }
}

/// <summary>Result of <see cref="GraphClientCredentialsProbe.RunAsync"/>.
/// <see cref="Ok"/> false carries the user-facing failure message. <see cref="Roles"/>
/// is always present for diagnostics.</summary>
public sealed record GraphPreflightOutcome
{
    public required bool Ok { get; init; }
    public string? FailureMessage { get; init; }
    public required IReadOnlyList<string> Roles { get; init; }
}
