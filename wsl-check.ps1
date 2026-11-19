# Checks, on a Windows machine with WSL 2, what docs/WSL.md still assumes: that a Linux process
# started through a detached wsl.exe outlives the window that started it and keeps its distro up,
# that Windows reaches a port the distro binds on 127.0.0.1, and that bytes pass through wsl.exe's
# stdio unchanged. Changes nothing but two files under /tmp in the distro and one in %TEMP%.
#
#   powershell -ExecutionPolicy Bypass -File .\wsl-check.ps1 start
#   (close every WSL terminal and this window, wait three minutes)
#   powershell -ExecutionPolicy Bypass -File .\wsl-check.ps1 check
#
# ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the system code page.
param(
  [ValidateSet('start', 'check')][string]$Step = 'start',
  [string]$Distro = '',
  # linux: the contrast, a process left in the distro with no wsl.exe attached.
  [ValidateSet('wsl', 'linux')][string]$Anchor = 'wsl'
)

$env:WSL_UTF8 = '1'
$Wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$StateFile = Join-Path $env:TEMP 'antumi-wsl-check.json'
$Port = 47831
$BackPort = 47832
$ProbePath = '/tmp/antumi-wsl-probe.js'

# An inbox wsl.exe ignores WSL_UTF8 and answers in UTF-16: the NULs go, and so do empty lines.
function Clean($lines) {
  @($lines | ForEach-Object { ("$_" -replace "`0", '').Trim() } | Where-Object { $_ })
}

function Say($name, $value) {
  Write-Output ("{0,-34} {1}" -f $name, $value)
}

function RunningDistros {
  Clean (& $Wsl --list --running --quiet 2>$null)
}

function ProbeAnswer($url) {
  $text = & curl.exe -s -m 5 $url 2>$null
  if (-not $text) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}

$Probe = @'
const http = require('http')
const fs = require('fs')
const port = Number(process.argv[2]) || 47831
const started = Date.now()
let bootId = ''
try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch (error) {}
let last = Date.now()
let maxGapMs = 0
setInterval(() => {
  const now = Date.now()
  maxGapMs = Math.max(maxGapMs, now - last - 1000)
  last = now
}, 1000)
http.createServer((request, response) => {
  if (request.url === '/quit') {
    response.end('bye')
    setTimeout(() => process.exit(0), 100)
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ bootId, started, uptimeSec: Math.round((Date.now() - started) / 1000), maxGapMs, node: process.version }))
}).listen(port, '127.0.0.1')
'@

