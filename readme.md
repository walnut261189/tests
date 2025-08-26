awesome — fresh start, TypeScript, ARM-first, super clean. here’s a turnkey blueprint you can drop into a new repo and deploy via GitLab CI/CD, with **dev/prod** config separation.

---

# 1) scaffold the repo

```bash
mkdir rbmq-azure-function-webhook && cd $_
npm init -y

# deps
npm i amqplib

# dev deps
npm i -D typescript @azure/functions

# tools you’ll use locally
npm i -D @types/node
npx tsc --init
```

---

# 2) project structure (final)

```
rbmq-azure-function-webhook/
│
├─ .gitignore
├─ .gitlab-ci.yml
├─ host.json
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ local.settings.json         # local-only (not committed)
│
├─ rabbitmqConnector/          # function folder (function.json must live here)
│  └─ function.json
│
├─ src/
│  ├─ rabbitmqConnector/
│  │  └─ index.ts              # function logic (TypeScript)
│  └─ lib/                     # optional shared utils
│     └─ forwarder.ts          # example “forward” stub
│
└─ main/                       # ARM deployment
   ├─ template.json
   ├─ parameters.dev.json
   └─ parameters.prod.json
```

---

# 3) config & metadata files

### `.gitignore`

```
node_modules/
dist/
.local/
*.log
local.settings.json
```

### `host.json`

```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

### `package.json`  (no publish script — CI only)

```json
{
  "name": "rbmq-azure-function-webhook",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "start:local": "npm run build && func start"
  },
  "dependencies": {
    "amqplib": "^0.10.3"
  },
  "devDependencies": {
    "@azure/functions": "^4.4.0",
    "@types/node": "^20.14.10",
    "typescript": "^5.5.4"
  }
}
```

### `local.settings.json` (local only)

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "APP_ENV": "dev",
    "RABBITMQ_URL": "amqp://guest:guest@localhost:5672",
    "RABBITMQ_QUEUE": "device-logs",
    "RABBITMQ_MAX_MESSAGES": "200",
    "RABBITMQ_DRAIN_MILLIS": "25000"
  }
}
```

---

# 4) function wiring (timer trigger)

### `rabbitmqConnector/function.json`

> keep `function.json` **in a top-level folder** named after the function. this is how the runtime discovers it. we point it at the compiled JS under `dist/`.

```json
{
  "bindings": [
    {
      "name": "myTimer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 */5 * * * *",
      "runOnStartup": false
    }
  ],
  "scriptFile": "../dist/rabbitmqConnector/index.js"
}
```

### `src/rabbitmqConnector/index.ts`

> batch-drains a queue for a limited duration/size each tick (safe for timer triggers). clean connection handling.

```ts
import type { Context } from "@azure/functions";
import amqp, { Connection, Channel, Options } from "amqplib";

// simple helper to read env with defaults
const env = (key: string, def?: string) => process.env[key] ?? def ?? "";

async function forwardMessage(_context: Context, _payload: string): Promise<void> {
  // TODO: implement your real forwarder here (HTTP, AQS, syslog, etc.)
  // keep this function pure & testable.
  return;
}

export default async function (context: Context): Promise<void> {
  const started = Date.now();
  context.log(`timer tick @ ${new Date().toISOString()}`);

  const rabbitUrl = env("RABBITMQ_URL", "amqp://localhost");
  const queue = env("RABBITMQ_QUEUE", "device-logs");
  const maxMessages = parseInt(env("RABBITMQ_MAX_MESSAGES", "200"), 10);
  const drainMillis = parseInt(env("RABBITMQ_DRAIN_MILLIS", "25000"), 10);

  let conn: Connection | null = null;
  let ch: Channel | null = null;

  try {
    const opts: Options.Connect = {
      // tune as needed for your broker
      heartbeat: 15
    };
    conn = await amqp.connect(rabbitUrl, opts);
    ch = await conn.createChannel();
    await ch.assertQueue(queue, { durable: true });
    await ch.prefetch(Math.min(50, maxMessages)); // avoid over-fetch

    let processed = 0;
    while (processed < maxMessages && Date.now() - started < drainMillis) {
      const msg = await ch.get(queue, { noAck: false });
      if (!msg) {
        // no messages right now; short sleep to avoid hot loop
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      const body = msg.content.toString("utf8");
      try {
        await forwardMessage(context, body);
        ch.ack(msg);
        processed++;
      } catch (e: any) {
        context.log.error("forward failed; nacking", e?.message);
        ch.nack(msg, false, true); // requeue
      }
    }

    context.log(`processed=${processed} queue=${queue} durationMs=${Date.now() - started}`);
  } catch (e: any) {
    context.log.error("rabbit worker failed:", e?.message ?? e);
  } finally {
    try { await ch?.close(); } catch {}
    try { await conn?.close(); } catch {}
  }
}
```

---

# 5) ARM template (infra as code)

### `main/template.json`

