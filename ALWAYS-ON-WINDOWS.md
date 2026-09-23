# 고정 주소 + 부팅 자동 실행 — Windows

**Fixed address + start-at-boot, on Windows**

이 문서대로 하면 ① 주소가 바뀌지 않고 ② 컴퓨터를 켜면 저절로 뜹니다.
bat 파일을 매번 여실 필요가 없습니다.

*Follow this and the address stops changing, and everything comes up on its own
at boot — no more opening a .bat file every morning.*

소요 시간: 컴퓨터당 **20분** + 재부팅 1회.
*About 20 minutes per machine, plus one reboot.*

---

## 중요: 컴퓨터가 **두 대**입니다 / Important: there are TWO machines

| | 컴퓨터 / Machine | 역할 / Role | 포트 | 주소 예 / Address |
|---|---|---|---|---|
| **A** | 키오스크 서버 (한국 밖) | 키오스크 본체 / *the kiosk itself* | 8791 | `ieumi.illkkun.cloud` |
| **B** | 한국 박스 (한국 안) | 한국 사이트 대신 열어주는 중계 / *fetch relay* | 8799 | `relay.illkkun.cloud` |

**터널은 두 개가 필요합니다. 토큰도 두 개입니다.**
한 터널의 커넥터는 자기가 실행되는 컴퓨터의 서비스만 볼 수 있기 때문입니다.
같은 토큰을 두 컴퓨터에 넣으면 Cloudflare가 둘을 번갈아 씁니다 — 키오스크
요청의 절반이 8791에 아무것도 없는 한국 박스로 갑니다.

***Two tunnels, two tokens.** A tunnel's connector can only reach services on
the machine it runs on. Installing one token on both boxes makes Cloudflare
load-balance between them, so half the kiosk requests land on the relay box,
which has nothing on port 8791.*

⚠️ **B를 빼먹으면 안 됩니다.** A만 고정하면 키오스크는 안정적으로 떠 있는데
한국 정부 사이트를 못 읽는 상태가 됩니다 — 예전에 "답을 안 한다"고 하셨던
그 문제와 같습니다.

*⚠️ **Do not skip B.** Fixing only A leaves the kiosk reliably up and unable to
read Korean government pages — the same failure as the "it won't answer" round.*

---

## 시작 전 확인 / Before you start

각 컴퓨터에서 / *on each machine:*

1. **Node.js** 가 `C:\Program Files\nodejs` 에 설치되어 있을 것
   *Node.js in the default machine-wide location. An nvm or per-user install is
   invisible to the SYSTEM account at boot — it works in your own shell and
   then fails silently every morning.*
2. `ieumi-server\.env` 파일이 있을 것 / *`.env` present*
   - A (키오스크): `DATABASE_URL`, `ANTHROPIC_API_KEY`, `CLOVA_API_KEY_ID`, `CLOVA_API_KEY`
   - B (중계): `KOREA_RELAY_TOKEN` 한 줄만 있으면 됩니다 / *that one line is enough*
3. **A에서만** `npm install --omit=dev` 를 한 번 실행했을 것
   *Only A needs dependencies. B needs nothing but Node — no npm install, no
   database, no API keys.*

---

## 1단계 — 토큰 두 개 받기 / Step 1: get both tokens

Cloudflare 대시보드 → Zero Trust → Networks → Tunnels → 해당 터널 클릭 →
**Configure** → "Install and run a connector" → **Windows**

이런 명령이 보입니다 / *it shows a command like:*

```
cloudflared.exe service install eyJhIjoi....
```

`service install` 뒤의 **긴 문자열**이 토큰입니다. 약 180자, `eyJ` 로 시작합니다.

*The token is the long string after `service install` — about 180 characters,
starting with `eyJ`.*

⚠️ **터널 ID(UUID)는 토큰이 아닙니다.** `89f96b75-d22a-...` 처럼 짧고 하이픈이
들어간 것은 터널 ID입니다. 그걸로는 설치되지 않습니다.
*⚠️ A tunnel **ID** — short, with hyphens — is not the token. It will not install.*