if ($Step -eq 'start') {
  Write-Output '== Antumi WSL check: start =='
  Say 'windows' ([System.Environment]::OSVersion.Version.ToString())
  Say 'wsl version' ((Clean (& $Wsl --version 2>$null)) | Select-Object -First 1)
  Write-Output '-- distros'
  Clean (& $Wsl --list --verbose 2>$null) | ForEach-Object { Write-Output "   $_" }

  if (-not $Distro) { $Distro = (Clean (& $Wsl --list --quiet 2>$null)) | Select-Object -First 1 }
  if (-not $Distro) { Write-Output 'RESULT: no WSL distro found'; exit 1 }
  Say 'distro' $Distro
  Say 'running before' ((RunningDistros) -contains $Distro)
  Say 'networking mode' ((Clean (& $Wsl -d $Distro --exec wslinfo --networking-mode 2>$null)) -join ' ')

  # --exec runs without the login shell, so a Node from nvm is not on its PATH.
  $plainNode = (Clean (& $Wsl -d $Distro --exec node -v 2>$null)) -join ' '
  Say 'node with --exec' $(if ($plainNode) { $plainNode } else { 'not found' })
  $node = (Clean (& $Wsl -d $Distro --exec bash -ilc 'command -v node' 2>$null)) | Where-Object { $_.StartsWith('/') } | Select-Object -Last 1
  Say 'node in login shell' $(if ($node) { $node } else { 'not found' })
  if (-not $node) { Write-Output 'RESULT: no Node in the distro, the rest cannot run'; exit 1 }

  $Probe | & $Wsl -d $Distro --exec sh -c "cat > $ProbePath"
  Say 'anchor' $Anchor
  $anchorPid = 0
  if ($Anchor -eq 'linux') {
    & $Wsl -d $Distro --exec sh -c "setsid nohup $node $ProbePath $Port >/dev/null 2>&1 &"
  } else {
    $anchorPid = (Start-Process -FilePath $Wsl -ArgumentList @('-d', $Distro, '--exec', $node, $ProbePath, "$Port") -WindowStyle Hidden -PassThru).Id
  }
  Start-Sleep -Seconds 3

  $answer = ProbeAnswer "http://127.0.0.1:$Port/"
  Say 'windows -> wsl 127.0.0.1' $(if ($answer) { 'ok' } else { 'FAILED' })
  Say 'windows -> wsl localhost' $(if (ProbeAnswer "http://localhost:$Port/") { 'ok' } else { 'FAILED' })

  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $BackPort)
  $listener.Start()
  $back = (Clean (& $Wsl -d $Distro --exec bash -c "timeout 3 bash -c '</dev/tcp/127.0.0.1/$BackPort' 2>/dev/null && echo ok || echo no")) -join ' '
  $listener.Stop()
  Say 'wsl -> windows 127.0.0.1' $back

  $in = Join-Path $env:TEMP 'antumi-wsl-check-in.bin'
  $out = Join-Path $env:TEMP 'antumi-wsl-check-out.bin'
  $bytes = New-Object byte[] 1048576
  (New-Object System.Random).NextBytes($bytes)
  [System.IO.File]::WriteAllBytes($in, $bytes)
  Start-Process -FilePath $Wsl -ArgumentList @('-d', $Distro, '--exec', 'cat') -RedirectStandardInput $in -RedirectStandardOutput $out -NoNewWindow -Wait
  $same = (Test-Path $out) -and ((Get-FileHash $in).Hash -eq (Get-FileHash $out).Hash)
  Say 'stdio passes 1MB unchanged' $same
  Remove-Item $in, $out -ErrorAction SilentlyContinue

  @{ distro = $Distro; anchor = $Anchor; pid = $anchorPid; port = $Port; bootId = $(if ($answer) { $answer.bootId } else { '' }); startedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Path $StateFile -Encoding ASCII

  Write-Output ''
  Write-Output 'NEXT: close every WSL terminal (and VS Code windows opened in WSL), close this window,'
  Write-Output '      wait three minutes, then open a new PowerShell and run this script with: check'
  exit 0
}

Write-Output '== Antumi WSL check: check =='
if (-not (Test-Path $StateFile)) { Write-Output 'RESULT: run the start step first'; exit 1 }
$state = Get-Content $StateFile -Raw | ConvertFrom-Json
$waited = [int]((Get-Date) - [datetime]$state.startedAt).TotalSeconds
Say 'seconds since start' $waited
# Asked before anything else here touches the distro: any other wsl.exe call would start it again.
$running = RunningDistros
Say 'distro still running' ($running -contains $state.distro)
Say 'other distros running' ((@($running | Where-Object { $_ -ne $state.distro })) -join ', ')
Say 'anchor' $state.anchor
if ($state.pid) { Say 'wsl.exe still alive' ([bool](Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) }
$answer = ProbeAnswer "http://127.0.0.1:$($state.port)/"
Say 'probe still answers' ([bool]$answer)
if ($answer) {
  Say 'same boot' ($answer.bootId -eq $state.bootId)
  Say 'probe uptime seconds' $answer.uptimeSec
  Say 'longest stall ms' $answer.maxGapMs
}
if ($answer -and $answer.bootId -eq $state.bootId -and $waited -ge 170) {
  Write-Output 'RESULT: the process survived and kept the distro up'
} elseif ($answer) {
  Write-Output 'RESULT: inconclusive, wait the full three minutes with every WSL terminal closed'
} else {
  Write-Output 'RESULT: the process did NOT survive'
}

& curl.exe -s -m 5 "http://127.0.0.1:$($state.port)/quit" 2>$null | Out-Null
& $Wsl -d $state.distro --exec rm -f $ProbePath 2>$null
Remove-Item $StateFile -ErrorAction SilentlyContinue
exit 0
