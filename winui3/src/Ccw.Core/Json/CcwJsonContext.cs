// Centralized System.Text.Json wiring for Ccw.Core.
//
// Why the explicit options:
//   * UnsafeRelaxedJsonEscaping    -> match JS JSON.stringify which does NOT
//                                     escape <, >, &, ', + or non-ASCII chars.
//                                     STJ default escapes them; would break
//                                     byte-equivalence with Node output.
//   * CamelCase                    -> TS interfaces use camelCase property
//                                     names; .NET records use PascalCase
//                                     members.
//   * WhenWritingNull              -> JSON.stringify omits undefined fields
//                                     entirely (no "key": null in the
//                                     output). Required to keep optional
//                                     fields out of the wire format.
//   * WriteIndented = false        -> JSON.stringify default, single-line.
//                                     Pretty-printed variants must be opted
//                                     into per call.
//   * Source generation            -> faster, AOT-safe, and pins the type
//                                     graph at compile time so silent
//                                     property-order regressions surface
//                                     as build failures.
//
// PARITY: any change here affects canonical hashes downstream.

using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Ccw.Core.Models;

namespace Ccw.Core.Json;

/// <summary>STJ source-gen context covering every Ccw.Core wire model.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(JobRecord))]
[JsonSerializable(typeof(JobConfig))]
[JsonSerializable(typeof(StepRecord))]
[JsonSerializable(typeof(ScoredReport))]
[JsonSerializable(typeof(PipelineDetection))]
[JsonSerializable(typeof(AuthConfig))]
[JsonSerializable(typeof(ScoreConfig))]
public partial class CcwJsonContext : JsonSerializerContext;

/// <summary>Pre-built singleton options. Use <see cref="Default"/> for compact
/// output (parity with Node <c>JSON.stringify(obj)</c>); use <see cref="Pretty"/>
/// for human-facing artifacts (parity with <c>JSON.stringify(obj, null, 2)</c>).</summary>
public static class CcwJsonOptions
{
    /// <summary>Compact JSON, byte-equivalent to <c>JSON.stringify(obj)</c>.</summary>
    public static JsonSerializerOptions Default { get; } = BuildOptions(indented: false);

    /// <summary>Pretty-printed JSON, byte-equivalent to <c>JSON.stringify(obj, null, 2)</c>.</summary>
    public static JsonSerializerOptions Pretty { get; } = BuildOptions(indented: true);

    private static JsonSerializerOptions BuildOptions(bool indented)
    {
        var opts = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = indented,
            // JS JSON.stringify uses LF regardless of OS. Without this,
            // STJ's indented writer on Windows emits CRLF and silently
            // breaks byte-equivalence with Node fixtures.
            NewLine = "\n",
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            TypeInfoResolver = CcwJsonContext.Default,
        };
        opts.MakeReadOnly();
        return opts;
    }
}
