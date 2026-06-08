using System.Globalization;
using Ccw.Core.Compare;

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
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            outputDir = Path.GetFullPath(Path.Combine("workspace", "compare-reports",
                $"{stamp}-{jobIds[0]}-vs-{jobIds[1]}"));
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
