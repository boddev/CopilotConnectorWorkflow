// Locks Phase 1a's parity contract: a known-good Node JobRecord fixture
// must deserialize cleanly into Ccw.Core.Models.JobRecord and re-serialize
// to the EXACT same bytes (LF-normalized).
//
// This is the gate for every downstream slice. If the serializer drops a
// property, reorders fields, escapes a character JS doesn't, or emits a
// "key": null for an absent optional, the round-trip diff fails and the
// canonical-hash work in slice 1b is built on sand.

using System.Text;
using System.Text.Json;
using Ccw.Core.Json;
using Ccw.Core.Models;
using Xunit;

namespace Ccw.Core.Tests.Json;

public class JobJsonRoundtripTests
{
    private static readonly string FixturesDir = Path.Combine(
        AppContext.BaseDirectory, "Fixtures");

    [Fact]
    public void MetadataProvenance_FractionalFields_RoundtripWithoutTruncation()
    {
        // GPT review BLOCKER: TS `titleFromSource: number` is a 0..1
        // fraction (round3(itemsWithSourceTitle / itemCount)). If we
        // ever stored these as int, the JSON `0.6` would silently parse
        // as `0` and re-emit as `0`, hiding real provenance signal.
        const string json = """
            {
              "titleFromSource": 0.6,
              "urlFromSource": 0.875,
              "iconUrlFromSource": 0,
              "schemaPropertiesPromotedToSearchable": 4,
              "schemaPropertiesPromotedToRefinable": 2
            }
            """;

        var rec = JsonSerializer.Deserialize<MetadataProvenance>(json, CcwJsonOptions.Pretty);
        Assert.NotNull(rec);
        Assert.Equal(0.6, rec.TitleFromSource);
        Assert.Equal(0.875, rec.UrlFromSource);
        Assert.Equal(0.0, rec.IconUrlFromSource);
    }

    [Fact]
    public void Roundtrip_BuildModeWithDetection_BytesMatchFixture()
    {
        var path = Path.Combine(FixturesDir, "job-build-mode-with-detection.json");
        var expectedBytes = NormalizeLf(File.ReadAllBytes(path));
        var expectedText = Encoding.UTF8.GetString(expectedBytes);

        var record = JsonSerializer.Deserialize<JobRecord>(expectedText, CcwJsonOptions.Pretty)
            ?? throw new InvalidOperationException("Deserialization returned null.");

        var actualText = JsonSerializer.Serialize(record, CcwJsonOptions.Pretty);
        var actualBytes = Encoding.UTF8.GetBytes(actualText);

        // Byte-for-byte compare. Any drift = parity break.
        Assert.Equal(expectedText, actualText);
        Assert.Equal(expectedBytes, actualBytes);
    }

