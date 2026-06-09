// Port of src/dataset-shape-detect.ts. Decides whether a dataset is
// "text-rich already-structured" (single schema with prose fields) and
// so should skip the enhancer. Conservative classifier that returns
// 'tie' for borderline cases.

using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ccw.Core.Models;

namespace Ccw.Core.Dataset;

public sealed record DatasetShapeDetection
{
    public required PipelineRecommendation Recommendation { get; init; }
    public required int RecordsSampled { get; init; }
    public required int FilesScanned { get; init; }
    public required int DistinctSchemas { get; init; }
    public required IReadOnlyList<string> DominantSchema { get; init; }
    public required double DominantSchemaShare { get; init; }
    public required IReadOnlyList<TextRichField> TextRichFields { get; init; }
    public required string Reason { get; init; }
}

public static class DatasetShapeDetector
{
    private const int MaxRecordsPerFile = 100;
    private const int MaxRecordsTotal = 1000;
    private const double DominantSchemaMinShare = 0.9;
    private const double DominantSchemaBorderlineShare = 0.8;
    private const double ProseShareMin = 0.5;
    private const int ProseMinLength = 80;
    private const double LetterRatioMin = 0.5;
    private const int FieldMinObservations = 10;

    private static readonly Regex UrlRe = new("^https?://\\S+$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex GuidRe = new("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex JsonBlobRe = new(@"^\s*[\[{].*[\]}]\s*$", RegexOptions.Singleline | RegexOptions.Compiled);
    private static readonly Regex EmailRe = new("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", RegexOptions.Compiled);

    public static DatasetShapeDetection DetectDatasetShape(string datasetPath, IReadOnlyList<string>? extensions = null)
    {
        var records = CollectSampleRecords(datasetPath, extensions);
        if (records.Count == 0)
        {
            return new DatasetShapeDetection
            {
                Recommendation = PipelineRecommendation.Enhance,
                RecordsSampled = 0,
                FilesScanned = 0,
                DistinctSchemas = 0,
                DominantSchema = [],
                DominantSchemaShare = 0,
                TextRichFields = [],
                Reason = "no parseable records found; keeping enhancer default",
            };
        }

        var filesScanned = records.Select(r => r.SourceFile).Distinct(StringComparer.OrdinalIgnoreCase).Count();
        var (dominantSchema, dominantSchemaShare, distinctSchemas) = PickDominantSchema(records);
        var dominantKey = string.Join("\u0000", dominantSchema);
        var dominantRecords = records.Where(r => r.FieldSchemaKey == dominantKey).ToList();
        var textRichFields = PickTextRichFields(dominantRecords, dominantSchema);

        var reason = ExplainDecision(distinctSchemas, dominantSchemaShare, dominantSchema, textRichFields, records.Count);

        PipelineRecommendation recommendation;
        if (dominantSchemaShare < DominantSchemaBorderlineShare)
        {
            recommendation = PipelineRecommendation.Enhance;
        }
        else if (dominantSchemaShare < DominantSchemaMinShare)
        {
            recommendation = PipelineRecommendation.Tie;
        }
        else if (textRichFields.Count == 0)
        {
            recommendation = PipelineRecommendation.Tie;
        }
        else
        {
            recommendation = PipelineRecommendation.Identity;
        }

        return new DatasetShapeDetection
        {
            Recommendation = recommendation,
            RecordsSampled = records.Count,
            FilesScanned = filesScanned,
            DistinctSchemas = distinctSchemas,
            DominantSchema = dominantSchema,
            DominantSchemaShare = dominantSchemaShare,
            TextRichFields = textRichFields,
            Reason = reason,
        };
    }

    private sealed record SampleRecord(
        IReadOnlyList<string> Fields,
        string FieldSchemaKey,
        Dictionary<string, JsonElement> Values,
        string SourceFile);

    private static List<SampleRecord> CollectSampleRecords(string datasetPath, IReadOnlyList<string>? extensions)
    {
        var files = WalkDataset(datasetPath, extensions);
        var records = new List<SampleRecord>();
        foreach (var file in files)
        {
            if (records.Count >= MaxRecordsTotal) break;
            var remaining = Math.Min(MaxRecordsPerFile, MaxRecordsTotal - records.Count);
            try
            {
                records.AddRange(ReadRecordsFromFile(file, remaining));
            }
            catch
            {
                // best-effort detection
            }
        }
        return records;
    }

    internal static List<string> WalkDataset(string datasetPath, IReadOnlyList<string>? extensions)
    {
        var wantedExts = extensions is { Count: > 0 }
            ? new HashSet<string>(extensions.Select(e => e.ToLowerInvariant().TrimStart('.')), StringComparer.Ordinal)
            : null;

        var out_ = new List<string>();
        if (File.Exists(datasetPath))
        {
            var ext = Path.GetExtension(datasetPath).ToLowerInvariant().TrimStart('.');
            if (wantedExts is null || wantedExts.Contains(ext)) out_.Add(datasetPath);
            return out_;
        }

        if (!Directory.Exists(datasetPath)) return out_;

        void Walk(string dir)
        {
            foreach (var entry in Directory.GetFileSystemEntries(dir))
            {
                if (Directory.Exists(entry))
                {
                    Walk(entry);
                }
                else if (File.Exists(entry))
                {
                    var ext = Path.GetExtension(entry).ToLowerInvariant().TrimStart('.');
                    if (wantedExts is null || wantedExts.Contains(ext)) out_.Add(entry);
                }
            }
        }
        Walk(datasetPath);
        out_.Sort(StringComparer.Ordinal);
        return out_;
    }

    private static List<SampleRecord> ReadRecordsFromFile(string filePath, int max)
    {
        var ext = Path.GetExtension(filePath).ToLowerInvariant().TrimStart('.');
        var content = StripBom(File.ReadAllText(filePath));

        if (ext == "jsonl" || (ext == "json" && IsJsonLinesShape(content)))
            return ParseJsonl(content, filePath, max);
        if (ext == "json")
            return ParseJson(content, filePath, max);
        if (ext is "csv" or "tsv")
            return ParseTabular(content, filePath, max, ext == "tsv" ? "\t" : ",");

        // document-like → synthetic single 'content' record
        var truncated = content.Length > 2000 ? content[..2000] : content;
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["content"] = JsonSerializer.SerializeToElement(truncated),
        };
        return [new SampleRecord(["content"], "content", values, filePath)];
    }

