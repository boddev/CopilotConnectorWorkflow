using Ccw.Core.Auth;
using Xunit;

namespace Ccw.Core.Tests.Auth;

public sealed class GraphRoleCheckerTests
{
    [Fact]
    public void Ok_When_Both_Groups_Satisfied_With_OwnedBy()
    {
        var roles = new[]
        {
            "ExternalConnection.ReadWrite.OwnedBy",
            "ExternalItem.ReadWrite.OwnedBy",
        };
        var r = GraphRoleChecker.CheckRoles(roles);
        Assert.True(r.Ok);
        Assert.Empty(r.Missing);
        Assert.Equal(roles, r.Roles);
    }

    [Fact]
    public void Ok_When_Both_Groups_Satisfied_With_All_Variant()
    {
        var roles = new[]
        {
            "ExternalConnection.ReadWrite.All",
            "ExternalItem.ReadWrite.All",
        };
        var r = GraphRoleChecker.CheckRoles(roles);
        Assert.True(r.Ok);
        Assert.Empty(r.Missing);
    }

    [Fact]
    public void Reports_Canonical_OwnedBy_For_Missing_Group()
    {
        var r = GraphRoleChecker.CheckRoles([]);
        Assert.False(r.Ok);
        Assert.Equal(new[]
        {
            "ExternalConnection.ReadWrite.OwnedBy",
            "ExternalItem.ReadWrite.OwnedBy",
        }, r.Missing);
    }

    [Fact]
    public void Partial_Coverage_Reports_Only_Missing_Group()
    {
        var r = GraphRoleChecker.CheckRoles(["ExternalConnection.ReadWrite.All"]);
        Assert.False(r.Ok);
        Assert.Single(r.Missing);
        Assert.Equal("ExternalItem.ReadWrite.OwnedBy", r.Missing[0]);
    }
}
