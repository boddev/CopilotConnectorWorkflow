using Ccw.Core.Jobs;
using Ccw.Core.Models;
using Ccw.UI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class NewJobPage : Page
{
    public NewJobPage()
    {
        InitializeComponent();
    }

    private void Create_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var cfg = new JobConfig
            {
                Dataset = DatasetBox.Text ?? "",
                Description = DescriptionBox.Text ?? "",
                Count = 20,
                ConnectorId = ConnectorIdBox.Text ?? "",
                ConnectorName = ConnectorNameBox.Text ?? "",
                DeployTarget = ((DeployTargetBox.SelectedItem as ComboBoxItem)?.Content as string) switch
                {
                    "azure-container-apps" => DeployTarget.AzureContainerApps,
                    "both" => DeployTarget.Both,
                    _ => DeployTarget.AzureFunctions,
                },
                Mode = RunMode.Build,
                AclMode = AclMode.Everyone,
                NoEnhance = NoEnhanceBox.IsChecked == true ? true : null,
            };
            var job = JobStore.CreateJob(cfg);
            JobStore.SaveJob(job);
            StatusText.Text = $"Created job {job.Id}";
            App.GetService<NavigationService>().Navigate(typeof(JobDetailPage), job.Id);
        }
        catch (System.Exception ex)
        {
            StatusText.Text = $"Failed: {ex.Message}";
        }
    }
}
