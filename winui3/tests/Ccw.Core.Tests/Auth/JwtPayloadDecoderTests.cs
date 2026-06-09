using System.Text;
using Ccw.Core.Auth;
using Xunit;

namespace Ccw.Core.Tests.Auth;

public sealed class JwtPayloadDecoderTests
{
    private static string MakeToken(string payloadJson)
    {
        var header = ToBase64Url("{\"alg\":\"none\",\"typ\":\"JWT\"}");
        var payload = ToBase64Url(payloadJson);
        var sig = ToBase64Url("sig");
        return $"{header}.{payload}.{sig}";
    }

    private static string ToBase64Url(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s);
        var b64 = Convert.ToBase64String(bytes).TrimEnd('=');
        return b64.Replace('+', '-').Replace('/', '_');
    }

    [Fact]
    public void DecodePayload_ParsesStandardClaims()
    {
        var tok = MakeToken("{\"sub\":\"abc\",\"roles\":[\"X\",\"Y\"]}");
        var el = JwtPayloadDecoder.DecodePayload(tok);
        Assert.Equal("abc", el.GetProperty("sub").GetString());
        Assert.Equal(2, el.GetProperty("roles").GetArrayLength());
    }

    [Fact]
    public void DecodePayload_HandlesUrlSafeBase64WithoutPadding()
    {
        var tok = MakeToken("{\"x\":\">>?\"}");
        var el = JwtPayloadDecoder.DecodePayload(tok);
        Assert.Equal(">>?", el.GetProperty("x").GetString());
    }

    [Fact]
    public void DecodePayload_ThrowsOnMalformed()
    {
        Assert.Throws<ArgumentException>(() => JwtPayloadDecoder.DecodePayload("nodots"));
    }

    [Fact]
    public void ExtractRoles_FiltersNonStringEntries()
    {
        var tok = MakeToken("{\"roles\":[\"X\",42,null,\"Y\"]}");
        var el = JwtPayloadDecoder.DecodePayload(tok);
        var roles = JwtPayloadDecoder.ExtractRoles(el);
        Assert.Equal(new[] { "X", "Y" }, roles);
    }

    [Fact]
    public void ExtractRoles_HandlesMissingOrWrongShape()
    {
        var tok = MakeToken("{\"roles\":\"not-an-array\"}");
        Assert.Empty(JwtPayloadDecoder.ExtractRoles(JwtPayloadDecoder.DecodePayload(tok)));

        var tok2 = MakeToken("{}");
        Assert.Empty(JwtPayloadDecoder.ExtractRoles(JwtPayloadDecoder.DecodePayload(tok2)));
    }
}
