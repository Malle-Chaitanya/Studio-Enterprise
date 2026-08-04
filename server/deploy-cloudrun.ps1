# Deploy studio-enterprise server to Cloud Run
# Run from: server/

$PROJECT = "studio-enterprise-migration"
$REGION = "us-central1"
$SERVICE = "studio-enterprise-server"
$IMAGE = "gcr.io/$PROJECT/$SERVICE"

# Load .env
$envVars = @{}
Get-Content .env | Where-Object { $_ -match '^\s*([^#][^=]+)=(.*)$' } | ForEach-Object {
    $m = [regex]::Match($_, '^\s*([^#=]+)=(.*)$')
    if ($m.Success) {
        $envVars[$m.Groups[1].Value.Trim()] = $m.Groups[2].Value.Trim()
    }
}

Write-Host "=== Creating / updating secrets ===" -ForegroundColor Cyan

function Upsert-Secret($name, $value) {
    if (-not $value) { Write-Warning "Skipping $name — empty"; return }
    $exists = gcloud secrets describe $name --project=$PROJECT 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating secret $name"
        $value | gcloud secrets create $name --project=$PROJECT --data-file=-
    } else {
        Write-Host "Updating secret $name"
        $value | gcloud secrets versions add $name --project=$PROJECT --data-file=-
    }
}

# Google creds
Upsert-Secret "studio-enterprise-google-client-id"     $envVars["GOOGLE_CLIENT_ID"]
Upsert-Secret "studio-enterprise-google-client-secret" $envVars["GOOGLE_CLIENT_SECRET"]

# SA key JSON (read from file path if GOOGLE_SA_KEY_FILE set, else use GOOGLE_SA_KEY_JSON)
$saKeyJson = $envVars["GOOGLE_SA_KEY_JSON"]
if (-not $saKeyJson -and $envVars["GOOGLE_SA_KEY_FILE"]) {
    $saKeyJson = Get-Content $envVars["GOOGLE_SA_KEY_FILE"] -Raw
}
Upsert-Secret "studio-enterprise-sa-key-json" $saKeyJson

# MongoDB (if set)
if ($envVars["MONGO_HOST"]) {
    Upsert-Secret "studio-enterprise-mongo-host" $envVars["MONGO_HOST"]
}

Write-Host "`n=== Building & pushing image ===" -ForegroundColor Cyan
gcloud builds submit --tag $IMAGE --project=$PROJECT .

Write-Host "`n=== Deploying to Cloud Run ===" -ForegroundColor Cyan

$CLOUD_RUN_URL = ""  # will be set after deploy

gcloud run deploy $SERVICE `
    --image $IMAGE `
    --region $REGION `
    --project $PROJECT `
    --platform managed `
    --allow-unauthenticated `
    --port 8080 `
    --memory 512Mi `
    --cpu 1 `
    --min-instances 0 `
    --max-instances 3 `
    --set-secrets "MS_CLIENT_ID=studio-enterprise-ms-client-id:latest,MS_CLIENT_SECRET=studio-enterprise-ms-client-secret:latest,GOOGLE_CLIENT_ID=studio-enterprise-google-client-id:latest,GOOGLE_CLIENT_SECRET=studio-enterprise-google-client-secret:latest,GOOGLE_SA_KEY_JSON=studio-enterprise-sa-key-json:latest" `
    --set-env-vars "NODE_ENV=production,LOG_LEVEL=info,CSGE_DB=csge,GOOGLE_AUTH_MODE=bypass,GOOGLE_IMPERSONATE_EMAIL=mia@cloudfuze.com,GEMINI_PROJECT_FALLBACK=studio-enterprise-migration,HERMAS_URL=http://localhost:8001,WEB_ORIGIN=*"

# Get URL
$CLOUD_RUN_URL = gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT --format="value(status.url)"

Write-Host "`n=== Updating PUBLIC_BASE_URL + redirect URIs ===" -ForegroundColor Cyan
gcloud run services update $SERVICE `
    --region $REGION `
    --project $PROJECT `
    --update-env-vars "PUBLIC_BASE_URL=$CLOUD_RUN_URL,MS_REDIRECT_URI=$CLOUD_RUN_URL/callback/microsoft,GOOGLE_REDIRECT_URI=$CLOUD_RUN_URL/callback/google"

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Service URL: $CLOUD_RUN_URL"
Write-Host "Health check: $CLOUD_RUN_URL/api/health"
Write-Host "Webhook URL:  $CLOUD_RUN_URL/api/workflows/dialogflow-webhook"
