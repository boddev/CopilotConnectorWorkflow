// Port of src/scoring.ts. Step 6 deterministic + local-semantic scoring.
//
// Produces 06-score/agent-response-scores.json + .md from an evalgen JSON
// (item set) plus one or more per-agent response CSVs. The JSON shape is
// the canonical persisted artifact consumed by `compare-jobs` and by the
// UI, so byte-equivalence with the Node output matters.
//
// PARITY NOTES (vs TS):
// * containsValue uses Unicode NFKD + diacritic strip + ASCII regex with
//   lookbehind. .NET supports lookbehind. Diacritic stripping is done by
//   removing Unicode chars whose category is NonSpacingMark after NFKD.
// * roundPct = round(x * 1000) / 10. JS Math.round is half-away-from-zero;
//   we match using MidpointRounding.AwayFromZero.
// * NO_RESULT_PATTERNS list matches src/scoring.ts. Folded match.
// * Local semantic F1: 2*p*r/(p+r), tokens are lowercased NFKD letters,
//   length>1, split on non [a-z0-9.].

using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Ccw.Core.Scoring;

/// <summary>One agent's response CSV plus identifying metadata.</summary>
public sealed record ScoreAgentConfig
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string ConnectorId { get; init; }
    public required string ResponseCsv { get; init; }
}

/// <summary>Top-level entry point. Mirrors TS scoreResponseSet.</summary>
public static class ResponseScorer
{
    private static readonly string[] NoResultPatterns =
    [
        "no matching",
        "not found",
        "unable to return",
        "was not located",
        "no records found",
        "could not find",
    ];

