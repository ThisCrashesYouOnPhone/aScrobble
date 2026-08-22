#!/usr/bin/env pwsh
# Test Apple Music API with stored tokens
# Usage: .\test-apple-api.ps1

$ErrorActionPreference = "Stop"

Write-Host "Fetching Apple tokens from Windows Credential Manager..." -ForegroundColor Cyan

# Service name must match what's used in storage.rs
$serviceName = "dev.aScrobble.app"

# Use cmdkey to list credentials (Windows built-in)
$creds = & cmdkey /list 2>&1 | Select-String -Pattern $serviceName

if (-not $creds) {
    Write-Error "No credentials found for service '$serviceName'. Run the aScrobble app and connect Apple Music first."
    exit 1
}

Write-Host "Found credentials:" -ForegroundColor Green
$creds | ForEach-Object { Write-Host "  $_" }

Write-Host "`nAttempting to read stored tokens from Windows Credential Manager..." -ForegroundColor Cyan

$code = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class CredentialManager
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    private static extern void CredFree(IntPtr credentialPtr);

    public static string ReadCredential(string targetName)
    {
        IntPtr credPtr;
        if (CredRead(targetName, 1, 0, out credPtr))
        {
            try
            {
                CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                if (cred.CredentialBlob != IntPtr.Zero && cred.CredentialBlobSize > 0)
                {
                    byte[] blob = new byte[cred.CredentialBlobSize];
                    Marshal.Copy(cred.CredentialBlob, blob, 0, cred.CredentialBlobSize);
                    return Encoding.Unicode.GetString(blob);
                }
            }
            finally
            {
                CredFree(credPtr);
            }
        }
        return null;
    }
}
"@

Add-Type -TypeDefinition $code -IgnoreWarnings

$jsonTokens = $null
foreach ($target in @("apple-tokens.dev.amusic.app", "apple-tokens.dev.ascrobble.app")) {
    $raw = [CredentialManager]::ReadCredential($target)
    if ($raw) {
        $jsonTokens = $raw
        break
    }
}

if ($jsonTokens) {
    $parsed = $jsonTokens | ConvertFrom-Json
    $devToken = $parsed.developer_token
    $userToken = $parsed.music_user_token
} else {
    $appDataDir = [System.IO.Path]::Combine($env:LOCALAPPDATA, "ascrobble")
    $tokenFile = [System.IO.Path]::Combine($appDataDir, "tokens.json")
    if (Test-Path $tokenFile) {
        $tokens = Get-Content $tokenFile | ConvertFrom-Json
        $devToken = $tokens.developer_token
        $userToken = $tokens.music_user_token
    }
}

if (-not $devToken -or -not $userToken) {
    Write-Host "`nCould not auto-extract tokens from keychain." -ForegroundColor Yellow
    $devToken = Read-Host -Prompt "Developer Token (starts with eyJ...)"
    $userToken = Read-Host -Prompt "Music User Token"
}

if (-not $devToken -or -not $userToken) {
    Write-Error "Missing required tokens. Cannot proceed."
    exit 1
}

Write-Host "`nTokens acquired successfully!" -ForegroundColor Green
Write-Host "Dev Token: $($devToken.Substring(0, [Math]::Min(20, $devToken.Length)))..." -ForegroundColor DarkGray
Write-Host "User Token: $($userToken.Substring(0, [Math]::Min(20, $userToken.Length)))..." -ForegroundColor DarkGray

# Test 1: Recently Played
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "TEST 1: Recently Played Tracks" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$headers = @{
    "Authorization" = "Bearer $devToken"
    "Music-User-Token" = $userToken
    "Origin" = "https://music.apple.com"
}

try {
    $response = Invoke-RestMethod -Uri "https://api.music.apple.com/v1/me/recent/played/tracks?limit=10" -Headers $headers
    
    Write-Host "SUCCESS! Found $($response.data.Count) recent tracks:" -ForegroundColor Green
    
    foreach ($track in $response.data | Select-Object -First 5) {
        $attrs = $track.attributes
        $isrc = if ($attrs.isrc) { $attrs.isrc } else { "NO ISRC" }
        Write-Host "  - $($attrs.name) by $($attrs.artistName) [ISRC: $isrc]"
    }
    
    # Save first track ISRC for play count test
    $firstTrack = $response.data[0]
    $firstTrackIsrc = $firstTrack.attributes.isrc
    $firstTrackName = $firstTrack.attributes.name
    
} catch {
    Write-Error "Failed to fetch recently played: $_"
    exit 1
}

# Test 2: Play Count Lookup (the position-0 probe API)
if ($firstTrackIsrc) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "TEST 2: Play Count Lookup (Position-0 Probe)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Testing with track: $firstTrackName" -ForegroundColor White
    Write-Host "ISRC: $firstTrackIsrc" -ForegroundColor White
    
    $catalogUrl = "https://api.music.apple.com/v1/catalog/us/songs?filter[isrc]=$firstTrackIsrc&include[songs]=library"
    Write-Host "`nRequest URL: $catalogUrl" -ForegroundColor DarkGray
    
    try {
        $catalogResponse = Invoke-RestMethod -Uri $catalogUrl -Headers $headers
        
        Write-Host "`nCatalog Response:" -ForegroundColor Green
        $catalogResponse | ConvertTo-Json -Depth 3 | Write-Host
        
        # Try to extract play count
        if ($catalogResponse.data -and $catalogResponse.data.Count -gt 0) {
            $song = $catalogResponse.data[0]
            Write-Host "`nSong found in catalog: $($song.attributes.name)" -ForegroundColor Green
            
            if ($song.attributes.playCount) {
                Write-Host "PLAY COUNT: $($song.attributes.playCount)" -ForegroundColor Green -BackgroundColor Black
            } else {
                Write-Host "WARNING: playCount attribute not found in response" -ForegroundColor Yellow
                Write-Host "This means the position-0 probe CANNOT detect repeats for this track." -ForegroundColor Yellow
            }
            
            # Check if track is in user's library
            if ($catalogResponse.data[0].relationships -and $catalogResponse.data[0].relationships.library) {
                Write-Host "Track IS in user's library" -ForegroundColor Green
            } else {
                Write-Host "WARNING: Track NOT in user's library - play count unavailable" -ForegroundColor Yellow
            }
        } else {
            Write-Host "No catalog data found for ISRC $firstTrackIsrc" -ForegroundColor Yellow
        }
        
    } catch {
        Write-Error "Failed to fetch catalog data: $_"
        Write-Host "Response details: $($_.Exception.Response)" -ForegroundColor Red
    }
} else {
    Write-Host "`n========================================" -ForegroundColor Yellow
    Write-Host "SKIPPING Play Count Test" -ForegroundColor Yellow
    Write-Host "First track has no ISRC - position-0 probe cannot work" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "TROUBLESHOOTING SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host @"

Position-0 Repeat Detection Requirements:
1. Track must have an ISRC (International Standard Recording Code)
2. Track must be in your Apple Music library (not just played from search)
3. Play count must increase between polls (requires 2+ worker runs)

If the play count test shows:
- "NO ISRC" → The track can't be probed (rare, usually streaming-only releases)
- "not found in catalog" → The track isn't in your library
- "playCount attribute not found" → Apple's API isn't returning it

To fix successive scrobbling:
- Add the track to your Apple Music library (click + or heart)
- Wait for 2 polling cycles (10+ minutes at 5-min intervals)
- Check Cloudflare worker logs for "Position-0 probe" messages

"@ -ForegroundColor White
