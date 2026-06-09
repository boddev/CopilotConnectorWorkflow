// Phase 8 — parity diff harness.
//
// Layered diff strategy (plan §8):
//   - byte-exact     : connector-project + deploy template files, rendered
//                      source files (teamsapp.yml, *.ts, deploy scripts).
//   - canonical JSON : semantic artifacts (job.json, scored reports,
//                      schema artifacts). Sort keys, use
//                      UnsafeRelaxedJsonEscaping, invariant culture.
//   - allowlist      : timestamps, absolute workspace paths,
//                      machine-specific tool paths, random IDs — diffed
//                      under regex masks, not raw text.
//   - skip           : node_modules, package-lock.json (npm version not
//                      pinned).
//
// This utility is the *infrastructure*. A live cross-runtime parity run
// against `node ccw run` is environment-dependent (requires Node + a
// working ccw checkout); it lives behind an env-flag-gated test below so
// CI without Node still passes.

using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ccw.Parity.Tests;

internal enum ParityDiffMode
{
    /// <summary>Compare raw bytes.</summary>
    ByteExact,
    /// <summary>Parse as JSON, sort keys recursively, normalize string
    /// encoding (UnsafeRelaxedJsonEscaping), serialize, diff text.</summary>
    CanonicalJson,
    /// <summary>Skip the file entirely.</summary>
    Skip,
}

internal sealed record ParityDiffResult(string RelativePath, bool Equal, string? Detail);

