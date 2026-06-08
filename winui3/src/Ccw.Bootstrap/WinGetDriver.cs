// WinGet driver — wraps `winget install --id <id> --silent
// --accept-source-agreements --accept-package-agreements` and parses
// progress. WinGet-absent branch (Server/LTSC images without App
// Installer): detected up front so the bootstrapper UI never invokes
// `winget` on a machine that lacks it (Opus N3 in the plan).
//
// Install is BEST-EFFORT (GPT IMPORTANT). Probes are load-bearing; every
// dependency has a manual-install URL fallback. Use the
// ManualInstallLinks dictionary for fallbacks.

using System.Diagnostics;
using System.IO;

namespace Ccw.Bootstrap;

public enum WinGetAvailability
{
    Available,
    NotInstalled,
    UnknownError,
}

public sealed record WinGetInstallResult
{
    public required bool Success { get; init; }
    public required int ExitCode { get; init; }
    /// <summary>True when the install exited with a "package already installed"
    /// status (Opus IMPORTANT). UI surfaces this as a no-op success.</summary>
    public bool AlreadyInstalled { get; init; }
    public string? Output { get; init; }
    public string? Error { get; init; }
}

/// <summary>WinGet exit codes we treat as effectively-successful. See
/// <see href="https://github.com/microsoft/winget-cli/blob/master/doc/windows/package-manager/winget/returnCodes.md"/>.</summary>
internal static class WinGetExitCodes
{
    public const int AlreadyInstalled = unchecked((int)0x8A15002B);
    public const int NoApplicableUpgrade = unchecked((int)0x8A15010B);
    public const int UpdateNotApplicable = unchecked((int)0x8A150019);
}

public static class WinGetDriver
{
    /// <summary>WinGet IDs for each dependency we install. NOTE: there is
    /// no published WinGet package for the `atk` CLI or the gh-copilot
    /// extension — those use ManualInstallCommands instead.</summary>
    public static readonly IReadOnlyDictionary<string, string> WinGetIds =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["node"] = "OpenJS.NodeJS.LTS",
            ["git"] = "Git.Git",
            ["az"] = "Microsoft.AzureCLI",
            ["gh"] = "GitHub.cli",
        };

    /// <summary>Per-dependency manual-install fallback when WinGet is absent
    /// or the install fails. URL points to the upstream installer/docs.</summary>
    public static readonly IReadOnlyDictionary<string, string> ManualInstallLinks =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["node"] = "https://nodejs.org/en/download",
            ["git"] = "https://git-scm.com/download/win",
            ["az"] = "https://learn.microsoft.com/cli/azure/install-azure-cli-windows",
            ["gh"] = "https://cli.github.com/",
            ["atk"] = "https://learn.microsoft.com/microsoft-365-copilot/extensibility/agents-toolkit/install-microsoft-365-agents-toolkit-cli",
            ["gh-copilot"] = "https://docs.github.com/copilot/github-copilot-in-the-cli/about-github-copilot-in-the-cli",
        };

    /// <summary>Imperative shell command the user can copy-paste in case
    /// the silent winget install fails (or winget is absent). For
    /// gh-copilot this is the only install path.</summary>
    public static readonly IReadOnlyDictionary<string, string> ManualInstallCommands =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["atk"] = "npm install -g @microsoft/m365agentstoolkit-cli",
            ["gh-copilot"] = "gh extension install github/gh-copilot",
        };

    /// <summary>Detect whether winget is present + usable. On Server/LTSC
    /// images App Installer isn't installed and winget.exe is absent.</summary>
    public static WinGetAvailability DetectAvailability()
    {
        var path = DependencyProbes.WhichOnPath("winget");
        if (path is null) return WinGetAvailability.NotInstalled;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = path,
                Arguments = "--version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return WinGetAvailability.UnknownError;
            if (!p.WaitForExit(5000))
            {
                try { p.Kill(true); } catch { /* best-effort */ }
                return WinGetAvailability.UnknownError;
            }
            return p.ExitCode == 0 ? WinGetAvailability.Available : WinGetAvailability.UnknownError;
        }
        catch
        {
            return WinGetAvailability.UnknownError;
        }
    }

    /// <summary>Resolve dependency name -> winget package id, or null if no
    /// winget-installable mapping exists (e.g. atk, gh-copilot).</summary>
    public static string? GetWinGetIdFor(string depName) =>
        WinGetIds.TryGetValue(depName, out var id) ? id : null;

    /// <summary>Install a package by winget id silently. Returns success +
    /// exit code + raw output for the UI to surface. Output streaming is a
    /// follow-up (Phase 5) — for now we capture everything and return it
    /// after exit.</summary>
    public static async Task<WinGetInstallResult> InstallAsync(
        string winGetId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(winGetId);
        var availability = DetectAvailability();
        if (availability != WinGetAvailability.Available)
        {
            return new WinGetInstallResult
            {
                Success = false,
                ExitCode = -1,
                Error = "winget is not available on this machine. Install App Installer from the Microsoft Store, or use the manual install link.",
            };
        }
        var psi = new ProcessStartInfo
        {
            FileName = "winget",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("install");
        psi.ArgumentList.Add("--id");
        psi.ArgumentList.Add(winGetId);
        psi.ArgumentList.Add("--silent");
        psi.ArgumentList.Add("--accept-source-agreements");
        psi.ArgumentList.Add("--accept-package-agreements");
        psi.ArgumentList.Add("--disable-interactivity");
        using var p = Process.Start(psi);
        if (p is null)
        {
            return new WinGetInstallResult
            {
                Success = false,
                ExitCode = -1,
                Error = "Failed to start winget.exe.",
            };
        }
        var stdoutTask = p.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = p.StandardError.ReadToEndAsync(cancellationToken);
        try
        {
            await p.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { p.Kill(true); } catch { /* best-effort */ }
            throw;
        }
        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);
        var alreadyInstalled = p.ExitCode == WinGetExitCodes.AlreadyInstalled
                            || p.ExitCode == WinGetExitCodes.NoApplicableUpgrade
                            || p.ExitCode == WinGetExitCodes.UpdateNotApplicable;
        return new WinGetInstallResult
        {
            Success = p.ExitCode == 0 || alreadyInstalled,
            ExitCode = p.ExitCode,
            AlreadyInstalled = alreadyInstalled,
            Output = stdout,
            Error = string.IsNullOrEmpty(stderr) ? null : stderr,
        };
    }
}
