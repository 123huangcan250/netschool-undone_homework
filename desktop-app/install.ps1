param(
    [string]$NodePath = '',
    [string]$PythonPath = '',
    [switch]$Launch
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if (!$PythonPath) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\pythonw.exe'
    if (Test-Path -LiteralPath $candidate) { $PythonPath = $candidate }
    else { $PythonPath = (Get-Command pythonw.exe -ErrorAction Stop).Source }
}
foreach ($required in @($NodePath, $PythonPath, (Join-Path $projectDir 'dist\learn.js'), (Join-Path $projectDir 'config\local.json'))) {
    if (!(Test-Path -LiteralPath $required)) { throw "Required file missing: $required" }
}
$desktopDir = [Environment]::GetFolderPath('Desktop')
$appDir = Join-Path $desktopDir '作业列表程序'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
$consolePythonPath = Join-Path (Split-Path -Parent $PythonPath) 'python.exe'
if (!(Test-Path -LiteralPath $consolePythonPath)) { throw "Required file missing: $consolePythonPath" }
foreach ($name in @('homework_app.pyw', 'fetch-homework.mjs', 'refresh-errors.mjs', 'browser-login.mjs', 'browser-session.mjs', 'session-cookie.mjs', 'automatic-login.mjs', 'windows_credentials.py', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $appDir $name) -Force
}
$settings = [ordered]@{
    projectDir = $projectDir
    configPath = Join-Path $projectDir 'config\local.json'
    nodePath = $NodePath
    pythonPath = $consolePythonPath
    refreshSeconds = 3600
}
[IO.File]::WriteAllText((Join-Path $appDir 'app-settings.json'), ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$shortcutPath = Join-Path $desktopDir '作业列表.lnk'
$launchArgs = '"' + (Join-Path $appDir 'homework_app.pyw') + '"'
# Use IShellLinkW so Windows preserves the Chinese shortcut name and arguments.
if (!('HomeworkShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class HomeworkShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink {}

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        // Slots declared in the IShellLinkW vtable order. Only setters below are invoked.
        void GetPath(); void GetIDList(); void SetIDList(); void GetDescription();
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory();
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments();
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(); void SetHotkey(); void GetShowCmd(); void SetShowCmd();
        void GetIconLocation(); void SetIconLocation(); void SetRelativePath(); void Resolve();
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string target);
    }

    public static void Save(string filename, string target, string arguments, string directory, string description)
    {
        var instance = new ShellLink();
        try
        {
            var link = (IShellLinkW)instance;
            link.SetPath(target);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(directory);
            link.SetDescription(description);
            ((IPersistFile)instance).Save(filename, true);
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@
}
[HomeworkShortcut]::Save($shortcutPath, $PythonPath, $launchArgs, $appDir, '每小时刷新本学期未提交作业，按剩余时间排序。')
if ($Launch) {
    # The user explicitly requested a visible, always-open desktop program.
    $appProcess = Start-Process -FilePath $PythonPath -ArgumentList $launchArgs -WorkingDirectory $appDir -PassThru
    [ordered]@{ shortcut = $shortcutPath; appDirectory = $appDir; pid = $appProcess.Id } | ConvertTo-Json
} else {
    [ordered]@{ shortcut = $shortcutPath; appDirectory = $appDir } | ConvertTo-Json
}
