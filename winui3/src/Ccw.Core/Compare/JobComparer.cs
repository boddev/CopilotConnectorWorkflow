// Post-hoc job comparator ported from src/compare-jobs.ts.
//
// Loads two completed jobs' canonical scored reports, validates pre-conditions,
// and emits comparison-report.{json,md} + score-matrix.csv. Never renders,
// builds, provisions, ingests, or calls Copilot.
//
// Rounding uses JsMath.Round (parity with V8 Math.round; Opus B1).

using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ccw.Core.Jobs;
using Ccw.Core.Json;
using Ccw.Core.Models;
using Ccw.Core.Util;

namespace Ccw.Core.Compare;

public sealed record CompareOptions
{
    public required string JobIdA { get; init; }
    public required string JobIdB { get; init; }
    public required string OutputDir { get; init; }
}

public sealed record CompareResult
{
    public required string OutputDir { get; init; }
    public required string ReportJsonPath { get; init; }
    public required string ReportMdPath { get; init; }
    public required string ScoreMatrixPath { get; init; }
    public required bool Comparable { get; init; }
    public required bool SemanticComparable { get; init; }
    public required IReadOnlyList<string> Diagnostics { get; init; }
}

public static class JobComparer
{
    public static CompareResult RunCompare(CompareOptions options)
    {
        var diagnostics = new List<string>();
        var a = MustLoadJob(options.JobIdA);
        var b = MustLoadJob(options.JobIdB);

        var enhanced = a.Config.NoEnhance != true ? a : b.Config.NoEnhance != true ? b : null;
        var nonEnhanced = a.Config.NoEnhance == true ? a : b.Config.NoEnhance == true ? b : null;
        if (enhanced is null || nonEnhanced is null || enhanced.Id == nonEnhanced.Id)
        {
            throw new InvalidOperationException(
                $"compare requires exactly one job with noEnhance=true and one without. " +
                $"Got: {a.Id} noEnhance={a.Config.NoEnhance == true}, {b.Id} noEnhance={b.Config.NoEnhance == true}");
        }

        Directory.CreateDirectory(options.OutputDir);
        var comparable = true;

        if (enhanced.Config.Mode != RunMode.Provision || nonEnhanced.Config.Mode != RunMode.Provision)
        {
            diagnostics.Add("one or both jobs ran in build mode; build jobs have no scored report and are not comparable");
            comparable = false;
        }

        ScoredReport? enhancedReport = comparable ? MustLoadScoredReport(enhanced) : null;
        ScoredReport? nonEnhancedReport = comparable ? MustLoadScoredReport(nonEnhanced) : null;

        if (!string.IsNullOrEmpty(enhanced.DatasetHash) && !string.IsNullOrEmpty(nonEnhanced.DatasetHash)
            && enhanced.DatasetHash != nonEnhanced.DatasetHash)
        {
            diagnostics.Add($"datasetHash mismatch: enhanced={enhanced.DatasetHash} non-enhanced={nonEnhanced.DatasetHash}");
            comparable = false;
        }
        if (!string.IsNullOrEmpty(enhanced.EvalSetHash) && !string.IsNullOrEmpty(nonEnhanced.EvalSetHash)
            && enhanced.EvalSetHash != nonEnhanced.EvalSetHash)
        {
            diagnostics.Add($"evalSetHash mismatch: enhanced={enhanced.EvalSetHash} non-enhanced={nonEnhanced.EvalSetHash}");
            comparable = false;
        }

        var semanticComparable = false;
        if (enhancedReport is not null && nonEnhancedReport is not null)
        {
            if (enhancedReport.JudgeProvider == nonEnhancedReport.JudgeProvider)
            {
                semanticComparable = true;
            }
            else
            {
                diagnostics.Add(
                    $"judgeProvider differs: enhanced={ProviderName(enhancedReport.JudgeProvider)} " +
                    $"non-enhanced={ProviderName(nonEnhancedReport.JudgeProvider)}; " +
                    "semantic delta omitted. Deterministic and operational metrics are still reported.");
            }
        }

        var report = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["comparable"] = comparable,
            ["semanticComparable"] = semanticComparable,
            ["diagnostics"] = diagnostics,
            ["enhanced"] = SummarizeJob(enhanced, enhancedReport),
            ["nonEnhanced"] = SummarizeJob(nonEnhanced, nonEnhancedReport),
            ["deltas"] = comparable && enhancedReport is not null && nonEnhancedReport is not null
                ? BuildDeltas(enhancedReport, nonEnhancedReport, semanticComparable)
                : null,
            ["perQuestion"] = comparable && enhancedReport is not null && nonEnhancedReport is not null
                ? BuildPerQuestion(enhancedReport, nonEnhancedReport, semanticComparable)
                : null,
        };

