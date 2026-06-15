using Ccw.UI.Services;
using Ccw.UI.ViewModels;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ccw.UI.Views;

public sealed partial class JobDetailPage : Page
{
    public JobDetailViewModel ViewModel { get; }

    public JobDetailPage()
    {
        InitializeComponent();
        ViewModel = new JobDetailViewModel(App.GetService<JobService>(), App.GetService<JobRunner>());
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        if (e.Parameter is string jobId) ViewModel.Load(jobId);
    }
}
