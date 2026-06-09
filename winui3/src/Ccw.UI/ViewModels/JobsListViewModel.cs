using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ccw.Core.Models;
using Ccw.UI.Services;

namespace Ccw.UI.ViewModels;

public partial class JobsListViewModel : ObservableObject
{
    private readonly JobService _jobs;

    public JobsListViewModel(JobService jobs)
    {
        _jobs = jobs;
        Refresh();
    }

    public ObservableCollection<JobRecord> Jobs { get; } = new();

    [ObservableProperty]
    public partial bool IsEmpty { get; set; }

    [RelayCommand]
    public void Refresh()
    {
        Jobs.Clear();
        foreach (var j in _jobs.ListJobs()) Jobs.Add(j);
        IsEmpty = Jobs.Count == 0;
    }
}
