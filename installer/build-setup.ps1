$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$payload = Join-Path $root "installer\sfx\ImagePromptOptimizerPayload.zip"
$shareName = "$([char]0x7ED9)$([char]0x540C)$([char]0x5B66)$([char]0x5B89)$([char]0x88C5)$([char]0x5305)"
$shareDir = Join-Path $root $shareName
$outExe = Join-Path $shareDir "ImagePromptOptimizer-Setup.exe"
$workDir = Join-Path $root "installer\build"
$sourcePath = Join-Path $workDir "ImagePromptOptimizerSetup.cs"

New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) {
    throw "Payload zip not found: $payload"
}

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($payload))
$chunks = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $base64.Length; $i += 3800) {
    $len = [Math]::Min(3800, $base64.Length - $i)
    $chunks.Add($base64.Substring($i, $len))
}
$payloadLiteral = ($chunks | ForEach-Object { '            "' + $_ + '"' }) -join " +`r`n"

$source = @"
using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Program
{
    private static readonly string AppName = new string(new char[] { (char)0x56FE, (char)0x50CF, (char)0x63D0, (char)0x793A, (char)0x8BCD, (char)0x4F18, (char)0x5316, (char)0x5668 });
    private const string AppId = "ImagePromptOptimizer";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        try
        {
            Install();
            MessageBox.Show("Install completed. You can launch the app from the desktop shortcut: " + AppName, "ImagePromptOptimizer Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Install failed:\n" + ex.Message, "ImagePromptOptimizer Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }

    private static void Install()
    {
        string installRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppId);
        string installDir = Path.Combine(installRoot, "App");
        string exePath = Path.Combine(installDir, "ImagePromptOptimizer.exe");
        string tempZip = Path.Combine(Path.GetTempPath(), AppId + "-payload-" + Guid.NewGuid().ToString("N") + ".zip");

        Directory.CreateDirectory(installRoot);
        StopExistingApp();
        if (Directory.Exists(installDir)) DeleteDirectoryWithRetry(installDir);
        Directory.CreateDirectory(installDir);

        File.WriteAllBytes(tempZip, Convert.FromBase64String(PayloadBase64()));
        try
        {
            ZipFile.ExtractToDirectory(tempZip, installDir);
        }
        finally
        {
            try { File.Delete(tempZip); } catch { }
        }

        if (!File.Exists(exePath)) throw new Exception("The package does not contain ImagePromptOptimizer.exe.");

        string desktopShortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
        string startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppName);
        Directory.CreateDirectory(startMenuDir);
        string startMenuShortcut = Path.Combine(startMenuDir, AppName + ".lnk");
        CreateShortcut(desktopShortcut, exePath, AppName);
        CreateShortcut(startMenuShortcut, exePath, AppName);
        WriteUninstaller(installRoot, installDir, desktopShortcut, startMenuDir);
    }

    private static void StopExistingApp()
    {
        foreach (Process process in Process.GetProcessesByName("ImagePromptOptimizer"))
        {
            try
            {
                process.CloseMainWindow();
                if (!process.WaitForExit(2000)) process.Kill();
                process.WaitForExit(3000);
            }
            catch { }
            finally
            {
                try { process.Dispose(); } catch { }
            }
        }
    }

    private static void DeleteDirectoryWithRetry(string path)
    {
        Exception last = null;
        for (int attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                ClearAttributes(path);
                Directory.Delete(path, true);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Thread.Sleep(500);
            }
        }
        throw new Exception("Cannot replace the old installation. Please close ImagePromptOptimizer and try again. Details: " + last.Message);
    }

    private static void ClearAttributes(string path)
    {
        if (!Directory.Exists(path)) return;
        foreach (string file in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
        {
            try { File.SetAttributes(file, FileAttributes.Normal); } catch { }
        }
        foreach (string dir in Directory.GetDirectories(path, "*", SearchOption.AllDirectories))
        {
            try { File.SetAttributes(dir, FileAttributes.Directory); } catch { }
        }
        try { File.SetAttributes(path, FileAttributes.Directory); } catch { }
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string description)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
        Type shortcutType = shortcut.GetType();
        shortcutType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
        shortcutType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(targetPath) });
        shortcutType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { description });
        shortcutType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
        Marshal.ReleaseComObject(shortcut);
        Marshal.ReleaseComObject(shell);
    }

    private static void WriteUninstaller(string installRoot, string installDir, string desktopShortcut, string startMenuDir)
    {
        string script =
            "$ErrorActionPreference = \"Stop\"\r\n" +
            "if (Test-Path -LiteralPath '" + EscapePs(desktopShortcut) + "') { Remove-Item -LiteralPath '" + EscapePs(desktopShortcut) + "' -Force }\r\n" +
            "if (Test-Path -LiteralPath '" + EscapePs(startMenuDir) + "') { Remove-Item -LiteralPath '" + EscapePs(startMenuDir) + "' -Recurse -Force }\r\n" +
            "if (Test-Path -LiteralPath '" + EscapePs(installDir) + "') { Remove-Item -LiteralPath '" + EscapePs(installDir) + "' -Recurse -Force }\r\n" +
            "Write-Host 'Uninstalled. Settings and history are kept in " + EscapePs(installRoot) + ".'\r\n";
        File.WriteAllText(Path.Combine(installRoot, "Uninstall.ps1"), script, System.Text.Encoding.UTF8);
    }

    private static string EscapePs(string value)
    {
        return value.Replace("'", "''");
    }

    private static string PayloadBase64()
    {
        return
$payloadLiteral;
    }
}
"@

Set-Content -LiteralPath $sourcePath -Value $source -Encoding UTF8

$candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "Cannot find .NET Framework csc.exe." }

& $csc /nologo /target:winexe /platform:anycpu /out:$outExe /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll $sourcePath
if ($LASTEXITCODE -ne 0) { throw "C# installer build failed." }

Write-Host "Built installer: $outExe"
