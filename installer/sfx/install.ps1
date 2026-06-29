$ErrorActionPreference = "Stop"

$appName = "$([char]0x56FE)$([char]0x50CF)$([char]0x63D0)$([char]0x793A)$([char]0x8BCD)$([char]0x4F18)$([char]0x5316)$([char]0x5668)"
$appId = "ImagePromptOptimizer"
$payloadZip = Join-Path $PSScriptRoot "ImagePromptOptimizerPayload.zip"
$installRoot = Join-Path $env:LOCALAPPDATA $appId
$installDir = Join-Path $installRoot "App"
$exePath = Join-Path $installDir "ImagePromptOptimizer.exe"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "$appName.lnk"
$startMenuDir = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\$appName"
$startMenuShortcut = Join-Path $startMenuDir "$appName.lnk"

function Test-WebView2Runtime {
    $clientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    $paths = @(
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKLM:\Software\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId"
    )
    foreach ($path in $paths) {
        if (Test-Path $path) { return $true }
    }
    return $false
}

function New-AppShortcut {
    param(
        [string]$Path,
        [string]$Target
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = Split-Path -Parent $Target
    $shortcut.Description = $appName
    $shortcut.Save()
}

if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) {
    throw "Installer payload not found: $payloadZip"
}

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Expand-Archive -LiteralPath $payloadZip -DestinationPath $installDir -Force

$uninstallPath = Join-Path $installRoot "Uninstall.ps1"
@"
`$ErrorActionPreference = "Stop"
`$appName = "`$([char]0x56FE)`$([char]0x50CF)`$([char]0x63D0)`$([char]0x793A)`$([char]0x8BCD)`$([char]0x4F18)`$([char]0x5316)`$([char]0x5668)"
`$appId = "$appId"
`$installRoot = Join-Path `$env:LOCALAPPDATA `$appId
`$installDir = Join-Path `$installRoot "App"
`$desktopShortcut = Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "`$appName.lnk"
`$startMenuDir = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\`$appName"
if (Test-Path -LiteralPath `$desktopShortcut) { Remove-Item -LiteralPath `$desktopShortcut -Force }
if (Test-Path -LiteralPath `$startMenuDir) { Remove-Item -LiteralPath `$startMenuDir -Recurse -Force }
if (Test-Path -LiteralPath `$installDir) { Remove-Item -LiteralPath `$installDir -Recurse -Force }
Write-Host "Uninstalled `$appName. Settings and history are kept in `$installRoot."
"@ | Set-Content -LiteralPath $uninstallPath -Encoding UTF8

New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
New-AppShortcut -Path $desktopShortcut -Target $exePath
New-AppShortcut -Path $startMenuShortcut -Target $exePath

if (-not (Test-WebView2Runtime)) {
    Write-Host ""
    Write-Host "Notice: Microsoft Edge WebView2 Runtime was not detected."
    Write-Host "If the app opens to a blank window, install WebView2 Runtime:"
    Write-Host "https://developer.microsoft.com/microsoft-edge/webview2/"
}

Write-Host ""
Write-Host "Installed to: $installDir"
Write-Host "Uninstall script: $uninstallPath"
