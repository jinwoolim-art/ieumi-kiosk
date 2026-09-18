// 자바스크립트로 그리는 페이지 읽기 — the renderer for pages that build themselves.
//
// 링크 중 상당수가 <빈 껍데기>를 돌려줍니다. 서버가 보내 주는 HTML 에는 내용이
// 없고, 브라우저가 자바스크립트를 돌려야 비로소 글이 채워지기 때문입니다.
// 복지로는 그냥 받아오면 글자가 <세 글자> 나옵니다. 브라우저로 열면 2,169자입니다 —
// 에너지바우처 지원 대상과 자격 기준이 전부 그 안에 있습니다.
//
// Many of these links return an empty shell: the server sends no content and the
// browser fills the page in afterwards. bokjiro.go.kr yields three characters of
// text when fetched plainly, and 2,169 when rendered — the eligibility rules we
// actually need are all in the difference.
//
// 새 의존성은 없습니다. 크롬(또는 엣지)의 --dump-dom 을 씁니다 — 페이지를 열고,
// 자바스크립트가 돌기를 기다렸다가, 완성된 화면을 글로 뱉어 주는 기능입니다.
// 라이브러리를 깔면 브라우저까지 따라 내려받게 되는데, 이 기기에는 이미 있습니다.
//
// No new dependency: this drives Chrome's own --dump-dom. A library such as
// Puppeteer would pull a second browser down beside the one already installed,
// and this job runs unattended on someone else's machine.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./env.js');

// 기다릴 시간. 한국 공공기관 페이지는 느립니다 — 화면이 채워지기 전에 뱉으면
// 그냥 빈 껍데기를 한 번 더 읽는 셈입니다.
const BUDGET_MS = Number(env.RENDER_BUDGET_MS || 9000);   // 자바스크립트가 돌 시간
const KILL_MS = Number(env.RENDER_KILL_MS || 45000);      // 이보다 오래 걸리면 포기

// 크롬이 어디 있는지. CHROME_PATH 가 있으면 그것만 씁니다.
const CANDIDATES = [
  env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

let cached;
function browserPath() {
  if (cached !== undefined) return cached;
  cached = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  return cached;
}

const available = () => !!browserPath();

/**
 * 한 페이지를 브라우저로 열어 완성된 HTML 을 돌려줍니다.
 *
 * 브라우저가 없으면 예외를 던집니다 — 조용히 빈 문자열을 주면, 부르는 쪽은
 * "페이지에 아무것도 없구나" 로 잘못 알아듣습니다. 그 둘은 다른 이야기입니다.
 */
function renderHtml(url, { budgetMs = BUDGET_MS, killMs = KILL_MS } = {}) {
  const exe = browserPath();
  if (!exe) throw new Error('크롬을 찾지 못했습니다 (no Chrome/Edge found — set CHROME_PATH)');

  // 매번 빈 프로필로 엽니다. 이걸 지정하지 않으면 그 기기에서 쓰는 크롬 프로필을
  // 건드리거나, 크롬이 이미 떠 있을 때 아예 실행되지 않습니다.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ieumi-render-'));

  return new Promise((resolve, reject) => {
    const child = spawn(exe, [
      '--headless=new', '--dump-dom',
      '--virtual-time-budget=' + budgetMs,
      '--user-data-dir=' + profile,
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--mute-audio',
      '--hide-scrollbars', '--window-size=1280,2400',
      url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    let out = '';
    let settled = false;
    const done = (err, html) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 이미 끝났습니다 */ }
      fs.rm(profile, { recursive: true, force: true }, () => {});
      err ? reject(err) : resolve(html);
    };

    const timer = setTimeout(() => done(new Error('render timeout')), killMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => done(e));
    child.on('close', () => done(null, out));
  });
}

module.exports = { renderHtml, available, browserPath, BUDGET_MS };
