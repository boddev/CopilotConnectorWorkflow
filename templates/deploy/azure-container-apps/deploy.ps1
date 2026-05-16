param(
  [Parameter(Mandatory=$true)][string]$ResourceGroup,
  [Parameter(Mandatory=$true)][string]$Location,
  [Parameter(Mandatory=$true)][string]$AcrName,
  [Parameter(Mandatory=$true)][string]$ConnectorId,
  [Parameter(Mandatory=$true)][string]$TenantId,
  [Parameter(Mandatory=$true)][string]$ClientId,
  [string]$ClientSecret = '',
  [switch]$UseManagedIdentity
)

$ErrorActionPreference = 'Stop'

Write-Host "Building image..."
docker build -t "$AcrName.azurecr.io/${ConnectorId}:latest" .
az acr login --name $AcrName
docker push "$AcrName.azurecr.io/${ConnectorId}:latest"

Write-Host "Ensuring Container Apps environment '$ConnectorId-env' exists..."
az containerapp env show --name "$ConnectorId-env" --resource-group $ResourceGroup 2>$null || `
  az containerapp env create --name "$ConnectorId-env" --resource-group $ResourceGroup --location $Location

Write-Host "Deploying Container App..."
az deployment group create `
  --resource-group $ResourceGroup `
  --template-file containerapp.bicep `
  --parameters connectorId=$ConnectorId image="$AcrName.azurecr.io/${ConnectorId}:latest" tenantId=$TenantId clientId=$ClientId clientSecret=$ClientSecret useManagedIdentity=$($UseManagedIdentity.IsPresent.ToString().ToLower())

Write-Host "Done. The container app will exec the Azure Functions host."
