using System;
using System.Collections.ObjectModel;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ccw.Core.Models;
using Ccw.Core.Process;
using Ccw.UI.Services;
using Microsoft.UI.Dispatching;

namespace Ccw.UI.ViewModels;

public partial class JobDetailViewModel : ObservableObject, IDisposable
{
    private readonly JobService _jobs;
    private readonly JobRunner _runner;
    private DispatcherQueue? _dispatcher;
    private JobRecord? _job;
    private CancellationTokenSource? _cts;
    private StepViewModel? _currentStep;

    private static readonly Regex s_stepFrame =
        new(@"^\s*===\s*Step\s+(\w+)", RegexOptions.Compiled);
    private static readonly Regex s_pipelineFrame =
        new(@"^\s*===\s*Pipeline\s", RegexOptions.Compiled);

    public JobDetailViewModel(JobService jobs, JobRunner runner)
    {
        _jobs = jobs;
        _runner = runner;
    }

    [ObservableProperty] public partial string JobId { get; set; } = "";
    [ObservableProperty] public partial string Status { get; set; } = "";
    [ObservableProperty] public partial string CreatedAt { get; set; } = "";
    [ObservableProperty] public partial string Description { get; set; } = "";
    [ObservableProperty] public partial bool IsRunning { get; set; }
    [ObservableProperty] public partial bool CanRun { get; set; } = true;
    [ObservableProperty] public partial string RunHint { get; set; } = "";

    public ObservableCollection<StepViewModel> Steps { get; } = new();

    public void Load(string jobId)
    {
        _dispatcher ??= DispatcherQueue.GetForCurrentThread();
        JobId = jobId;
        var job = _jobs.Load(jobId);
        if (job is null) return;
        _job = job;
        ApplyJob(job);
    }

    private void ApplyJob(JobRecord job)
    {
        Status = JobStatusGlyph(job.Status);
        CreatedAt = job.CreatedAt;
        Description = job.Config.Description;

        if (Steps.Count == 0)
        {
            foreach (var s in job.Steps.Values)
            {
                var vm = new StepViewModel(s.Name);
                vm.UpdateFrom(s);
                Steps.Add(vm);
            }
        }
        else
        {
            foreach (var s in job.Steps.Values) FindStep(s.Name)?.UpdateFrom(s);
        }

        UpdateRunHint(job);
    }

    private StepViewModel? FindStep(StepName name)
    {
        foreach (var s in Steps) if (s.Step == name) return s;
        return null;
    }

    private void UpdateRunHint(JobRecord job)
    {
        if (!IsRunning) CanRun = job.Status != JobStatus.Running;
        RunHint = job.Status switch
        {
            JobStatus.Pending => "This job hasn't started yet. Click Run pipeline to begin.",
            JobStatus.Running => "Pipeline running\u2026",
            JobStatus.Done => "Pipeline completed successfully.",
            JobStatus.Failed => "Pipeline failed. Review the failing stage's output below.",
            JobStatus.Cancelled => "Pipeline run was cancelled.",
            _ => "",
        };
    }

    [RelayCommand]
    public void Refresh()
    {
        if (IsRunning) return;
        Steps.Clear();
        Load(JobId);
    }

    [RelayCommand]
    public async Task RunPipelineAsync()
    {
        if (IsRunning || _job is null) return;
        _dispatcher ??= DispatcherQueue.GetForCurrentThread();
        var dispatcher = _dispatcher!;

        IsRunning = true;
        CanRun = false;
        _currentStep = null;
        foreach (var s in Steps) s.Reset();
        RunHint = "Pipeline running\u2026";
        Status = JobStatusGlyph(JobStatus.Running);

        _cts = new CancellationTokenSource();
        var job = _job;

        try
        {
            var result = await Task.Run(() => _runner.RunAsync(
                job,
                line => dispatcher.TryEnqueue(() => OnLog(line)),
                saved => dispatcher.TryEnqueue(() => OnJobSaved(saved)),
                _cts.Token)).ConfigureAwait(true);
            _job = result;
            ApplyJob(result);
        }
        catch (OperationCanceledException)
        {
            RunHint = "Pipeline run was cancelled.";
            Status = JobStatusGlyph(JobStatus.Cancelled);
        }
        catch (Exception ex)
        {
            RunHint = $"Run error: {ex.Message}";
        }
        finally
        {
            IsRunning = false;
            _cts?.Dispose();
            _cts = null;
            CanRun = _job is null || _job.Status != JobStatus.Running;
        }
    }

    [RelayCommand]
    public void Cancel() => _cts?.Cancel();

    public void Dispose()
    {
        _cts?.Dispose();
        _cts = null;
        GC.SuppressFinalize(this);
    }

    private void OnLog(LogLine line)
    {
        var text = line.Text ?? "";
        var frame = s_stepFrame.Match(text);
        if (frame.Success)
        {
            _currentStep = FindStep(ParseStep(frame.Groups[1].Value));
            _currentStep?.AppendOutput(text);
            return;
        }
        if (s_pipelineFrame.IsMatch(text))
        {
            _currentStep = null;
            return;
        }
        _currentStep?.AppendOutput(text);
    }

    private void OnJobSaved(JobRecord saved)
    {
        _job = saved;
        Status = JobStatusGlyph(saved.Status);
        foreach (var s in saved.Steps.Values) FindStep(s.Name)?.UpdateFrom(s);
    }

    private static StepName ParseStep(string token) => token switch
    {
        "evalgen" => StepName.EvalGen,
        "enhance" => StepName.Enhance,
        "schema" => StepName.Schema,
        "connector" => StepName.Connector,
        "deploy" => StepName.Deploy,
        "score" => StepName.Score,
        _ => StepName.EvalGen,
    };

    private static string JobStatusGlyph(JobStatus status) => status switch
    {
        JobStatus.Pending => "\u23F3 Pending",
        JobStatus.Running => "\u25B6 Running",
        JobStatus.Done => "\u2713 Done",
        JobStatus.Failed => "\u2717 Failed",
        JobStatus.Cancelled => "\u25A0 Cancelled",
        _ => status.ToString(),
    };
}
