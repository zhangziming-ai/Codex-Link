$ErrorActionPreference='Stop'
$existing=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Codex Link' }
if($existing){throw 'Existing installation detected; refusing replacement.'}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('codex-link-ui01-install-'+[Guid]::NewGuid().ToString('N'))
$testTarget=[IO.Path]::GetFullPath((Join-Path $testRoot 'app'))
if(-not $testTarget.StartsWith([IO.Path]::GetFullPath($testRoot)+[IO.Path]::DirectorySeparatorChar)){throw 'Target escapes test root'}
$installer=(Resolve-Path 'dist/Codex-Link-Setup-2.1.0-x64.exe').Path
$install=Start-Process -FilePath $installer -ArgumentList '/S',"/D=$testTarget" -WindowStyle Hidden -Wait -PassThru
if($install.ExitCode -ne 0){throw "Install failed: $($install.ExitCode)"}
$env:CODEX_LINK_SMOKE_EXE=Join-Path $testTarget 'Codex Link.exe'
try {
 node scripts/ui01-package-smoke.js
 if($LASTEXITCODE -ne 0){throw 'Installed application smoke failed'}
 $evidence=Get-Content 'ui-verification/ui01-2.1/package-smoke.json' -Raw | ConvertFrom-Json
 $uninstaller=Get-ChildItem -LiteralPath $testTarget -Filter 'Uninstall*.exe' | Select-Object -First 1
 if(-not $uninstaller){throw 'No uninstaller'}
 $removal=Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
 if($removal.ExitCode -ne 0){throw "Uninstall failed: $($removal.ExitCode)"}
 $backups=Get-ChildItem -LiteralPath (Join-Path $evidence.fixture 'backups') -Filter 'manifest.json' -Recurse
 if($backups.Count -lt 1){throw 'Backup did not survive uninstall'}
 $evidence | Add-Member -NotePropertyName installerSha256 -NotePropertyValue (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
 $evidence | Add-Member -NotePropertyName installDirectory -NotePropertyValue $testTarget
 $evidence | Add-Member -NotePropertyName installerExitCode -NotePropertyValue $install.ExitCode
 $evidence | Add-Member -NotePropertyName uninstallerExitCode -NotePropertyValue $removal.ExitCode
 $evidence | Add-Member -NotePropertyName backupsPreserved -NotePropertyValue $true
 $evidence | ConvertTo-Json -Depth 8 | Set-Content 'ui-verification/ui01-2.1/installer-smoke.json' -Encoding utf8
 Write-Output 'PASS: custom-directory install, application backup/restart, uninstall, backups preserved'
} finally { Remove-Item Env:CODEX_LINK_SMOKE_EXE -ErrorAction SilentlyContinue }
