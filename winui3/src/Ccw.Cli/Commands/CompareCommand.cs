using System.Globalization;
using Ccw.Core.Compare;
using Ccw.Core.Jobs;

namespace Ccw.Cli.Commands;

internal static class CompareCommand
{
    public static int Run(ParsedArgs args)
    {
        var jobIds = ArgvParser.CollectRepeatedJobIds(args.Tail);
        if (jobIds.Count != 2)
        {
            Console.Error.WriteLine("ccw compare requires --job <id> twice");
            return 2;
        }
        var outputDir = args.Flag("output");
        if (string.IsNullOrEmpty(outputDir))
        {
            // Default to %LOCALAPPDATA%\CopilotConnectorWorkflow\workspace\
            // compare-reports — consistent with the workspace-root divergence
            // documented in plan §10. Earlier code resolved CWD-relative
            // ("workspace/compare-reports") which would scatter reports
            // around the filesystem and fail when ccw was invoked from
            // C:\Windows\System32 (Opus I3 review).
            var workspaceParent = Path.GetDirectoryName(JobStore.WorkspaceRoot())
                                  ?? Directory.GetCurrentDirectory();
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            outputDir = Path.Combine(workspaceParent, "compare-reports",
                $"{stamp}-{jobIds[0]}-vs-{jobIds[1]}");
        }
        else
        {
            outputDir = Path.GetFullPath(outputDir);
        }
        try
        {
            var result = JobComparer.RunCompare(new Ccw.Core.Compare.CompareOptions
            {
                JobIdA = jobIds[0],
                JobIdB = jobIds[1],
                OutputDir = outputDir,
            });
            Console.WriteLine($"Comparable: {result.Comparable}; semanticComparable: {result.SemanticComparable}");
            Console.WriteLine($"Report: {result.ReportMdPath}");
            Console.WriteLine($"Matrix: {result.ScoreMatrixPath}");
            foreach (var d in result.Diagnostics) Console.WriteLine($"  - {d}");
            return result.Comparable ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }
    }
}