    [Fact]
    public void EnumsSerialize_AsKebabOrCamelCaseStrings_NotIntegers()
    {
        // Defensive: STJ's default enum serializer is integer-based. The
        // source-generation context MUST set UseStringEnumConverter = true
        // and the [JsonStringEnumMemberName] attributes drive the wire form.
        var record = MinimalJob() with
        {
            Config = MinimalConfig() with
            {
                DeployTarget = DeployTarget.AzureContainerApps,
                Mode = RunMode.Provision,
                AclMode = AclMode.EveryoneExceptGuests,
            },
        };

        var json = JsonSerializer.Serialize(record, CcwJsonOptions.Default);

        Assert.Contains("\"deployTarget\":\"azure-container-apps\"", json, StringComparison.Ordinal);
        Assert.Contains("\"mode\":\"provision\"", json, StringComparison.Ordinal);
        Assert.Contains("\"aclMode\":\"everyoneExceptGuests\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"deployTarget\":1", json, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalDeployTarget_Serializes_AsLocalString()
    {
        // Parity contract: DeployTarget.Local must serialize to the TS literal
        // 'local' (src/types.ts), never an integer, so job.json round-trips
        // through the Node CCW and the parity harness.
        var record = MinimalJob() with
        {
            Config = MinimalConfig() with { DeployTarget = DeployTarget.Local },
        };

        var json = JsonSerializer.Serialize(record, CcwJsonOptions.Default);
        Assert.Contains("\"deployTarget\":\"local\"", json, StringComparison.Ordinal);

        var back = JsonSerializer.Deserialize<JobRecord>(json, CcwJsonOptions.Default);
        Assert.Equal(DeployTarget.Local, back!.Config.DeployTarget);
    }

    [Fact]
    public void AbsentOptionals_AreOmitted_NotSerializedAsNull()
    {
        // JSON.stringify omits undefined fields entirely. STJ's default would
        // emit "key": null. WhenWritingNull on the serializer flips that.
        var record = MinimalJob();

        var json = JsonSerializer.Serialize(record, CcwJsonOptions.Default);

        Assert.DoesNotContain("\"datasetHash\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"evalSetHash\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("null", json, StringComparison.Ordinal);
    }

    [Fact]
    public void PropertyOrder_MatchesTypescriptDeclaration()
    {
        // First-cut check: the top-level JobRecord property order matches
        // src/types.ts. A finer-grained snapshot is the fixture test above.
        var json = JsonSerializer.Serialize(MinimalJob(), CcwJsonOptions.Default);

        var idIdx = json.IndexOf("\"id\":", StringComparison.Ordinal);
        var createdAtIdx = json.IndexOf("\"createdAt\":", StringComparison.Ordinal);
        var updatedAtIdx = json.IndexOf("\"updatedAt\":", StringComparison.Ordinal);
        var statusIdx = json.IndexOf("\"status\":", StringComparison.Ordinal);
        var configIdx = json.IndexOf("\"config\":", StringComparison.Ordinal);
        var stepsIdx = json.IndexOf("\"steps\":", StringComparison.Ordinal);
        var workspaceIdx = json.IndexOf("\"workspace\":", StringComparison.Ordinal);

        Assert.True(idIdx < createdAtIdx);
        Assert.True(createdAtIdx < updatedAtIdx);
        Assert.True(updatedAtIdx < statusIdx);
        Assert.True(statusIdx < configIdx);
        Assert.True(configIdx < stepsIdx);
        Assert.True(stepsIdx < workspaceIdx);
    }

    [Fact]
    public void UnescapedCharacters_AreEmittedRaw_NotEscaped()
    {
        // JS JSON.stringify does NOT escape <, >, &, ', + or non-ASCII.
        // STJ default does. UnsafeRelaxedJsonEscaping on the encoder is
        // what makes the bytes match.
        var record = MinimalJob() with
        {
            Config = MinimalConfig() with
            {
                Description = "ngo & environment <wiki> 'é' +data",
            },
        };

        var json = JsonSerializer.Serialize(record, CcwJsonOptions.Default);

        Assert.Contains("ngo & environment <wiki> 'é' +data", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\\u0026", json, StringComparison.Ordinal); // &
        Assert.DoesNotContain("\\u003C", json, StringComparison.Ordinal); // <
        Assert.DoesNotContain("\\u0027", json, StringComparison.Ordinal); // '
    }

    [Fact]
    public void StepNames_AllConstant_MatchesEnumDeclarationOrder()
    {
        // Insertion order into JobRecord.Steps comes from StepNames.All.
        // Locking the constant prevents accidental reordering.
        Assert.Equal(
            [StepName.EvalGen, StepName.Enhance, StepName.Schema,
             StepName.Connector, StepName.Deploy, StepName.Score],
            StepNames.All);
    }

    private static JobRecord MinimalJob() => new()
    {
        Id = "20251031t170422-test",
        CreatedAt = "2025-10-31T17:04:22.123Z",
        UpdatedAt = "2025-10-31T17:04:22.123Z",
        Status = JobStatus.Pending,
        Config = MinimalConfig(),
        Steps = new Dictionary<StepName, StepRecord>
        {
            [StepName.EvalGen] = new() { Name = StepName.EvalGen, Status = StepStatus.Pending },
            [StepName.Enhance] = new() { Name = StepName.Enhance, Status = StepStatus.Pending },
            [StepName.Schema] = new() { Name = StepName.Schema, Status = StepStatus.Pending },
            [StepName.Connector] = new() { Name = StepName.Connector, Status = StepStatus.Pending },
            [StepName.Deploy] = new() { Name = StepName.Deploy, Status = StepStatus.Pending },
            [StepName.Score] = new() { Name = StepName.Score, Status = StepStatus.Pending },
        },
        Workspace = "C:\\workspace",
    };

    private static JobConfig MinimalConfig() => new()
    {
        Dataset = "data/test",
        Description = "test dataset",
        Count = 10,
        ConnectorId = "test",
        ConnectorName = "Test",
        DeployTarget = DeployTarget.AzureFunctions,
        Mode = RunMode.Build,
        AclMode = AclMode.Everyone,
    };

    private static byte[] NormalizeLf(byte[] input)
    {
        // .gitattributes should keep the fixture as LF, but a fresh clone
        // on a CRLF-default host could still flip it. Strip stray CRs so
        // the byte compare is meaningful.
        if (Array.IndexOf(input, (byte)'\r') < 0)
        {
            return input;
        }

        var output = new byte[input.Length];
        var write = 0;
        foreach (var b in input)
        {
            if (b == (byte)'\r')
            {
                continue;
            }

            output[write++] = b;
        }

        Array.Resize(ref output, write);
        return output;
    }
}
