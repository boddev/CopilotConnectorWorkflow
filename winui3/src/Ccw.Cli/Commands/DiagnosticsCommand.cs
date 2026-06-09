// Headless --diagnostics flag (plan Phase 8): emit a JSON report of the
// bootstrap dependency probes + ccw.exe self info. Used by:
//   - CI smoke that runs the CLI against a fresh runner image to confirm
//     the deps story matches the probe layer.
//   - The Phase 8 fresh-VM end-to-end smoke checklist (manual gate).
//   - Anyone who wants a one-shot machine-readable inventory without
//     parsing the human-readable `ccw tools` output.
//
// Output shape is intentionally stable — it's a contract that the CI
// workflow consumes. The schema lives next to the JSON itself
// (`schemaVersion`) so consumers can refuse to parse unfamiliar versions.

using System.Text.Json;
using System.Text.Json.Serialization;
using Ccw.Bootstrap;
using Ccw.Core;

namespace Ccw.Cli.Commands;

internal static class DiagnosticsCommand
{
    public const string DiagnosticsSchemaVersion = "1";

    public static int Run(ParsedArgs args)
    {
        ArgumentNullException.ThrowIfNull(args);

        var srcRoot = args.Flag("src-root");
        var options = string.IsNullOrEmpty(srcRoot)
            ? new BootstrapOptions()
            : new BootstrapOptions { SrcRoot = srcRoot };

        var probes = DependencyProbes.ProbeAll(options);

        var report = new DiagnosticsReport
        {
            SchemaVersion = DiagnosticsSchemaVersion,
            Cli = new DiagnosticsCliInfo
            {
                Version = CoreInfo.Version,
                SchemaVersion = CoreInfo.SchemaVersion,
                ProcessPath = Environment.ProcessPath ?? string.Empty,
                OsVersion = Environment.OSVersion.ToString(),
                ProcessArchitecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
            },
            Dependencies = probes.Select(p => new DiagnosticsProbe
            {
                Name = p.Name,
                DisplayName = p.DisplayName,
                Present = p.Present,
                Version = p.Version,
                ExpectedMinimumVersion = p.ExpectedMinimumVersion,
                MeetsMinimumVersion = p.MeetsMinimumVersion,
                Path = p.Path,
                RequiredAction = p.RequiredAction?.ToString(),
                Note = p.Note,
            }).ToList(),
            // Overall exit status: 0 iff every dependency is present AND
            // meets its minimum version. The CI smoke uses the exit code,
            // not the JSON, as its gate.
            AllOk = probes.All(p => p.Present && p.MeetsMinimumVersion),
        };

        var json = JsonSerializer.Serialize(report, DiagnosticsJsonContext.Default.DiagnosticsReport);
        Console.WriteLine(json);

        return report.AllOk ? 0 : 1;
    }
}

internal sealed class DiagnosticsReport
{
    [JsonPropertyName("schemaVersion")] public required string SchemaVersion { get; init; }
    [JsonPropertyName("cli")] public required DiagnosticsCliInfo Cli { get; init; }
    [JsonPropertyName("dependencies")] public required IReadOnlyList<DiagnosticsProbe> Dependencies { get; init; }
    [JsonPropertyName("allOk")] public required bool AllOk { get; init; }
}

internal sealed class DiagnosticsCliInfo
{
    [JsonPropertyName("version")] public required string Version { get; init; }
    [JsonPropertyName("schemaVersion")] public required string SchemaVersion { get; init; }
    [JsonPropertyName("processPath")] public required string ProcessPath { get; init; }
    [JsonPropertyName("osVersion")] public required string OsVersion { get; init; }
    [JsonPropertyName("processArchitecture")] public required string ProcessArchitecture { get; init; }
}

internal sealed class DiagnosticsProbe
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("displayName")] public required string DisplayName { get; init; }
    [JsonPropertyName("present")] public required bool Present { get; init; }
    [JsonPropertyName("version")] public string? Version { get; init; }
    [JsonPropertyName("expectedMinimumVersion")] public string? ExpectedMinimumVersion { get; init; }
    [JsonPropertyName("meetsMinimumVersion")] public required bool MeetsMinimumVersion { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
    [JsonPropertyName("requiredAction")] public string? RequiredAction { get; init; }
    [JsonPropertyName("note")] public string? Note { get; init; }
}

[JsonSerializable(typeof(DiagnosticsReport))]
[JsonSourceGenerationOptions(
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class DiagnosticsJsonContext : JsonSerializerContext
{
}
