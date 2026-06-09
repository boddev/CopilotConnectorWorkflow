// Schema validator ported from src/steps/step3-schema.ts.
//
// Pure C# port of the schema-hardening + validation logic. Step engine wiring
// (orchestrator hooks, file IO, step records) lives in Ccw.Steps proper; this
// file ships the pure functions that the engine + tests both call.

using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ccw.Steps.Schema;

#pragma warning disable CA1720 // Identifier 'String'/'Int64'/'Double' matches Graph API parity names.
public enum GraphPropertyType
{
    String, Int64, Double, DateTime, Boolean, StringCollection,
}
#pragma warning restore CA1720


public sealed class GraphProperty
{
    public string Name { get; set; } = string.Empty;
    public GraphPropertyType Type { get; set; }
    public bool? IsSearchable { get; set; }
    public bool? IsQueryable { get; set; }
    public bool? IsRetrievable { get; set; }
    public bool? IsRefinable { get; set; }
    public bool? IsExactMatchRequired { get; set; }
    public List<string>? Labels { get; set; }
    public List<string>? Aliases { get; set; }
}

public sealed class GraphConnectorSchema
{
    public string BaseType { get; set; } = "microsoft.graph.externalItem";
    public List<GraphProperty> Properties { get; set; } = [];
}

public sealed record ValidationIssue(string Severity, string Message);

public static class SchemaValidator
{
    private static readonly Regex s_nameRe = new("^[A-Za-z][A-Za-z0-9]{0,31}$", RegexOptions.Compiled);
    private static readonly Regex s_aliasRe = new("^[A-Za-z][A-Za-z0-9]{0,31}$", RegexOptions.Compiled);
    private static readonly Regex s_urlSafeRe = new("^[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=-]+$", RegexOptions.Compiled);
    private static readonly Regex s_camelCaseRe = new("[^A-Za-z0-9]+([A-Za-z0-9]?)", RegexOptions.Compiled);

    private const int MaxItemBytes = 4 * 1024 * 1024;

    public static GraphConnectorSchema HardenSchema(IReadOnlyList<JsonElement> suggestionProps)
    {
        var namesSeen = new HashSet<string>(StringComparer.Ordinal);
        var labelsSeen = new HashSet<string>(StringComparer.Ordinal);
        var output = new List<GraphProperty>();

        foreach (var p in suggestionProps)
        {
            if (p.ValueKind != JsonValueKind.Object) continue;
            var rawName = GetStringField(p, "name") ?? string.Empty;
            var name = SanitizeName(rawName);
            if (string.IsNullOrEmpty(name) || namesSeen.Contains(name)) continue;
            namesSeen.Add(name);

            var type = CoerceType(GetStringField(p, "type") ?? "String");
            var isQueryable = GetBoolField(p, "isQueryable", true);
            var isRetrievable = GetBoolField(p, "isRetrievable", true);
            var wantsRefinable = GetBoolField(p, "isRefinable", false);
            var isSearchable = GetBoolField(p, "isSearchable", type == GraphPropertyType.String);
            var hasExactMatch = GetBoolField(p, "isExactMatchRequired", false);
            if (hasExactMatch && isSearchable) isSearchable = false;
            var finalRefinable = wantsRefinable && !isSearchable;

            var prop = new GraphProperty
            {
                Name = name,
                Type = type,
                IsSearchable = isSearchable,
                IsQueryable = isQueryable,
                IsRetrievable = isRetrievable,
            };
            if (finalRefinable) prop.IsRefinable = true;
            if (hasExactMatch) prop.IsExactMatchRequired = true;

            foreach (var label in CollectLabels(p, name))
            {
                if (labelsSeen.Add(label))
                {
                    prop.Labels ??= [];
                    prop.Labels.Add(label);
                }
            }
            if (prop.Labels is { Count: > 0 } && prop.IsRetrievable != true) prop.IsRetrievable = true;

            var aliases = CollectAliases(p);
            if (aliases.Count > 0) prop.Aliases = aliases;

            if (output.Count < 128) output.Add(prop);
        }

        EnsureLabel(output, "title", "title");
        EnsureLabel(output, "url", "url");
        SoftEnsureIconUrl(output);
        if (output.Count > 128) output.RemoveRange(128, output.Count - 128);

        return new GraphConnectorSchema { BaseType = "microsoft.graph.externalItem", Properties = output };
    }

    public static string SanitizeName(string raw)
    {
        var s = s_camelCaseRe.Replace(raw, m =>
        {
            var next = m.Groups[1].Value;
            return next.Length == 0 ? string.Empty : next.ToUpperInvariant();
        });
        if (s.Length == 0 || !char.IsLetter(s[0])) s = "p" + s;
        return s.Length > 32 ? s[..32] : s;
    }

