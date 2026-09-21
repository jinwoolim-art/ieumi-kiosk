// 실시간 날씨 — 기상청 단기예보 API(공공데이터포털)로 "지금 이 동네" 날씨를 한 줄로.
//
// 왜 여기 있나: 어르신이 "오늘 날씨 어때요?"라고 물으면 이음이가 답해야 하는데,
// 날씨는 복지관 설정처럼 고정이 아니라 몇 분마다 바뀝니다. 그래서 프롬프트의
// '고정 블록'(buildSystem)이 아니라 매 대화마다 새로 끼워 넣는 값으로 다룹니다.
//
// 좌표는 기상청 '격자(nx, ny)'입니다. 위경도가 아니라 기상청이 나눠 놓은 칸 번호라
// 지역마다 표에서 찾아 넣습니다. 지금은 파일럿(서초) 하나만 있으면 되므로 서초를
// 기본값으로 둡니다. 복지관이 늘면 region → (nx, ny) 매핑 표로 확장하면 됩니다.
const env = require('./env');   // .env 로더는 process.env가 아니라 env 객체로 값을 넘깁니다.

const GRID = {
  '서초': { nx: 61, ny: 125 },
  '서초구': { nx: 61, ny: 125 },
};
const DEFAULT_GRID = { nx: 61, ny: 125 };  // 서초 (파일럿)

const SKY = { '1': '맑음', '3': '구름 많음', '4': '흐림' };
const PTY = { '0': '', '1': '비', '2': '비 또는 눈', '3': '눈', '5': '빗방울', '6': '진눈깨비', '7': '눈날림' };

const TTL_MS = Number(env.WEATHER_TTL_MS || 5 * 60_000);  // 5분 캐시
const cache = new Map();  // "nx,ny" -> { at, text }

// 초단기실황: 매시 정시에 관측, 약 40분 뒤 제공. 안전하게 현재-1시간의 정시를 씁니다.
function baseNcst(now) {
  const d = new Date(now.getTime() - 60 * 60_000);
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return { base_date: yyyymmdd, base_time: `${String(d.getHours()).padStart(2, '0')}00` };
}

// 초단기예보: 매시 30분 발표, 약 45분 뒤 제공. 하늘상태(SKY)는 실황엔 없고 예보에만 있어
// 여기서 하늘상태 한 칸만 빌려 옵니다. 안전하게 현재-1시간의 30분을 base로.
function baseFcst(now) {
  const d = new Date(now.getTime() - 60 * 60_000);
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return { base_date: yyyymmdd, base_time: `${String(d.getHours()).padStart(2, '0')}30` };
}

async function callKma(path, params) {
  const key = env.DATAGO_KEY;
  if (!key) throw new Error('DATAGO_KEY 없음');
  const qs = new URLSearchParams({ serviceKey: key, dataType: 'JSON', numOfRows: '60', pageNo: '1', ...params });
  const url = `http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/${path}?${qs}`;
  const r = await fetch(url);
  const j = await r.json();
  const h = j?.response?.header;
  if (!h || h.resultCode !== '00') throw new Error(h?.resultMsg || '기상청 응답 오류');
  return j.response.body.items.item;
}

/**
 * region(예: '서초구')의 지금 날씨를 한 줄 문장으로. 실패하면 null(이음이는 조용히
 * "정확한 건 담당 선생님께"로 자연히 넘어감 — 프롬프트 정책이 받쳐 줍니다).
 */
async function forRegion(region = '', now = new Date()) {
  const grid = GRID[String(region).trim()] || GRID[String(region).trim().replace(/구$/, '')] || DEFAULT_GRID;
  const ckey = `${grid.nx},${grid.ny}`;
  const hit = cache.get(ckey);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.text;

  try {
    // 현재 기온·강수·습도 (초단기실황)
    const nb = baseNcst(now);
    const ncst = await callKma('getUltraSrtNcst', { ...nb, nx: String(grid.nx), ny: String(grid.ny) });
    const v = {};
    for (const it of ncst) v[it.category] = it.obsrValue;

    // 하늘상태 (초단기예보의 첫 SKY) — 실패해도 무시
    let sky = '';
    try {
      const fb = baseFcst(now);
      const fcst = await callKma('getUltraSrtFcst', { ...fb, nx: String(grid.nx), ny: String(grid.ny) });
      const first = fcst.find(it => it.category === 'SKY');
      if (first) sky = SKY[first.fcstValue] || '';
    } catch { /* 하늘상태는 없으면 생략 */ }

    const parts = [];
    if (sky) parts.push(sky);
    const pty = PTY[v.PTY] || '';
    if (pty) parts.push(pty + ' 옴');
    else if (sky) parts.push('비는 안 옴');
    if (v.T1H != null) parts.push(`기온 ${Math.round(Number(v.T1H))}도`);
    if (v.REH != null) parts.push(`습도 ${v.REH}%`);

    const label = String(region).trim() || '이 동네';
    const text = `${label} 지금: ${parts.join(', ')}`;
    cache.set(ckey, { at: now.getTime(), text });
    return text;
  } catch (e) {
    return null;
  }
}

module.exports = { forRegion, GRID };
