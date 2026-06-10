using System;
using Ccw.Core.Auth;
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

    private async void Browse_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new Windows.Storage.Pickers.FolderPicker();
            picker.FileTypeFilter.Add("*");
            var shell = ((App)Application.Current).Shell;
            if (shell is null)
            {
                StatusText.Text = "Browse unavailable: shell window not ready.";
                return;
            }
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(shell);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
            var folder = await picker.PickSingleFolderAsync();
            if (folder is not null)
            {
                DatasetBox.Text = folder.Path;
                StatusText.Text = $"Selected dataset folder: {folder.Path}";
            }
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Browse failed: {ex.Message}";
        }
    }

    private void Mode_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (AuthPanel is null) return;
        AuthPanel.Visibility = IsProvisionMode() ? Visibility.Visible : Visibility.Collapsed;
    }

    private void UseManagedIdentity_Toggled(object sender, RoutedEventArgs e)
    {
        if (SecretPanel is null) return;
        SecretPanel.Visibility = UseManagedIdentityBox.IsChecked == true
            ? Visibility.Collapsed
            : Visibility.Visible;
    }

    private async void ValidateAuth_Click(object sender, RoutedEventArgs e)
    {
        ValidateRing.IsActive = true;
        ValidateAuthButton.IsEnabled = false;
        AuthStatusText.Text = "Validating\u2026";
        try
        {
            bool useManagedIdentity = UseManagedIdentityBox.IsChecked == true;
            string? envVarName = PersistSecretIfProvided(useManagedIdentity);

            var runner = new AuthPreflightRunner();
            var result = await runner.RunAsync(new AuthPreflightOptions
            {
                TenantId = TrimToNull(TenantIdBox.Text),
                ClientId = TrimToNull(ClientIdBox.Text),
                ClientSecretEnvVar = envVarName,
                UseManagedIdentity = useManagedIdentity,
                RunGraph = true,
                RunWorkIq = false,
                RunEvalScoreA2A = false,
            }).ConfigureAwait(true);

            var graph = result.Checks.Count > 0 ? result.Checks[0] : null;
            AuthStatusText.Text = graph is null
                ? (result.Passed ? "Auth check passed." : "Auth check failed.")
                : $"{graph.Status}: {graph.Message}";
        }
        catch (Exception ex)
        {
            AuthStatusText.Text = $"Validation error: {ex.Message}";
        }
        finally
        {
            ValidateRing.IsActive = false;
            ValidateAuthButton.IsEnabled = true;
        }
    }

    private void Create_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            bool provision = IsProvisionMode();
            AuthConfig? auth = null;
            if (provision)
            {
                bool useManagedIdentity = UseManagedIdentityBox.IsChecked == true;
                string? envVarName = PersistSecretIfProvided(useManagedIdentity);
                auth = new AuthConfig
                {
                    TenantId = TrimToNull(TenantIdBox.Text),
                    ClientId = TrimToNull(ClientIdBox.Text),
                    ClientSecretEnvVar = useManagedIdentity ? null : envVarName,
                    UseManagedIdentity = useManagedIdentity ? true : null,
                };
            }

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
                    "local" => DeployTarget.Local,
                    _ => DeployTarget.AzureFunctions,
                },
                Mode = provision ? RunMode.Provision : RunMode.Build,
                AclMode = AclMode.Everyone,
                NoEnhance = NoEnhanceBox.IsChecked == true ? true : null,
                Auth = auth,
            };
            var job = JobStore.CreateJob(cfg);
            JobStore.SaveJob(job);
            StatusText.Text = $"Created job {job.Id}";
            App.GetService<NavigationService>().Navigate(typeof(JobDetailPage), job.Id);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Failed: {ex.Message}";
        }
    }

    private bool IsProvisionMode() =>
        (ModeBox.SelectedItem as ComboBoxItem)?.Content as string == "provision";

    /// <summary>
    /// When a client secret was typed (and managed identity is off), store it in an
    /// OS environment variable so the connector reads it at push time, and return the
    /// resolved env-var name. Returns the resolved name even when no secret was typed
    /// (the user may already have the variable set in their environment).
    /// </summary>
    private string? PersistSecretIfProvided(bool useManagedIdentity)
    {
        if (useManagedIdentity) return null;
        var envVarName = ClientSecretStore.ResolveEnvVarName(ClientSecretEnvVarBox.Text);
        var secret = ClientSecretBox.Password ?? "";
        if (!string.IsNullOrEmpty(secret))
        {
            ClientSecretStore.Persist(envVarName, secret);
        }
        return envVarName;
    }

    private static string? TrimToNull(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