    public static GraphPropertyType CoerceType(string raw)
    {
        var v = raw.ToLowerInvariant();
        if (v.StartsWith("int", StringComparison.Ordinal)) return GraphPropertyType.Int64;
        if (v is "double" or "number" or "float") return GraphPropertyType.Double;
        if (v is "datetime" or "date") return GraphPropertyType.DateTime;
        if (v is "boolean" or "bool") return GraphPropertyType.Boolean;
        if (v is "stringcollection" or "string[]") return GraphPropertyType.StringCollection;
        return GraphPropertyType.String;
    }

    private static List<string> CollectLabels(JsonElement p, string propName)
    {
        var output = new List<string>();
        var single = GetStringField(p, "semanticLabel") ?? GetStringField(p, "label");
        if (!string.IsNullOrEmpty(single)) output.Add(single);
        if (p.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array)
        {
            foreach (var l in labels.EnumerateArray())
                if (l.ValueKind == JsonValueKind.String && l.GetString() is { } s) output.Add(s);
        }
        if (propName == "title" && !output.Contains("title", StringComparer.Ordinal)) output.Add("title");
        if (propName == "url" && !output.Contains("url", StringComparer.Ordinal)) output.Add("url");
        return output;
    }

    public static List<string> CollectAliases(JsonElement p)
    {
        var output = new List<string>();
        void AddAlias(string value)
        {
            if (!s_aliasRe.IsMatch(value)) return;
            if (!output.Contains(value, StringComparer.Ordinal)) output.Add(value);
        }

        if (p.TryGetProperty("aliases", out var aliases))
        {
            if (aliases.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in aliases.EnumerateArray())
                    if (a.ValueKind == JsonValueKind.String && a.GetString() is { Length: > 0 } s) AddAlias(s);
            }
            else if (aliases.ValueKind == JsonValueKind.String && aliases.GetString() is { Length: > 0 } str)
            {
                foreach (var a in str.Split(',').Select(t => t.Trim()).Where(t => t.Length > 0)) AddAlias(a);
            }
        }
        if (p.TryGetProperty("alternateNames", out var alt) && alt.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in alt.EnumerateArray())
                if (a.ValueKind == JsonValueKind.String && a.GetString() is { Length: > 0 } s) AddAlias(s);
        }
        return output;
    }

    private static void EnsureLabel(List<GraphProperty> props, string propName, string label)
    {
        if (props.Any(p => p.Labels?.Contains(label) == true)) return;
        var named = props.FirstOrDefault(p => p.Name == propName);
        if (named is not null)
        {
            named.Labels ??= [];
            named.Labels.Add(label);
            named.IsRetrievable = true;
        }
        else
        {
            props.Insert(0, new GraphProperty
            {
                Name = propName,
                Type = GraphPropertyType.String,
                IsSearchable = label == "title",
                IsQueryable = true,
                IsRetrievable = true,
                Labels = [label],
            });
        }
    }

    public static void SoftEnsureIconUrl(List<GraphProperty> props)
    {
        if (props.Any(p => p.Labels?.Contains("iconUrl") == true)) return;
        var candidate = props.FirstOrDefault(p => p.Name is "iconUrl" or "icon_url" or "iconurl");
        if (candidate is not null)
        {
            candidate.Labels ??= [];
            candidate.Labels.Add("iconUrl");
            candidate.IsRetrievable = true;
        }
    }

    public static List<ValidationIssue> ValidateSchema(GraphConnectorSchema schema)
    {
        var issues = new List<ValidationIssue>();
        if (schema.Properties.Count > 128)
            issues.Add(new ValidationIssue("error", $">128 properties ({schema.Properties.Count})"));

        foreach (var p in schema.Properties)
        {
            if (p.IsSearchable == true && p.IsRefinable == true)
                issues.Add(new ValidationIssue("error", $"property '{p.Name}' has both searchable and refinable (mutually exclusive)"));
            if (p.Labels is { Count: > 0 } && p.IsRetrievable != true)
                issues.Add(new ValidationIssue("error", $"property '{p.Name}' has labels but is not retrievable"));
            if (!s_nameRe.IsMatch(p.Name))
                issues.Add(new ValidationIssue("error", $"property name '{p.Name}' invalid (must match ^[A-Za-z][A-Za-z0-9]{{0,31}}$)"));
            if (string.Equals(p.Name, "content", StringComparison.OrdinalIgnoreCase))
                issues.Add(new ValidationIssue("error", $"'content' is a reserved property; do not declare it in the schema"));

            foreach (var alias in p.Aliases ?? [])
            {
                if (!s_aliasRe.IsMatch(alias))
                    issues.Add(new ValidationIssue("error", $"property '{p.Name}' alias '{alias}' invalid (must match ^[A-Za-z][A-Za-z0-9]{{0,31}}$)"));
            }
        }

        var labelCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var p in schema.Properties)
        {
            foreach (var l in p.Labels ?? [])
                labelCounts[l] = labelCounts.GetValueOrDefault(l) + 1;
        }
        foreach (var (l, n) in labelCounts)
            if (n > 1) issues.Add(new ValidationIssue("error", $"label '{l}' assigned to {n} properties (must be exactly one)"));
        if (!labelCounts.ContainsKey("title"))
            issues.Add(new ValidationIssue("error", "no property has the 'title' semantic label"));
        if (!labelCounts.ContainsKey("url"))
            issues.Add(new ValidationIssue("error", "no property has the 'url' semantic label"));
        if (!labelCounts.ContainsKey("iconUrl"))
            issues.Add(new ValidationIssue("warning", "no property has the 'iconUrl' semantic label \u2014 add an iconUrl property to improve search result appearance"));
        return issues;
    }

    public static List<ValidationIssue> ValidateItemSample(string jsonlPath, GraphConnectorSchema schema, int sampleSize)
    {
        var propByName = schema.Properties.ToDictionary(p => p.Name, p => p, StringComparer.Ordinal);
        var issues = new List<ValidationIssue>();
        var lines = ReadJsonlSample(jsonlPath, sampleSize);
        var lineNo = 0;
        foreach (var line in lines)
        {
            lineNo++;
            JsonElement item;
            try { item = JsonDocument.Parse(line).RootElement.Clone(); }
            catch (JsonException)
            {
                issues.Add(new ValidationIssue("error", $"line {lineNo}: not valid JSON"));
                continue;
            }

            if (!item.TryGetProperty("id", out var idElem) || idElem.ValueKind != JsonValueKind.String)
            {
                issues.Add(new ValidationIssue("error", $"line {lineNo}: missing string 'id'"));
            }
            else
            {
                var idStr = idElem.GetString()!;
                if (!s_urlSafeRe.IsMatch(idStr))
                    issues.Add(new ValidationIssue("warning", $"line {lineNo}: id '{idStr}' may not be URL-safe"));
            }

            var size = Encoding.UTF8.GetByteCount(line);
            if (size > MaxItemBytes)
                issues.Add(new ValidationIssue("error", $"line {lineNo}: item exceeds 4MB ({size} bytes)"));

            if (item.TryGetProperty("properties", out var props) && props.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in props.EnumerateObject())
                {
                    if (!propByName.TryGetValue(SanitizeName(prop.Name), out var schemaProp)) continue;
                    if (prop.Value.ValueKind == JsonValueKind.Null) continue;
                    if (!MatchesType(prop.Value, schemaProp.Type))
                        issues.Add(new ValidationIssue("warning",
                            $"line {lineNo}: property '{prop.Name}' value type does not match schema ({schemaProp.Type})"));
                }
            }
        }
        if (lines.Count == 0) issues.Add(new ValidationIssue("error", "enhanced-items.jsonl is empty"));
        return DedupeIssues(issues);
    }

    private static List<string> ReadJsonlSample(string jsonlPath, int sampleSize)
    {
        var lines = new List<string>();
        using var reader = new StreamReader(jsonlPath);
        string? line;
        while ((line = reader.ReadLine()) is not null && lines.Count < sampleSize)
        {
            if (!string.IsNullOrWhiteSpace(line)) lines.Add(line);
        }
        return lines;
    }

    private static bool MatchesType(JsonElement v, GraphPropertyType t) => t switch
    {
        GraphPropertyType.String => v.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False,
        GraphPropertyType.Int64 => v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out _),
        GraphPropertyType.Double => v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var dd) && !double.IsNaN(dd) && !double.IsInfinity(dd),
        GraphPropertyType.Boolean => v.ValueKind is JsonValueKind.True or JsonValueKind.False,
        GraphPropertyType.DateTime => v.ValueKind == JsonValueKind.String && DateTime.TryParse(v.GetString(), out _),
        GraphPropertyType.StringCollection => v.ValueKind == JsonValueKind.Array && v.EnumerateArray().All(x => x.ValueKind == JsonValueKind.String),
        _ => true,
    };

    private static readonly Regex s_lineNoRe = new("line \\d+", RegexOptions.Compiled);

    private static List<ValidationIssue> DedupeIssues(List<ValidationIssue> issues)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var output = new List<ValidationIssue>();
        foreach (var i in issues)
        {
            var key = i.Severity + "|" + s_lineNoRe.Replace(i.Message, "line *");
            if (seen.Add(key)) output.Add(i);
        }
        return output;
    }

    private static string? GetStringField(JsonElement element, string name) =>
        element.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool GetBoolField(JsonElement element, string name, bool fallback) =>
        element.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean()
            : fallback;
}
