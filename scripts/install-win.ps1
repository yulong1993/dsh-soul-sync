#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$DshHome = "",
    [string]$VaultDir = "",
    [string]$Passphrase = "",
    [switch]$NoPassphrase,
    [string]$DeviceLabel = "",
    [string[]]$Map = @(),
    [switch]$SkipDesktop,
    [switch]$SkipWeb,
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
}

function Msg {
    param([string]$Text)
    return [regex]::Replace($Text, '\\u([0-9A-Fa-f]{4})', {
        param($m)
        return [char][int]('0x' + $m.Groups[1].Value)
    })
}

function Quote-WinArg {
    param([string]$Arg)
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    $escaped = $Arg -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-ProcessSync {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [hashtable]$EnvOverrides = @{}
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($ArgumentList | ForEach-Object { Quote-WinArg $_ }) -join ' ')
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    foreach ($k in $EnvOverrides.Keys) {
        $val = $EnvOverrides[$k]
        if ($null -eq $val) {
            if ($psi.EnvironmentVariables.ContainsKey($k)) {
                $psi.EnvironmentVariables.Remove($k)
            }
        } else {
            $psi.EnvironmentVariables[$k] = [string]$val
        }
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit()

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()

    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoParent = Split-Path -Parent $RepoRoot
$RepoName = Split-Path -Leaf $RepoRoot
$CliEntry = Join-Path $RepoRoot "bin\dsh-soul.js"

if (-not (Test-Path $CliEntry)) {
    Write-Error (Msg "\u627e\u4e0d\u5230 CLI \u5165\u53e3\u6587\u4ef6: $CliEntry")
    exit 1
}

# 1. Auto-detect DeepSeek Harness Electron binary, CLI script inside app.asar, and bundled Node
$DshInstallDir = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness"
$DshElectronExe = Join-Path $DshInstallDir "DeepSeek Harness.exe"
$DshAsarPath = Join-Path $DshInstallDir "resources\app.asar"
$DshHostCliJs = Join-Path $DshAsarPath "dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
$DshBundledNode = Join-Path $DshInstallDir "resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

$NodeExe = $null
if (Test-Path $DshBundledNode) {
    $NodeExe = $DshBundledNode
} else {
    $sysNode = Get-Command node -ErrorAction SilentlyContinue
    if ($sysNode) {
        $NodeExe = $sysNode.Source
    }
}

if (-not $NodeExe) {
    Write-Error (Msg "\u672a\u627e\u5230 Node.js\uff08\u8bf7\u5148\u5b89\u88c5 DeepSeek Harness \u6216 Node.js >= 22.15\uff09\u3002")
    exit 1
}

$UseDirectElectron = (Test-Path $DshElectronExe) -and (Test-Path $DshAsarPath)
$FallbackDshCmd = $null
if (-not $UseDirectElectron) {
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($dshCmd) {
        $FallbackDshCmd = $dshCmd.Source
    }
}

if (-not $UseDirectElectron -and -not $FallbackDshCmd) {
    Write-Error (Msg "\u672a\u68c0\u6d4b\u5230 DeepSeek Harness \u5b89\u88c5\u76ee\u5f55\u6216 dsh \u547d\u4ee4\u3002")
    exit 1
}

Write-Host (Msg "=== dsh-soul-sync Windows \u4e00\u952e\u5b89\u88c5\u5668 ===")
Write-Host (Msg "Node \u8fd0\u884c\u65f6: $NodeExe")
if ($UseDirectElectron) {
    Write-Host (Msg "DSH CLI: \u76f4\u8fde\u5185\u7f6e Electron \u5bbf\u4e3b ($DshElectronExe)")
} else {
    Write-Host (Msg "DSH CLI: \u7cfb\u7edf dsh ($FallbackDshCmd)")
}

# 2. Desktop tray running process guard
if (-not $SkipDesktop) {
    $runningDesktop = @(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID })
    if ($runningDesktop.Count -gt 0) {
        if ($NonInteractive) {
            Write-Warning (Msg "\u68c0\u6d4b\u5230 DeepSeek Harness \u684c\u9762\u7aef\u6b63\u5728\u8fd0\u884c\uff0c\u5efa\u8bae\u5b89\u88c5\u5b8c\u6210\u540e\u91cd\u542f\u684c\u9762\u7aef\uff0c\u6216\u4f7f\u7528 -SkipDesktop \u8df3\u8fc7 desktop profile\u3002")
        } else {
            Write-Host ""
            Write-Host (Msg "\u68c0\u6d4b\u5230 DeepSeek Harness \u684c\u9762\u7aef\u6b63\u5728\u8fd0\u884c\uff08\u53f3\u4e0b\u89d2\u6258\u76d8\uff09\u3002") -ForegroundColor Yellow
            Write-Host (Msg "\u4e3a\u907f\u514d profile \u6587\u4ef6\u5360\u9501\uff0c\u8bf7\u5148\u53f3\u952e\u9000\u51fa\u6258\u76d8\u4e2d\u7684 DeepSeek Harness\uff0c\u7136\u540e\u6309\u56de\u8f66\u7ee7\u7eed...") -ForegroundColor Yellow
            [void](Read-Host)
        }
    }
}

# 3. Run dsh-soul init
$InitArgs = @($CliEntry, "init")
if ($DshHome) {
    $InitArgs += @("--dsh-home", $DshHome)
}
if ($NonInteractive) {
    $InitArgs += "--non-interactive"
}
if ($VaultDir) {
    $InitArgs += @("--vault", $VaultDir)
}
if ($NoPassphrase) {
    $InitArgs += "--no-passphrase"
} elseif ($PSBoundParameters.ContainsKey("Passphrase")) {
    if ($Passphrase -eq "") {
        $InitArgs += "--no-passphrase"
    } else {
        $InitArgs += @("--passphrase", $Passphrase)
    }
}
if ($DeviceLabel) {
    $InitArgs += @("--device-label", $DeviceLabel)
}
foreach ($m in $Map) {
    if ($m -and $m.Trim().Length -gt 0) {
        $InitArgs += @("--map", $m)
    }
}

Write-Host ""
Write-Host (Msg "[1/3] \u6b63\u5728\u521d\u59cb\u5316 Soul Sync \u914d\u7f6e\u3001\u91d1\u5e93\u4e0e\u63a5\u529b\u6280\u80fd...")
& $NodeExe @InitArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error (Msg "dsh-soul init \u6267\u884c\u5931\u8d25\uff0c\u9000\u51fa\u7801: $LASTEXITCODE")
    exit $LASTEXITCODE
}

