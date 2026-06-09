// Port of src/dataset-normalization.ts. Some source exports use newline-delimited
// JSON but keep a .json extension; EvalGen treats .json as a single JSON document.
// This module detects that disguised JSONL shape and converts to CSV so tabular
// records stay tabular, leaving other files untouched.

using System.IO;
using System.Text;
using System.Text.Json;

namespace Ccw.Core.Dataset;

public sealed record PreparedDataset
{
    public required string Dataset { get; init; }
    public IReadOnlyList<string>? Extensions { get; init; }
    public required IReadOnlyList<string> Diagnostics { get; init; }
}

public static class DatasetNormalization
{
    private static readonly HashSet<string> SupportedDiscoveryExtensions = new(StringComparer.Ordinal)
    {
        "csv", "tsv", "json", "jsonl", "xlsx", "xls", "docx", "pdf", "pptx", "txt", "md",
    };

    public static PreparedDataset PrepareDatasetForWorkflow(
        string datasetPath,
        string workspace,
        IReadOnlyList<string>? extensions = null)
    {
        var extensionFilter = extensions is { Count: > 0 }
            ? new HashSet<string>(extensions.Select(NormalizeExtension).Where(e => e.Length > 0), StringComparer.Ordinal)
            : null;
        var files = CollectDatasetFiles(datasetPath, extensionFilter);
        var jsonlJsonFiles = files
            .Where(f => f.Extension == "json" && IsJsonLinesFile(f.AbsolutePath))
            .ToList();

        if (jsonlJsonFiles.Count == 0)
        {
            return new PreparedDataset { Dataset = datasetPath, Extensions = extensions, Diagnostics = [] };
        }

        var stageDir = Path.Combine(workspace, "00-normalized-dataset");
        if (Directory.Exists(stageDir)) Directory.Delete(stageDir, recursive: true);
        Directory.CreateDirectory(stageDir);

        var effectiveExtensions = new HashSet<string>(StringComparer.Ordinal);
        var convertedRows = 0;
        var convertedSources = new HashSet<string>(jsonlJsonFiles.Select(f => f.AbsolutePath), StringComparer.OrdinalIgnoreCase);

        foreach (var file in files)
        {
            if (convertedSources.Contains(file.AbsolutePath))
            {
                var csvRelative = ReplaceExtension(file.RelativePath, ".csv");
                var csvPath = Path.Combine(stageDir, csvRelative);
                convertedRows += ConvertJsonLinesToCsv(file.AbsolutePath, csvPath);
                effectiveExtensions.Add("csv");
            }
            else
            {
                var dest = Path.Combine(stageDir, file.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(file.AbsolutePath, dest, overwrite: true);
                effectiveExtensions.Add(file.Extension);
            }
        }

        return new PreparedDataset
        {
            Dataset = stageDir,
            Extensions = effectiveExtensions.OrderBy(x => x, StringComparer.Ordinal).ToList(),
            Diagnostics =
            [
                $"normalized {jsonlJsonFiles.Count} .json JSONL file(s) to CSV ({convertedRows} row(s)) at {stageDir}",
            ],
        };
    }

    internal sealed record DatasetFile(string AbsolutePath, string RelativePath, string Extension);

    private static string NormalizeExtension(string value) =>
        value.Trim().ToLowerInvariant().TrimStart('.');

    internal static List<DatasetFile> CollectDatasetFiles(string datasetPath, HashSet<string>? extensionFilter)
    {
        var resolved = Path.GetFullPath(datasetPath);
        var files = new List<DatasetFile>();

        void Include(string absolutePath, string relativePath)
        {
            var ext = NormalizeExtension(Path.GetExtension(absolutePath));
            if (string.IsNullOrEmpty(ext) || !SupportedDiscoveryExtensions.Contains(ext)) return;
            if (extensionFilter is not null && !extensionFilter.Contains(ext)) return;
            files.Add(new DatasetFile(absolutePath, relativePath, ext));
        }

        if (File.Exists(resolved))
        {
            Include(resolved, Path.GetFileName(resolved));
            return files;
        }

        if (!Directory.Exists(resolved)) return files;

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
                    var rel = Path.GetRelativePath(resolved, entry);
                    Include(entry, rel);
                }
            }
        }

        Walk(resolved);
        return files.OrderBy(f => f.RelativePath, StringComparer.Ordinal).ToList();
    }

    public static bool IsJsonLinesFile(string filePath)
    {
        var content = StripBom(File.ReadAllText(filePath));
        try
        {
            using var _ = JsonDocument.Parse(content);
            return false;
        }
        catch (JsonException)
        {
            // continue with JSONL detection
        }

        var lines = content.Split('\n', '\r')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToList();
        if (lines.Count < 2) return false;

        foreach (var line in lines)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            }
            catch (JsonException) { return false; }
        }

        return true;
    }

    public static int ConvertJsonLinesToCsv(string inputPath, string outputPath)
    {
        var content = StripBom(File.ReadAllText(inputPath));
        var lines = content.Split('\n', '\r')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToList();

        var rows = new List<Dictionary<string, JsonElement>>();
        var columns = new List<string>();
        var columnsSeen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var line in lines)
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) continue;
            var row = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                row[prop.Name] = prop.Value.Clone();
                if (columnsSeen.Add(prop.Name)) columns.Add(prop.Name);
            }
            rows.Add(row);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        var sb = new StringBuilder();
        sb.Append(string.Join(",", columns.Select(CsvEscape)));
        foreach (var row in rows)
        {
            sb.Append('\n');
            sb.Append(string.Join(",", columns.Select(c =>
                CsvEscape(row.TryGetValue(c, out var v) ? StringifyCell(v) : string.Empty))));
        }
        sb.Append('\n');
        File.WriteAllText(outputPath, sb.ToString());
        return rows.Count;
    }

    private static string StringifyCell(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null => string.Empty,
        JsonValueKind.Undefined => string.Empty,
        JsonValueKind.String => v.GetString() ?? string.Empty,
        JsonValueKind.Number => v.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => v.GetRawText(),
    };

    private static string CsvEscape(string value)
    {
        if (value.IndexOfAny(['"', ',', '\r', '\n']) < 0) return value;
        return "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }

    private static string ReplaceExtension(string relativePath, string extension)
    {
        var dir = Path.GetDirectoryName(relativePath) ?? string.Empty;
        var name = Path.GetFileNameWithoutExtension(relativePath);
        return string.IsNullOrEmpty(dir) ? name + extension : Path.Combine(dir, name + extension);
    }

    private static string StripBom(string value) =>
        value.Length > 0 && value[0] == '\uFEFF' ? value[1..] : value;
}
