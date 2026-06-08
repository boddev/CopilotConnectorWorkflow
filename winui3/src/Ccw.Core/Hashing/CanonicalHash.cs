// Port of src/canonical-hash.ts.
//
// PARITY CONTRACT (must be byte-equivalent to the Node implementation):
//
//   datasetHash: SHA-256 of "<relPath>\t<sha256>\t<byteLen>" lines joined by
//                '\n', sorted by relPath using JsLocaleCompareComparer.
//                Relative paths are normalized to lowercase forward-slash.
//                Files starting with '_' are skipped. Directories named
//                evalset / workspace / node_modules / .git (case-
//                insensitive) are skipped. Optional include-extension
//                filter is matched against the dot-stripped lowercase ext.
//
//   evalSetHash: SHA-256 of compact JSON.stringify of each canonical eval
//                item, joined by '\n', sorted by id using
//                JsLocaleCompareComparer. Canonical item shape is the
//                snake_case CanonicalEvalItem (see the record below);
//                assertions emit `wholeWord:true` only when truthy.
//                Items missing a prompt are dropped. Items missing an id
//                fall back to the first 12 hex chars of sha256(prompt).
//
// Any change here cascades through job.json hashes, evalSetHash for
// compare-mode pairing, and the Step 6 scored-report metadata. Touch
// with extreme care; the parity fixtures under
// tests/Ccw.Core.Tests/Hashing/ are the gate.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ccw.Core.Hashing;

/// <summary>One file's entry in a dataset hash manifest. TS: <c>DatasetFileEntry</c>.</summary>
public sealed record DatasetFileEntry(string RelativePath, string Sha256, long ByteLength);

/// <summary>Result of <see cref="CanonicalHash.HashDataset"/>. TS: <c>DatasetHashResult</c>.</summary>
public sealed record DatasetHashResult(string Hash, IReadOnlyList<DatasetFileEntry> Files);

/// <summary>Result of <see cref="CanonicalHash.HashEvalSetFile"/>. TS: <c>EvalSetHashResult</c>.</summary>
public sealed record EvalSetHashResult(string Hash, int ItemCount);

/// <summary>
/// Internal record holding the canonical shape of an eval item used
/// solely for hash-input serialization. snake_case property names match
/// the TS object literal in canonicalizeEvalItem(); property ORDER is
/// pinned by [JsonPropertyOrder] so JSON.stringify output is byte-
/// equivalent to Node.
/// </summary>
internal sealed record CanonicalEvalItem
{
    [JsonPropertyName("id")] [JsonPropertyOrder(0)]
    public required string Id { get; init; }

    [JsonPropertyName("prompt")] [JsonPropertyOrder(1)]
    public required string Prompt { get; init; }

    [JsonPropertyName("expected_answer")] [JsonPropertyOrder(2)]
    public required string ExpectedAnswer { get; init; }

    [JsonPropertyName("assertions")] [JsonPropertyOrder(3)]
    public required IReadOnlyList<CanonicalAssertion> Assertions { get; init; }

    [JsonPropertyName("supporting_facts")] [JsonPropertyOrder(4)]
    public required IReadOnlyList<string> SupportingFacts { get; init; }

    [JsonPropertyName("category")] [JsonPropertyOrder(5)]
    public required string Category { get; init; }

    [JsonPropertyName("difficulty")] [JsonPropertyOrder(6)]
    public required string Difficulty { get; init; }
}

/// <summary>One assertion in a CanonicalEvalItem. wholeWord field is
/// emitted only when true (matches TS conditional spread).</summary>
internal sealed record CanonicalAssertion
{
    [JsonPropertyName("value")] [JsonPropertyOrder(0)]
    public required string Value { get; init; }

    [JsonPropertyName("wholeWord")] [JsonPropertyOrder(1)]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? WholeWord { get; init; }
}

[JsonSerializable(typeof(CanonicalEvalItem))]
internal partial class CanonicalEvalJsonContext : JsonSerializerContext;

/// <summary>Canonical hashing for dataset and eval-set contents.</summary>
public static class CanonicalHash
{
    private static readonly HashSet<string> ExcludedPathSegments = new(StringComparer.OrdinalIgnoreCase)
    {
        "evalset", "workspace", "node_modules", ".git",
    };

    private static readonly JsonSerializerOptions CanonicalItemOptions = BuildCanonicalItemOptions();

    private static JsonSerializerOptions BuildCanonicalItemOptions()
    {
        // Compact (single-line), unsafe-relaxed escaping, snake_case driven
        // by [JsonPropertyName] (NOT a naming policy). NewLine doesn't
        // matter because WriteIndented = false, but pinned for safety.
        var opts = new JsonSerializerOptions
        {
            WriteIndented = false,
            NewLine = "\n",
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            TypeInfoResolver = CanonicalEvalJsonContext.Default,
        };
        opts.MakeReadOnly();
        return opts;
    }

