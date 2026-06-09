using System;
using System.Collections.ObjectModel;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ccw.Core.Models;
using Ccw.UI.Services;

namespace Ccw.UI.ViewModels;

public partial class JobDetailViewModel : ObservableObject
{
    private readonly JobService _jobs;

    public JobDetailViewModel(JobService jobs)
    {
        _jobs = jobs;
    }

    [ObservableProperty] public partial string JobId { get; set; } = "";
    [ObservableProperty] public partial string Status { get; set; } = "";
    [ObservableProperty] public partial string CreatedAt { get; set; } = "";
    [ObservableProperty] public partial string Description { get; set; } = "";

    public ObservableCollection<StepRecord> Steps { get; } = new();
    public ObservableCollection<string> LogLines { get; } = new();

    public void Load(string jobId)
    {
        JobId = jobId;
        var job = _jobs.Load(jobId);
        if (job is null) return;
        Status = job.Status.ToString();
        CreatedAt = job.CreatedAt ?? "";
        Description = job.Config?.Description ?? "";
        Steps.Clear();
        foreach (var s in job.Steps.Values) Steps.Add(s);
    }

    [RelayCommand]
    public void Refresh() => Load(JobId);
}