# 4. Install plugin bundle into target DSH profiles (pushd to repo parent + relative path to bypass & and .env pitfalls)
$TargetProfiles = @()
if (-not $SkipWeb) { $TargetProfiles += "web" }
if (-not $SkipDesktop) { $TargetProfiles += "desktop" }

Write-Host ""
Write-Host (Msg "[2/3] \u6b63\u5728\u5411 DSH profile \u6ce8\u518c dsh-soul-sync \u63d2\u4ef6\u5305...")

$DshEnv = @{}
if ($DshHome) {
    $DshEnv["DSH_HOME"] = $DshHome
}
$RelBundlePath = "./$RepoName"

Push-Location $RepoParent
try {
    foreach ($profile in $TargetProfiles) {
        Write-Host (Msg "  -> \u5b89\u88c5\u5230 profile: $profile ($RelBundlePath)")
        if ($UseDirectElectron) {
            $runEnv = @{ "ELECTRON_RUN_AS_NODE" = "1" }
            foreach ($k in $DshEnv.Keys) { $runEnv[$k] = $DshEnv[$k] }
            $res = Invoke-ProcessSync -FilePath $DshElectronExe `
                -ArgumentList @("--expose-internals", $DshHostCliJs, "plugin", "--profile", $profile, "add", $RelBundlePath) `
                -WorkingDirectory $RepoParent `
                -EnvOverrides $runEnv
        } else {
            $res = Invoke-ProcessSync -FilePath $FallbackDshCmd `
                -ArgumentList @("plugin", "--profile", $profile, "add", $RelBundlePath) `
                -WorkingDirectory $RepoParent `
                -EnvOverrides $DshEnv
        }

        if ($res.StdOut) { Write-Host $res.StdOut.TrimEnd() }
        if ($res.StdErr) { Write-Host $res.StdErr.TrimEnd() }

        if ($res.ExitCode -ne 0) {
            $combined = ($res.StdOut + "`n" + $res.StdErr)
            if ($combined -match "already\s+(installed|exists|added)") {
                Write-Host (Msg "  [\u5df2\u5b89\u88c5] profile $profile \u5df2\u5305\u542b dsh-soul-sync\uff0c\u5e42\u7b49\u8df3\u8fc7\u3002")
            } elseif ($profile -eq "desktop" -and $combined -match "initialize its profile") {
                Write-Host (Msg "  [\u63d0\u793a] \u5c1a\u672a\u9996\u6b21\u542f\u52a8\u8fc7 DeepSeek Harness \u684c\u9762\u7aef\uff0c\u5df2\u5148\u5b8c\u6210 web \u914d\u7f6e\u6ce8\u518c\uff1b\u9996\u6b21\u6253\u5f00\u5e76\u9000\u51fa\u684c\u9762\u7aef\u540e\u91cd\u8dd1\u672c\u811a\u672c\u5373\u53ef\u6302\u8f7d desktop\u3002") -ForegroundColor Yellow
            } else {
                Write-Error (Msg "\u5411 profile $profile \u5b89\u88c5\u63d2\u4ef6\u5931\u8d25\uff0c\u9000\u51fa\u7801: $($res.ExitCode)")
                exit $res.ExitCode
            }
        }
    }
} finally {
    Pop-Location
}

# 5. Run doctor health check
Write-Host ""
Write-Host (Msg "[3/3] \u6b63\u5728\u8fd0\u884c dsh-soul doctor \u5065\u5eb7\u4f53\u68c0...")
$DoctorArgs = @($CliEntry, "doctor")
if ($DshHome) {
    $DoctorArgs += @("--dsh-home", $DshHome)
}
& $NodeExe @DoctorArgs
$DoctorExit = $LASTEXITCODE
if ($DoctorExit -ne 0) {
    exit $DoctorExit
}

Write-Host ""
Write-Host (Msg "\u5b89\u88c5\u5168\u90e8\u5b8c\u6210\uff01\u8bf7\u91cd\u542f DeepSeek Harness\uff0c\u5728\u5bf9\u8bdd\u6846\u8f93\u5165 /soul status \u5373\u53ef\u67e5\u770b\u53cc\u673a\u4f53\u68c0\u5361\u3002") -ForegroundColor Green
exit 0
