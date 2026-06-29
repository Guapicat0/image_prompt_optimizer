$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$publicDir = Join-Path $root "public"
$listener = [System.Net.HttpListener]::new()
$port = 8787
$prefix = "http://localhost:$port/"
$listener.Prefixes.Add($prefix)

function Send-Json {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [object]$Body
    )
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $json = $Body | ConvertTo-Json -Depth 30
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-File {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Send-Json $Response 404 @{ error = "File not found" }
        return
    }

    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    $types = @{
        ".html" = "text/html; charset=utf-8"
        ".css" = "text/css; charset=utf-8"
        ".js" = "application/javascript; charset=utf-8"
        ".png" = "image/png"
        ".jpg" = "image/jpeg"
        ".jpeg" = "image/jpeg"
        ".webp" = "image/webp"
    }
    $Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Read-BodyText {
    param([System.Net.HttpListenerRequest]$Request)
    $reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-HeaderValue {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [string]$Name
    )
    return $Request.Headers.Get($Name)
}

function Normalize-BaseUrl {
    param([string]$BaseUrl)
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        throw "Base URL is required."
    }
    $normalized = $BaseUrl.Trim().TrimEnd("/")
    if ($normalized.EndsWith("/v1", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $normalized.Substring(0, $normalized.Length - 3).TrimEnd("/")
    }
    return $normalized
}

function Invoke-OpenAIJson {
    param(
        [string]$Method,
        [string]$BaseUrl,
        [string]$ApiKey,
        [string]$Path,
        [object]$Body = $null,
        [int]$TimeoutSec = 90
    )
    $uri = "$(Normalize-BaseUrl $BaseUrl)$Path"
    $headers = @{ Authorization = "Bearer $ApiKey" }
    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec $TimeoutSec -DisableKeepAlive
    }
    $json = $Body | ConvertTo-Json -Depth 40
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec $TimeoutSec -DisableKeepAlive
}

function Invoke-ImageEdit {
    param(
        [string]$BaseUrl,
        [string]$ApiKey,
        [string]$Model,
        [string]$Prompt,
        [string]$FileName,
        [string]$MimeType,
        [byte[]]$ImageBytes,
        [string]$Size,
        [string]$Quality
    )

    if ([string]::IsNullOrWhiteSpace($Model)) {
        throw "Please select an image model."
    }
    if ([string]::IsNullOrWhiteSpace($Prompt)) {
        throw "Please enter an image editing prompt."
    }

    Add-Type -AssemblyName System.Net.Http
    $uri = "$(Normalize-BaseUrl $BaseUrl)/v1/images/edits"
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $ApiKey)
    $form = [System.Net.Http.MultipartFormDataContent]::new()
    $form.Add([System.Net.Http.StringContent]::new($Model, [System.Text.Encoding]::UTF8), "model")
    $form.Add([System.Net.Http.StringContent]::new($Prompt, [System.Text.Encoding]::UTF8), "prompt")
    if (-not [string]::IsNullOrWhiteSpace($Size)) {
        $form.Add([System.Net.Http.StringContent]::new($Size, [System.Text.Encoding]::UTF8), "size")
    }
    if (-not [string]::IsNullOrWhiteSpace($Quality)) {
        $form.Add([System.Net.Http.StringContent]::new($Quality, [System.Text.Encoding]::UTF8), "quality")
    }
    $form.Add([System.Net.Http.StringContent]::new("b64_json", [System.Text.Encoding]::UTF8), "response_format")
    $fileContent = [System.Net.Http.ByteArrayContent]::new($ImageBytes)
    $safeMime = if ([string]::IsNullOrWhiteSpace($MimeType)) { "application/octet-stream" } else { $MimeType }
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($safeMime)
    $safeName = if ([string]::IsNullOrWhiteSpace($FileName)) { "image.png" } else { $FileName }
    $form.Add($fileContent, "image", $safeName)
    try {
        $response = $client.PostAsync($uri, $form).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            if ($text.Length -gt 1200) { $text = $text.Substring(0, 1200) + "..." }
            throw "Image edit request failed: $text"
        }
        return $text | ConvertFrom-Json
    } finally {
        $form.Dispose()
        $client.Dispose()
    }
}

function Invoke-ImageEditJson {
    param(
        [string]$BaseUrl,
        [string]$ApiKey,
        [string]$Model,
        [string]$Prompt,
        [string]$MimeType,
        [byte[]]$ImageBytes,
        [string]$Size,
        [string]$Quality
    )

    $imageBase64 = [Convert]::ToBase64String($ImageBytes)
    $imageUrl = "data:$MimeType;base64,$imageBase64"
    $body = @{
        model = $Model
        prompt = $Prompt
        image = $imageUrl
        size = $Size
        quality = $Quality
        response_format = "b64_json"
    }
    return Invoke-OpenAIJson "POST" $BaseUrl $ApiKey "/v1/images/edits" $body
}