> Linux Consumption plan + Function App + Storage + App Insights. App settings include **dev/prod** knobs. Secrets passed as secureString params.

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "location": { "type": "string", "defaultValue": "[resourceGroup().location]" },
    "environment": { "type": "string", "allowedValues": ["dev", "prod"] },
    "functionAppName": { "type": "string" },
    "storageAccountName": { "type": "string" },
    "appInsightsName": { "type": "string" },
    "rabbitMqUrl": { "type": "secureString" },
    "rabbitMqQueue": { "type": "string", "defaultValue": "device-logs" },
    "nodeMajor": { "type": "string", "defaultValue": "18" }
  },
  "variables": {
    "planName": "[concat(parameters('functionAppName'), '-plan')]"
  },
  "resources": [
    {
      "type": "Microsoft.Storage/storageAccounts",
      "apiVersion": "2023-01-01",
      "name": "[parameters('storageAccountName')]",
      "location": "[parameters('location')]",
      "sku": { "name": "Standard_LRS" },
      "kind": "StorageV2",
      "properties": { "supportsHttpsTrafficOnly": true }
    },
    {
      "type": "Microsoft.Insights/components",
      "apiVersion": "2020-02-02",
      "name": "[parameters('appInsightsName')]",
      "location": "[parameters('location')]",
      "properties": {
        "Application_Type": "web",
        "Flow_Type": "Redfield"
      }
    },
    {
      "type": "Microsoft.Web/serverfarms",
      "apiVersion": "2023-01-01",
      "name": "[variables('planName')]",
      "location": "[parameters('location')]",
      "kind": "functionapp",
      "sku": { "name": "Y1", "tier": "Dynamic" },
      "properties": { "reserved": true }
    },
    {
      "type": "Microsoft.Web/sites",
      "apiVersion": "2023-01-01",
      "name": "[parameters('functionAppName')]",
      "location": "[parameters('location')]",
      "kind": "functionapp,linux",
      "dependsOn": [
        "[resourceId('Microsoft.Web/serverfarms', variables('planName'))]",
        "[resourceId('Microsoft.Storage/storageAccounts', parameters('storageAccountName'))]"
      ],
      "properties": {
        "serverFarmId": "[resourceId('Microsoft.Web/serverfarms', variables('planName'))]",
        "siteConfig": {
          "linuxFxVersion": "[concat('Node|', parameters('nodeMajor'))]"
        }
      }
    },
    {
      "type": "Microsoft.Web/sites/config",
      "apiVersion": "2023-01-01",
      "name": "[concat(parameters('functionAppName'), '/appsettings')]",
      "dependsOn": [
        "[resourceId('Microsoft.Web/sites', parameters('functionAppName'))]",
        "[resourceId('Microsoft.Insights/components', parameters('appInsightsName'))]"
      ],
      "properties": {
        "FUNCTIONS_WORKER_RUNTIME": "node",
        "FUNCTIONS_EXTENSION_VERSION": "~4",
        "WEBSITE_RUN_FROM_PACKAGE": "1",
        "SCM_DO_BUILD_DURING_DEPLOYMENT": "true",
        "WEBSITE_NODE_DEFAULT_VERSION": "[concat('~', parameters('nodeMajor'))]",
        "APP_ENV": "[parameters('environment')]",
        "RABBITMQ_URL": "[parameters('rabbitMqUrl')]",
        "RABBITMQ_QUEUE": "[parameters('rabbitMqQueue')]",
        "APPLICATIONINSIGHTS_CONNECTION_STRING": "[concat('InstrumentationKey=', reference(resourceId('microsoft.insights/components/', parameters('appInsightsName')), '2020-02-02').InstrumentationKey)]",
        "AzureWebJobsStorage": "[concat('DefaultEndpointsProtocol=https;AccountName=', parameters('storageAccountName'), ';AccountKey=', listKeys(resourceId('Microsoft.Storage/storageAccounts', parameters('storageAccountName')), '2023-01-01').keys[0].value, ';EndpointSuffix=core.windows.net')]"
      }
    }
  ],
  "outputs": {
    "functionAppName": { "type": "string", "value": "[parameters('functionAppName')]" }
  }
}
```

### `main/parameters.dev.json`

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment": { "value": "dev" },
    "functionAppName": { "value": "rbmq-func-dev-001" },
    "storageAccountName": { "value": "rbmqdevstore001" },
    "appInsightsName": { "value": "rbmq-func-ai-dev" },
    "rabbitMqUrl": { "value": "amqp://user:pass@host:5672" },
    "rabbitMqQueue": { "value": "device-logs" },
    "nodeMajor": { "value": "18" }
  }
}
```

