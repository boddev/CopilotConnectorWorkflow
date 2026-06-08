using Ccw.Core.Auth;

namespace Ccw.Cli.Commands;

internal static class AuthCommand
{
    public static async Task<int> RunAsync(ParsedArgs args, CancellationToken ct)
    {
        var runner = new AuthPreflightRunner();
        var result = await runner.RunAsync(new AuthPreflightOptions
        {
            TenantId = args.Flag("tenant-id"),
            ClientId = args.Flag("client-id"),
            ClientSecretEnvVar = args.Flag("client-secret-env"),
            RunGraph = !args.Bool("skip-graph"),
            RunWorkIq = !args.Bool("skip-workiq"),
            RunEvalScoreA2A = args.Bool("eval-score-a2a") || ShouldRunEvalScoreA2AFromEnv(),
        }, ct).ConfigureAwait(false);
        Console.WriteLine(AuthPreflightJson.FormatHumanReadable(result));
        return result.Passed ? 0 : 1;
    }

    private static bool ShouldRunEvalScoreA2AFromEnv()
    {
        var v = Environment.GetEnvironmentVariable("CCW_EVAL_SCORE_A2A");
        return v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
    }
}