    /// <summary>Reads evalgen.json + per-agent CSVs, writes
    /// <c>agent-response-scores.json</c> + <c>agent-response-scores.md</c>
    /// under <paramref name="outputDir"/>.</summary>
    public static void ScoreResponseSet(string evalgenJson, IReadOnlyList<ScoreAgentConfig> agents, string outputDir)
    {
        var evalItems = ReadEvalItems(evalgenJson);
        var agentsPayload = new Dictionary<string, object>(StringComparer.Ordinal);
        var payload = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["methodology"] = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["deterministic_grounding_score"] = "80% EvalGen must-contain assertion coverage + 20% supporting-fact value coverage",
                ["semantic_quality_score"] = "Local semantic quality fallback: token-overlap F1 between expected and actual answer, separate from deterministic grounding.",
                ["matching"] = "Case-insensitive, Unicode-normalized, punctuation/spacing-tolerant matching; whole-word assertions enforce token boundaries.",
            },
            ["agents"] = agentsPayload,
        };

        foreach (var agent in agents)
        {
            var rows = ReadCsv(agent.ResponseCsv);
            var scored = new List<Dictionary<string, object?>>(evalItems.Count);
            for (var i = 0; i < evalItems.Count; i++)
            {
                var row = i < rows.Count ? rows[i] : new Dictionary<string, string>(StringComparer.Ordinal);
                scored.Add(ScoreItem(evalItems[i], row, i + 1));
            }

            agentsPayload[agent.Key] = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["summary"] = Summarize(agent, scored),
                ["items"] = scored,
                ["category_summary"] = SummarizeCategories(scored),
            };
        }

        Directory.CreateDirectory(outputDir);
        var json = JsonSerializer.Serialize(payload, ScoringJsonOptions);
        File.WriteAllText(Path.Combine(outputDir, "agent-response-scores.json"), json + "\n");
        File.WriteAllText(Path.Combine(outputDir, "agent-response-scores.md"), RenderMarkdown(payload, agents));
    }

    private static readonly JsonSerializerOptions ScoringJsonOptions = new()
    {
        WriteIndented = true,
        NewLine = "\n",
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    internal sealed class EvalItem
    {
        public string? id { get; set; }
        public string? prompt { get; set; }
        public string? expected_answer { get; set; }
        public string? expectedAnswer { get; set; }
        public List<EvalAssertion>? assertions { get; set; }
        public List<string>? supporting_facts { get; set; }
        public List<string>? supportingFacts { get; set; }
        public string? category { get; set; }
        public string? difficulty { get; set; }
    }

    internal sealed class EvalAssertion
    {
        public string? value { get; set; }
        public bool? wholeWord { get; set; }
    }

    private static List<EvalItem> ReadEvalItems(string filePath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(filePath));
        if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException($"EvalGen JSON has no items array: {filePath}");
        }
        var out_ = new List<EvalItem>(items.GetArrayLength());
        foreach (var item in items.EnumerateArray())
        {
            out_.Add(item.Deserialize<EvalItem>() ?? new EvalItem());
        }
        return out_;
    }

    private static Dictionary<string, object?> ScoreItem(EvalItem item, Dictionary<string, string> row, int index)
    {
        var response = row.GetValueOrDefault("actual_answer") ?? string.Empty;
        var assertions = item.assertions ?? [];
        var assertionResults = new List<Dictionary<string, object?>>(assertions.Count);
        foreach (var a in assertions)
        {
            var value = a.value ?? string.Empty;
            assertionResults.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["value"] = value,
                ["passed"] = ContainsValue(response, value, a.wholeWord == true),
                ["whole_word"] = a.wholeWord == true,
            });
        }

        var facts = NormalizeFacts(item.supporting_facts ?? item.supportingFacts ?? []);
        var factResults = new List<Dictionary<string, object?>>();
        foreach (var fact in facts)
        {
            var (_, value) = ParseFact(fact);
            if (string.IsNullOrEmpty(value)) continue;
            factResults.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["value"] = value,
                ["passed"] = ContainsValue(response, value, IsShortCode(value)),
            });
        }

        var assertionsTotal = assertionResults.Count;
        var assertionsPassed = assertionResults.Count(r => (bool)r["passed"]!);
        var factsTotal = factResults.Count;
        var factsPassed = factResults.Count(r => (bool)r["passed"]!);
        var expected = item.expected_answer ?? item.expectedAnswer ?? row.GetValueOrDefault("expected_answer") ?? string.Empty;
        var expectedNoResult = HasNoResultLanguage(expected);
        var responseNoResult = HasNoResultLanguage(response);

        double assertionScore = 0, factScore = 0, deterministicScore = 0;
        string status = "fail";
        if (assertionsTotal > 0)
        {
            assertionScore = (double)assertionsPassed / assertionsTotal;
            factScore = factsTotal > 0 ? (double)factsPassed / factsTotal : assertionScore;
            deterministicScore = (0.8 * assertionScore) + (0.2 * factScore);
            status = assertionsPassed == assertionsTotal ? "pass" : assertionsPassed > 0 ? "partial" : "fail";
        }
        else if (factsTotal > 0)
        {
            assertionScore = (double)factsPassed / factsTotal;
            factScore = assertionScore;
            deterministicScore = factScore;
            status = factsPassed == factsTotal ? "pass" : factsPassed > 0 ? "partial" : "fail";
        }
        else if (expectedNoResult)
        {
            assertionScore = responseNoResult ? 1 : 0;
            factScore = assertionScore;
            deterministicScore = assertionScore;
            status = responseNoResult ? "pass" : "fail";
        }

        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["index"] = index,
            ["id"] = item.id ?? string.Empty,
            ["category"] = item.category ?? string.Empty,
            ["difficulty"] = item.difficulty ?? string.Empty,
            ["prompt"] = item.prompt ?? row.GetValueOrDefault("prompt") ?? string.Empty,
            ["expected_answer"] = expected,
            ["actual_answer"] = response,
            ["assertions"] = assertionResults,
            ["supporting_facts"] = factResults,
            ["assertions_passed"] = assertionsPassed,
            ["assertions_total"] = assertionsTotal,
            ["facts_passed"] = factsPassed,
            ["facts_total"] = factsTotal,
            ["deterministic_grounding_score"] = RoundPct(deterministicScore),
            ["semantic_quality_score"] = RoundPct(LocalSemanticQuality(expected, response)),
            ["semantic_quality_provider"] = "local-token-overlap",
            ["assertion_score"] = RoundPct(assertionScore),
            ["fact_score"] = RoundPct(factScore),
            ["status"] = status,
            ["has_citation"] = HasCitation(response),
            ["has_no_result_language"] = responseNoResult,
            ["expected_no_result"] = expectedNoResult,
            ["failed_checks"] = assertionResults.Where(r => !(bool)r["passed"]!).Select(r => r["value"]).ToList(),
        };
    }

    private static Dictionary<string, object?> Summarize(ScoreAgentConfig agent, List<Dictionary<string, object?>> scores)
    {
        var deterministic = scores.Select(s => ToDouble(s["deterministic_grounding_score"])).ToList();
        var semantic = scores.Select(s => ToDouble(s["semantic_quality_score"])).ToList();
        var totalA = Sum(scores, "assertions_total");
        var passedA = Sum(scores, "assertions_passed");
        var totalF = Sum(scores, "facts_total");
        var passedF = Sum(scores, "facts_passed");
        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["agent"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["key"] = agent.Key,
                ["name"] = agent.Name,
                ["connector_id"] = agent.ConnectorId,
            },
            ["prompt_count"] = scores.Count,
            ["average_deterministic_grounding_score"] = Average(deterministic),
            ["average_semantic_quality_score"] = Average(semantic),
            ["assertion_pass_rate"] = totalA > 0 ? RoundPct((double)passedA / totalA) : 100.0,
            ["assertions_passed"] = passedA,
            ["assertions_total"] = totalA,
            ["fact_pass_rate"] = totalF > 0 ? RoundPct((double)passedF / totalF) : 100.0,
            ["facts_passed"] = passedF,
            ["facts_total"] = totalF,
            ["pass_count"] = scores.Count(s => (string?)s["status"] == "pass"),
            ["partial_count"] = scores.Count(s => (string?)s["status"] == "partial"),
            ["fail_count"] = scores.Count(s => (string?)s["status"] == "fail"),
            ["citation_count"] = scores.Count(s => (bool)s["has_citation"]!),
        };
    }

    private static Dictionary<string, object?> SummarizeCategories(List<Dictionary<string, object?>> scores)
    {
        var categories = scores.Select(CategoryOf).Distinct(StringComparer.Ordinal).OrderBy(c => c, StringComparer.Ordinal).ToList();
        var out_ = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var c in categories)
        {
            var items = scores.Where(s => CategoryOf(s) == c).ToList();
            out_[c] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["count"] = items.Count,
                ["average_deterministic_grounding_score"] = Average(items.Select(i => ToDouble(i["deterministic_grounding_score"])).ToList()),
                ["average_semantic_quality_score"] = Average(items.Select(i => ToDouble(i["semantic_quality_score"])).ToList()),
            };
        }
        return out_;
    }

    private static string CategoryOf(Dictionary<string, object?> s)
    {
        var v = s["category"]?.ToString();
        return string.IsNullOrEmpty(v) ? "uncategorized" : v;
    }

    private static string RenderMarkdown(Dictionary<string, object> payload, IReadOnlyList<ScoreAgentConfig> agents)
    {
        var lines = new List<string>
        {
            "# Agent Response Scoring",
            string.Empty,
            "Scores include deterministic grounding and a separate semantic quality score.",
            string.Empty,
            "| Agent | Connector | Avg grounding | Avg semantic quality | Assertions passed | Fact pass rate | Pass | Partial | Fail |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|",
        };
        var agentsPayload = (Dictionary<string, object>)payload["agents"];
        foreach (var agent in agents)
        {
            if (!agentsPayload.TryGetValue(agent.Key, out var raw)) continue;
            var summary = (Dictionary<string, object?>)((Dictionary<string, object>)raw)["summary"]!;
            lines.Add($"| {agent.Name} | `{agent.ConnectorId}` | {summary["average_deterministic_grounding_score"]}% | " +
                $"{summary["average_semantic_quality_score"]}% | {summary["assertions_passed"]}/{summary["assertions_total"]} | " +
                $"{summary["fact_pass_rate"]}% | {summary["pass_count"]} | {summary["partial_count"]} | {summary["fail_count"]} |");
        }
        return string.Join("\n", lines) + "\n";
    }

    // -- TEXT NORMALIZATION & MATCHING ---------------------------------

    /// <summary>NFKD + strip nonspacing marks + lowercase. Mirrors TS
    /// <c>value.normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase()</c>.</summary>
    public static string FoldText(string value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var nfkd = value.Normalize(NormalizationForm.FormKD);
        var sb = new StringBuilder(nfkd.Length);
        foreach (var ch in nfkd)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(ch);
        }
        return sb.ToString().ToLowerInvariant();
    }

    /// <summary>Folded + all non-alphanumerics removed.</summary>
    public static string Compact(string value) =>
        NonAlnumRegex.Replace(FoldText(value), string.Empty);

    private static readonly Regex NonAlnumRegex = new("[^a-z0-9]+", RegexOptions.Compiled);

    public static bool ContainsValue(string response, string expected, bool wholeWord)
    {
        if (string.IsNullOrEmpty(expected)) return true;
        var foldedResp = FoldText(response);
        var foldedExp = FoldText(expected);
        if (wholeWord || IsShortCode(expected))
        {
            var pattern = $"(?<![a-z0-9]){Regex.Escape(foldedExp)}(?![a-z0-9])";
            if (Regex.IsMatch(foldedResp, pattern)) return true;
        }
        return foldedResp.Contains(foldedExp, StringComparison.Ordinal)
            || Compact(response).Contains(Compact(expected), StringComparison.Ordinal);
    }

    public static double LocalSemanticQuality(string expected, string actual)
    {
        var e = TokenSet(expected);
        var a = TokenSet(actual);
        if (e.Count == 0) return a.Count == 0 ? 1.0 : 0.0;
        if (a.Count == 0) return 0.0;
        var overlap = e.Count(t => a.Contains(t));
        var precision = (double)overlap / a.Count;
        var recall = (double)overlap / e.Count;
        return precision + recall == 0 ? 0 : (2 * precision * recall) / (precision + recall);
    }

    private static HashSet<string> TokenSet(string value)
    {
        var folded = FoldText(value);
        var tokens = Regex.Split(folded, "[^a-z0-9.]+");
        return [.. tokens.Where(t => t.Length > 1)];
    }

    public static bool IsShortCode(string value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        var stripped = Regex.Replace(value, "[^A-Za-z0-9]", string.Empty);
        return stripped.Length > 1 && stripped.Length <= 3
            && stripped.Equals(stripped.ToUpperInvariant(), StringComparison.Ordinal);
    }

    public static bool HasNoResultLanguage(string value)
    {
        var folded = FoldText(value);
        return NoResultPatterns.Any(p => folded.Contains(p, StringComparison.Ordinal));
    }

    public static bool HasCitation(string value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        return value.Contains("\ue200cite", StringComparison.Ordinal)
            || value.Contains("cite", StringComparison.Ordinal)
            || Regex.IsMatch(value, @"\[\^\d+\^\]");
    }

    private static IEnumerable<string> NormalizeFacts(IEnumerable<string> facts) =>
        facts.Where(f => f is not null && !string.IsNullOrWhiteSpace(f));

    public static (string Key, string Value) ParseFact(string fact)
    {
        var i = fact.IndexOf('=');
        return i < 0 ? (string.Empty, fact.Trim()) : (fact[..i].Trim(), fact[(i + 1)..].Trim());
    }

    // -- CSV PARSER (matches TS parseCsv) ------------------------------

    public static List<Dictionary<string, string>> ReadCsv(string filePath)
    {
        var rows = ParseCsv(File.ReadAllText(filePath));
        if (rows.Count == 0) return [];
        var header = rows[0];
        var data = new List<Dictionary<string, string>>(rows.Count - 1);
        for (var i = 1; i < rows.Count; i++)
        {
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var j = 0; j < header.Count; j++)
            {
                dict[header[j]] = j < rows[i].Count ? rows[i][j] : string.Empty;
            }
            data.Add(dict);
        }
        return data;
    }

    public static List<List<string>> ParseCsv(string content)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var inQuotes = false;
        var text = StripBom(content);
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (ch == '"')
            {
                if (inQuotes && i + 1 < text.Length && text[i + 1] == '"')
                {
                    cell.Append('"');
                    i++;
                }
                else
                {
                    inQuotes = !inQuotes;
                }
            }
            else if (ch == ',' && !inQuotes)
            {
                row.Add(cell.ToString());
                cell.Clear();
            }
            else if ((ch == '\n' || ch == '\r') && !inQuotes)
            {
                if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                row.Add(cell.ToString());
                rows.Add(row);
                row = [];
                cell.Clear();
            }
            else
            {
                cell.Append(ch);
            }
        }
        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            rows.Add(row);
        }
        return rows.Where(cells => cells.Any(v => !string.IsNullOrWhiteSpace(v))).ToList();
    }

    private static string StripBom(string s) =>
        s.Length > 0 && s[0] == '\uFEFF' ? s[1..] : s;

    // -- ARITHMETIC ----------------------------------------------------

    /// <summary>JS Math.round(value * 1000) / 10. Half-away-from-zero per
    /// ECMAScript spec. We use AwayFromZero to match.</summary>
    public static double RoundPct(double value) =>
        Ccw.Core.Util.JsMath.Round(value * 1000) / 10;

    public static double Average(IReadOnlyList<double> values) =>
        values.Count == 0
            ? 0
            : Ccw.Core.Util.JsMath.Round((values.Sum() / values.Count) * 10) / 10;

    private static int Sum(List<Dictionary<string, object?>> values, string key) =>
        values.Sum(v => ToInt(v[key]));

    private static double ToDouble(object? v) => v switch
    {
        null => 0,
        double d => d,
        int i => i,
        long l => l,
        _ => double.TryParse(v.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : 0,
    };

    private static int ToInt(object? v) => v switch
    {
        null => 0,
        int i => i,
        long l => (int)l,
        double d => (int)d,
        _ => int.TryParse(v.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var n) ? n : 0,
    };
}
