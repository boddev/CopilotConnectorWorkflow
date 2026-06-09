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
    internal void Classify_ReturnsExpectedMode(string relPath, ParityDiffMode expected)
    {
        Assert.Equal(expected, ParityDiffer.DefaultClassify(relPath));
    }

    [Fact]
    internal void ByteExact_EqualBytes_ReportsEqual()
    {
        var a = Encoding.UTF8.GetBytes("hello world\n");
        var b = Encoding.UTF8.GetBytes("hello world\n");
        var r = ParityDiffer.Diff("templates/x.ts", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    internal void ByteExact_CrlfVsLf_ReportsNotEqual()
    {
        var a = Encoding.UTF8.GetBytes("hello world\r\n");
        var b = Encoding.UTF8.GetBytes("hello world\n");
        var r = ParityDiffer.Diff("templates/x.ts", a, b);
        Assert.False(r.Equal);
        Assert.Contains("byte-exact diff", r.Detail);
    }

    [Fact]
    internal void CanonicalJson_KeyOrder_Ignored()
    {
        var a = Encoding.UTF8.GetBytes("""{"b":2,"a":1}""");
        var b = Encoding.UTF8.GetBytes("""{"a":1,"b":2}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    internal void CanonicalJson_HtmlEscaping_Equalized()
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
    internal void CanonicalJson_TimestampDrift_Allowlisted()
    {
        var a = Encoding.UTF8.GetBytes("""{"createdAt":"2024-09-15T12:34:56.789Z","id":"abc"}""");
        var b = Encoding.UTF8.GetBytes("""{"createdAt":"2024-09-15T18:00:00Z","id":"abc"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    internal void CanonicalJson_WorkspacePathDrift_Allowlisted()
    {
        var a = Encoding.UTF8.GetBytes("""{"workspace":"C:\\Users\\alice\\src\\CopilotConnectorWorkflow\\workspace\\jobs\\abc"}""");
        var b = Encoding.UTF8.GetBytes("""{"workspace":"C:\\Users\\bob\\AppData\\Local\\CopilotConnectorWorkflow\\workspace\\jobs\\abc"}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.True(r.Equal, r.Detail);
    }

    [Fact]
    internal void CanonicalJson_ValueDrift_ReportsNotEqual()
    {
        var a = Encoding.UTF8.GetBytes("""{"name":"alice","score":42}""");
        var b = Encoding.UTF8.GetBytes("""{"name":"alice","score":43}""");
        var r = ParityDiffer.Diff("workspace/jobs/x/job.json", a, b);
        Assert.False(r.Equal);
        Assert.Contains("canonical-JSON diff", r.Detail);
    }

    [Fact]
    internal void SkippedFiles_ReportEqual_RegardlessOfContent()
    {
        var a = Encoding.UTF8.GetBytes("alpha");
        var b = Encoding.UTF8.GetBytes("beta");
        var r = ParityDiffer.Diff("connector-project/node_modules/foo/index.js", a, b);
        Assert.True(r.Equal);
        Assert.Equal("(skipped)", r.Detail);
    }
}