    /// <summary>
    /// Hash a dataset (folder or single file) canonically. TS: <c>hashDataset</c>.
    /// </summary>
    /// <param name="datasetPath">Folder or single file.</param>
    /// <param name="extensions">Optional include list (e.g. <c>["csv","json"]</c>).
    /// When omitted, every file under the dataset is included (excluded path
    /// segments still skipped).</param>
    public static DatasetHashResult HashDataset(string datasetPath, IReadOnlyList<string>? extensions = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(datasetPath);

        var resolved = Path.GetFullPath(datasetPath);
        if (!File.Exists(resolved) && !Directory.Exists(resolved))
        {
            throw new FileNotFoundException($"dataset not found: {resolved}", resolved);
        }

        HashSet<string>? extFilter = null;
        if (extensions is { Count: > 0 })
        {
            extFilter = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in extensions)
            {
                extFilter.Add(NormalizeExt(e));
            }
        }

        var entries = new List<DatasetFileEntry>();
        var isFile = File.Exists(resolved);
        if (isFile)
        {
            var ext = NormalizeExt(Path.GetExtension(resolved));
            if (extFilter is null || extFilter.Contains(ext))
            {
                entries.Add(HashOneFile(resolved, Path.GetFileName(resolved)));
            }
        }
        else
        {
            WalkDirectory(resolved, string.Empty, extFilter, entries);
        }

        entries.Sort((a, b) => JsLocaleCompareComparer.Instance.Compare(a.RelativePath, b.RelativePath));

        var sb = new StringBuilder();
        for (var i = 0; i < entries.Count; i++)
        {
            if (i > 0)
            {
                sb.Append('\n');
            }

            var e = entries[i];
            sb.Append(e.RelativePath).Append('\t').Append(e.Sha256).Append('\t')
              .Append(e.ByteLength.ToString(CultureInfo.InvariantCulture));
        }

