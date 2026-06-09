using System.Text.Json;

namespace Ccw.Core.Auth;

/// <summary>Decodes the payload (second segment) of a compact JWS / JWT, returning
/// the parsed claims as a <see cref="JsonElement"/>.
///
/// Mirrors Node <c>decodeJwtPayload</c> in <c>src/auth-preflight.ts</c>:
/// <list type="bullet">
///   <item>splits on '.', requires at least 2 segments</item>
///   <item>URL-safe → standard Base64 (<c>-</c> → <c>+</c>, <c>_</c> → <c>/</c>)</item>
///   <item>right-pads with '=' to a multiple of 4</item>
///   <item>UTF-8 decode → <c>JSON.parse</c></item>
/// </list>
///
/// We do NOT validate signature, issuer, audience, or expiry — the preflight
/// only cares whether the locally-acquired access token CARRIES the right
/// roles (Opus Phase-2 closure I-2: client-credentials tokens have no
/// id token and MSAL does not parse access-token claims, so we must JWT-decode
/// the access token directly regardless of whether we go through MSAL later).
/// The Node version is identically permissive.</summary>
public static class JwtPayloadDecoder
{
    public static JsonElement DecodePayload(string token)
    {
        ArgumentNullException.ThrowIfNull(token);
        var parts = token.Split('.');
        if (parts.Length < 2)
        {
            throw new ArgumentException("Access token is not a JWT.", nameof(token));
        }

        var payload = parts[1];
        // URL-safe → standard base64 (Node: replace(/-/g, '+').replace(/_/g, '/')).
        var chars = payload.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            if (chars[i] == '-')
            {
                chars[i] = '+';
            }
            else if (chars[i] == '_')
            {
                chars[i] = '/';
            }
        }
        var standard = new string(chars);
        // Right-pad to a multiple of 4 (Node: padEnd(Math.ceil(len / 4) * 4, '=')).
        var padded = standard.Length % 4 == 0
            ? standard
            : standard.PadRight(((standard.Length + 3) / 4) * 4, '=');

        var bytes = Convert.FromBase64String(padded);
        // OPUS B2 — JsonDocument.Parse returns a doc that owns a pooled byte
        // buffer; the buffer is only returned to ArrayPool on Dispose. Clone()
        // copies the element data but does NOT dispose the doc. We MUST
        // dispose explicitly to avoid leaking a pooled buffer per call.
        using var doc = JsonDocument.Parse(bytes);
        return doc.RootElement.Clone();
    }

    /// <summary>Reads the <c>roles</c> claim as a list of strings, dropping
    /// non-string entries (mirrors Node's <c>filter((r): r is string =&gt; typeof r === 'string')</c>).
    /// Returns an empty list when the claim is missing or not an array.</summary>
    public static IReadOnlyList<string> ExtractRoles(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return [];
        if (!payload.TryGetProperty("roles", out var rolesEl)) return [];
        if (rolesEl.ValueKind != JsonValueKind.Array) return [];
        var roles = new List<string>(rolesEl.GetArrayLength());
        foreach (var role in rolesEl.EnumerateArray())
        {
            if (role.ValueKind == JsonValueKind.String)
            {
                var s = role.GetString();
                if (s is not null) roles.Add(s);
            }
        }
        return roles;
    }
}
