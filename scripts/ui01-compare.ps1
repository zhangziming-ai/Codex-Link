$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$taskPairs=@(@('01-总览.png','overview'),@('02-创建备份.png','backup'),@('03-从备份恢复.png','restore'),@('04-备份管理.png','manager'),@('05-设置.png','settings'))
foreach($taskPair in $taskPairs){
 $taskLeft=[System.Drawing.Image]::FromFile((Join-Path $PWD "docs/design-previews/ui-directions/UI-01/$($taskPair[0])"))
 $taskRight=[System.Drawing.Image]::FromFile((Join-Path $PWD "ui-verification/ui01-2.0/1488x1056/$($taskPair[1]).png"))
 $taskBoard=New-Object System.Drawing.Bitmap(1488,528)
 $taskGraphics=[System.Drawing.Graphics]::FromImage($taskBoard)
 $taskGraphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
 $taskGraphics.DrawImage($taskLeft,0,0,744,528)
 $taskGraphics.DrawImage($taskRight,744,0,744,528)
 $taskBoard.Save((Join-Path $PWD "ui-verification/ui01-2.0/compare-$($taskPair[1]).png"))
 Write-Output "$($taskPair[1]): source $($taskLeft.Width)x$($taskLeft.Height), actual $($taskRight.Width)x$($taskRight.Height)"
 $taskGraphics.Dispose();$taskBoard.Dispose();$taskLeft.Dispose();$taskRight.Dispose()
}
