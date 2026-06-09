using System.Collections.ObjectModel;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ccw.Bootstrap;
using Ccw.UI.Services;

namespace Ccw.UI.ViewModels;

public partial class DiagnosticsViewModel : ObservableObject
{
    private readonly DiagnosticsService _svc;

    public DiagnosticsViewModel(DiagnosticsService svc)
    {
        _svc = svc;
    }

    public ObservableCollection<DependencyProbeResult> Probes { get; } = new();

    [ObservableProperty] public partial bool IsBusy { get; set; }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsBusy = true;
        try
        {
            Probes.Clear();
            var results = await _svc.ProbeAllAsync().ConfigureAwait(true);
            foreach (var r in results) Probes.Add(r);
        }
        finally { IsBusy = false; }
    }
}
