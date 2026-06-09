// Headless --diagnostics flag (plan Phase 8): emit a JSON report of the
// bootstrap dependency probes + ccw.exe self info + tool inventory. Used by:
//   - CI smoke that runs the CLI against a fresh runner image to confirm
//     the deps story matches the probe layer.
//   - The Phase 8 fresh-VM end-to-end smoke checklist (manual gate).
//   - Anyone who wants a one-shot machine-readable inventory without
//     parsing the human-readable `ccw tools` output.
//
// Output shape is intentionally stable — it's a contract that the CI
// workflow consumes. The schema lives next to the JSON itself
// (`schemaVersion`) so consumers can refuse to parse unfamiliar versions.
//
// The diagnostics writer ALWAYS emits a syntactically-valid JSON envelope
// to stdout, even when an internal probe throws — see Run()'s outer
// try/catch (Opus Phase 8 IMPORTANT 5). Consumers that parse stdout-as-
// JSON never get an empty body, only an "error" object alongside any
// partially-completed inventory.

using System.Text.Json;
using System.Text.Json.Serialization;
using Ccw.Bootstrap;
using Ccw.Core;
using Ccw.Core.Tools;

namespace Ccw.Cli.Commands;

internal static class DiagnosticsCommand
{
    public const string DiagnosticsSchemaVersion = "1";

    public static int Run(ParsedArgs args)
    {
        ArgumentNullException.ThrowIfNull(args);

        DiagnosticsReport report;
        try
        {
            report = BuildReport(args);
        }
        catch (Exception ex)
        {
            // Opus Phase 8 IMPORTANT 5: still emit a valid JSON envelope on
            // probe-layer failure so CI consumers that parse stdout-as-JSON
            // never get an empty body. Exit 1 distinguishes from probe-
            // reported "one or more deps missing" only via the .error.type.
            report = new DiagnosticsReport
            {
                SchemaVersion = DiagnosticsSchemaVersion,
                Cli = SafeCliInfo(),
                Dependencies = [],
                Tools = [],
                AllOk = false,
                Error = new DiagnosticsError
                {
                    Type = ex.GetType().FullName ?? ex.GetType().Name,
                    Message = ex.Message,
                },
            };
            WriteReport(report);
            return 1;
        }

        WriteReport(report);
        return report.AllOk ? 0 : 1;
    }

    private static DiagnosticsReport BuildReport(ParsedArgs args)
    {
        var srcRoot = args.Flag("src-root");
        var options = string.IsNullOrEmpty(srcRoot)
            ? new BootstrapOptions()
            : new BootstrapOptions { SrcRoot = srcRoot };

        var probes = DependencyProbes.ProbeAll(options);

        // GPT Phase 8 IMPORTANT 4: include the `ccw tools` inventory so a
        // diagnostics-only CI gate also catches missing runtime tooling
        // (templates root, EvalGen / EvalScore paths, etc.) instead of
        // requiring a separate `ccw tools` invocation. The contract is
        // that `allOk = probes-OK AND tools-OK` so CI gating on the exit
        // code remains a single signal.
        IReadOnlyList<ToolStatus> toolStatuses;
        try
        {
            toolStatuses = ToolResolver.Probe();
        }
        catch (Exception ex)
        {
            toolStatuses = [new ToolStatus
            {
                Name = "tool-resolver",
                Path = string.Empty,
                Ok = false,
                Note = $"ToolResolver.Probe() threw: {ex.GetType().Name}: {ex.Message}",
            }];
        }

        var probesOk = probes.All(p => p.Present && p.MeetsMinimumVersion);
        var toolsOk = toolStatuses.All(t => t.Ok);

        return new DiagnosticsReport
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
            Tools = toolStatuses.Select(t => new DiagnosticsTool
            {
                Name = t.Name,
                Path = t.Path,
                Ok = t.Ok,
                Note = t.Note,
            }).ToList(),
            // Overall exit status: 0 iff every dependency is present AND
            // meets its minimum version AND every tool is OK. CI smoke uses
            // the exit code, not the JSON, as its gate.
            AllOk = probesOk && toolsOk,
        };
    }

    private static DiagnosticsCliInfo SafeCliInfo()
    {
        // Used when the main probe path threw. Best-effort; values may
        // themselves throw if the environment is wildly broken, in which
        // case the outer envelope writer falls through to a minimal one.
        try
        {
            return new DiagnosticsCliInfo
            {
                Version = CoreInfo.Version,
                SchemaVersion = CoreInfo.SchemaVersion,
                ProcessPath = Environment.ProcessPath ?? string.Empty,
                OsVersion = Environment.OSVersion.ToString(),
                ProcessArchitecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
            };
        }
        catch
        {
            return new DiagnosticsCliInfo
            {
                Version = "unknown",
                SchemaVersion = "unknown",
                ProcessPath = string.Empty,
                OsVersion = "unknown",
                ProcessArchitecture = "unknown",
            };
        }
    }

    private static void WriteReport(DiagnosticsReport report)
    {
        var json = JsonSerializer.Serialize(report, DiagnosticsJsonContext.Default.DiagnosticsReport);
        Console.WriteLine(json);
    }
}

internal sealed class DiagnosticsReport
{
    [JsonPropertyName("schemaVersion")] public required string SchemaVersion { get; init; }
    [JsonPropertyName("cli")] public required DiagnosticsCliInfo Cli { get; init; }
    [JsonPropertyName("dependencies")] public required IReadOnlyList<DiagnosticsProbe> Dependencies { get; init; }
    [JsonPropertyName("tools")] public required IReadOnlyList<DiagnosticsTool> Tools { get; init; }
    [JsonPropertyName("allOk")] public required bool AllOk { get; init; }
    [JsonPropertyName("error")] public DiagnosticsError? Error { get; init; }
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

internal sealed class DiagnosticsTool
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("path")] public required string Path { get; init; }
    [JsonPropertyName("ok")] public required bool Ok { get; init; }
    [JsonPropertyName("note")] public string? Note { get; init; }
}

internal sealed class DiagnosticsError
{
    [JsonPropertyName("type")] public required string Type { get; init; }
    [JsonPropertyName("message")] public required string Message { get; init; }
}

[JsonSerializable(typeof(DiagnosticsReport))]
[JsonSourceGenerationOptions(
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class DiagnosticsJsonContext : JsonSerializerContext
{
}
