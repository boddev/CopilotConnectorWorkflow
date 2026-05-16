@description('Connector ID used as Container App name.')
param connectorId string

@description('Azure region.')
param location string = resourceGroup().location

@description('Container image including tag, e.g. myregistry.azurecr.io/{{connectorId}}:latest')
param image string

@description('Tenant ID for the Entra app.')
param tenantId string

@description('Client ID for the Entra app.')
param clientId string

@secure()
@description('Client secret for the Entra app. Leave empty when using managed identity.')
param clientSecret string = ''

param useManagedIdentity bool = false

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: '${connectorId}-env'
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: connectorId
  location: location
  identity: useManagedIdentity ? { type: 'SystemAssigned' } : null
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: { external: true, targetPort: 80 }
      secrets: useManagedIdentity ? [] : [
        { name: 'client-secret', value: clientSecret }
      ]
    }
    template: {
      containers: [{
        name: connectorId
        image: image
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'TENANT_ID', value: tenantId }
          { name: 'CLIENT_ID', value: clientId }
          { name: 'USE_MANAGED_IDENTITY', value: string(useManagedIdentity) }
          { name: 'CONNECTION_ID', value: connectorId }
          ...(useManagedIdentity ? [] : [{ name: 'CLIENT_SECRET', secretRef: 'client-secret' }])
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
