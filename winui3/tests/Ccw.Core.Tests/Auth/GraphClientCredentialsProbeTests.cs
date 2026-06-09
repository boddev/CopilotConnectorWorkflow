using System.Net;
using System.Net.Http;
using System.Text;
using Ccw.Core.Auth;
using Xunit;

namespace Ccw.Core.Tests.Auth;

public sealed class GraphClientCredentialsProbeTests
{
    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => handle(request);
    }

    private static string MakeToken(string payloadJson)
    {
        static string B64(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        return $"{B64("{\"alg\":\"none\"}")}.{B64(payloadJson)}.{B64("sig")}";
    }

    [Fact]
    public async Task PassesWhenTokenHasRolesAndProbeReturns200()
    {
        var token = MakeToken("{\"roles\":[\"ExternalConnection.ReadWrite.OwnedBy\",\"ExternalItem.ReadWrite.OwnedBy\"]}");
        var handler = new StubHandler(req =>
        {
            if (req.Method == HttpMethod.Post)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent($"{{\"access_token\":\"{token}\"}}"),
                });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"value\":[]}"),
            });
        });
        var probe = new GraphClientCredentialsProbe(handler);
        var outcome = await probe.RunAsync("tenant", "client", "secret");
        Assert.True(outcome.Ok);
        Assert.Equal(2, outcome.Roles.Count);
    }

    [Fact]
    public async Task FailsWhenRolesMissing()
    {
        var token = MakeToken("{\"roles\":[]}");
        var handler = new StubHandler(req => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent($"{{\"access_token\":\"{token}\"}}"),
        }));
        var probe = new GraphClientCredentialsProbe(handler);
        var outcome = await probe.RunAsync("tenant", "client", "secret");
        Assert.False(outcome.Ok);
        Assert.NotNull(outcome.FailureMessage);
        Assert.Contains("ExternalConnection.ReadWrite.OwnedBy", outcome.FailureMessage);
    }

    [Fact]
    public async Task ThrowsOnTokenEndpoint400()
    {
        var handler = new StubHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("{\"error\":\"invalid_client\",\"error_description\":\"AADSTS7000215\"}"),
        }));
        var probe = new GraphClientCredentialsProbe(handler);
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => probe.RunAsync("t", "c", "s"));
        Assert.Contains("invalid_client", ex.Message);
        Assert.Contains("AADSTS7000215", ex.Message);
    }

    [Fact]
    public async Task ThrowsOnProbe403()
    {
        var token = MakeToken("{\"roles\":[\"ExternalConnection.ReadWrite.OwnedBy\",\"ExternalItem.ReadWrite.OwnedBy\"]}");
        var handler = new StubHandler(req =>
        {
            if (req.Method == HttpMethod.Post)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent($"{{\"access_token\":\"{token}\"}}"),
                });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)
            {
                Content = new StringContent("{\"error\":{\"code\":\"Forbidden\"}}"),
            });
        });
        var probe = new GraphClientCredentialsProbe(handler);
        await Assert.ThrowsAsync<InvalidOperationException>(() => probe.RunAsync("t", "c", "s"));
    }

    [Theory]
    [InlineData("{\"error\":\"invalid_grant\",\"error_description\":\"bad\"}", "invalid_grant - bad")]
    [InlineData("{\"message\":\"oops\"}", "oops")]
    [InlineData("not-json", "not-json")]
    [InlineData("{}", "No error details returned.")]
    public void SummarizeJsonError_MirrorsNode(string input, string expected)
    {
        var actual = GraphClientCredentialsProbe.SummarizeJsonError(input);
        Assert.Equal(expected, actual);
    }
}
