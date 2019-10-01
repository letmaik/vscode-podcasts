# Audio player that emulates a subset of the mplayer cli interface.

param (
    [Parameter(Mandatory=$true)][string]$path, # audio file
    [string]$inputConfigPath, # MPlayer-style input.conf file
    [int]$ss = 0, # offset in seconds
    [string]$thumbnailUrl = $null # displayed in System Media Transport Controls
)

$ErrorActionPreference = "Stop"

if ($thumbnailUrl -and $thumbnailUrl -ne 'none') {
    $thumbnailUrl = [System.Uri]$thumbnailUrl
} else {
    $thumbnailUrl = $null
}

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

# Import WinRT types
$null = [Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
$null = [Windows.Media.Playback.MediaPlaybackItem, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Media.Playback.MediaPlayerAudioCategory, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Media.Playback.MediaPlaybackState, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.MusicProperties, Windows.Storage.FileProperties, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.StorageItemThumbnail, Windows.Storage.FileProperties, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.ThumbnailMode, Windows.Storage.FileProperties, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.ThumbnailOptions, Windows.Storage.FileProperties, ContentType = WindowsRuntime]


# https://fleexlab.blogspot.com/2018/02/using-winrts-iasyncoperation-in.html
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$player = New-Object Windows.Media.Playback.MediaPlayer
$playbackSession = $player.PlaybackSession

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$source = [Windows.Media.Core.MediaSource]::CreateFromStorageFile($file)
$playbackItem = New-Object Windows.Media.Playback.MediaPlaybackItem($source)

# Integrate with System Media Transport Controls (SMTC)
$preferredThumbnailSize = 300
$thumbnail = Await ($file.GetThumbnailAsync([Windows.Storage.FileProperties.ThumbnailMode]::MusicView,
    $preferredThumbnailSize,
    [Windows.Storage.FileProperties.ThumbnailOptions]::ReturnOnlyIfCached)) ([Windows.Storage.FileProperties.StorageItemThumbnail])
if ($thumbnail) {
    $thumbnailStream = [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromStream($thumbnail)
} elseif ($thumbnailUrl) {
    $thumbnailStream = [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromUri($thumbnailUrl)
} else {
    $thumbnailStream = $null
}
$musicProps = Await ($file.Properties.GetMusicPropertiesAsync()) ([Windows.Storage.FileProperties.MusicProperties])
$displayProps = $playbackItem.GetDisplayProperties()
$displayProps.Type = [Windows.Media.MediaPlaybackType]::Music
$displayProps.Thumbnail = $thumbnailStream
$displayProps.MusicProperties.Title = $musicProps.Title
$displayProps.MusicProperties.Artist = $musicProps.Artist
$displayProps.MusicProperties.AlbumArtist = $musicProps.AlbumArtist
$displayProps.MusicProperties.TrackNumber = $musicProps.TrackNumber
$playbackItem.ApplyDisplayProperties($displayProps)

$player.Source = $playbackItem
$player.AudioCategory = [Windows.Media.Playback.MediaPlayerAudioCategory]::Media
$playbackSession.Position = [System.TimeSpan]::FromSeconds($ss)
$player.Play()
$duration = $musicProps.Duration

function PrintStatusLine {
    # A:   4.3 (04.2) of 261.0 (04:21.0)  0.0% 1.2x
    $elapsedSecs = ("{0:f1}" -f $playbackSession.Position.TotalSeconds).replace(",",".")
    $elapsedHuman = $playbackSession.Position
    $durationSecs = ("{0:f1}" -f $duration.TotalSeconds).replace(",",".")
    $durationHuman = $duration
    if ($playbackSession.PlaybackRate -eq 1.0) {
        $speedRatio = ''
    } else {
        $speedRatio = ("{0:f2}x" -f $playbackSession.PlaybackRate).replace(",",".")
    }
    Write-Host "`rA: $elapsedSecs ($elapsedHuman) of $durationSecs ($durationHuman) 0.0% $speedRatio" -NoNewline
}

try {
    while ($player.Position -lt $duration) {
        $key = ReadKey
        
        if ($keyMapping.ContainsKey($key)) {
            $cmd, $val = $keyMapping[$key]
            switch ($cmd) {
                # standard MPlayer commands
                "seek" {
                    $playbackSession.Position += [System.TimeSpan]::FromSeconds($val)
                }
                "speed_mult" {
                    $playbackSession.PlaybackRate *= $val
                }
                "speed_incr" {
                    $playbackSession.PlaybackRate += $val
                }
                "speed_set" {
                    $playbackSession.PlaybackRate = $val
                }
                "pause" {
                    $state = $playbackSession.PlaybackState
                    if ($state -eq [Windows.Media.Playback.MediaPlaybackState]::Paused) {
                        $player.Play()
                    } else {
                        $player.Pause()
                    }
                }
                "quit" {
                    $playbackSession.Position = $duration
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
    $player.Dispose()
}
