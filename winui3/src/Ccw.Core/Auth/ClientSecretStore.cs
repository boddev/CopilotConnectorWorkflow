using System.Text.RegularExpressions;
using Ccw.Core.Util;

namespace Ccw.Core.Auth;

/// <summary>
/// Stores a Microsoft Entra client secret in an OS environment variable so the
/// connector picks it up at push time. The whole CCW system resolves the secret by
/// env-var *name* (<see cref="Ccw.Core.Models.AuthConfig.ClientSecretEnvVar"/>); CLI
/// and connector child processes inherit the parent environment (see ProcessRunner).
/// Configuring the secret in-app is therefore equivalent to the user running
/// <c>setx</c> — only the env-var name is ever persisted to job.json, never the
/// secret itself, so the wire format stays identical to the TS port.
/// </summary>
public static class ClientSecretStore
{
    public const string DefaultEnvVarName = "CCW_CLIENT_SECRET";

    /// <summary>
    /// Pick the env-var name to store the secret under. An explicit, valid name
    /// (letters, digits, underscore; not starting with a digit) is honored;
    /// anything else falls back to <see cref="DefaultEnvVarName"/>.
    /// </summary>
    public static string ResolveEnvVarName(string? explicitName)
    {
        if (string.IsNullOrWhiteSpace(explicitName)) return DefaultEnvVarName;
        var sanitized = Regex.Replace(explicitName.Trim(), "[^A-Za-z0-9_]", "_");
        if (sanitized.Length == 0 || char.IsDigit(sanitized[0])) return DefaultEnvVarName;
        return sanitized;
    }

    /// <summary>
    /// Persist <paramref name="secret"/> under <paramref name="name"/> for the
    /// current process (immediate, so an in-process auth preflight sees it) and,
    /// best effort, for the user (so a CLI launched from a NEW terminal inherits
    /// it). Returns true when the durable user-scope write succeeded. The user-scope
    /// write can throw under a packaged/MSIX environment, so it is wrapped and the
    /// process-scope value is always set first.
    /// </summary>
    public static bool Persist(string name, string secret)
    {
        ArgumentException.ThrowIfNullOrEmpty(name);
        Environment.SetEnvironmentVariable(name, secret, EnvironmentVariableTarget.Process);
        try
        {
            Environment.SetEnvironmentVariable(name, secret, EnvironmentVariableTarget.User);
            return true;
        }
        catch (Exception ex)
        {
            AppLogger.Log($"Could not persist client secret to user environment '{name}'; process-scope only.", ex);
            return false;
        }
    }
}