### `main/parameters.prod.json`

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment": { "value": "prod" },
    "functionAppName": { "value": "rbmq-func-prod-001" },
    "storageAccountName": { "value": "rbmqprodstor001" },
    "appInsightsName": { "value": "rbmq-func-ai-prod" },
    "rabbitMqUrl": { "value": "amqp://user:pass@host:5672" },
    "rabbitMqQueue": { "value": "device-logs" },
    "nodeMajor": { "value": "18" }
  }
}
```

> ⚠️ storage account names must be globally unique (lowercase, digits). adjust names before deploying.

---

# 6) GitLab pipeline (infra → build → deploy)

### `.gitlab-ci.yml`

```yaml
stages: [infra, build, package, deploy]

# set this at runtime: dev or prod
variables:
  DEPLOY_ENV: "dev"
  AZ_SUBSCRIPTION_ID: ""
  AZ_TENANT_ID: ""
  AZ_CLIENT_ID: ""
  AZ_CLIENT_SECRET: ""
  AZ_RESOURCE_GROUP: "rg-rbmq-functions"

# choose parameter file based on DEPLOY_ENV
.before_select_params: &select_params
  - |
    if [ "$DEPLOY_ENV" = "prod" ]; then
      export PARAMS=main/parameters.prod.json
    else
      export PARAMS=main/parameters.dev.json
    fi
    echo "Using parameters: $PARAMS"

infra:
  stage: infra
  image: mcr.microsoft.com/azure-cli:2.62.0
  script:
    - *select_params
    - az login --service-principal -u "$AZ_CLIENT_ID" -p "$AZ_CLIENT_SECRET" --tenant "$AZ_TENANT_ID"
    - az account set --subscription "$AZ_SUBSCRIPTION_ID"
    - az deployment group create \
        --resource-group "$AZ_RESOURCE_GROUP" \
        --template-file main/template.json \
        --parameters @"$PARAMS"

build:
  stage: build
  image: node:18
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
      - package.json
      - package-lock.json
      - host.json
      - rabbitmqConnector/function.json

package:
  stage: package
  image: alpine:3.20
  dependencies: [build]
  script:
    - apk add --no-cache zip
    - mkdir -p out
    - zip -r out/functionapp.zip \
        dist/ \
        package.json package-lock.json \
        host.json \
        rabbitmqConnector/function.json
  artifacts:
    paths: [out/functionapp.zip]

deploy:
  stage: deploy
  image: mcr.microsoft.com/azure-cli:2.62.0
  dependencies: [package]
  script:
    - *select_params
    - az login --service-principal -u "$AZ_CLIENT_ID" -p "$AZ_CLIENT_SECRET" --tenant "$AZ_TENANT_ID"
    - az account set --subscription "$AZ_SUBSCRIPTION_ID"
    # get functionAppName from your chosen parameters file (jq must be installed if you want to parse; else set env var)
    - apt-get update && apt-get install -y jq
    - export FUNC_NAME=$(jq -r '.parameters.functionAppName.value' "$PARAMS")
    - echo "Deploying to $FUNC_NAME"
    - az functionapp deployment source config-zip \
        --resource-group "$AZ_RESOURCE_GROUP" \
        --name "$FUNC_NAME" \
        --src out/functionapp.zip
```

> The code package contains:
>
> * `dist/**` (compiled JS)
> * `package.json` + `package-lock.json` (so Azure installs runtime deps)
> * `host.json`
> * `rabbitmqConnector/function.json` (points to `../dist/.../index.js`)

---

# 7) run locally

```bash
# terminal 1: compile continuously (optional)
npm run watch

# terminal 2: once build exists, start functions host
npm run start:local
```

* local storage: Azurite is used via `UseDevelopmentStorage=true`.
* set your local RabbitMQ env vars in `local.settings.json`.

---

# 8) deploy

1. push to GitLab with `DEPLOY_ENV=dev` (or `prod`) in CI variables.
2. pipeline runs:

   * **infra** (ARM template with chosen parameters)
   * **build** (ts → js)
   * **package** (zip artifacts)
   * **deploy** (zip deploy to the Function App)

Azure will see `package.json` in the zip and (because `SCM_DO_BUILD_DURING_DEPLOYMENT=true`) will run **`npm install`** on the app to produce `node_modules` for your compiled JS.

---

# 9) tweakability (dev vs prod)

* **Switch schedule per env**: add `schedule` to app settings (e.g., `RABBITMQ_SCHEDULE`) and have `function.json` reference it? (function.json doesn’t support env substitution natively). Prefer separate **function.json** per branch/env if schedules differ, or keep a conservative common schedule.
* **Throughput knobs**: `RABBITMQ_MAX_MESSAGES`, `RABBITMQ_DRAIN_MILLIS` are env-based already.
* **Secrets**: keep `rabbitMqUrl` a **secureString** in parameter files or inject via CI variables and override with `--parameters rabbitMqUrl=$RABBIT_URL` in the infra job.

---

that’s it — a clean, production-grade baseline: TypeScript, timer trigger, RabbitMQ, ARM infra, dev/prod separation, and GitLab CI that builds then deploys with server-side `npm install`. want me to also add a tiny HTTP health-check function so you can probe liveness from outside?
