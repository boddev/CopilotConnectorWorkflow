using Ccw.Core.Models;
using Ccw.UI.Services;
using Ccw.UI.ViewModels;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class JobsListPage : Page
{
    public JobsListViewModel ViewModel { get; }

    public JobsListPage()
    {
        InitializeComponent();
        ViewModel = new JobsListViewModel(App.GetService<JobService>());
    }

    private void Refresh_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e) => ViewModel.Refresh();

    private void Jobs_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is JobRecord job)
            App.GetService<NavigationService>().Navigate(typeof(JobDetailPage), job.Id);
    }
}
