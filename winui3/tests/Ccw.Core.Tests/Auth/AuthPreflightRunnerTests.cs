using Ccw.Core.Auth;
using Xunit;

namespace Ccw.Core.Tests.Auth;

public sealed class AuthPreflightRunnerTests
{
    [Fact]
    public async Task NoFlags_ReturnsAllSkipped_PassedFalse()
    {
        var runner = new AuthPreflightRunner();
        var result = await runner.RunAsync(new AuthPreflightOptions());
        Assert.Equal(3, result.Checks.Count);
        Assert.All(result.Checks, c => Assert.Equal(AuthCheckStatus.Skipped, c.Status));
        Assert.False(result.Passed);
    }

    [Fact]
    public async Task ManagedIdentity_ReturnsGraphSkipped()
    {
        var runner = new AuthPreflightRunner();
        var result = await runner.RunAsync(new AuthPreflightOptions
        {
            RunGraph = true,
            UseManagedIdentity = true,
        });
        var graph = result.Checks.First(c => c.Name == "Graph connector app auth");
        Assert.Equal(AuthCheckStatus.Skipped, graph.Status);
        Assert.Contains("Managed identity", graph.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MissingTenantOrClient_ReturnsFailedWithExplicitFields()
    {
        var runner = new AuthPreflightRunner(envLookup: _ => null);
        var result = await runner.RunAsync(new AuthPreflightOptions
        {
            RunGraph = true,
            ClientSecretEnvVar = "FAKE_VAR",
        });
        var graph = result.Checks.First(c => c.Name == "Graph connector app auth");
        Assert.Equal(AuthCheckStatus.Failed, graph.Status);
        Assert.Contains("tenant ID", graph.Message);
        Assert.Contains("client ID", graph.Message);
        Assert.Contains("environment variable FAKE_VAR", graph.Message);
    }

    [Fact]
    public async Task WorkIqAndEvalScore_FlaggedReturnsSkippedWithDeferralMessage()
    {
        var runner = new AuthPreflightRunner();
        var result = await runner.RunAsync(new AuthPreflightOptions
        {
            RunWorkIq = true,
            RunEvalScoreA2A = true,
        });
        var workiq = result.Checks.First(c => c.Name == "WorkIQ MCP auth");
        var evalscore = result.Checks.First(c => c.Name == "EvalScore A2A MSAL auth");
        Assert.Equal(AuthCheckStatus.Skipped, workiq.Status);
        Assert.Contains("Not yet ported", workiq.Message);
        Assert.Equal(AuthCheckStatus.Skipped, evalscore.Status);
        Assert.Contains("Not yet ported", evalscore.Message);
        Assert.False(result.Passed);
    }

    [Fact]
    public void Json_PropertyOrder_AndLowercaseStatus_MatchNodeShape()
    {
        var result = new AuthPreflightResult
        {
            Passed = true,
            Checks =
            [
                new AuthPreflightCheck { Name = "A", Status = AuthCheckStatus.Passed, Message = "ok" },
                new AuthPreflightCheck { Name = "B", Status = AuthCheckStatus.Skipped, Message = "skip" },
            ],
        };
        var json = AuthPreflightJson.Serialize(result);

        var passedIdx = json.IndexOf("\"passed\"", StringComparison.Ordinal);
        var checksIdx = json.IndexOf("\"checks\"", StringComparison.Ordinal);
        var nameIdx = json.IndexOf("\"name\"", StringComparison.Ordinal);
        var statusIdx = json.IndexOf("\"status\"", StringComparison.Ordinal);
        var messageIdx = json.IndexOf("\"message\"", StringComparison.Ordinal);
        Assert.True(passedIdx >= 0 && checksIdx > passedIdx);
        Assert.True(nameIdx > 0 && statusIdx > nameIdx && messageIdx > statusIdx);

        Assert.Contains("\"passed\"", json);
        Assert.Contains("\"skipped\"", json);
        Assert.Contains(": \"passed\"", json);
    }

    [Fact]
    public void HumanReadable_FormatsMatchesNodeText()
    {
        var result = new AuthPreflightResult
        {
            Passed = false,
            Checks =
            [
                new AuthPreflightCheck { Name = "X", Status = AuthCheckStatus.Failed, Message = "boom" },
            ],
        };
        var text = AuthPreflightJson.FormatHumanReadable(result);
        Assert.StartsWith("Authentication preflight\n\n", text);
        Assert.Contains("[FAIL] X: boom", text);
        Assert.False(text.EndsWith('\n'));
    }

    [Fact]
    public void SanitizeError_RedactsClientSecret()
    {
        var msg = "POST failed: client_secret=abc123&grant_type=client_credentials";
        var s = AuthPreflightRunner.SanitizeError(msg);
        Assert.Contains("client_secret=<redacted>", s);
        Assert.DoesNotContain("abc123", s);
    }
}
