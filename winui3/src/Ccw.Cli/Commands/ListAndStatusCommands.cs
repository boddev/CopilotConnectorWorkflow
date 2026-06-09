using System.Text.Json;
using Ccw.Core.Jobs;
using Ccw.Core.Json;
using Ccw.Core.Models;

namespace Ccw.Cli.Commands;

internal static class ListCommand
{
    public static int Run()
    {
        var jobs = JobStore.ListJobs();
        foreach (var j in jobs)
        {
            var steps = string.Join(' ', j.Steps.Values
                .Select(s => $"{NameLiteral(s.Name)}={StatusLiteral(s.Status)}"));
            Console.WriteLine($"{j.Id}  {StatusLiteral(j.Status)}  {steps}");
        }
        return 0;
    }

    private static string NameLiteral(StepName n) => n switch
    {
        StepName.EvalGen => "evalgen",
        StepName.Enhance => "enhance",
        StepName.Schema => "schema",
        StepName.Connector => "connector",
        StepName.Deploy => "deploy",
        StepName.Score => "score",
        _ => n.ToString(),
    };

    internal static string StatusLiteral(StepStatus s) => s switch
    {
        StepStatus.Pending => "pending",
        StepStatus.Running => "running",
        StepStatus.Done => "done",
        StepStatus.Failed => "failed",
        StepStatus.Skipped => "skipped",
        _ => s.ToString(),
    };

    internal static string StatusLiteral(JobStatus s) => s switch
    {
        JobStatus.Pending => "pending",
        JobStatus.Running => "running",
        JobStatus.Done => "done",
        JobStatus.Failed => "failed",
        _ => s.ToString(),
    };
}

internal static class StatusCommand
{
    public static int Run(ParsedArgs args)
    {
        var id = args.Flag("job") ?? args.Flag("id");
        if (string.IsNullOrEmpty(id))
        {
            Console.Error.WriteLine("--job <id> required");
            return 2;
        }
        var j = JobStore.LoadJob(id);
        if (j is null)
        {
            Console.Error.WriteLine($"job not found: {id}");
            return 2;
        }
        Console.WriteLine(JsonSerializer.Serialize(j, CcwJsonOptions.Pretty));
        return 0;
    }
}
