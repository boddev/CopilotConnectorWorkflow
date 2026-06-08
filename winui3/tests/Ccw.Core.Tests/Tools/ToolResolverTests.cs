// Phase 1i tests: Tool path resolution + semver compare + probe.

using Ccw.Core.Tools;
using Xunit;

namespace Ccw.Core.Tests.Tools;

public class ToolResolverTests
{
    [Fact]
    public void Resolve_WithExplicitRoots_BuildsAllPaths()
    {
        var paths = ToolResolver.Resolve(new ToolResolverOptions
        {
            WorkflowRepoRoot = @"C:\src\CopilotConnectorWorkflow",
            SrcRoot = @"C:\src",
        });

        Assert.Equal(@"C:\src\EvaluationCLI\eval-gen\dist\index.js", paths.EvalGen);
        Assert.Equal(@"C:\src\EvaluationCLI\eval-score\node\dist\index.js", paths.EvalScore);
        Assert.Equal(@"C:\src\CopilotConnectorWorkflow\dist\enhancer\enhance_for_copilot.js", paths.DataEnhancer);
        Assert.Equal(@"C:\src\CopilotConnectorWorkflow\templates", paths.TemplatesRoot);
    }

    [Fact]
    public void Resolve_DefaultsSrcRootToParentOfWorkflowRepo()
    {
        var paths = ToolResolver.Resolve(new ToolResolverOptions
        {
            WorkflowRepoRoot = @"D:\code\my-workflow",
        });

        Assert.Equal(@"D:\code\EvaluationCLI\eval-gen\dist\index.js", paths.EvalGen);
    }

    [Theory]
    [InlineData("22.21.1", "22.21.1", 0)]
    [InlineData("22.21.2", "22.21.1", 1)]
    [InlineData("22.21.0", "22.21.1", -1)]
    [InlineData("23.0.0", "22.21.1", 1)]
    [InlineData("v22.21.1", "22.21.1", 0)]
    [InlineData("v22.21.1", "v22.21.1", 0)]
    [InlineData("22", "22.0.0", 0)]
    [InlineData("22.21", "22.21.0", 0)]
    [InlineData("22.21.1.7", "22.21.1", 0)]
    public void CompareSemver_MatchesNodeBehavior(string a, string b, int expectedSign)
    {
        var actual = ToolResolver.CompareSemver(a, b);
        Assert.Equal(expectedSign, Math.Sign(actual));
    }

    [Fact]
    public void CompareSemver_NonNumericSegmentsTreatedAsZero()
    {
        Assert.Equal(0, ToolResolver.CompareSemver("a.b.c", "0.0.0"));
        Assert.Equal(0, ToolResolver.CompareSemver("22.21.abc", "22.21.0"));
    }

    [Fact]
    public void Probe_ReturnsFiveEntries_InTsOrder()
    {
        var paths = new ToolPaths
        {
            EvalGen = @"C:\nonexistent\eval-gen.js",
            EvalScore = @"C:\nonexistent\eval-score.js",
            DataEnhancer = @"C:\nonexistent\enhancer.js",
            TsDataEnhancer = @"C:\nonexistent\enhancer.ts",
            CopilotConnectorSkill = @"C:\nonexistent\skill",
            TemplatesRoot = @"C:\nonexistent\templates",
        };

        var statuses = ToolResolver.Probe(paths);

        Assert.Collection(statuses,
            s => Assert.Equal("eval-gen", s.Name),
            s => Assert.Equal("eval-score", s.Name),
            s => Assert.Equal("data-enhancer (compiled)", s.Name),
            s => Assert.Equal("data-enhancer (typescript src)", s.Name),
            s => Assert.Equal("copilot-connector skill", s.Name));
    }

    [Fact]
    public void Probe_MissingTools_PopulateFixHintInNote()
    {
        var paths = new ToolPaths
        {
            EvalGen = @"C:\nonexistent\eval-gen.js",
            EvalScore = @"C:\nonexistent\eval-score.js",
            DataEnhancer = @"C:\nonexistent\enhancer.js",
            TsDataEnhancer = @"C:\nonexistent\enhancer.ts",
            CopilotConnectorSkill = @"C:\nonexistent\skill",
            TemplatesRoot = @"C:\nonexistent\templates",
        };

        var statuses = ToolResolver.Probe(paths);
        foreach (var s in statuses)
        {
            Assert.False(s.Ok);
            Assert.NotNull(s.Note);
            Assert.StartsWith("Missing. ", s.Note);
        }
    }

