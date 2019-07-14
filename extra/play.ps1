# Audio player that emulates a subset of the mplayer cli interface.

param (
    [Parameter(Mandatory=$true)][string]$path, # audio file
    [string]$inputConfigPath, # MPlayer-style input.conf file
    [int]$ss = 0 # offset in seconds
)

$ErrorActionPreference = "Stop"

# Mapping from MPlayer key names to .NET key names
# https://docs.microsoft.com/en-us/dotnet/api/system.consolekey
$keyNameMapping = @{
    "RIGHT" = "RightArrow";
    "LEFT" = "LeftArrow";
    "DOWN" = "DownArrow";
    "UP" = "UpArrow";
    "PGUP" = "PageUp";
    "PGDWN" = "PageDown";
    "BS" = "Backspace";
    "SPACE" = "Spacebar";
    "ESC" = "Escape";
}
 
$keyMapping = @{
    # custom commands
    "s" = "status", $null
}
if ($inputConfigPath) {
    $lines = Get-Content $inputConfigPath
    foreach ($line in $lines) {
        if ($line -match '^([^\s#]+)\s+(\w+)\s*([^\s#]*)\s*#?.*$') {
            $key = $Matches[1]
            if ($keyNameMapping.ContainsKey($key)) {
                $key = $keyNameMapping[$key]
            }
            $cmd = $Matches[2]
            $arg = $Matches[3]
            try {
                $arg = [float]$arg
            } catch {}
            $keyMapping[$key] = $cmd, $arg
        } elseif ($line -and !$line.startsWith('##')) {
            Write-Host "Ignoring: $line"
        }
    }
}

$keyMapping | Out-Host

if ([System.Console]::IsInputRedirected) {
    function ReadKey {
        # blocking
        $key = [System.Console]::Read()
        if ($key -eq -1) {
            return $false
        }
        $keyChar = [System.Convert]::ToChar($key)
        return $keyChar.ToString()
    }
} else {
    function ReadKey {
        # non-blocking
        if ([System.Console]::KeyAvailable) {
            $keyInfo = [System.Console]::ReadKey()
            $key = $keyInfo.Key
            # If not a unicode character (e.g. left arrow), char will be \U0000.
            $keyChar = $keyInfo.KeyChar
            if ($keyChar) {
                # converting [char] to [string] allows string comparison
                return $keyChar.ToString()
            } else {
                return $key.ToString()
            }
        } else {
            return $false
        }
    }
}

Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open($path)
$player.Position = [System.TimeSpan]::FromSeconds($ss)
$player.Play()
$paused = $false

function PrintStatusLine {
    # A:   4.3 (04.2) of 261.0 (04:21.0)  0.0%
    $elapsedSecs = ("{0:f1}" -f $player.Position.TotalSeconds).replace(",",".")
    $elapsedHuman = $player.Position
    $durationSecs = ("{0:f1}" -f $duration.TotalSeconds).replace(",",".")
    $durationHuman = $duration
    if ($player.SpeedRatio -eq 1.0) {
        $speedRatio = ''
    } else {
        $speedRatio = ("{0:f2}x" -f $player.SpeedRatio).replace(",",".")
    }
    Write-Host "`rA: $elapsedSecs ($elapsedHuman) of $durationSecs ($durationHuman) 0.0% $speedRatio" -NoNewline
}

try {
    $i = 0
    do {
        # Wait until NaturalDuration is available.
        # This is also a proxy for the MediaOpened event.
        # (events are not working for some reason)
        $duration = $player.NaturalDuration.TimeSpan
        Start-Sleep -Milliseconds 100
        $i += 1
        if ($i -gt 50) {
            throw "Unable to play $path"
        }
    } while (!$duration)
    
    while ($player.Position -lt $duration) {
        $key = ReadKey
        
        if ($keyMapping.ContainsKey($key)) {
            $cmd, $val = $keyMapping[$key]
            switch ($cmd) {
                # standard MPlayer commands
                "seek" {
                    $player.Position += [System.TimeSpan]::FromSeconds($val)
                }
                "speed_mult" {
                    $player.SpeedRatio *= $val
                }
                "speed_set" {
                    $player.SpeedRatio = $val
                }
                "pause" {
                    if ($paused) {
                        $player.Play()
                        $paused = $false
                    } else {
                        $player.Pause()
                        $paused = $true
                    }
                }
                "quit" {
                    $player.Position = $duration
                }
                # additional commands
                "status" {
                    # Unfortunately reading from stdin and printing to stdout cannot be done
                    # in two threads in parallel in PowerShell. Therefore, the status line
                    # is not printed continuously (as would be the case with MPlayer) but rather
                    # on demand when requested by stdin.
                    PrintStatusLine
                }
                default {
                    Write-Host "Unsupported command: $cmd"
                }
            }
        }
        # Only print continuously when a terminal is attached
        # where non-blocking key-reading can be used.
        if (![System.Console]::IsInputRedirected) {
            PrintStatusLine
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    # Clean-up in case we're not running in a separate shell that's killed.
    $player.Close();
}
