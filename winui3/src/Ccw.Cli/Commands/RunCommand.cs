using System.Globalization;
using System.Threading.Channels;
using Ccw.Core.Auth;
using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.Core.Process;
using Ccw.Steps.Engines;

namespace Ccw.Cli.Commands;

internal static class RunCommand
{
    public static async Task<int> RunAsync(ParsedArgs args, bool resume, CancellationToken ct)
    {
        JobRecord job;
        if (!resume)
        {
            JobConfig cfg;
            try { cfg = BuildConfigFromFlags(args); }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 2; }
            if (args.Bool("auth-preflight")
                && !await RunAuthPreflightForConfigAsync(cfg, args, ct).ConfigureAwait(false))
            {
                return 1;
            }
            try { job = JobStore.CreateJob(cfg); }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 2; }
            Console.WriteLine($"Created job {job.Id} at {job.Workspace}");
            if (job.Config.PipelineDetection is { } d)
            {
                var verb = d.AppliedNoEnhance
                    ? "Auto-detect \u2192 identity (skip enhancer)"
                    : $"Auto-detect \u2192 {d.Recommendation.ToString().ToLowerInvariant()} (keep enhancer)";
                Console.WriteLine($"  {verb}: {d.Reason}");
                if (d.AppliedNoEnhance)
                {
                    Console.WriteLine("  To override, rerun with --force-enhance or --no-auto-detect-pipeline.");
                }
            }
        }
        else
        {
            var id = args.Flag("job");
            if (string.IsNullOrEmpty(id))
            {
                Console.Error.WriteLine("--job <id> required for resume");
                return 2;
            }
            var loaded = JobStore.LoadJob(id);
            if (loaded is null)
            {
                Console.Error.WriteLine($"job not found: {id}");
                return 2;
            }
            job = loaded;
            if (args.Bool("auth-preflight")
                && !await RunAuthPreflightForConfigAsync(job.Config, args, ct).ConfigureAwait(false))
            {
                return 1;
            }
            Console.WriteLine($"Resuming job {job.Id}");
        }

        var logChannel = Channel.CreateBounded<LogLine>(new BoundedChannelOptions(4096)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
        });
        var drainTask = Task.Run(async () =>
        {
            await foreach (var line in logChannel.Reader.ReadAllAsync(CancellationToken.None).ConfigureAwait(false))
            {
                Console.Out.Write(line.Text);
            }
        }, CancellationToken.None);

        var forceSteps = CollectMulti(args, "force-step")
            .Select(ParseStepNameOrThrow)
            .ToList();
        StepName? startAt = args.Flag("start-at") is { } s ? ParseStepNameOrThrow(s) : null;
        StepName? stopAfter = args.Flag("stop-after") is { } e ? ParseStepNameOrThrow(e) : null;

        var pipeline = await Orchestrator.RunPipelineAsync(new RunPipelineOptions
        {
            Job = job,
            StepEngines = DefaultStepEngines.Build(),
            LogSink = logChannel.Writer,
            ForceAll = args.Bool("force"),
            ForceSteps = forceSteps,
            StartAt = startAt,
            StopAfter = stopAfter,
        }, JobStore.SaveJob, ct).ConfigureAwait(false);

        logChannel.Writer.TryComplete();
        await drainTask.ConfigureAwait(false);

        return pipeline.Status == JobStatus.Done ? 0 : 1;
    }

    private static async Task<bool> RunAuthPreflightForConfigAsync(JobConfig cfg, ParsedArgs args, CancellationToken ct)
    {
        var runner = new AuthPreflightRunner();
        var result = await runner.RunAsync(new AuthPreflightOptions
        {
            TenantId = cfg.Auth?.TenantId,
            ClientId = cfg.Auth?.ClientId,
            ClientSecretEnvVar = cfg.Auth?.ClientSecretEnvVar,
            UseManagedIdentity = cfg.Auth?.UseManagedIdentity ?? false,
            RunGraph = cfg.Mode == RunMode.Provision,
            RunWorkIq = !args.Bool("skip-workiq-auth"),
            RunEvalScoreA2A = ShouldRunEvalScoreA2AFromEnv(),
        }, ct).ConfigureAwait(false);
        Console.WriteLine(AuthPreflightJson.FormatHumanReadable(result));
        return result.Passed;
    }

    private static bool ShouldRunEvalScoreA2AFromEnv()
    {
        var v = Environment.GetEnvironmentVariable("CCW_EVAL_SCORE_A2A");
        return v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<string> CollectMulti(ParsedArgs args, string name)
    {
        var v = args.Flag(name);
        if (string.IsNullOrEmpty(v)) return [];
        return v.Split(',').Select(s => s.Trim()).Where(s => !string.IsNullOrEmpty(s));
    }

    internal static StepName ParseStepNameOrThrow(string s) => s switch
    {
        "evalgen" => StepName.EvalGen,
        "enhance" => StepName.Enhance,
        "schema" => StepName.Schema,
        "connector" => StepName.Connector,
        "deploy" => StepName.Deploy,
        "score" => StepName.Score,
        _ => throw new ArgumentException($"invalid step name: {s}"),
    };

    internal static JobConfig BuildConfigFromFlags(ParsedArgs args)
    {
        static string Required(ParsedArgs a, string k)
        {
            var v = a.Flag(k);
            if (string.IsNullOrEmpty(v)) throw new ArgumentException($"--{k} is required");
            return v;
        }

        var mode = args.Flag("mode") switch
        {
            "build" or null => RunMode.Build,
            "provision" => RunMode.Provision,
            var x => throw new ArgumentException($"invalid --mode: {x}"),
        };
        var deployTarget = args.Flag("deploy-target") switch
        {
            "azure-functions" or null => DeployTarget.AzureFunctions,
            "azure-container-apps" => DeployTarget.AzureContainerApps,
            "both" => DeployTarget.Both,
            var x => throw new ArgumentException($"invalid --deploy-target: {x}"),
        };
        var aclMode = args.Flag("acl-mode") switch
        {
            "everyone" or null => AclMode.Everyone,
            "everyoneExceptGuests" => AclMode.EveryoneExceptGuests,
            "none" => AclMode.None,
            var x => throw new ArgumentException($"invalid --acl-mode: {x}"),
        };

        var count = args.Flag("count") is { } cs && int.TryParse(cs, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cn)
            ? Math.Clamp(cn, 5, 200)
            : 30;

        AuthConfig? auth = null;
        if (mode == RunMode.Provision)
        {
            auth = new AuthConfig
            {
                TenantId = Required(args, "tenant-id"),
                ClientId = Required(args, "client-id"),
                ClientSecretEnvVar = args.Flag("client-secret-env"),
                UseManagedIdentity = args.Bool("use-managed-identity"),
            };
        }

        var noEnhance = args.Bool("no-enhance") ? (bool?)true : null;
        var forceEnhance = args.Bool("force-enhance") ? (bool?)true : null;
        if (noEnhance == true && forceEnhance == true)
        {
            throw new ArgumentException("--no-enhance and --force-enhance are mutually exclusive");
        }
        bool? autoDetectPipeline =
            args.Bool("no-auto-detect-pipeline") || noEnhance == true || forceEnhance == true
                ? false
                : true;

        if (args.Flag("reuse-eval-from") is not null && args.Flag("eval-set") is not null)
        {
            throw new ArgumentException("--reuse-eval-from and --eval-set are mutually exclusive");
        }

        var dataset = Path.GetFullPath(Required(args, "dataset"));
        var description = Required(args, "description");

        string? agentInstructions = args.Flag("agent-instructions");
        if (args.Flag("agent-instructions-file") is { } pathF)
        {
            agentInstructions = File.ReadAllText(Path.GetFullPath(pathF));
        }

        ScoreConfig? score = null;
        var jp = args.Flag("judge-provider");
        if (jp is not null
            || args.Flag("judge-agent-id") is not null
            || args.Flag("candidate-agent-id") is not null
            || args.Bool("skip-agent-publish")
            || args.Flag("evaluators") is not null
            || args.Flag("index-ready-min-minutes") is not null)
        {
            var judgeProvider = (jp ?? "github-copilot") switch
            {
                "github-copilot" => JudgeProvider.GitHubCopilot,
                "workiq" => JudgeProvider.WorkIQ,
                var x => throw new ArgumentException($"--judge-provider must be 'github-copilot' or 'workiq', got '{x}'"),
            };
            if (judgeProvider == JudgeProvider.WorkIQ && string.IsNullOrEmpty(args.Flag("judge-agent-id")))
            {
                throw new ArgumentException("--judge-agent-id is required when --judge-provider workiq is set");
            }
            score = new ScoreConfig
            {
                JudgeProvider = judgeProvider,
                JudgeAgentId = args.Flag("judge-agent-id"),
                CandidateAgentId = args.Flag("candidate-agent-id"),
                SkipAgentPublish = args.Bool("skip-agent-publish") ? true : null,
                Evaluators = args.Flag("evaluators"),
                IndexReadyMinSeconds = args.Flag("index-ready-min-minutes") is { } mr
                    && int.TryParse(mr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var mn) ? mn * 60 : null,
            };
        }

        return new JobConfig
        {
            Dataset = dataset,
            Description = description,
            Count = count,
            Extensions = args.Flag("extensions")?.Split(',').Select(s => s.Trim()).Where(s => !string.IsNullOrEmpty(s)).ToList(),
            ConnectorId = Required(args, "connector-id"),
            ConnectorName = Required(args, "connector-name"),
            ConnectorDescription = args.Flag("connector-description"),
            DeployTarget = deployTarget,
            Mode = mode,
            AclMode = aclMode,
            Auth = auth,
            NoEnhance = noEnhance,
            ForceEnhance = forceEnhance,
            AutoDetectPipeline = autoDetectPipeline,
            ReuseEvalFromJobId = args.Flag("reuse-eval-from"),
            EvalSetPath = args.Flag("eval-set") is { } es ? Path.GetFullPath(es) : null,
            Score = score,
            AgentName = args.Flag("agent-name"),
            AgentInstructions = agentInstructions,
            UrlPrefix = args.Flag("url-prefix"),
        };
    }
}