        var hash = Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()));
        return new DatasetHashResult($"sha256:{hash}", entries);
    }

    private static void WalkDirectory(
        string root,
        string rel,
        HashSet<string>? extFilter,
        List<DatasetFileEntry> output)
    {
        var here = string.IsNullOrEmpty(rel) ? root : Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));

        // fs.readdirSync().sort() in JS is default Array.sort -> UTF-16
        // codepoint compare. For ASCII names this is ordinal. The eventual
        // re-sort at the manifest level uses JsLocaleCompare, but this
        // internal traversal order DOES matter for non-ASCII names because
        // it determines which files are encountered first (cosmetic only,
        // since the manifest is sorted again). Matching Node behavior with
        // StringComparer.Ordinal here.
        var names = Directory.GetFileSystemEntries(here)
            .Select(p => Path.GetFileName(p)!)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();

        foreach (var name in names)
        {
            if (name.StartsWith('_'))
            {
                continue;
            }

            if (ExcludedPathSegments.Contains(name))
            {
                continue;
            }

            var childRel = string.IsNullOrEmpty(rel) ? name : $"{rel}/{name}";
            var childAbs = Path.Combine(here, name);

            if (Directory.Exists(childAbs))
            {
                WalkDirectory(root, childRel, extFilter, output);
            }
            else if (File.Exists(childAbs))
            {
                if (extFilter is not null)
                {
                    var ext = NormalizeExt(Path.GetExtension(name));
                    if (!extFilter.Contains(ext))
                    {
                        continue;
                    }
                }

                output.Add(HashOneFile(childAbs, childRel));
            }
        }
    }

    private static DatasetFileEntry HashOneFile(string absolutePath, string relativePath)
    {
        var info = new FileInfo(absolutePath);
        var sha = Sha256HexOfFile(absolutePath);
        return new DatasetFileEntry(NormalizeRelativePath(relativePath), sha, info.Length);
    }

    /// <summary>Hash an eval set canonically from its JSON sidecar.
    /// TS: <c>hashEvalSetFile</c>.</summary>
    public static EvalSetHashResult HashEvalSetFile(string evalGenJsonPath)
    {
        ArgumentException.ThrowIfNullOrEmpty(evalGenJsonPath);

        if (!File.Exists(evalGenJsonPath))
        {
            throw new FileNotFoundException($"eval set not found: {evalGenJsonPath}", evalGenJsonPath);
        }

        using var stream = File.OpenRead(evalGenJsonPath);
        using var doc = JsonDocument.Parse(stream);
        if (!doc.RootElement.TryGetProperty("items", out var itemsEl) ||
            itemsEl.ValueKind != JsonValueKind.Array)
        {
            return HashEvalSetItems([]);
        }

        var items = new List<JsonElement>(itemsEl.GetArrayLength());
        foreach (var item in itemsEl.EnumerateArray())
        {
            items.Add(item.Clone());
        }

        return HashEvalSetItems(items);
    }

    /// <summary>Hash an eval set canonically from raw items already parsed.
    /// TS: <c>hashEvalSetItems</c>.</summary>
    public static EvalSetHashResult HashEvalSetItems(IReadOnlyList<JsonElement> rawItems)
    {
        ArgumentNullException.ThrowIfNull(rawItems);

        var canonical = new List<CanonicalEvalItem>(rawItems.Count);
        foreach (var raw in rawItems)
        {
            var c = CanonicalizeEvalItem(raw);
            if (c is not null)
            {
                canonical.Add(c);
            }
        }

        canonical.Sort((a, b) => JsLocaleCompareComparer.Instance.Compare(a.Id, b.Id));

        var sb = new StringBuilder();
        for (var i = 0; i < canonical.Count; i++)
        {
            if (i > 0)
            {
                sb.Append('\n');
            }

            sb.Append(JsonSerializer.Serialize(canonical[i], CanonicalItemOptions));
        }

        var hash = Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()));
        return new EvalSetHashResult($"sha256:{hash}", canonical.Count);
    }

    private static CanonicalEvalItem? CanonicalizeEvalItem(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var prompt = StringField(GetProp(value, "prompt"));
        if (string.IsNullOrEmpty(prompt))
        {
            return null;
        }

        var id = StringField(GetProp(value, "id"));
        if (string.IsNullOrEmpty(id))
        {
            id = HashId(prompt);
        }

        // expected_answer falls back to expectedAnswer (camelCase variant).
        var expectedAnswer = StringField(GetProp(value, "expected_answer"));
        if (string.IsNullOrEmpty(expectedAnswer))
        {
            expectedAnswer = StringField(GetProp(value, "expectedAnswer"));
        }

        // supporting_facts falls back to supportingFacts.
        var supportingFactsRaw = GetProp(value, "supporting_facts");
        if (supportingFactsRaw is null || supportingFactsRaw.Value.ValueKind == JsonValueKind.Undefined)
        {
            supportingFactsRaw = GetProp(value, "supportingFacts");
        }

        return new CanonicalEvalItem
        {
            Id = id,
            Prompt = prompt,
            ExpectedAnswer = expectedAnswer,
            Assertions = NormalizeAssertions(GetProp(value, "assertions")),
            SupportingFacts = NormalizeSupportingFacts(supportingFactsRaw),
            Category = StringField(GetProp(value, "category")),
            Difficulty = StringField(GetProp(value, "difficulty")),
        };
    }

    private static IReadOnlyList<CanonicalAssertion> NormalizeAssertions(JsonElement? value)
    {
        if (value is null || value.Value.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<CanonicalAssertion>();
        }

        var result = new List<CanonicalAssertion>();
        foreach (var entry in value.Value.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var v = StringField(GetProp(entry, "value"));
            if (string.IsNullOrEmpty(v))
            {
                continue;
            }

            var wholeWord = GetProp(entry, "wholeWord");
            var isWholeWord = wholeWord is not null && wholeWord.Value.ValueKind == JsonValueKind.True;

            result.Add(new CanonicalAssertion
            {
                Value = v,
                WholeWord = isWholeWord ? true : null,
            });
        }

        return result;
    }

    private static IReadOnlyList<string> NormalizeSupportingFacts(JsonElement? value)
    {
        if (value is null || value.Value.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var result = new List<string>();
        foreach (var entry in value.Value.EnumerateArray())
        {
            var s = StringField(entry);
            if (!string.IsNullOrEmpty(s))
            {
                result.Add(s);
            }
        }

        return result;
    }

    private static string StringField(JsonElement? value)
    {
        if (value is null)
        {
            return string.Empty;
        }

        var el = value.Value;
        return el.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => string.Empty,
            JsonValueKind.String => (el.GetString() ?? string.Empty).Trim(),
            JsonValueKind.Number => el.GetRawText(), // matches JS String(number)
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => JsonSerializer.Serialize(el),
        };
    }

    private static JsonElement? GetProp(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var el) ? el : null;

    private static string HashId(string prompt)
    {
        var full = Sha256Hex(Encoding.UTF8.GetBytes(prompt));
        return full[..12];
    }

    private static string Sha256Hex(byte[] bytes)
    {
        var digest = SHA256.HashData(bytes);
        return Convert.ToHexStringLower(digest);
    }

    private static string Sha256HexOfFile(string path)
    {
        using var fs = File.OpenRead(path);
        var digest = SHA256.HashData(fs);
        return Convert.ToHexStringLower(digest);
    }

    private static string NormalizeRelativePath(string value) =>
        value.Replace('\\', '/').ToLowerInvariant();

    private static string NormalizeExt(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        return value[0] == '.'
            ? value[1..].ToLowerInvariant()
            : value.ToLowerInvariant();
    }
}
