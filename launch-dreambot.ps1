param(
    [string]$AccountLine,
    [string]$AccountsFile = ".\data\accounts.txt",
    [int]$AccountIndex = 0,
    [string]$LauncherPath = "$env:USERPROFILE\DreamBot\Launcher.jar",
    [Parameter(Mandatory = $true)]
    [string]$ScriptName,
    [int]$World = 301,
    [string[]]$ScriptParams = @(),
    [switch]$UseGeneratedTotp,
    [switch]$ShowTotp,
    [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

function Read-AccountLine {
    if (-not [string]::IsNullOrWhiteSpace($AccountLine)) {
        return $AccountLine.Trim()
    }

    if (-not (Test-Path -LiteralPath $AccountsFile)) {
        throw "Account file not found: $AccountsFile. Create it from accounts.example.txt or pass -AccountLine."
    }

    $lines = @(Get-Content -LiteralPath $AccountsFile |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith("#") }
    )

    if ($AccountIndex -lt 0 -or $AccountIndex -ge $lines.Count) {
        throw "AccountIndex $AccountIndex is outside the file range. Found $($lines.Count) account line(s)."
    }

    return $lines[$AccountIndex].Trim()
}

function Parse-AccountLine {
    param([Parameter(Mandatory = $true)][string]$Line)

    $firstColon = $Line.IndexOf(":")
    $lastColon = $Line.LastIndexOf(":")
    if ($firstColon -le 0 -or $lastColon -le $firstColon) {
        throw "Invalid account format. Expected email:password:totp_secret"
    }

    return [pscustomobject]@{
        Email = $Line.Substring(0, $firstColon)
        Password = $Line.Substring($firstColon + 1, $lastColon - $firstColon - 1)
        TotpSecret = $Line.Substring($lastColon + 1)
    }
}

function Format-ProcessArguments {
    param([string[]]$Arguments)

    return ($Arguments | ForEach-Object {
        if ($_ -match '\s|"' ) {
            '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"'
        }
        else {
            $_
        }
    }) -join " "
}

Test-TotpImplementation

$line = Read-AccountLine
$account = Parse-AccountLine -Line $line
$totpCode = Get-TotpCode -Secret $account.TotpSecret
$totpForDreamBot = if ($UseGeneratedTotp) { $totpCode } else { $account.TotpSecret }

$javaArgs = @(
    "-jar", $LauncherPath,
    "-script", $ScriptName,
    "-accountUsername", $account.Email,
    "-accountPassword", $account.Password,
    "-accountTotp", $totpForDreamBot,
    "-world", "$World"
)

if ($ScriptParams.Count -gt 0) {
    $javaArgs += "-params"
    $javaArgs += $ScriptParams
}

$safeTotp = if ($UseGeneratedTotp) { "<generated-6-digit-code>" } else { ConvertTo-Masked $account.TotpSecret }

$safeArgs = @(
    "-jar", $LauncherPath,
    "-script", $ScriptName,
    "-accountUsername", $account.Email,
    "-accountPassword", (ConvertTo-Masked $account.Password),
    "-accountTotp", $safeTotp,
    "-world", "$World"
)

if ($ScriptParams.Count -gt 0) {
    $safeArgs += "-params"
    $safeArgs += $ScriptParams
}

Write-Host "Account: $($account.Email)"
Write-Host "Password: $(ConvertTo-Masked $account.Password)"
Write-Host "TOTP secret: $(ConvertTo-Masked $account.TotpSecret)"
if ($ShowTotp) {
    Write-Host "Current TOTP code: $totpCode"
}
else {
    Write-Host "Current TOTP code: <hidden; pass -ShowTotp to display>"
}
Write-Host ""
Write-Host "DreamBot command preview:"
Write-Host ("java " + ($safeArgs | ForEach-Object {
    if ($_ -match "\s") { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}) -join " ")

if ($Launch) {
    if (-not (Test-Path -LiteralPath $LauncherPath)) {
        throw "DreamBot launcher not found: $LauncherPath"
    }

    Write-Host ""
    Write-Host "Launching DreamBot..."
    Start-Process -FilePath "java" -ArgumentList (Format-ProcessArguments -Arguments $javaArgs)
}
else {
    Write-Host ""
    Write-Host "Dry run only. Add -Launch to start DreamBot."
}
