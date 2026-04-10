# Test Apple Music API with stored tokens
# Run: .\test-apple.ps1

$devToken = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzc0ODk2NTE3LCJleHAiOjE3ODIxNTQxMTcsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.Rr-x075Wm_iiqd0AhxcGEsZsIOnaM6eSLGSe1Ou7_SQsC0AFuVcX9qFtv-icBdPnbKSuZJOHm_JH1QwyS4DC8g"
$userToken = "0.AsfsVtcU51vQAqBsiYr2ddQCFBCgXdSfBLhCO8ihrXdH6h64Ms01PHv4+kOTIr/4ndyZXaxJEsmne57xnQADTdCiAcRc5V2oxxceJYEXX2iHfCCVYioQv1VtRjHuKo7Hxapap6Nz1ob1mIwvY0T+t1hGeEhLa/icoGUUVXTzJJZw8RmKMd67hgJxBVYf5rgIskUat/vp9Jn4wQY0dl2e+NX99OJ4cAWpQ7ZAPQPOZtY1QlHgpA=="

$headers = @{
    "Authorization" = "Bearer $devToken"
    "Music-User-Token" = $userToken
    "Origin" = "https://music.apple.com"
}

Write-Host "Testing Apple Music API..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "https://api.music.apple.com/v1/me/recent/played/tracks?limit=10" -Headers $headers
    
    Write-Host "SUCCESS! Found $($response.data.Count) recent tracks:" -ForegroundColor Green
    
    foreach ($track in $response.data | Select-Object -First 5) {
        $attrs = $track.attributes
        $isrc = if ($attrs.isrc) { $attrs.isrc } else { "NO ISRC" }
        Write-Host "  - $($attrs.name) by $($attrs.artistName) [ISRC: $isrc]"
    }
    
    # Test play count lookup for first track with ISRC
    $firstTrack = $response.data | Where-Object { $_.attributes.isrc } | Select-Object -First 1
    if ($firstTrack) {
        $isrc = $firstTrack.attributes.isrc
        Write-Host "`nTesting play count lookup for ISRC: $isrc" -ForegroundColor Cyan
        
        $catalogUrl = "https://api.music.apple.com/v1/catalog/us/songs?filter[isrc]=$isrc&include[songs]=library"
        try {
            $catalog = Invoke-RestMethod -Uri $catalogUrl -Headers $headers
            
            if ($catalog.data -and $catalog.data.Count -gt 0) {
                $song = $catalog.data[0]
                Write-Host "Found in catalog: $($song.attributes.name)" -ForegroundColor Green
                
                if ($song.attributes.playCount) {
                    Write-Host "PLAY COUNT: $($song.attributes.playCount)" -ForegroundColor Green -BackgroundColor Black
                } else {
                    Write-Host "WARNING: No playCount attribute! Track may not be in library." -ForegroundColor Yellow
                }
            } else {
                Write-Host "Not found in catalog - track not in your library" -ForegroundColor Yellow
            }
        } catch {
            Write-Error "Catalog lookup failed: $_"
        }
    } else {
        Write-Host "`nWARNING: No tracks with ISRC found - position-0 probe cannot work" -ForegroundColor Red
    }
    
} catch {
    Write-Error "API call failed: $_"
}