        var reportJsonPath = Path.Combine(options.OutputDir, "comparison-report.json");
        var reportMdPath = Path.Combine(options.OutputDir, "comparison-report.md");
        var scoreMatrixPath = Path.Combine(options.OutputDir, "score-matrix.csv");
        File.WriteAllText(reportJsonPath, JsonSerializer.Serialize(report, CcwJsonOptions.Pretty) + "\n");
        File.WriteAllText(reportMdPath, RenderMarkdown(report, enhanced, nonEnhanced, enhancedReport, nonEnhancedReport));
        File.WriteAllText(scoreMatrixPath, RenderScoreMatrix(enhancedReport, nonEnhancedReport));

        return new CompareResult
        {
            OutputDir = options.OutputDir,
            ReportJsonPath = reportJsonPath,
            ReportMdPath = reportMdPath,
            ScoreMatrixPath = scoreMatrixPath,
            Comparable = comparable,
            SemanticComparable = semanticComparable,
            Diagnostics = diagnostics,
        };
    }

    private static JobRecord MustLoadJob(string jobId)
        => JobStore.LoadJob(jobId) ?? throw new InvalidOperationException($"job not found: {jobId}");

    private static ScoredReport MustLoadScoredReport(JobRecord job)
    {
        var file = Path.Combine(job.Workspace, "06-score", "agent-response-scores.json");
        if (!File.Exists(file))
            throw new InvalidOperationException(
                $"job {job.Id} has no scored report at {file} (Step 6 must complete in provision mode)");
        var json = File.ReadAllText(file);
        return JsonSerializer.Deserialize<ScoredReport>(json, CcwJsonOptions.Pretty)
            ?? throw new InvalidOperationException($"scored report deserialize returned null: {file}");
    }

    private static Dictionary<string, object?> SummarizeJob(JobRecord job, ScoredReport? report) =>
        new(StringComparer.Ordinal)
        {
            ["jobId"] = job.Id,
            ["connectorId"] = job.Config.ConnectorId,
            ["connectorName"] = job.Config.ConnectorName,
            ["noEnhance"] = job.Config.NoEnhance == true,
            ["datasetHash"] = job.DatasetHash,
            ["evalSetHash"] = job.EvalSetHash,
            ["mode"] = job.Config.Mode.ToString().ToLowerInvariant(),
            ["judgeProvider"] = report is null ? null : ProviderName(report.JudgeProvider),
            ["judgeModel"] = report?.JudgeModel,
            ["promptCount"] = report?.PromptCount,
            ["validPromptCount"] = report?.ValidPromptCount,
            ["deterministicAverage"] = report?.DeterministicScore.Average,
            ["semanticAverage"] = report?.SemanticScore.Average,
            ["citationRate"] = report?.CitationRate,
            ["retryCount"] = report?.RetryCount,
            ["rateLimitCount"] = report?.RateLimitCount,
            ["indexReadyAt"] = report?.IndexReadyAt,
            ["metadataProvenance"] = report?.MetadataProvenance,
        };

    private static Dictionary<string, object?> BuildDeltas(
        ScoredReport enhanced, ScoredReport nonEnhanced, bool semanticComparable)
    {
        var deltas = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["deterministicAverageDelta"] = RoundDelta(enhanced.DeterministicScore.Average - nonEnhanced.DeterministicScore.Average),
            ["citationRateDelta"] = RoundDelta(enhanced.CitationRate - nonEnhanced.CitationRate),
            ["retryCountDelta"] = enhanced.RetryCount - nonEnhanced.RetryCount,
            ["rateLimitCountDelta"] = enhanced.RateLimitCount - nonEnhanced.RateLimitCount,
            ["validPromptCountDelta"] = enhanced.ValidPromptCount - nonEnhanced.ValidPromptCount,
        };
        if (semanticComparable)
        {
            deltas["semanticAverageDelta"] = RoundDelta(enhanced.SemanticScore.Average - nonEnhanced.SemanticScore.Average);
            var byDim = new Dictionary<string, double>(StringComparer.Ordinal);
            var dimensions = new HashSet<string>(StringComparer.Ordinal);
            if (enhanced.SemanticScore.ByDimension is not null)
                foreach (var k in enhanced.SemanticScore.ByDimension.Keys) dimensions.Add(k);
            if (nonEnhanced.SemanticScore.ByDimension is not null)
                foreach (var k in nonEnhanced.SemanticScore.ByDimension.Keys) dimensions.Add(k);
            foreach (var d in dimensions)
            {
                var e = enhanced.SemanticScore.ByDimension?.TryGetValue(d, out var ev) == true ? ev : 0;
                var n = nonEnhanced.SemanticScore.ByDimension?.TryGetValue(d, out var nv) == true ? nv : 0;
                byDim[d] = RoundDelta(e - n);
            }
            deltas["semanticDimensionDeltas"] = byDim;
        }
        return deltas;
    }

    public sealed record PerQuestionRow
    {
        public required string Id { get; init; }
        public required string Prompt { get; init; }
        public QuestionSide? Enhanced { get; set; }
        public QuestionSide? NonEnhanced { get; set; }
        public double? DeterministicDelta { get; set; }
        public double? SemanticDelta { get; set; }
    }

    public sealed record QuestionSide(double Deterministic, double Semantic, string Status);

    private static List<PerQuestionRow> BuildPerQuestion(
        ScoredReport enhanced, ScoredReport nonEnhanced, bool semanticComparable)
    {
        var byId = new Dictionary<string, PerQuestionRow>(StringComparer.Ordinal);
        foreach (var item in enhanced.Items)
        {
            byId[item.Id] = new PerQuestionRow
            {
                Id = item.Id,
                Prompt = item.Prompt,
                Enhanced = new QuestionSide(item.Deterministic.Score, item.Semantic.Score,
                    item.Deterministic.Status.ToString().ToLowerInvariant()),
            };
        }
        foreach (var item in nonEnhanced.Items)
        {
            if (!byId.TryGetValue(item.Id, out var row))
            {
                row = new PerQuestionRow { Id = item.Id, Prompt = item.Prompt };
                byId[item.Id] = row;
            }
            row.NonEnhanced = new QuestionSide(item.Deterministic.Score, item.Semantic.Score,
                item.Deterministic.Status.ToString().ToLowerInvariant());
        }
        foreach (var row in byId.Values)
        {
            if (row.Enhanced is not null && row.NonEnhanced is not null)
            {
                row.DeterministicDelta = RoundDelta(row.Enhanced.Deterministic - row.NonEnhanced.Deterministic);
                if (semanticComparable)
                    row.SemanticDelta = RoundDelta(row.Enhanced.Semantic - row.NonEnhanced.Semantic);
            }
        }
        return byId.Values
            .OrderBy(r => r.Id, StringComparer.InvariantCulture)
            .ToList();
    }

    private static string RenderMarkdown(
        Dictionary<string, object?> report, JobRecord enhanced, JobRecord nonEnhanced,
        ScoredReport? enhancedReport, ScoredReport? nonEnhancedReport)
    {
        var lines = new List<string>
        {
            "# Comparison report", "",
            $"- comparable: **{((bool)report["comparable"]!).ToString().ToLowerInvariant()}**",
            $"- semanticComparable: **{((bool)report["semanticComparable"]!).ToString().ToLowerInvariant()}**",
            "",
        };
        if (report["diagnostics"] is List<string> diags && diags.Count > 0)
        {
            lines.Add("## Diagnostics"); lines.Add("");
            foreach (var d in diags) lines.Add($"- {d}");
            lines.Add("");
        }
        lines.Add("## Jobs"); lines.Add("");
        lines.Add("| | Enhanced | Non-enhanced |");
        lines.Add("|---|---|---|");
        lines.Add($"| Job id | `{enhanced.Id}` | `{nonEnhanced.Id}` |");
        lines.Add($"| Connector id | `{enhanced.Config.ConnectorId}` | `{nonEnhanced.Config.ConnectorId}` |");
        lines.Add($"| Judge provider | {Dash(enhancedReport?.JudgeProvider is { } eProv ? ProviderName(eProv) : null)} | {Dash(nonEnhancedReport?.JudgeProvider is { } nProv ? ProviderName(nProv) : null)} |");
        lines.Add($"| Deterministic average | {Dash(FormatNullableDouble(enhancedReport?.DeterministicScore.Average))} | {Dash(FormatNullableDouble(nonEnhancedReport?.DeterministicScore.Average))} |");
        lines.Add($"| Semantic average | {Dash(FormatNullableDouble(enhancedReport?.SemanticScore.Average))} | {Dash(FormatNullableDouble(nonEnhancedReport?.SemanticScore.Average))} |");
        lines.Add($"| Citation rate | {Dash(FormatNullableDouble(enhancedReport?.CitationRate))} | {Dash(FormatNullableDouble(nonEnhancedReport?.CitationRate))} |");
        lines.Add($"| Retry count | {Dash(FormatNullableInt(enhancedReport?.RetryCount))} | {Dash(FormatNullableInt(nonEnhancedReport?.RetryCount))} |");
        lines.Add($"| Rate-limit count | {Dash(FormatNullableInt(enhancedReport?.RateLimitCount))} | {Dash(FormatNullableInt(nonEnhancedReport?.RateLimitCount))} |");
        lines.Add($"| Index ready at | {Dash(enhancedReport?.IndexReadyAt)} | {Dash(nonEnhancedReport?.IndexReadyAt)} |");
        lines.Add("");

        if (report["deltas"] is Dictionary<string, object?> deltas)
        {
            lines.Add("## Deltas (enhanced \u2212 non-enhanced)"); lines.Add("");
            foreach (var (key, value) in deltas)
            {
                if (value is Dictionary<string, double>) continue;
                lines.Add($"- `{key}`: {FormatScalar(value)}");
            }
            if (deltas.TryGetValue("semanticDimensionDeltas", out var sdd) && sdd is Dictionary<string, double> dimDeltas)
            {
                lines.Add(""); lines.Add("### Semantic dimension deltas"); lines.Add("");
                foreach (var (dim, value) in dimDeltas)
                    lines.Add($"- {dim}: {value.ToString(CultureInfo.InvariantCulture)}");
            }
            lines.Add("");
        }

        if (enhancedReport?.MetadataProvenance is not null || nonEnhancedReport?.MetadataProvenance is not null)
        {
            lines.Add("## Metadata provenance"); lines.Add("");
            lines.Add("| | Enhanced | Non-enhanced |");
            lines.Add("|---|---|---|");
            var ep = enhancedReport?.MetadataProvenance;
            var np = nonEnhancedReport?.MetadataProvenance;
            lines.Add($"| Title from source | {Dash(FormatNullableDouble(ep?.TitleFromSource))} | {Dash(FormatNullableDouble(np?.TitleFromSource))} |");
            lines.Add($"| URL from source | {Dash(FormatNullableDouble(ep?.UrlFromSource))} | {Dash(FormatNullableDouble(np?.UrlFromSource))} |");
            lines.Add($"| Icon URL from source | {Dash(FormatNullableDouble(ep?.IconUrlFromSource))} | {Dash(FormatNullableDouble(np?.IconUrlFromSource))} |");
            lines.Add("");
        }
        return string.Join("\n", lines) + "\n";
    }

    private static string RenderScoreMatrix(ScoredReport? enhanced, ScoredReport? nonEnhanced)
    {
        const string header = "id,prompt,enhanced_deterministic,enhanced_semantic,enhanced_status,nonenhanced_deterministic,nonenhanced_semantic,nonenhanced_status,deterministic_delta,semantic_delta";
        if (enhanced is null || nonEnhanced is null) return header + "\n";
        var rows = BuildPerQuestion(enhanced, nonEnhanced, enhanced.JudgeProvider == nonEnhanced.JudgeProvider);
        var sb = new StringBuilder();
        sb.Append(header);
        foreach (var row in rows)
        {
            sb.Append('\n');
            sb.Append(CsvEscape(row.Id)); sb.Append(',');
            sb.Append(CsvEscape(row.Prompt)); sb.Append(',');
            sb.Append(NumOrEmpty(row.Enhanced?.Deterministic)); sb.Append(',');
            sb.Append(NumOrEmpty(row.Enhanced?.Semantic)); sb.Append(',');
            sb.Append(row.Enhanced?.Status ?? string.Empty); sb.Append(',');
            sb.Append(NumOrEmpty(row.NonEnhanced?.Deterministic)); sb.Append(',');
            sb.Append(NumOrEmpty(row.NonEnhanced?.Semantic)); sb.Append(',');
            sb.Append(row.NonEnhanced?.Status ?? string.Empty); sb.Append(',');
            sb.Append(NumOrEmpty(row.DeterministicDelta)); sb.Append(',');
            sb.Append(NumOrEmpty(row.SemanticDelta));
        }
        sb.Append('\n');
        return sb.ToString();
    }

    private static string NumOrEmpty(double? v) => v.HasValue ? v.Value.ToString(CultureInfo.InvariantCulture) : string.Empty;

    private static readonly Regex s_csvUnsafe = new("[,\"\\r\\n]", RegexOptions.Compiled);

    private static string CsvEscape(string value)
    {
        if (!s_csvUnsafe.IsMatch(value)) return value;
        return "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }

    private static string ProviderName(JudgeProvider provider) => provider switch
    {
        JudgeProvider.GitHubCopilot => "github-copilot",
        JudgeProvider.WorkIQ => "workiq",
        _ => provider.ToString().ToLowerInvariant(),
    };

    private static string Dash(string? value) => string.IsNullOrEmpty(value) ? "-" : value;

    private static string FormatScalar(object? value) => value switch
    {
        null => "null",
        double d => d.ToString(CultureInfo.InvariantCulture),
        int i => i.ToString(CultureInfo.InvariantCulture),
        long l => l.ToString(CultureInfo.InvariantCulture),
        bool b => b ? "true" : "false",
        _ => value.ToString() ?? string.Empty,
    };

    private static double RoundDelta(double value) => JsMath.Round(value * 10) / 10;

    private static string? FormatNullableDouble(double? value) =>
        value?.ToString(CultureInfo.InvariantCulture);

    private static string? FormatNullableInt(int? value) =>
        value?.ToString(CultureInfo.InvariantCulture);
}
