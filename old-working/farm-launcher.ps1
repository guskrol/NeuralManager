param(
    [ValidateSet("Preview", "Launch", "Status", "Stop")]
    [string]$Action = "Preview",
    [string]$ConfigFile = ".\farm.json",
    [int]$MaxInstances = 0,
    [int]$LaunchDelaySeconds = -1,
    [switch]$UseGeneratedTotp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$StateFile = ".\farm-state.json"
$LogsDir = ".\logs"

function ConvertFrom-Base32 {
    param([Parameter(Mandatory = $true)][string]$Value)

    $alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    $clean = ($Value.ToUpperInvariant() -replace "[^A-Z2-7]", "")
    if ([string]::IsNullOrWhiteSpace($clean)) {
        throw "TOTP secret is empty or invalid."
    }

    $bits = New-Object System.Collections.Generic.List[int]
    foreach ($char in $clean.ToCharArray()) {
        $index = $alphabet.IndexOf($char)
        if ($index -lt 0) {
            throw "Invalid Base32 character in TOTP secret: $char"
        }

        for ($shift = 4; $shift -ge 0; $shift--) {
            $bits.Add(($index -shr $shift) -band 1)
        }
    }

    $bytes = New-Object System.Collections.Generic.List[byte]
    for ($i = 0; $i + 7 -lt $bits.Count; $i += 8) {
        $byte = 0
        for ($j = 0; $j -lt 8; $j++) {
            $byte = ($byte -shl 1) -bor $bits[$i + $j]
        }
        $bytes.Add([byte]$byte)
    }

    return ,([byte[]]$bytes.ToArray())
}

function Get-TotpCode {
    param(
        [Parameter(Mandatory = $true)][string]$Secret,
        [int]$Digits = 6,
        [int]$PeriodSeconds = 30,
        [int64]$UnixSeconds = -1
    )

    $key = ConvertFrom-Base32 -Value $Secret
    $effectiveUnixSeconds = if ($UnixSeconds -lt 0) { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } else { $UnixSeconds }
    $counter = [int64][Math]::Floor($effectiveUnixSeconds / $PeriodSeconds)
    $counterBytes = [BitConverter]::GetBytes($counter)
    if ([BitConverter]::IsLittleEndian) {
        [Array]::Reverse($counterBytes)
    }

    $hmac = [System.Security.Cryptography.HMACSHA1]::new($key)
    try {
        $hash = $hmac.ComputeHash($counterBytes)
    }
    finally {
        $hmac.Dispose()
    }

    $offset = $hash[$hash.Length - 1] -band 0x0F
    $binary =
        (($hash[$offset] -band 0x7F) -shl 24) -bor
        (($hash[$offset + 1] -band 0xFF) -shl 16) -bor
        (($hash[$offset + 2] -band 0xFF) -shl 8) -bor
        ($hash[$offset + 3] -band 0xFF)

    $modulo = [int][Math]::Pow(10, $Digits)
    return ($binary % $modulo).ToString(("0" * $Digits))
}

function Test-TotpImplementation {
    $rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    $actual = Get-TotpCode -Secret $rfcSecret -Digits 8 -UnixSeconds 59
    $expected = "94287082"
    if ($actual -ne $expected) {
        throw "Internal TOTP self-test failed. Expected $expected, got $actual."
    }
}

function ConvertTo-Masked {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value)) {
        return ""
    }
    if ($Value.Length -le 4) {
        return "*" * $Value.Length
    }
    return $Value.Substring(0, 2) + ("*" * [Math]::Min(10, $Value.Length - 4)) + $Value.Substring($Value.Length - 2)
}

function Get-OptionalValue {
    param(
        [object]$Object,
        [string]$Name,
        [object]$DefaultValue
    )

    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name -and $null -ne $Object.$Name) {
        return $Object.$Name
    }

    return $DefaultValue
}

function Resolve-LocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BaseDir
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $Path))
}

function Read-FarmConfig {
    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        throw "Config file not found: $ConfigFile. Copy farm.example.json to farm.json first."
    }

    $raw = Get-Content -LiteralPath $ConfigFile -Raw
    return $raw | ConvertFrom-Json
}

function Read-Accounts {
    param([Parameter(Mandatory = $true)][string]$AccountsFile)

    if (-not (Test-Path -LiteralPath $AccountsFile)) {
        throw "Account file not found: $AccountsFile"
    }

    $lines = @(Get-Content -LiteralPath $AccountsFile |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith("#") }
    )

    $accounts = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i].Trim()
        $firstColon = $line.IndexOf(":")
        $lastColon = $line.LastIndexOf(":")
        if ($firstColon -le 0 -or $lastColon -le $firstColon) {
            throw "Invalid account format at line $($i + 1). Expected email:password:totp_secret"
        }

        $accounts.Add([pscustomobject]@{
            Index = $i
            Email = $line.Substring(0, $firstColon)
            Password = $line.Substring($firstColon + 1, $lastColon - $firstColon - 1)
            TotpSecret = $line.Substring($lastColon + 1)
        })
    }

    return @($accounts.ToArray())
}