/// <summary>Diff utility implementing the layered strategy. Stateless:
/// callers feed a (file, mode) classifier in.</summary>
internal static class ParityDiffer
{
    /// <summary>Allowlist patterns applied before diffing JSON / text. Matches
    /// are replaced with a placeholder so diff doesn't trip on values that
    /// vary per run.</summary>
    public static readonly IReadOnlyList<(Regex Pattern, string Placeholder)> DefaultAllowlist =
    [
        // ISO-8601 timestamps (matches what JSON Date.toISOString() emits).
        (new Regex(@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", RegexOptions.Compiled), "<TIMESTAMP>"),
        // Unix epoch numbers > 1e12 (ms-precision; covers the Node Date.now()
        // and most C# DateTimeOffset.ToUnixTimeMilliseconds outputs without
        // false-matching small ordinals).
        (new Regex(@"\b1[6-9]\d{11}\b", RegexOptions.Compiled), "<EPOCHMS>"),
        // Absolute Windows paths under workspace or LOCALAPPDATA. Any
        // multi-segment path containing 'workspace' or 'CopilotConnectorWorkflow'.
        // Backslash separators may be raw (`C:\Users\...`) or JSON-encoded
        // (`C:\\Users\\...`) depending on whether the input is canonicalized
        // (`Diff` runs allowlist on `ToJsonString()` output, which re-escapes
        // backslashes), so we accept one OR more in each gap with `\\+`.
        (new Regex(@"[A-Z]:\\+(?:[^\\""]+\\+)*(?:workspace|CopilotConnectorWorkflow)\\+[^""\\]*(?:\\+[^""\\]*)*", RegexOptions.Compiled | RegexOptions.IgnoreCase), "<WORKSPACE_PATH>"),
        // Absolute POSIX paths under workspace or CopilotConnectorWorkflow.
        (new Regex(@"/(?:[^/\s]+/)*(?:workspace|CopilotConnectorWorkflow)/[^\s""]*", RegexOptions.Compiled), "<WORKSPACE_PATH>"),
        // Random job-id-style hex (8+ hex chars stranded between non-hex).
        (new Regex(@"\b[0-9a-f]{8,}\b", RegexOptions.Compiled), "<HEX_ID>"),
        // GUIDs.
        (new Regex(@"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "<GUID>"),
    ];

    /// <summary>Default classifier: rules of thumb for which mode each file
    /// gets. Callers can override.</summary>
    public static ParityDiffMode DefaultClassify(string relativePath)
    {
        ArgumentNullException.ThrowIfNull(relativePath);
        var rel = relativePath.Replace('\\', '/');

        // Skip non-deterministic / not-pinned content entirely.
        if (rel.Contains("/node_modules/", StringComparison.Ordinal)) return ParityDiffMode.Skip;
        if (rel.EndsWith("package-lock.json", StringComparison.Ordinal)) return ParityDiffMode.Skip;
        if (rel.EndsWith(".tsbuildinfo", StringComparison.Ordinal)) return ParityDiffMode.Skip;
        if (rel.EndsWith(".log", StringComparison.Ordinal)) return ParityDiffMode.Skip;

        // Semantic artifacts → canonical JSON.
        if (rel.EndsWith("job.json", StringComparison.OrdinalIgnoreCase)) return ParityDiffMode.CanonicalJson;
        if (rel.EndsWith("agent-response-scores.json", StringComparison.OrdinalIgnoreCase)) return ParityDiffMode.CanonicalJson;
        if (rel.EndsWith(".evalgen.json", StringComparison.OrdinalIgnoreCase)) return ParityDiffMode.CanonicalJson;
        if (rel.EndsWith("compare-report.json", StringComparison.OrdinalIgnoreCase)) return ParityDiffMode.CanonicalJson;

        // Everything else (rendered TS, YAML, MD, scripts, templates) →
        // byte-exact. CRLF/LF drift is caught here because we intentionally
        // do NOT normalize.
        return ParityDiffMode.ByteExact;
    }

    public static ParityDiffResult Diff(
        string relativePath,
        ReadOnlySpan<byte> a,
        ReadOnlySpan<byte> b,
        Func<string, ParityDiffMode>? classifier = null,
        IReadOnlyList<(Regex Pattern, string Placeholder)>? allowlist = null)
    {
        ArgumentNullException.ThrowIfNull(relativePath);
        classifier ??= DefaultClassify;
        allowlist ??= DefaultAllowlist;

        var mode = classifier(relativePath);
        return mode switch
        {
            ParityDiffMode.Skip => new ParityDiffResult(relativePath, true, "(skipped)"),
            ParityDiffMode.ByteExact => DiffByteExact(relativePath, a, b),
            ParityDiffMode.CanonicalJson => DiffCanonicalJson(relativePath, a, b, allowlist),
            _ => throw new InvalidOperationException($"Unhandled mode {mode}"),
        };
    }

    private static ParityDiffResult DiffByteExact(string rel, ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        if (a.SequenceEqual(b)) return new ParityDiffResult(rel, true, null);
        return new ParityDiffResult(rel, false,
            $"byte-exact diff: a.Length={a.Length} b.Length={b.Length}, first byte diff at offset {FirstDiff(a, b)}");
    }

    private static int FirstDiff(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var min = Math.Min(a.Length, b.Length);
        for (var i = 0; i < min; i++)
        {
            if (a[i] != b[i]) return i;
        }
        return min;
    }

    private static ParityDiffResult DiffCanonicalJson(
        string rel,
        ReadOnlySpan<byte> a,
        ReadOnlySpan<byte> b,
        IReadOnlyList<(Regex Pattern, string Placeholder)> allowlist)
    {
        var canonA = Canonicalize(a, allowlist);
        var canonB = Canonicalize(b, allowlist);
        if (canonA == canonB) return new ParityDiffResult(rel, true, null);

        // Find the first divergent character for a useful diff message.
        var max = Math.Min(canonA.Length, canonB.Length);
        var firstDiff = max;
        for (var i = 0; i < max; i++)
        {
            if (canonA[i] != canonB[i]) { firstDiff = i; break; }
        }

        var contextStart = Math.Max(0, firstDiff - 40);
        var contextEnd = Math.Min(canonA.Length, firstDiff + 40);
        var contextA = canonA.Substring(contextStart, contextEnd - contextStart);
        var contextEndB = Math.Min(canonB.Length, firstDiff + 40);
        var contextB = canonB.Substring(contextStart, contextEndB - contextStart);

        return new ParityDiffResult(rel, false,
            $"canonical-JSON diff at offset {firstDiff}: A=…{contextA}… B=…{contextB}…");
    }

    private static string Canonicalize(ReadOnlySpan<byte> bytes, IReadOnlyList<(Regex Pattern, string Placeholder)> allowlist)
    {
        var doc = JsonNode.Parse(bytes.ToArray());
        var sorted = SortKeys(doc);
        var json = sorted?.ToJsonString(new JsonSerializerOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            WriteIndented = true,
        }) ?? "null";
        foreach (var (pattern, placeholder) in allowlist)
        {
            json = pattern.Replace(json, placeholder);
        }
        return json;
    }

    private static JsonNode? SortKeys(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            var sorted = new JsonObject();
            foreach (var key in obj.Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal))
            {
                sorted[key] = SortKeys(obj[key]?.DeepClone());
            }
            return sorted;
        }
        if (node is JsonArray arr)
        {
            var copy = new JsonArray();
            foreach (var item in arr)
            {
                copy.Add(SortKeys(item?.DeepClone()));
            }
            return copy;
        }
        return node?.DeepClone();
    }
}
