using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ccw.Core.Models;
using Ccw.Core.Util;
using Ccw.Steps.Engines;
using Xunit;

namespace Ccw.Steps.Tests.Engines;

public sealed class NodeStepShimTests
{
    [Fact]
    public void TryResolveContained_AcceptsRelativeUnderRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-shim-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        try
        {
            var ok = NodeStepShim.TryResolveContained(root, "02-enhance/items.jsonl", out var abs);
            Assert.True(ok);
            Assert.StartsWith(Path.GetFullPath(root), abs, StringComparison.OrdinalIgnoreCase);
        }
        finally { try { Directory.Delete(root, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryResolveContained_RejectsTraversal()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-shim-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        try
        {
            var escaped = NodeStepShim.TryResolveContained(root, "../../etc/passwd", out _);
            Assert.False(escaped);
        }
        finally { try { Directory.Delete(root, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryResolveContained_RejectsAbsolutePathOutsideRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-shim-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        try
        {
            var outside = Path.GetTempPath(); // parent of root
            var ok = NodeStepShim.TryResolveContained(root, outside, out _);
            Assert.False(ok);
        }
        finally { try { Directory.Delete(root, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryResolveContained_PrefixCheck_RejectsSiblingNamePrefix()
    {
        var root = Path.Combine(Path.GetTempPath(), "ccw-shim-" + Path.GetRandomFileName());
        Directory.CreateDirectory(root);
        try
        {
            // sibling whose name STARTS WITH root's name must not pass
            // (no separator between rootFull and the rest of the path).
            var sibling = root + "-sibling";
            var ok = NodeStepShim.TryResolveContained(root, sibling + "/file.txt", out _);
            Assert.False(ok);
        }
        finally { try { Directory.Delete(root, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryReadResultEnvelope_ReturnsNullOnInvalidJson()
    {
        var path = Path.Combine(Path.GetTempPath(), "ccw-res-" + Path.GetRandomFileName() + ".json");
        File.WriteAllText(path, "not json {");
        try
        {
            var env = NodeStepShim.TryReadResultEnvelope(path);
            Assert.Null(env);
        }
        finally { try { File.Delete(path); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryReadResultEnvelope_ReturnsNullOnMissingFile()
    {
        var env = NodeStepShim.TryReadResultEnvelope(Path.Combine(Path.GetTempPath(), "ccw-no-such-result-" + Path.GetRandomFileName()));
        Assert.Null(env);
    }

    [Fact]
    public void TryReadResultEnvelope_ReturnsNullOnSchemaVersionMismatch()
    {
        var path = Path.Combine(Path.GetTempPath(), "ccw-res-" + Path.GetRandomFileName() + ".json");
        File.WriteAllText(path, "{\"schemaVersion\":999,\"step\":\"enhance\",\"status\":\"done\",\"exitCode\":0,\"artifacts\":[]}");
        try
        {
            Assert.Null(NodeStepShim.TryReadResultEnvelope(path));
        }
        finally { try { File.Delete(path); } catch { /* swallow */ } }
    }

    [Fact]
    public void TryReadResultEnvelope_ParsesValidEnvelope()
    {
        var path = Path.Combine(Path.GetTempPath(), "ccw-res-" + Path.GetRandomFileName() + ".json");
        File.WriteAllText(path,
            "{\"schemaVersion\":1,\"step\":\"enhance\",\"status\":\"done\",\"exitCode\":0," +
            "\"artifacts\":[{\"path\":\"02-enhance/items.jsonl\",\"role\":\"enhancedItems\"}]," +
            "\"diagnostics\":[\"ok\"]}");
        try
        {
            var env = NodeStepShim.TryReadResultEnvelope(path);
            Assert.NotNull(env);
            Assert.Equal("enhance", env!.Step);
            Assert.Equal("done", env.Status);
            Assert.Single(env.Artifacts);
            Assert.Equal("02-enhance/items.jsonl", env.Artifacts[0].Path);
            Assert.Equal("enhancedItems", env.Artifacts[0].Role);
        }
        finally { try { File.Delete(path); } catch { /* swallow */ } }
    }

    [Fact]
    public void FoldEnvelopeIntoResult_ComputesHashesInCSharp()
    {
        // GPT NB-6: hashes from the shim are advisory; C# recomputes.
        var workspace = Path.Combine(Path.GetTempPath(), "ccw-fold-" + Path.GetRandomFileName());
        Directory.CreateDirectory(Path.Combine(workspace, "02-enhance"));
        try
        {
            var artifact = Path.Combine(workspace, "02-enhance", "items.jsonl");
            File.WriteAllText(artifact, "{\"id\":\"a\"}\n");

            var env = new StepResultEnvelope
            {
                Step = "enhance",
                Status = "done",
                ExitCode = 0,
                Artifacts = new[]
                {
                    new StepResultArtifact
                    {
                        Path = "02-enhance/items.jsonl",
                        Role = "enhancedItems",
                        Sha256 = "deadbeefdeadbeef",
                        Bytes = 9999,
                    },
                },
            };

            var result = NodeStepShim.FoldEnvelopeIntoResult(env, processResult: null, workspace, "s", "e", "enhance");

            Assert.Equal(StepStatus.Done, result.Status);
            Assert.Single(result.Artifacts);
            var got = result.Artifacts[0];
            Assert.Equal("02-enhance/items.jsonl", got.Path);
            Assert.Equal("enhancedItems", got.Role);
            Assert.Equal(HashHelpers.FileHash(artifact), got.Sha256);
            Assert.NotEqual("deadbeefdeadbeef", got.Sha256);
            Assert.Equal(new FileInfo(artifact).Length, got.Bytes);
        }
        finally { try { Directory.Delete(workspace, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void FoldEnvelopeIntoResult_FailsOnMissingArtifact()
    {
        var workspace = Path.Combine(Path.GetTempPath(), "ccw-fold-" + Path.GetRandomFileName());
        Directory.CreateDirectory(workspace);
        try
        {
            var env = new StepResultEnvelope
            {
                Step = "enhance",
                Status = "done",
                ExitCode = 0,
                Artifacts = new[]
                {
                    new StepResultArtifact { Path = "02-enhance/missing.jsonl" },
                },
            };
            var result = NodeStepShim.FoldEnvelopeIntoResult(env, null, workspace, "s", "e", "enhance");
            Assert.Equal(StepStatus.Failed, result.Status);
            Assert.NotNull(result.Diagnostics);
            Assert.Contains(result.Diagnostics!, d => d.Contains("missing", StringComparison.OrdinalIgnoreCase));
        }
        finally { try { Directory.Delete(workspace, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void FoldEnvelopeIntoResult_RejectsContainmentEscape()
    {
        var workspace = Path.Combine(Path.GetTempPath(), "ccw-fold-" + Path.GetRandomFileName());
        Directory.CreateDirectory(workspace);
        try
        {
            var env = new StepResultEnvelope
            {
                Step = "enhance",
                Status = "done",
                ExitCode = 0,
                Artifacts = new[]
                {
                    new StepResultArtifact { Path = "../escape.txt" },
                },
            };
            var result = NodeStepShim.FoldEnvelopeIntoResult(env, null, workspace, "s", "e", "enhance");
            Assert.Equal(StepStatus.Failed, result.Status);
            Assert.Empty(result.Artifacts);
            Assert.Contains(result.Diagnostics ?? [], d => d.Contains("escapes workspace", StringComparison.OrdinalIgnoreCase));
        }
        finally { try { Directory.Delete(workspace, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void FoldEnvelopeIntoResult_NullEnvelope_FailsWithProcessExit()
    {
        var run = new Ccw.Core.Process.RunResult { ExitCode = 137, Ok = false, Output = "boom" };
        var result = NodeStepShim.FoldEnvelopeIntoResult(null, run, Path.GetTempPath(), "s", "e", "enhance");
        Assert.Equal(StepStatus.Failed, result.Status);
        Assert.Equal(137, result.ExitCode);
        Assert.NotNull(result.ErrorMessage);
    }
}