try {
    $listener.Start()
    Write-Host "Image Prompt Optimizer is running at $prefix"
    Write-Host "Use Ctrl+C to stop it."
    Start-Process $prefix | Out-Null

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Base-URL, X-API-Key")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        try {
            if ($request.HttpMethod -eq "OPTIONS") {
                $response.StatusCode = 204
                continue
            }

            $path = $request.Url.AbsolutePath
            if ($path -eq "/api/models" -and $request.HttpMethod -eq "GET") {
                $baseUrl = Get-HeaderValue $request "X-Base-URL"
                $apiKey = Get-HeaderValue $request "X-API-Key"
                $result = Invoke-OpenAIJson "GET" $baseUrl $apiKey "/v1/models" $null 12
                Send-Json $response 200 $result
                continue
            }

            if ($path -eq "/api/ping" -and $request.HttpMethod -eq "GET") {
                $baseUrl = Get-HeaderValue $request "X-Base-URL"
                $apiKey = Get-HeaderValue $request "X-API-Key"
                $started = Get-Date
                $result = Invoke-OpenAIJson "GET" $baseUrl $apiKey "/v1/models"
                $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
                Send-Json $response 200 @{
                    ok = $true
                    pingMs = $elapsed
                    models = $result.data
                }
                continue
            }

            if ($path -eq "/api/analyze" -and $request.HttpMethod -eq "POST") {
                $baseUrl = Get-HeaderValue $request "X-Base-URL"
                $apiKey = Get-HeaderValue $request "X-API-Key"
                $payload = Read-BodyText $request | ConvertFrom-Json
                $imageUrl = "data:$($payload.mimeType);base64,$($payload.imageBase64)"
                $systemText = "You are a professional photo retouching director and prompt engineer. Analyze image weaknesses, then produce an image-editing prompt. Return JSON only. All user-facing values must be written in Simplified Chinese."
                $userText = @'
Analyze this image and return JSON with exactly these fields:
{
  "issues": ["weakness 1", "weakness 2"],
  "editing_prompt": "a complete Chinese prompt for an image editing model",
  "negative_prompt": "things to avoid",
  "rationale": "brief optimization reasoning"
}

Requirements:
1. Preserve the subject identity, original composition intent, and realistic texture.
2. The editing prompt must be specific about lighting, color, clarity, blemish repair, background, and detail enhancement.
3. Do not ask the model to invent unrelated elements or change the subject identity.
4. If the image is an ID photo, academic figure, product image, or landscape, optimize for that use case.
5. Write issues, editing_prompt, negative_prompt, and rationale in Simplified Chinese.
'@
                $schema = @{
                    type = "object"
                    additionalProperties = $false
                    required = @("issues", "editing_prompt", "negative_prompt", "rationale")
                    properties = @{
                        issues = @{ type = "array"; items = @{ type = "string" } }
                        editing_prompt = @{ type = "string" }
                        negative_prompt = @{ type = "string" }
                        rationale = @{ type = "string" }
                    }
                }
                $body = @{
                    model = $payload.model
                    messages = @(
                        @{
                            role = "system"
                            content = $systemText
                        },
                        @{
                            role = "user"
                            content = @(
                                @{ type = "text"; text = $userText },
                                @{ type = "image_url"; image_url = @{ url = $imageUrl } }
                            )
                        }
                    )
                    response_format = @{ type = "json_object" }
                }
                try {
                    $result = Invoke-OpenAIJson "POST" $baseUrl $apiKey "/v1/chat/completions" $body 120
                } catch {
                    Start-Sleep -Seconds 1
                    $result = Invoke-OpenAIJson "POST" $baseUrl $apiKey "/v1/chat/completions" $body 120
                }
                Send-Json $response 200 $result
                continue
            }

            if ($path -eq "/api/edit" -and $request.HttpMethod -eq "POST") {
                $baseUrl = Get-HeaderValue $request "X-Base-URL"
                $apiKey = Get-HeaderValue $request "X-API-Key"
                $payload = Read-BodyText $request | ConvertFrom-Json
                $bytes = [Convert]::FromBase64String($payload.imageBase64)
                try {
                    $result = Invoke-ImageEditJson $baseUrl $apiKey $payload.model $payload.prompt $payload.mimeType $bytes $payload.size $payload.quality
                } catch {
                    $jsonError = $_.Exception.Message
                    try {
                        $result = Invoke-ImageEdit $baseUrl $apiKey $payload.model $payload.prompt $payload.fileName $payload.mimeType $bytes $payload.size $payload.quality
                    } catch {
                        throw "JSON image edit failed: $jsonError`nMultipart image edit failed: $($_.Exception.Message)"
                    }
                }
                Send-Json $response 200 $result
                continue
            }

            $localPath = if ($path -eq "/") {
                Join-Path $publicDir "index.html"
            } else {
                $clean = $path.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
                Join-Path $publicDir $clean
            }
            Send-File $response $localPath
        } catch {
            Send-Json $response 500 @{ error = $_.Exception.Message }
        } finally {
            $response.OutputStream.Close()
        }
    }
} finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
}
