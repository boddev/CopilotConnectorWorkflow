// Content-hash helpers ported from src/jobs.ts.
//
// CRITICAL parity invariants (Opus-4.8 review B2/B3, Phase 1 remaining):
//   - dirHash uses ORDINAL sort (matches JS Array.sort() = UTF-16 code-unit order).
//     Do NOT use JsLocaleCompareComparer here — that is only for canonical-hash.
//   - objectHash mirrors JSON.stringify(obj, replacerArray) semantics: the keys
//     in the array are a recursive whitelist applied at every nesting level.
//   - SHA-256 hex, first 16 chars.

using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Ccw.Core.Util;

public static class HashHelpers
{
    private static readonly JsonSerializerOptions s_replacerOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    /// <summary>SHA-256 hex of a file's bytes, first 16 chars. Returns empty string when missing/not-a-file.</summary>
    public static string FileHash(string file)
    {
        if (!File.Exists(file)) return string.Empty;
        using var sha = SHA256.Create();
        using var fs = File.OpenRead(file);
        var hash = sha.ComputeHash(fs);
        return Convert.ToHexStringLower(hash)[..16];
    }

    /// <summary>Recursive directory hash. Aggregates "relative/path:fileHash\n" lines using
    /// ORDINAL alphabetic order (matches JS readdirSync().sort()).</summary>
    public static string DirHash(string dir)
    {
        if (!Directory.Exists(dir))
        {
            if (File.Exists(dir)) return FileHash(dir);
            return string.Empty;
        }

        using var sha = SHA256.Create();
        using var cs = new CryptoStream(Stream.Null, sha, CryptoStreamMode.Write);

        void Walk(string d, string rel)
        {
            // Ordinal sort matches JS readdirSync().sort() default (UTF-16 code units).
            // Combining files + subdirs together matches the JS code which iterates the
            // single readdirSync() list.
            var entries = Directory.GetFileSystemEntries(d)
                .Select(p => (Path: p, Name: Path.GetFileName(p)))
                .OrderBy(e => e.Name, StringComparer.Ordinal)
                .ToList();
            foreach (var (path, name) in entries)
            {
                var r = string.IsNullOrEmpty(rel) ? name : $"{rel}/{name}";
                if (Directory.Exists(path))
                {
                    Walk(path, r);
                }
                else if (File.Exists(path))
                {
                    var bytes = Encoding.UTF8.GetBytes(r);
                    cs.Write(bytes, 0, bytes.Length);
                    cs.WriteByte((byte)':');
                    var fh = Encoding.UTF8.GetBytes(FileHash(path));
                    cs.Write(fh, 0, fh.Length);
                    cs.WriteByte((byte)'\n');
                }
            }
        }
        Walk(dir, string.Empty);
        cs.FlushFinalBlock();
        return Convert.ToHexStringLower(sha.Hash!)[..16];
    }

    /// <summary>Mirrors <c>JSON.stringify(obj, Object.keys(obj).sort())</c> + sha256[:16],
    /// applied recursively (the JS replacer array filters at every nesting level —
    /// Opus B3).
    ///
    /// IMPORTANT (Opus Phase-2 NB-3): in production, the ONLY caller of
    /// <c>ObjectHash</c> is <c>stepInputsHash(parts: unknown[])</c> in
    /// <c>orchestrator.ts</c>, which always passes an ARRAY. For arrays the
    /// helper is fully parity-correct (key order is irrelevant, and
    /// <c>ExtractTopLevelKeys</c> returns <c>[]</c> so nested objects pass
    /// through structurally). For BARE OBJECT inputs whose insertion order
    /// differs from sorted order, this C# helper emits keys in insertion
    /// order while JS replacer-array emit forces sorted order — the hashes
    /// will diverge. There is no production path that hits that case today;
    /// if a future caller hashes a bare object, sort the emitted keys
    /// before serializing (TODO marked in code) or rename the helper to
    /// reflect the array-only contract.</summary>
    public static string ObjectHash(object? obj)
    {
        if (obj is null) return ComputeSha16("null");
        var topKeys = ExtractTopLevelKeys(obj);
        var allowed = new HashSet<string>(topKeys, StringComparer.Ordinal);
        var element = JsonSerializer.SerializeToElement(obj, s_replacerOptions);
        var filtered = FilterRecursive(element, allowed);
        var json = JsonSerializer.Serialize(filtered, s_replacerOptions);
        return ComputeSha16(json);
    }

    private static string ComputeSha16(string text)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexStringLower(bytes)[..16];
    }

    private static List<string> ExtractTopLevelKeys(object obj)
    {
        var element = JsonSerializer.SerializeToElement(obj, s_replacerOptions);
        if (element.ValueKind != JsonValueKind.Object) return [];
        var keys = element.EnumerateObject().Select(p => p.Name).ToList();
        keys.Sort(StringComparer.Ordinal);
        return keys;
    }

    private static System.Text.Json.Nodes.JsonNode? FilterRecursive(JsonElement element, HashSet<string> allowed)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var obj = new System.Text.Json.Nodes.JsonObject();
                foreach (var prop in element.EnumerateObject())
                {
                    if (!allowed.Contains(prop.Name)) continue;
                    obj[prop.Name] = FilterRecursive(prop.Value, allowed);
                }
                return obj;
            case JsonValueKind.Array:
                var arr = new System.Text.Json.Nodes.JsonArray();
                foreach (var item in element.EnumerateArray())
                {
                    arr.Add(FilterRecursive(item, allowed));
                }
                return arr;
            case JsonValueKind.String:
                return System.Text.Json.Nodes.JsonValue.Create(element.GetString());
            case JsonValueKind.Number:
                return System.Text.Json.Nodes.JsonNode.Parse(element.GetRawText());
            case JsonValueKind.True:
                return System.Text.Json.Nodes.JsonValue.Create(true);
            case JsonValueKind.False:
                return System.Text.Json.Nodes.JsonValue.Create(false);
            default:
                return null;
        }
    }
}