function Get-ConfiguredAccounts {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Accounts
    )

    $items = @(Get-OptionalValue -Object $Config -Name "accounts" -DefaultValue @())
    if ($items.Count -eq 0) {
        $items = @()
        foreach ($account in $Accounts) {
            $items += [pscustomobject]@{ index = $account.Index; enabled = $true }
        }
    }

    $selected = New-Object System.Collections.Generic.List[object]
    foreach ($item in $items) {
        $enabled = [bool](Get-OptionalValue -Object $item -Name "enabled" -DefaultValue $true)
        if (-not $enabled) {
            continue
        }

        $index = [int](Get-OptionalValue -Object $item -Name "index" -DefaultValue -1)
        if ($index -lt 0 -or $index -ge $Accounts.Count) {
            throw "Configured account index $index is outside accounts file range. Found $($Accounts.Count) account(s)."
        }

        $account = $Accounts[$index]
        $scriptName = [string](Get-OptionalValue -Object $item -Name "scriptName" -DefaultValue (Get-OptionalValue -Object $Config -Name "defaultScriptName" -DefaultValue ""))
        if ([string]::IsNullOrWhiteSpace($scriptName)) {
            throw "Missing scriptName for account index $index and no defaultScriptName was configured."
        }

        $world = [int](Get-OptionalValue -Object $item -Name "world" -DefaultValue (Get-OptionalValue -Object $Config -Name "defaultWorld" -DefaultValue 301))
        $scriptParams = @(Get-OptionalValue -Object $item -Name "scriptParams" -DefaultValue @())

        $selected.Add([pscustomobject]@{
            Index = $account.Index
            Email = $account.Email
            Password = $account.Password
            TotpSecret = $account.TotpSecret
            ScriptName = $scriptName
            World = $world
            ScriptParams = $scriptParams
        })
    }

    return @($selected.ToArray())
}

function New-DreamBotArgs {
    param(
        [Parameter(Mandatory = $true)]$Account,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [bool]$PassGeneratedTotp
    )

    $totp = if ($PassGeneratedTotp) { Get-TotpCode -Secret $Account.TotpSecret } else { $Account.TotpSecret }
    $args = @(
        "-jar", $LauncherPath,
        "-script", $Account.ScriptName,
        "-accountUsername", $Account.Email,
        "-accountPassword", $Account.Password,
        "-accountTotp", $totp,
        "-world", "$($Account.World)"
    )

    if ($Account.ScriptParams.Count -gt 0) {
        $args += "-params"
        $args += $Account.ScriptParams
    }

    return $args
}

function New-SafeDreamBotArgs {
    param(
        [Parameter(Mandatory = $true)]$Account,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [bool]$PassGeneratedTotp
    )

    $safeTotp = if ($PassGeneratedTotp) { "<generated-6-digit-code>" } else { ConvertTo-Masked $Account.TotpSecret }
    $args = @(
        "-jar", $LauncherPath,
        "-script", $Account.ScriptName,
        "-accountUsername", $Account.Email,
        "-accountPassword", (ConvertTo-Masked $Account.Password),
        "-accountTotp", $safeTotp,
        "-world", "$($Account.World)"
    )

    if ($Account.ScriptParams.Count -gt 0) {
        $args += "-params"
        $args += $Account.ScriptParams
    }

    return $args
}