    [Fact]
    public void Probe_ExistingFile_ReportsOkAndNoNote()
    {
        using var tmp = new TempDir();
        var present = Path.Combine(tmp.Path, "eval-gen-fake.js");
        File.WriteAllText(present, "console.log('hi');");

        var paths = new ToolPaths
        {
            EvalGen = present,
            EvalScore = @"C:\nonexistent\eval-score.js",
            DataEnhancer = @"C:\nonexistent\enhancer.js",
            TsDataEnhancer = @"C:\nonexistent\enhancer.ts",
            CopilotConnectorSkill = @"C:\nonexistent\skill",
            TemplatesRoot = @"C:\nonexistent\templates",
        };

        var statuses = ToolResolver.Probe(paths);
        Assert.True(statuses[0].Ok);
        Assert.Null(statuses[0].Note);
    }

    [Fact]
    public void Resolve_TsEnhancer_PrefersWorkflowSrcBundle_WhenPresent()
    {
        using var tmp = new TempDir();
        var workflow = Path.Combine(tmp.Path, "Workflow");
        var src = Path.Combine(workflow, "src", "enhancer");
        Directory.CreateDirectory(src);
        var bundled = Path.Combine(src, "enhance_for_copilot.ts");
        File.WriteAllText(bundled, "// bundled");

        var paths = ToolResolver.Resolve(new ToolResolverOptions
        {
            WorkflowRepoRoot = workflow,
            SrcRoot = tmp.Path,
        });

        Assert.Equal(bundled, paths.TsDataEnhancer);
    }

    [Fact]
    public void Resolve_TsEnhancer_FallsBackToSkillClone_WhenNoBundle()
    {
        using var tmp = new TempDir();
        var workflow = Path.Combine(tmp.Path, "Workflow");
        Directory.CreateDirectory(workflow);
        var skillSrc = Path.Combine(tmp.Path, "CopilotConnectorSkill", "copilot-connector",
            "sample_codes", "data-enhancer", "typescript", "src");
        Directory.CreateDirectory(skillSrc);
        var skillFile = Path.Combine(skillSrc, "enhance_for_copilot.ts");
        File.WriteAllText(skillFile, "// from skill");

        var paths = ToolResolver.Resolve(new ToolResolverOptions
        {
            WorkflowRepoRoot = workflow,
            SrcRoot = tmp.Path,
        });

        Assert.Equal(skillFile, paths.TsDataEnhancer);
    }

    [Fact]
    public void Resolve_TsEnhancer_FallsBackToFirstCandidate_WhenNothingExists()
    {
        // Use a temp dir for BOTH workflow and src so neither this
        // machine's `~/.copilot/skills/copilot-connector` clone nor any
        // pre-existing sibling clone wins. Need to set USERPROFILE so
        // the resolver's third candidate (user home) doesn't accidentally
        // hit a real file on the test runner.
        using var tmp = new TempDir();
        var fakeHome = Path.Combine(tmp.Path, "fake-home");
        Directory.CreateDirectory(fakeHome);

        var originalProfile = Environment.GetEnvironmentVariable("USERPROFILE");
        Environment.SetEnvironmentVariable("USERPROFILE", fakeHome);
        try
        {
            var workflow = Path.Combine(tmp.Path, "nope-workflow");
            var src = Path.Combine(tmp.Path, "nope-src");

            var paths = ToolResolver.Resolve(new ToolResolverOptions
            {
                WorkflowRepoRoot = workflow,
                SrcRoot = src,
            });

            // Matches TS `?? candidates[0]` — surfaces a useful "Missing" status.
            Assert.Equal(Path.Combine(workflow, "src", "enhancer", "enhance_for_copilot.ts"),
                paths.TsDataEnhancer);
        }
        finally
        {
            Environment.SetEnvironmentVariable("USERPROFILE", originalProfile);
        }
    }

    [Fact]
    public void Resolve_SkillRoot_PrefersSiblingClone_WhenSkillMdExists()
    {
        using var tmp = new TempDir();
        var workflow = Path.Combine(tmp.Path, "Workflow");
        Directory.CreateDirectory(workflow);
        var sibling = Path.Combine(tmp.Path, "CopilotConnectorSkill", "copilot-connector");
        Directory.CreateDirectory(sibling);
        File.WriteAllText(Path.Combine(sibling, "SKILL.md"), "# skill");

        var paths = ToolResolver.Resolve(new ToolResolverOptions
        {
            WorkflowRepoRoot = workflow,
            SrcRoot = tmp.Path,
        });

        Assert.Equal(sibling, paths.CopilotConnectorSkill);
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; }

        public TempDir()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "ccw-tools-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch { /* best-effort cleanup */ }
        }
    }
}
