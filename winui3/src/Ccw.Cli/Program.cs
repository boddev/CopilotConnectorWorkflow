using System;
using Ccw.Cli.Commands;

namespace Ccw.Cli;

/// <summary>Entry point for ccw.exe. Mirrors src/cli.ts main(): hand-rolled
/// argv parse → switch on cmd → dispatch to a per-command handler. Exit
/// codes match Node: 0 success, 1 functional failure, 2 usage error.</summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            return MainAsync(args).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            return 130; // SIGINT-equivalent
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static async Task<int> MainAsync(string[] args)
    {
        var parsed = ArgvParser.Parse(args);
        var ct = CancellationToken.None; // wired in Phase 5 when the UI host can cancel
        switch (parsed.Cmd)
        {
            case "help":
            case "--help":
            case "-h":
                Console.WriteLine(Usage.Text);
                return 0;
            case "tools":
                return ToolsCommand.Run();
            case "auth":
                return await AuthCommand.RunAsync(parsed, ct).ConfigureAwait(false);
            case "list":
                return ListCommand.Run();
            case "status":
                return StatusCommand.Run(parsed);
            case "compare":
                return CompareCommand.Run(parsed);
            case "compare-dataset":
            case "compare-batch":
                Console.Error.WriteLine(
                    $"'{parsed.Cmd}' was removed when the comparator was consolidated.\n" +
                    "Use 'ccw run --no-enhance --reuse-eval-from <enhancedJobId> ...' to create a paired non-enhanced run,\n" +
                    "then 'ccw compare --job <enhancedJobId> --job <nonEnhancedJobId>' to diff them.");
                return 2;
            case "run":
                return await RunCommand.RunAsync(parsed, resume: false, ct).ConfigureAwait(false);
            case "resume":
                return await RunCommand.RunAsync(parsed, resume: true, ct).ConfigureAwait(false);
            default:
                Console.Error.WriteLine($"Unknown command: {parsed.Cmd}");
                Console.WriteLine(Usage.Text);
                return 2;
        }
    }
}
