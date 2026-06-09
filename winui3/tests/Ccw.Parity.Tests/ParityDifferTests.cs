// Phase 8 — tests for the parity diff harness itself.
//
// The full cross-runtime diff (running Node `ccw run` + C# `ccw run` and
// comparing artifacts) lives behind the CCW_PARITY_RUN_FIXTURES env flag
// because it requires both runtimes plus a sample dataset. These tests
// exercise the diff utility's classifier + canonicalizer in isolation so
// regressions in the layered strategy are caught even on CI runners
// without Node.

using System.Text;
using Xunit;

namespace Ccw.Parity.Tests;

public class ParityDifferTests
{
    [Theory]
    [InlineData("templates/connector-project/teamsapp.yml", ParityDiffMode.ByteExact)]
    [InlineData("workspace/jobs/abc/job.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/agent-response-scores.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/eval-set.evalgen.json", ParityDiffMode.CanonicalJson)]
    [InlineData("connector-project/node_modules/foo/index.js", ParityDiffMode.Skip)]
    [InlineData("connector-project/package-lock.json", ParityDiffMode.Skip)]
    [InlineData("connector-project/dist/x.tsbuildinfo", ParityDiffMode.Skip)]
    [InlineData("workspace/jobs/abc/step4.log", ParityDiffMode.Skip)]
    [InlineData("templates/deploy/provision.ps1", ParityDiffMode.ByteExact)]
    // GPT Phase 8 IMPORTANT 5: schema + deploy semantic JSON canonicalised.
    [InlineData("workspace/jobs/abc/03-schema/connector-schema.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/03-schema/schema-validation.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/05-deploy/resources.json", ParityDiffMode.CanonicalJson)]
    // Opus Phase 8 IMPORTANT 2: rendered connector-project package.json /
    // tsconfig get rewritten by npm install + tsc; canonicalise inside the
    // connector subtree only.
    [InlineData("workspace/jobs/abc/04-connector/connector-project/package.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/04-connector/connector-project/tsconfig.json", ParityDiffMode.CanonicalJson)]
    [InlineData("workspace/jobs/abc/04-connector/connector-project/tsconfig.build.json", ParityDiffMode.CanonicalJson)]
    public void Classify_ReturnsExpectedMode(string relPath, ParityDiffMode expected)
    {
        Assert.Equal(expected, ParityDiffer.DefaultClassify(relPath));
    }

    [Fact]
    public void ByteExact_EqualBytes_ReportsEqual()
    {
        var a = Encoding.UTF8.GetBytes("hello world\n");
        var b = Encoding.UTF8.GetBytes("hello world\n");
        var r = ParityDiffer.Diff("templates/x.ts", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void ByteExact_CrlfVsLf_ReportsNotEqual()
    {
        var a = Encoding.UTF8.GetBytes("hello world\r\n");
        var b = Encoding.UTF8.GetBytes("hello world\n");
        var r = ParityDiffer.Diff("templates/x.ts", a, b);
        Assert.False(r.Equal);
        Assert.Contains("byte-exact diff", r.Detail);
    }

    [Fact]
    public void CanonicalJson_KeyOrder_Ignored()
    {
        var a = Encoding.UTF8.GetBytes("""{"b":2,"a":1}""");
        var b = Encoding.UTF8.GetBytes("""{"a":1,"b":2}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void CanonicalJson_HtmlEscaping_Equalized()
    {
        // C# default STJ would escape `<`/`>`/`&` as \u003C etc;
        // UnsafeRelaxedJsonEscaping (which we use) does not. Both encodings
        // of the same content should canonicalize to the same string.
        var a = Encoding.UTF8.GetBytes("""{"x":"<b>&</b>"}""");
        var b = Encoding.UTF8.GetBytes("{\"x\":\"\\u003Cb\\u003E\\u0026\\u003C/b\\u003E\"}");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void CanonicalJson_TimestampDrift_Allowlisted()
    {
        var a = Encoding.UTF8.GetBytes("""{"createdAt":"2024-09-15T12:34:56.789Z","id":"abc"}""");
        var b = Encoding.UTF8.GetBytes("""{"createdAt":"2024-09-15T18:00:00Z","id":"abc"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void CanonicalJson_WorkspacePathDrift_Allowlisted()
    {
        var a = Encoding.UTF8.GetBytes("""{"workspace":"C:\\Users\\alice\\src\\CopilotConnectorWorkflow\\workspace\\jobs\\abc"}""");
        var b = Encoding.UTF8.GetBytes("""{"workspace":"C:\\Users\\bob\\AppData\\Local\\CopilotConnectorWorkflow\\workspace\\jobs\\abc"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void CanonicalJson_ValueDrift_ReportsNotEqual()
    {
        var a = Encoding.UTF8.GetBytes("""{"name":"alice","score":42}""");
        var b = Encoding.UTF8.GetBytes("""{"name":"alice","score":43}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.False(r.Equal);
        Assert.Contains("canonical-JSON diff", r.Detail);
    }

    [Fact]
    public void SkippedFiles_ReportEqual_RegardlessOfContent()
    {
        var a = Encoding.UTF8.GetBytes("alpha");
        var b = Encoding.UTF8.GetBytes("beta");
        var r = ParityDiffer.Diff("connector-project/node_modules/foo/index.js", a, b);
        Assert.True(r.Equal);
        Assert.Equal("(skipped)", r.Detail);
    }

    // ---- Opus + GPT Phase 8 fold-in tests ----

    [Fact]
    public void CanonicalJson_GuidsAreMaskedAsGuid_NotShreddedByHexId()
    {
        // Opus Phase 8 BLOCKER 1: regression test for HEX_ID-shadows-GUID.
        // Two different GUIDs in the same field should compare equal once
        // canonicalised + allowlisted.
        var a = Encoding.UTF8.GetBytes("""{"correlationId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}""");
        var b = Encoding.UTF8.GetBytes("""{"correlationId":"11111111-2222-3333-4444-555555555555"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    public void CanonicalJson_HashDriftIsCaught_NotMaskedByHexId()
    {
        // Opus Phase 8 BLOCKER 2 + GPT Phase 8 BLOCKER 2: the broad HEX_ID
        // regex was removed because it silently masked SHA-256 hash drift
        // (the very thing the harness is supposed to catch per plan §4.8).
        // 64-char SHA-256 hashes must compare unequal when they differ.
        var a = Encoding.UTF8.GetBytes("""{"datasetHash":"a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8"}""");
        var b = Encoding.UTF8.GetBytes("""{"datasetHash":"deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.False(r.Equal, "SHA-256 hash drift must be detected, not silently masked.");
        Assert.Contains("canonical-JSON diff", r.Detail);
    }

    [Fact]
    public void CanonicalJson_ShortCommitShaDriftIsCaught_NotMaskedByHexId()
    {
        // Same BLOCKER as above, additional shape: 8-char commit-SHA
        // prefixes are how plan §5 pins EvalToolkit reproducibility. Drift
        // here must be caught.
        var a = Encoding.UTF8.GetBytes("""{"evalToolkitCommit":"5e2d4a1f"}""");
        var b = Encoding.UTF8.GetBytes("""{"evalToolkitCommit":"deadbeef"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.False(r.Equal, "8-char commit-SHA pin drift must be detected.");
    }
}
