param(
    [ValidateSet('discover', 'running', 'focus', 'bootstrap')][string]$Action,
    [string]$Executable,
    [string]$ScriptPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($Executable) { $Executable = [IO.Path]::GetFullPath($Executable) }
if ($Action -eq 'discover') {
    $choices = @()
    foreach ($version in @('8.0', '9.0', '7.0')) {
        $key = "HKLM:\SOFTWARE\McNeel\Rhinoceros\$version\Install"
        if (Test-Path $key) {
            $location = (Get-ItemProperty $key).Path
            if ($location) {
                $file = Join-Path $location 'Rhino.exe'
                if (Test-Path -LiteralPath $file) { $choices += @{ path = $file; name = "Rhino $version" } }
            }
        }
    }
    ConvertTo-Json -InputObject @($choices) -Compress
    exit
}
$processes = @(Get-Process Rhino -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ((-not $Executable) -or [string]::Equals($_.Path, $Executable, [StringComparison]::OrdinalIgnoreCase))
})
if ($Action -eq 'running') {
    ConvertTo-Json -InputObject @($processes | ForEach-Object { @{ pid = $_.Id; path = $_.Path; ready = ($_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Responding) } }) -Compress
    exit
}
if ($processes.Count -ne 1) { throw 'Choose the intended Rhino instance before connecting.' }
if ($Action -eq 'focus') {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CorvasRhinoWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'
    $handle = $processes[0].MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { throw 'Rhino has not opened its main window yet.' }
    if ([CorvasRhinoWindow]::IsIconic($handle)) { [void][CorvasRhinoWindow]::ShowWindowAsync($handle, 9) }
    [void][CorvasRhinoWindow]::SetForegroundWindow($handle)
    '{"ok":true}'
    exit
}
if (-not (Test-Path -LiteralPath $ScriptPath)) { throw 'Connection script is missing.' }
$major = (Get-Item -LiteralPath $Executable).VersionInfo.FileMajorPart
$rhino = New-Object -ComObject "Rhino.Interface.$major"
try {
    $rhino.Visible = $true
    $command = '_-RunPythonScript "' + $ScriptPath + '"'
    $ok = $rhino.RunScript($command, 0)
    if ($ok) { '{"ok":true}' }
    else { '{"ok":false,"retryable":true,"reason":"Rhino did not accept the command yet"}' }
} catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    if ($failure.HResult -in @(-2147418111, -2147417846)) {
        '{"ok":false,"retryable":true,"reason":"Rhino is busy initializing"}'
    } else { throw }
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rhino) }