function Format-CommandPreview {
    param([string[]]$CommandArgs)

    return "java " + (($CommandArgs | ForEach-Object {
        if ($_ -match "\s") { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join " ")
}

function Format-ProcessArguments {
    param([string[]]$CommandArgs)

    return ($CommandArgs | ForEach-Object {
        if ($_ -match '\s|"' ) {
            '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"'
        }
        else {
            $_
        }
    }) -join " "
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StateFile)) {
        return @()
    }

    $raw = Get-Content -LiteralPath $StateFile -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    return @($raw | ConvertFrom-Json)
}

function Write-State {
    param([object[]]$Rows)

    $Rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Get-LiveState {
    $rows = @(Read-State)
    $live = New-Object System.Collections.Generic.List[object]
    foreach ($row in $rows) {
        $process = $null
        if ($row.Pid) {
            $process = Get-Process -Id ([int]$row.Pid) -ErrorAction SilentlyContinue
        }

        $live.Add([pscustomobject]@{
            Email = $row.Email
            ScriptName = $row.ScriptName
            World = $row.World
            Pid = $row.Pid
            StartedAt = $row.StartedAt
            Status = if ($null -eq $process) { "StoppedOrUnknown" } else { "Running" }
        })
    }

    return @($live.ToArray())
}

function Show-Status {
    $rows = @(Get-LiveState)
    if ($rows.Count -eq 0) {
        Write-Host "No tracked launches yet."
        return
    }

    $rows | Format-Table -AutoSize
}

function Stop-TrackedProcesses {
    $rows = @(Get-LiveState)
    if ($rows.Count -eq 0) {
        Write-Host "No tracked launches to stop."
        return
    }

    foreach ($row in $rows) {
        if ($row.Status -ne "Running") {
            continue
        }

        Write-Host "Stopping $($row.Email) pid=$($row.Pid)"
        Stop-Process -Id ([int]$row.Pid)
    }
}

Test-TotpImplementation

if ($Action -eq "Status") {
    Show-Status
    return
}

if ($Action -eq "Stop") {
    Stop-TrackedProcesses
    return
}

$config = Read-FarmConfig
$configDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($ConfigFile))
$launcherPath = [string](Get-OptionalValue -Object $config -Name "launcherPath" -DefaultValue "$env:USERPROFILE\DreamBot\Launcher.jar")
$accountsFile = [string](Get-OptionalValue -Object $config -Name "accountsFile" -DefaultValue ".\accounts.txt")
$accountsFile = Resolve-LocalPath -Path $accountsFile -BaseDir $configDir
$accounts = @(Read-Accounts -AccountsFile $accountsFile)
$selectedAccounts = @(Get-ConfiguredAccounts -Config $config -Accounts $accounts)
$effectiveMaxInstances = if ($MaxInstances -gt 0) { $MaxInstances } else { [int](Get-OptionalValue -Object $config -Name "maxInstances" -DefaultValue 1) }
$effectiveDelay = if ($LaunchDelaySeconds -ge 0) { $LaunchDelaySeconds } else { [int](Get-OptionalValue -Object $config -Name "launchDelaySeconds" -DefaultValue 20) }
$passGeneratedTotp = if ($UseGeneratedTotp) { $true } else { [bool](Get-OptionalValue -Object $config -Name "useGeneratedTotp" -DefaultValue $false) }

if ($selectedAccounts.Count -eq 0) {
    Write-Host "No enabled accounts configured."
    return
}

Write-Host "Farm config: $ConfigFile"
Write-Host "Accounts file: $accountsFile"
Write-Host "Launcher: $launcherPath"
Write-Host "Mode: $Action"
Write-Host "Accounts selected: $($selectedAccounts.Count)"
Write-Host "Max instances this run: $effectiveMaxInstances"
Write-Host "Launch delay: $effectiveDelay second(s)"
Write-Host "TOTP mode: $(if ($passGeneratedTotp) { 'generated 6-digit code' } else { 'secret' })"
Write-Host ""

if ($Action -eq "Preview") {
    foreach ($account in $selectedAccounts) {
        $safeArgs = New-SafeDreamBotArgs -Account $account -LauncherPath $launcherPath -PassGeneratedTotp $passGeneratedTotp
        Write-Host "[$($account.Index)] $($account.Email) -> script=$($account.ScriptName), world=$($account.World)"
        Write-Host (Format-CommandPreview -CommandArgs $safeArgs)
        Write-Host ""
    }
    return
}

if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "DreamBot launcher not found: $launcherPath"
}

if (-not (Test-Path -LiteralPath $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir | Out-Null
}

$stateRows = New-Object System.Collections.Generic.List[object]
$launched = 0
foreach ($account in $selectedAccounts) {
    if ($launched -ge $effectiveMaxInstances) {
        Write-Host "MaxInstances reached; leaving remaining accounts for the next run."
        break
    }

    $args = New-DreamBotArgs -Account $account -LauncherPath $launcherPath -PassGeneratedTotp $passGeneratedTotp
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $safeEmail = $account.Email -replace "[^a-zA-Z0-9._-]", "_"
    $stdout = Join-Path $LogsDir "$timestamp-$safeEmail.out.log"
    $stderr = Join-Path $LogsDir "$timestamp-$safeEmail.err.log"

    Write-Host "Launching [$($account.Index)] $($account.Email) -> $($account.ScriptName) world $($account.World)"
    $process = Start-Process -FilePath "java" -ArgumentList (Format-ProcessArguments -CommandArgs $args) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $stateRows.Add([pscustomobject]@{
        Email = $account.Email
        ScriptName = $account.ScriptName
        World = $account.World
        Pid = $process.Id
        StartedAt = (Get-Date).ToString("o")
        Stdout = $stdout
        Stderr = $stderr
    })

    $launched++
    if ($launched -lt $selectedAccounts.Count -and $launched -lt $effectiveMaxInstances -and $effectiveDelay -gt 0) {
        Start-Sleep -Seconds $effectiveDelay
    }
}

Write-State -Rows @($stateRows.ToArray())
Write-Host ""
Write-Host "Launch complete. Use:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Status"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Stop"