    private static bool IsJsonLinesShape(string content)
    {
        try
        {
            using var _ = JsonDocument.Parse(content);
            return false;
        }
        catch (JsonException) { }

        var lines = content.Split('\n').Where(l => l.Trim().Length > 0).ToList();
        if (lines.Count < 2) return false;
        for (var i = 0; i < Math.Min(5, lines.Count); i++)
        {
            try
            {
                using var doc = JsonDocument.Parse(lines[i].Trim());
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            }
            catch (JsonException) { return false; }
        }
        return true;
    }

    private static List<SampleRecord> ParseJsonl(string content, string filePath, int max)
    {
        var out_ = new List<SampleRecord>();
        foreach (var line in content.Split('\n'))
        {
            if (out_.Count >= max) break;
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(trimmed);
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    out_.Add(MakeRecord(doc.RootElement, filePath));
                }
            }
            catch (JsonException) { }
        }
        return out_;
    }

    private static List<SampleRecord> ParseJson(string content, string filePath, int max)
    {
        JsonDocument? doc;
        try { doc = JsonDocument.Parse(content); }
        catch (JsonException) { return []; }

        using (doc)
        {
            if (doc.RootElement.ValueKind == JsonValueKind.Array)
            {
                var out_ = new List<SampleRecord>();
                foreach (var item in doc.RootElement.EnumerateArray())
                {
                    if (out_.Count >= max) break;
                    if (item.ValueKind == JsonValueKind.Object)
                        out_.Add(MakeRecord(item, filePath));
                }
                return out_;
            }
            if (doc.RootElement.ValueKind == JsonValueKind.Object)
            {
                return [MakeRecord(doc.RootElement, filePath)];
            }
        }
        return [];
    }

    private static List<SampleRecord> ParseTabular(string content, string filePath, int max, string delim)
    {
        var lines = content.Split('\n');
        if (lines.Length < 2) return [];
        var header = ParseDelimitedLine(lines[0], delim);
        if (header.Count == 0) return [];
        var out_ = new List<SampleRecord>();
        for (var i = 1; i < lines.Length && out_.Count < max; i++)
        {
            var raw = lines[i];
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var cells = ParseDelimitedLine(raw, delim);
            var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            for (var j = 0; j < header.Count; j++)
            {
                values[header[j]] = JsonSerializer.SerializeToElement(j < cells.Count ? cells[j] : string.Empty);
            }
            var fields = values.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            var key = string.Join("\u0000", fields);
            out_.Add(new SampleRecord(fields, key, values, filePath));
        }
        return out_;
    }

    private static List<string> ParseDelimitedLine(string line, string delim)
    {
        var out_ = new List<string>();
        var cur = new System.Text.StringBuilder();
        var inQuotes = false;
        for (var i = 0; i < line.Length; i++)
        {
            var ch = line[i];
            if (inQuotes)
            {
                if (ch == '"' && i + 1 < line.Length && line[i + 1] == '"') { cur.Append('"'); i++; }
                else if (ch == '"') inQuotes = false;
                else cur.Append(ch);
            }
            else
            {
                if (ch == '"') inQuotes = true;
                else if (line.AsSpan(i).StartsWith(delim)) { out_.Add(cur.ToString()); cur.Clear(); i += delim.Length - 1; }
                else cur.Append(ch);
            }
        }
        out_.Add(cur.ToString());
        return out_.Select(s => s.Trim()).ToList();
    }

    private static SampleRecord MakeRecord(JsonElement obj, string sourceFile)
    {
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var prop in obj.EnumerateObject())
        {
            values[prop.Name] = prop.Value.Clone();
        }
        var fields = values.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
        return new SampleRecord(fields, string.Join("\u0000", fields), values, sourceFile);
    }

    private static (IReadOnlyList<string> DominantSchema, double DominantSchemaShare, int DistinctSchemas)
        PickDominantSchema(List<SampleRecord> records)
    {
        var counts = new Dictionary<string, (IReadOnlyList<string> Fields, int Count)>(StringComparer.Ordinal);
        foreach (var r in records)
        {
            if (counts.TryGetValue(r.FieldSchemaKey, out var existing))
            {
                counts[r.FieldSchemaKey] = (existing.Fields, existing.Count + 1);
            }
            else
            {
                counts[r.FieldSchemaKey] = (r.Fields, 1);
            }
        }
        if (counts.Count == 0) return ([], 0, 0);
        var top = counts.Values.OrderByDescending(v => v.Count).First();
        return (top.Fields, (double)top.Count / records.Count, counts.Count);
    }

    private static List<TextRichField> PickTextRichFields(List<SampleRecord> dominantRecords, IReadOnlyList<string> schema)
    {
        var out_ = new List<TextRichField>();
        foreach (var field in schema)
        {
            var values = new List<string>();
            foreach (var r in dominantRecords)
            {
                if (!r.Values.TryGetValue(field, out var v)) continue;
                var s = StringifyValue(v);
                if (!string.IsNullOrEmpty(s)) values.Add(s);
            }
            if (values.Count < FieldMinObservations) continue;

            var proseCount = 0;
            var totalLen = 0L;
            var sampleValue = string.Empty;
            foreach (var v in values)
            {
                totalLen += v.Length;
                if (IsProseValue(v))
                {
                    proseCount++;
                    if (sampleValue.Length == 0 || v.Length > sampleValue.Length) sampleValue = v;
                }
            }
            var proseShare = (double)proseCount / values.Count;
            var averageLength = (double)totalLen / values.Count;
            if (proseShare >= ProseShareMin)
            {
                out_.Add(new TextRichField
                {
                    Field = field,
                    ProseShare = proseShare,
                    AverageLength = averageLength,
                    SampleValue = sampleValue.Length > 120 ? sampleValue[..120] + "\u2026" : sampleValue,
                });
            }
        }
        return out_.OrderByDescending(t => t.ProseShare).ToList();
    }

    private static string StringifyValue(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null => string.Empty,
        JsonValueKind.Undefined => string.Empty,
        JsonValueKind.String => v.GetString() ?? string.Empty,
        JsonValueKind.Number => v.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => string.Empty,
    };

    private static bool IsProseValue(string v)
    {
        if (v.Length < ProseMinLength) return false;
        if (!v.Any(char.IsWhiteSpace)) return false;
        if (UrlRe.IsMatch(v)) return false;
        if (GuidRe.IsMatch(v)) return false;
        if (EmailRe.IsMatch(v)) return false;
        if (JsonBlobRe.IsMatch(v)) return false;

        var letters = 0;
        var totalChars = 0;
        foreach (var rune in v.EnumerateRunes())
        {
            if (System.Text.Rune.IsWhiteSpace(rune)) continue;
            totalChars++;
            var category = System.Text.Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter
                or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter)
            {
                letters++;
            }
        }
        if (totalChars == 0) return false;
        return (double)letters / totalChars >= LetterRatioMin;
    }

    private static string ExplainDecision(
        int distinctSchemas, double dominantSchemaShare, IReadOnlyList<string> dominantSchema,
        List<TextRichField> textRichFields, int recordsSampled)
    {
        var sharePct = (dominantSchemaShare * 100).ToString("F1", CultureInfo.InvariantCulture);
        var parts = new List<string>
        {
            $"sampled {recordsSampled} records across {distinctSchemas} distinct schema{(distinctSchemas == 1 ? string.Empty : "s")}",
            $"dominant schema covers {sharePct}% ({dominantSchema.Count} field{(dominantSchema.Count == 1 ? string.Empty : "s")})",
        };
        if (textRichFields.Count == 0)
        {
            parts.Add("no text-rich fields detected");
        }
        else
        {
            var fieldList = string.Join(", ", textRichFields.Take(3).Select(f =>
                $"{f.Field} (prose {(f.ProseShare * 100).ToString("F0", CultureInfo.InvariantCulture)}%, avg {f.AverageLength.ToString("F0", CultureInfo.InvariantCulture)} chars)"));
            parts.Add($"text-rich fields: {fieldList}");
        }
        return string.Join("; ", parts);
    }

    private static string StripBom(string value) =>
        value.Length > 0 && value[0] == '\uFEFF' ? value[1..] : value;
}
