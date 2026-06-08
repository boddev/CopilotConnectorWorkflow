namespace Ccw.Core.Auth;

/// <summary>Result of <see cref="GraphRoleChecker.Check"/>. Mirrors the Node
/// <c>tokenHasGraphConnectorRoles</c> return shape:
/// <c>{ ok: bool, missing: string[], roles: string[] }</c>.</summary>
public sealed record GraphRoleCheckResult
{
    public required bool Ok { get; init; }
    public required IReadOnlyList<string> Missing { get; init; }
    public required IReadOnlyList<string> Roles { get; init; }
}

/// <summary>Mirrors Node <c>tokenHasGraphConnectorRoles</c> in
/// <c>src/auth-preflight.ts</c>. The Node version uses two role groups; a
/// token is acceptable iff it has AT LEAST ONE role from EACH group. The
/// reported <c>missing</c> name is the canonical (.OwnedBy) variant of any
/// group that has no member present.
/// <para>
/// Required groups (each is an OR; the groups are ANDed together):
/// </para>
/// <list type="bullet">
///   <item>ExternalConnection.ReadWrite.OwnedBy | ExternalConnection.ReadWrite.All</item>
///   <item>ExternalItem.ReadWrite.OwnedBy | ExternalItem.ReadWrite.All</item>
/// </list>
/// </summary>
public static class GraphRoleChecker
{
    // Order must match Node so the 'missing' output matches byte-for-byte.
    private static readonly string[][] RequiredGroups =
    [
        ["ExternalConnection.ReadWrite.OwnedBy", "ExternalConnection.ReadWrite.All"],
        ["ExternalItem.ReadWrite.OwnedBy", "ExternalItem.ReadWrite.All"],
    ];

    public static GraphRoleCheckResult Check(string accessToken)
    {
        var payload = JwtPayloadDecoder.DecodePayload(accessToken);
        var roles = JwtPayloadDecoder.ExtractRoles(payload);
        return CheckRoles(roles);
    }

    /// <summary>Pure check against an already-extracted role list. Useful for
    /// testing without minting a real JWT.</summary>
    public static GraphRoleCheckResult CheckRoles(IReadOnlyList<string> roles)
    {
        var roleSet = roles.ToHashSet(StringComparer.Ordinal);
        var missing = new List<string>();
        foreach (var group in RequiredGroups)
        {
            var anyPresent = false;
            foreach (var role in group)
            {
                if (roleSet.Contains(role))
                {
                    anyPresent = true;
                    break;
                }
            }
            if (!anyPresent)
            {
                missing.Add(group[0]);
            }
        }
        return new GraphRoleCheckResult
        {
            Ok = missing.Count == 0,
            Missing = missing,
            Roles = roles,
        };
    }
}
