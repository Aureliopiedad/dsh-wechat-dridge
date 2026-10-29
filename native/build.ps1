param([string]$OutputName = 'Worker.exe')
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$assemblyRoot = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'
$references = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') | ForEach-Object {
    $dll = Get-ChildItem -LiteralPath (Join-Path $assemblyRoot $_) -Filter "${_}.dll" -Recurse | Select-Object -First 1
    if (-not $dll) { throw "Missing assembly: $_" }
    '/reference:' + $dll.FullName
}
& $compiler /nologo /target:exe /platform:x64 /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll ("/out:" + (Join-Path $PSScriptRoot $OutputName)) $references (Join-Path $PSScriptRoot 'Worker.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
