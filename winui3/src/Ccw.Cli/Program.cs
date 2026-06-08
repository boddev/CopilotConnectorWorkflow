using System;

namespace Ccw.Cli;

/// <summary>
/// Phase 0 placeholder. The real System.CommandLine command tree lands
/// in Phase 4 (run | resume | compare | status | list | tools | auth)
/// with parity scoped to the step log stream only (Opus I7).
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        Console.WriteLine($"ccw - Windows-native CopilotConnectorWorkflow CLI (scaffold v{Ccw.Core.CoreInfo.SchemaVersion})");
        Console.WriteLine("Phase 0 scaffold only. The real command surface lands in Phase 4.");

        if (args.Length > 0)
        {
            Console.WriteLine($"args: {string.Join(' ', args)}");
        }
        return 0;
    }
}
