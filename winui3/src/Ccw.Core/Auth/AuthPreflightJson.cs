using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ccw.Core.Auth;

/// <summary>JSON wire format helpers for the auth preflight. Output shape
/// matches Node <c>JSON.stringify(runAuthPreflight result, null, 2)</c> for
/// parity-test friendliness:
/// <list type="bullet">
///   <item>property order: <c>passed, checks</c>; inside each check <c>name, status, message</c></item>
///   <item>status emitted as the lowercase string literals from Node</item>
///   <item>indented (2 spaces) via <see cref="JsonWriterOptions.Indented"/></item>
///   <item><c>UnsafeRelaxedJsonEscaping</c> so non-ASCII flows through identical to Node</item>
/// </list>
/// <see cref="FormatHumanReadable(AuthPreflightResult)"/> mirrors Node's
/// <c>formatAuthPreflightResult</c> text output for the console.</summary>
public static class AuthPreflightJson
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Converters = { new AuthCheckStatusJsonConverter() },
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static string Serialize(AuthPreflightResult result)
        => JsonSerializer.Serialize(result, Options);

    public static string FormatHumanReadable(AuthPreflightResult result)
    {
        var sb = new StringBuilder();
        sb.Append("Authentication preflight\n\n");
        foreach (var check in result.Checks)
        {
            var marker = check.Status switch
            {
                AuthCheckStatus.Passed => "PASS",
                AuthCheckStatus.Failed => "FAIL",
                _ => "SKIP",
            };
            sb.Append(string.Format(CultureInfo.InvariantCulture, "[{0}] {1}: {2}\n", marker, check.Name, check.Message));
        }
        if (!result.Checks.Any(c => c.Status != AuthCheckStatus.Skipped))
        {
            sb.Append("\nNo checks were executed. Remove a --skip-* option or provide the required auth settings.\n");
        }
        // Match Node's join('\n') — no trailing newline after the last line.
        var s = sb.ToString();
        return s.EndsWith('\n') ? s[..^1] : s;
    }

    private sealed class AuthCheckStatusJsonConverter : JsonConverter<AuthCheckStatus>
    {
        public override AuthCheckStatus Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var s = reader.GetString();
            return s switch
            {
                "passed" => AuthCheckStatus.Passed,
                "failed" => AuthCheckStatus.Failed,
                "skipped" => AuthCheckStatus.Skipped,
                _ => throw new JsonException(string.Format(CultureInfo.InvariantCulture, "Unknown auth check status: {0}", s)),
            };
        }

        public override void Write(Utf8JsonWriter writer, AuthCheckStatus value, JsonSerializerOptions options)
        {
            writer.WriteStringValue(value switch
            {
                AuthCheckStatus.Passed => "passed",
                AuthCheckStatus.Failed => "failed",
                AuthCheckStatus.Skipped => "skipped",
                _ => throw new JsonException("Unknown AuthCheckStatus value."),
            });
        }
    }
}
