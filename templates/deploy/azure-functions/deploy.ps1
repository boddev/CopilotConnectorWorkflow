param(
  [Parameter(Mandatory=$true)][string]$ResourceGroup,
  [Parameter(Mandatory=$true)][string]$Location,
  [Parameter(Mandatory=$true)][string]$FunctionAppName,
  [Parameter(Mandatory=$true)][string]$StorageAccountName,
  [Parameter(Mandatory=$true)][string]$TenantId,
  [Parameter(Mandatory=$true)][string]$ClientId,
  [string]$ClientSecret = '',
  [switch]$UseManagedIdentity
)

$ErrorActionPreference = 'Stop'

az group create --name $ResourceGroup --location $Location | Out-Null
az storage account create --name $StorageAccountName --resource-group $ResourceGroup --location $Location --sku Standard_LRS | Out-Null
az functionapp create `
  --resource-group $ResourceGroup `
  --consumption-plan-location $Location `
  --runtime node `
  --runtime-version 20 `
  --functions-version 4 `
  --name $FunctionAppName `
  --storage-account $StorageAccountName

$useMiStr = $UseManagedIdentity.IsPresent.ToString().ToLower()
az functionapp config appsettings set `
  --name $FunctionAppName `
  --resource-group $ResourceGroup `
  --settings TENANT_ID=$TenantId CLIENT_ID=$ClientId CLIENT_SECRET=$ClientSecret USE_MANAGED_IDENTITY=$useMiStr

if ($UseManagedIdentity) {
  az functionapp identity assign --name $FunctionAppName --resource-group $ResourceGroup | Out-Null
}

Write-Host "Deploying code..."
npm run build
func azure functionapp publish $FunctionAppName --typescript
Write-Host "Done."
