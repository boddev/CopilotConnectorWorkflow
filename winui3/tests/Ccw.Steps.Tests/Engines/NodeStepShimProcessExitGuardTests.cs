using System.IO;
using Ccw.Core.Models;
using Ccw.Core.Process;
using Ccw.Steps.Engines;
using Xunit;

namespace Ccw.Steps.Tests.Engines;

// GPT Phase-2 closure follow-up BLOCKER #2: a shim that writes 'done'
// then crashes must be folded as Failed, not Done. Pins behavior.
public sealed class NodeStepShimProcessExitGuardTests
{
    [Fact]
    public void DoneEnvelope_WithProcessExitNonZero_IsFolded_AsFailed()
    {
        var ws = Path.Combine(Path.GetTempPath(), "ccw-guard-" + Path.GetRandomFileName());
        Directory.CreateDirectory(ws);
        try
        {
            var env = new StepResultEnvelope
            {
                Step = "enhance",
                Status = "done",
                ExitCode = 0,
                Artifacts = [],
            };
            var run = new RunResult { ExitCode = 137, Ok = false, Output = "OOM" };
            var result = NodeStepShim.FoldEnvelopeIntoResult(env, run, ws, "s", "e", "enhance");
            Assert.Equal(StepStatus.Failed, result.Status);
            Assert.Equal(137, result.ExitCode);
            Assert.NotNull(result.Diagnostics);
            Assert.Contains(result.Diagnostics!, d => d.Contains("shim exited 137", StringComparison.Ordinal));
            Assert.Contains("shim exited 137", result.ErrorMessage ?? "");
        }
        finally { try { Directory.Delete(ws, true); } catch { /* swallow */ } }
    }

    [Fact]
    public void DoneEnvelope_WithProcessOk_StillFolds_AsDone()
    {
        var ws = Path.Combine(Path.GetTempPath(), "ccw-guard-" + Path.GetRandomFileName());
        Directory.CreateDirectory(ws);
        try
        {
            var env = new StepResultEnvelope
            {
                Step = "enhance",
                Status = "done",
                ExitCode = 0,
                Artifacts = [],
            };
            var run = new RunResult { ExitCode = 0, Ok = true, Output = "" };
            var result = NodeStepShim.FoldEnvelopeIntoResult(env, run, ws, "s", "e", "enhance");
            Assert.Equal(StepStatus.Done, result.Status);
        }
        finally { try { Directory.Delete(ws, true); } catch { /* swallow */ } }
    }
}
