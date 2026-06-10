using System;
using Ccw.Core.Auth;
using Xunit;

namespace Ccw.Core.Tests.Auth;

public sealed class ClientSecretStoreTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveEnvVarName_BlankInput_UsesDefault(string? input)
    {
        Assert.Equal(ClientSecretStore.DefaultEnvVarName, ClientSecretStore.ResolveEnvVarName(input));
    }

    [Fact]
    public void ResolveEnvVarName_ValidName_IsHonored()
    {
        Assert.Equal("MY_SECRET", ClientSecretStore.ResolveEnvVarName("MY_SECRET"));
    }

    [Fact]
    public void ResolveEnvVarName_InvalidChars_AreSanitizedToUnderscore()
    {
        Assert.Equal("my_secret_", ClientSecretStore.ResolveEnvVarName("my secret!"));
    }

    [Fact]
    public void ResolveEnvVarName_LeadingDigit_FallsBackToDefault()
    {
        Assert.Equal(ClientSecretStore.DefaultEnvVarName, ClientSecretStore.ResolveEnvVarName("1bad"));
    }

    [Fact]
    public void Persist_SetsProcessEnvironmentVariable()
    {
        var name = "CCW_TEST_SECRET_" + Guid.NewGuid().ToString("N");
        try
        {
            ClientSecretStore.Persist(name, "s3cr3t");
            Assert.Equal("s3cr3t", Environment.GetEnvironmentVariable(name));
        }
        finally
        {
            Environment.SetEnvironmentVariable(name, null, EnvironmentVariableTarget.Process);
            try { Environment.SetEnvironmentVariable(name, null, EnvironmentVariableTarget.User); }
            catch { /* user scope may be unavailable in CI/packaged contexts */ }
        }
    }
}
