<#
  install-autostart.ps1 -- make this machine's part of Ieumi come up by itself
  when Windows boots, behind a Cloudflare address that does not change.

  There are TWO machines in this system, and each one runs this script once,
  with its OWN tunnel token. They are separate tunnels on purpose: a tunnel's
  connector can only reach services on the machine it runs on, and installing
  one token on both boxes makes Cloudflare load-balance between them -- so half
  the kiosk requests would land on the relay box, which has nothing on 8791.

      the kiosk machine   (this one, outside Korea)
          .\install-autostart.ps1 -Token "<kiosk tunnel token>"
          -> serves the kiosk on port 8791 at e.g. ieumi.illkkun.cloud

      the Korea box       (the relay, inside Korea)
          .\install-autostart.ps1 -Token "<relay tunnel token>" -Relay
          -> serves the fetch relay on port 8799 at e.g. relay.illkkun.cloud

  Each install gives you:
    1. the "Cloudflared" Windows service, built from that machine's token --
       this is what makes the address permanent instead of a trycloudflare one
    2. a scheduled task, trigger "at system startup", running as SYSTEM
    3. sleep and hibernation turned off

  Both come up before anyone logs in, and both restart themselves if they die.

  RUN AS ADMINISTRATOR:
      powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Token "<TOKEN>"

  To take it back out again (add -Relay on the Korea box):
      powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Uninstall

  Windows PowerShell 5.1 on purpose: that is what ships with Windows and what
  these boxes have. No &&, no ternary, no ?? -- they are parser errors there.
#>
param(
  [string]$Token,
  [switch]$Relay,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# ---- which half of the system is this? --------------------------------------
if ($Relay) {
  $TaskName = 'Ieumi Korea Relay'
  $Port     = 8799
  $BootBat  = 'boot-relay.bat'
  $What     = 'Korea fetch relay'
} else {
  $TaskName = 'Ieumi Kiosk'
  $Port     = 8791
  $BootBat  = 'boot-kiosk.bat'
  $What     = 'Ieumi kiosk server'
}

function Say($msg)  { Write-Host "  $msg" }
function Ok($msg)   { Write-Host "  [ok]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host ""; Write-Host "  [stop] $msg" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "  Ieumi -- always-on setup: $What (port $Port)" -ForegroundColor Cyan
Write-Host "  --------------------------------------------------------"

# ---- must be elevated -------------------------------------------------------
#  Both halves need it: installing a service, and registering a SYSTEM task.
#  Without it the failure arrives much later as "access is denied", from
#  somewhere that never mentions the word administrator.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die "This must run as Administrator. Right-click PowerShell, choose 'Run as administrator', then run it again."
}

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $here
$bootBat   = Join-Path $here $BootBat
$envFile   = Join-Path $serverDir '.env'

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "removed the scheduled task '$TaskName'"
  } else {
    Say "no scheduled task '$TaskName' to remove"
    Say "(the other half uses a different name -- add or drop -Relay)"
  }

  $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($svc) {
    $cfd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cfd) {
      & $cfd.Source service uninstall | Out-Null
      Ok "removed the Cloudflared service"
    } else {
      Warn "cloudflared.exe is gone but its service is still registered. Remove it with:  sc.exe delete cloudflared"
    }
  } else {
    Say "no Cloudflared service to remove"
  }

  Write-Host ""
  Say "Power settings were left alone. To let this PC sleep again:"
  Say "    powercfg /change standby-timeout-ac 30"
  Write-Host ""
  exit 0
}

# ---------------------------------------------------------------- sanity
#  Each of these would otherwise show up as a task that starts and exits one
#  second later, which from Task Scheduler is indistinguishable from success.
if (-not (Test-Path $bootBat)) { Die "$BootBat is missing from $here" }
if (-not (Test-Path $envFile)) {
  if ($Relay) {
    Die "ieumi-server\.env does not exist. The relay needs one line in it:  KOREA_RELAY_TOKEN=<the same long random string as on the kiosk machine>"
  }
  Die "ieumi-server\.env does not exist. The server cannot start without it. Copy .env.example, fill in the keys, then run this again."
}

if ($Relay) {
  # The relay needs NOTHING but Node -- no npm install, no database, no API
  # keys. Checking for node_modules here would block a Korea box that is
  # perfectly capable of running it.
  if (-not (Select-String -Path $envFile -Pattern '^KOREA_RELAY_TOKEN=' -Quiet)) {
    Die "KOREA_RELAY_TOKEN is not in .env. Without it the relay refuses every request, which from the kiosk side looks exactly like every Korean page having gone blank."
  }
  Ok ".env has KOREA_RELAY_TOKEN"

  if (Select-String -Path $envFile -Pattern '^KOREA_RELAY_URL=http' -Quiet) {
    Warn "KOREA_RELAY_URL is set in this .env. That line belongs on the kiosk"
    Warn "machine, not here -- pointing this box at its own relay only adds a"
    Warn "hop to every page fetch, and the nightly sync pays it hundreds of times."
  }
} else {
  if (-not (Test-Path (Join-Path $serverDir 'node_modules\pg'))) {
    Die "Dependencies are not installed. Run this first, in $serverDir :   npm install --omit=dev"
  }
  Ok ".env and node_modules are in place"

  # The trap this whole exercise exists to close. A permanent kiosk address in
  # front of a relay address that dies every restart looks like success and
  # then reproduces the "Korean pages are blank" bug a day later.
  $line = Select-String -Path $envFile -Pattern '^KOREA_RELAY_URL=(.+)$' | Select-Object -First 1
  if ($line) {
    $relayUrl = $line.Matches[0].Groups[1].Value.Trim()
    if ($relayUrl -match 'trycloudflare\.com') {
      Write-Host ""
      Warn "KOREA_RELAY_URL still points at a TEMPORARY address:"
      Warn "    $relayUrl"
      Warn "Those die on every restart. Fixing only the kiosk address leaves the"
      Warn "kiosk reliably up and unable to read Korean government pages."
      Warn "Give the Korea box its own tunnel, then put its permanent hostname here."
      Write-Host ""
    } else {
      Ok "relay points at a permanent address: $relayUrl"
    }
  }
}

