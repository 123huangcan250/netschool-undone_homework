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
foreach ($name in @('homework_app.pyw', 'fetch-homework.mjs', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $appDir $name) -Force
}
$settings = [ordered]@{
    projectDir = $projectDir
    configPath = Join-Path $projectDir 'config\local.json'
    nodePath = $NodePath
    refreshSeconds = 3600
}
[IO.File]::WriteAllText((Join-Path $appDir 'app-settings.json'), ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$shortcutPath = Join-Path $desktopDir '作业列表.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $PythonPath
$shortcut.Arguments = '"' + (Join-Path $appDir 'homework_app.pyw') + '"'
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = '每小时刷新本学期未提交作业，按剩余时间排序。'
$shortcut.Save()
if ($Launch) {
    # The user explicitly requested a visible, always-open desktop program.
    $appProcess = Start-Process -FilePath $PythonPath -ArgumentList $shortcut.Arguments -WorkingDirectory $appDir -PassThru
    [ordered]@{ shortcut = $shortcutPath; appDirectory = $appDir; pid = $appProcess.Id } | ConvertTo-Json
} else {
    [ordered]@{ shortcut = $shortcutPath; appDirectory = $appDir } | ConvertTo-Json
}