⚠️ 토큰은 **비밀번호와 같습니다.** 이 토큰이 있으면 어떤 컴퓨터든 그 주소로
서비스를 띄울 수 있습니다. 단체 채팅방에 붙여넣지 마세요.
*⚠️ The token is a credential. Direct message only, never a group chat.*

---

## 2단계 — 관리자 PowerShell / Step 2: PowerShell as Administrator

시작 버튼 → `PowerShell` 검색 → **마우스 오른쪽 클릭** → **관리자 권한으로 실행**

*Start → search `PowerShell` → right-click → **Run as administrator**. Required:
it installs a service and registers a SYSTEM task. Without it the script stops
and says so.*

---

## 3단계 — 명령 한 줄 / Step 3: one command

**A — 키오스크 컴퓨터 / the kiosk machine**

```powershell
cd <repo>\ieumi-server\tools; powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Token "<A의 토큰>"
```

**B — 한국 박스 / the Korea box** — `-Relay` 를 꼭 붙이세요 / *note `-Relay`*

```powershell
cd <repo>\ieumi-server\tools; powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Token "<B의 토큰>" -Relay
```

초록색 `[ok]` 줄들이 나오면 성공입니다. 빨간 `[stop]` 이 나오면 그 줄에
무엇을 해야 하는지 적혀 있습니다.
*Green `[ok]` lines mean it worked. A red `[stop]` line says exactly what to fix.*

---

## 4단계 — A의 .env 를 B의 고정 주소로 / Step 4: point A at B's new address

B가 끝나면, **A**의 `ieumi-server\.env` 에서 이 줄을 영구 주소로 바꿉니다.
*Once B is done, change this line in **A**'s `.env` to the permanent address:*

```
KOREA_RELAY_URL=https://relay.illkkun.cloud
```

이 단계를 빠뜨리면 A는 이미 죽은 임시 주소를 계속 부릅니다.
*Miss this and A keeps calling a temporary address that is already dead.*

---

## 5단계 — 재부팅 (이게 진짜 확인입니다) / Step 5: reboot — the real test

두 대 모두 **재부팅**하고, **로그인하지 마세요.** 그 상태로 맥에서 주소를
열어 보세요. 열리면 끝입니다.

*Reboot both, and do **not** log in. Then open the address from the Mac. If it
answers with nobody logged in, the setup is correct. Testing it while logged in
proves nothing — that is the case that already worked.*

---

## 안 될 때 / If something breaks

| 증상 / Symptom | 확인할 것 / Check |
|---|---|
| 주소가 502 | 터널은 살아 있고 프로그램이 죽은 것 — 로그 마지막 줄 / *tunnel up, process down* |
| 주소가 아예 안 열림 | `Get-Service cloudflared` 가 `Running` 인지 / *is the tunnel service running* |
| 시작했다 바로 꺼짐 | `.env` 문제. 로그에 `FATAL` 로 적힙니다 / *logged as `FATAL`* |
| 키오스크는 뜨는데 한국 사이트만 못 읽음 | B가 죽었거나 4단계를 안 한 것 / *B is down, or step 4 was skipped* |
| 아침에만 안 됨 | 절전, 또는 Windows Update 재시작 / *sleep, or an update restart* |

로그 보기 / *read the log:*

```powershell
Get-Content <repo>\ieumi-server\logs\boot-kiosk.log -Tail 40   # A
Get-Content <repo>\ieumi-server\logs\boot-relay.log -Tail 40   # B
```

되돌리기 / *undo* (B에서는 `-Relay` 추가 / *add `-Relay` on B*):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Uninstall
```

---

## 이 설정이 못 막는 두 가지 / Two things this cannot fix

1. **전원.** 절전은 껐지만, 컴퓨터를 끄면 당연히 멈춥니다. 두 대 모두 켜져
   있어야 합니다.
   *Both PCs have to stay powered on. Sleep is disabled, but "off" is still off.*

2. **Windows Update 재시작.** 업데이트가 밤에 재시작하면 자동으로 다시
   올라오지만 몇 분간 끊깁니다. 설정 → Windows Update → **활성 시간**을
   테스트 시간대로 지정해 두세요.
   *An update restart recovers automatically, with a few minutes of downtime.
   Set **Active hours** to cover the testing window.*
