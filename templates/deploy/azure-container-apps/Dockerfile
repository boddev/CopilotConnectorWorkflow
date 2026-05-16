FROM mcr.microsoft.com/azure-functions/node:4-node20-slim
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=node
WORKDIR /home/site/wwwroot
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY host.json ./
COPY data ./data