# ---------------------------------------------------------------- cloudflared
if (-not $Token) {
  Write-Host ""
  Say "Paste this machine's tunnel token (the long string from the Cloudflare"
  Say "dashboard -- about 180 characters, starting with eyJ)."
  Say "Treat it as a password: it lets any machine serve that hostname."
  $Token = Read-Host "  token"
}
$Token = $Token.Trim()
if (-not $Token) { Die "No token given. Nothing to install." }

# A tunnel ID and a connector token are different things, and the dashboard
# shows both. Installing the ID fails with a message that does not say which
# of the two you handed it.
if ($Token -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  Die @'
That is the tunnel ID, not the connector token.

In the Cloudflare dashboard: Zero Trust -> Networks -> Tunnels -> click the
tunnel -> Configure -> "Install and run a connector" -> Windows. It shows:

    cloudflared.exe service install eyJhIjoi....

The token is the long string after "service install" -- roughly 180
characters, starting with eyJ. That is the one this script needs.
'@
}

$cfd = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cfd) {
  Say "cloudflared is not installed -- trying winget..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host ""
    Say "cloudflared is not installed, and winget is not available either."
    Say "Download it by hand instead:"
    Say "    https://github.com/cloudflare/cloudflared/releases"
    Say "    (click 'Show all assets' at the bottom -- the Windows builds are hidden)"
    Say ""
    Say "    take    cloudflared-windows-amd64.exe"
    Say "    rename  it to cloudflared.exe"
    Say "    put it  in C:\Program Files\cloudflared\"
    Say ""
    Die "Then close this window, open a NEW administrator PowerShell, and run this again."
  }
  & winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  # winget only puts it on the PATH of processes started afterwards, so this
  # window still cannot see it. Re-read the machine PATH rather than telling
  # the user to start over.
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $cfd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cfd) {
    Die "winget ran but cloudflared still cannot be found. Close this window, open a new administrator PowerShell, and run this again."
  }
}
Ok "cloudflared: $($cfd.Source)"

# A service already registered with the OLD token keeps serving the old tunnel
# and silently ignores the new one. Always replace, never add.
$existing = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($existing) {
  Say "a Cloudflared service already exists -- replacing it so the new token takes effect"
  & $cfd.Source service uninstall | Out-Null
  Start-Sleep -Seconds 2
}

& $cfd.Source service install $Token
if ($LASTEXITCODE -ne 0) {
  Die "cloudflared service install failed (exit $LASTEXITCODE). The usual cause is a truncated token -- copy it from the dashboard again, whole."
}

Set-Service -Name 'cloudflared' -StartupType Automatic
Start-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$svc = Get-Service -Name 'cloudflared'
if ($svc.Status -eq 'Running') {
  Ok "Cloudflared service is running, and set to start at boot"
} else {
  Warn "Cloudflared service is '$($svc.Status)'. Check it with:  Get-Service cloudflared"
}

# ---------------------------------------------------------------- the process
$action  = New-ScheduledTaskAction -Execute $bootBat -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
# SYSTEM: runs with nobody logged in, and needs no stored password.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# IgnoreNew            -- never a second copy fighting for the port
# ExecutionTimeLimit 0 -- this is meant to run for months, not to finish
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "$What on port $Port, started at boot." -Force | Out-Null
Ok "scheduled task '$TaskName' registered, trigger: at system startup"

Start-ScheduledTask -TaskName $TaskName

# ---------------------------------------------------------------- power
#  A PC that falls asleep takes the service and the task down with it, and the
#  symptom from the other end is identical to the tunnel being broken.
& powercfg /change standby-timeout-ac 0   | Out-Null
& powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok "this PC will no longer sleep or hibernate on mains power"

# ---------------------------------------------------------------- verify
Write-Host ""
Say "waiting for $What to answer on port $Port ..."
$up = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
}

$logName = [System.IO.Path]::GetFileNameWithoutExtension($BootBat)
Write-Host ""
if ($up) {
  Ok "answering at http://localhost:$Port/health"
} else {
  Warn "nothing answered on port $Port after 40 seconds."
  Warn "The reason will be in:  $serverDir\logs\$logName.log"
}

Write-Host ""
Write-Host "  ----------------------------------------------------------------"
Write-Host "  Last step, and it is the only real test: REBOOT this PC." -ForegroundColor Yellow
Write-Host "  Do not log in afterwards. From another machine, open the fixed"
Write-Host "  address. If it answers with nobody logged in, this half is done."
Write-Host "  ----------------------------------------------------------------"
Write-Host ""
