// 공공데이터포털 활용신청이 열렸는지만 확인합니다 — npm run check-datago
//
// 왜 따로 있는가:
//
// 공공데이터포털(data.go.kr)은 API 마다 키를 따로 주지 않습니다. 계정에 인증키가
// <하나> 있고, 쓰고 싶은 서비스마다 '활용신청' 을 눌러 승인받는 구조입니다.
// 그래서 어떤 서비스가 막혀 있을 때, 그것이
//
//   (가) 키가 틀린 것인지,
//   (나) 키는 맞는데 그 서비스에 활용신청이 안 된 것인지
//
// 코드만 봐서는 알 수 없습니다. 둘 다 '안 된다' 로 보이기 때문입니다.
// 2026-09-14 부터 이 구분이 클라이언트와 여러 번 오갔습니다 — "키를 전달했는데
// 적용이 안 된 것 같다" 는 말이 나올 때마다 실제로는 (나) 였습니다.
//
// One data.go.kr account has ONE key; every API needs its own 활용신청 approval.
// A blocked service therefore looks identical whether the key is wrong or the key
// is simply not subscribed to that service — and the answer has been "not
// subscribed" every time it has come up with this client. This prints which,
// with the portal's own words, so the question can be settled in thirty seconds
// instead of by reading code.
//
// 모델도 부르지 않고 데이터베이스도 건드리지 않습니다. 크레딧이 들지 않습니다.
// No model call, no database: this costs nothing to run.
//
//   npm run check-datago            전부
//   npm run check-datago -- 약국     이름에 그 말이 들어간 것만
//   npm run check-datago -- --json  결과를 JSON 으로
const env = require('./env.js');
const { pfetch } = require('./proxy-fetch');

const KEY = env.DATAGO_KEY || '';

// 서울특별시 서초구, 그리고 격자 좌표 (61,125) 는 서초구입니다.
const SEOUL = encodeURIComponent('서울특별시');
const SEOCHO = encodeURIComponent('서초구');

// 클라이언트에게 활용신청을 부탁드린 목록 그대로입니다 (REPLY-TO-TOM-keys.md).
// 'have' 는 이미 열려 있어야 하는 것 — 이 줄이 실패하면 키 자체나 네트워크 문제이지
// 활용신청 문제가 아닙니다. 기준점으로 남겨 둡니다.
const SERVICES = [
  { have: true, name: '노인일자리 (SenuriService)', use: '일자리 — 이미 씁니다',
    url: 'https://apis.data.go.kr/B552474/SenuriService/getJobList', qs: 'pageNo=1&numOfRows=1' },
  { have: true, name: '복지로 중앙부처 복지서비스', use: '복지 안내 (열려 있음)',
    url: 'http://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001',
    qs: 'pageNo=1&numOfRows=3&callTp=L&srchKeyCode=003' },
  { have: true, name: '복지로 지자체 복지서비스', use: '서초구 복지 (열려 있음)',
    url: 'http://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist',
    qs: `pageNo=1&numOfRows=3&ctpvNm=${SEOUL}&sggNm=${SEOCHO}` },

  { name: '약국 (국립중앙의료원)', use: 's1 — 문 연 약국',
    url: 'http://apis.data.go.kr/B552657/ErmctInsttInfoInqireService/getParmacyListInfoInqire',
    qs: `Q0=${SEOUL}&Q1=${SEOCHO}&pageNo=1&numOfRows=3` },
  { name: '응급의료기관 (국립중앙의료원)', use: 's1 — 응급실',
    url: 'http://apis.data.go.kr/B552657/ErmctInfoInqireService/getEgytListInfoInqire',
    qs: `Q0=${SEOUL}&Q1=${SEOCHO}&pageNo=1&numOfRows=3` },
  { name: '응급실 실시간 병상', use: 's1 — 실시간 병상',
    url: 'http://apis.data.go.kr/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire',
    qs: `STAGE1=${SEOUL}&STAGE2=${SEOCHO}&pageNo=1&numOfRows=3` },
  { name: '기상청 단기예보', use: 's8 — 날씨',
    url: 'http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst',
    qs: 'dataType=JSON&base_date=__YMD__&base_time=0500&nx=61&ny=125&pageNo=1&numOfRows=3' },
  { name: '기상청 기상특보', use: 's56 — 재난·안전',
    url: 'http://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList',
    qs: 'pageNo=1&numOfRows=3&dataType=JSON&stnId=108' },
  { name: 'TAGO 버스도착정보', use: 's9 — 버스 도착',
    url: 'http://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',
    qs: 'cityCode=23&nodeId=DJB8001793&pageNo=1&numOfRows=3&_type=json' },
  { name: 'TAGO 버스정류소정보', use: 's9 — 정류장 찾기',
    url: 'http://apis.data.go.kr/1613000/BusSttnInfoInqireService/getSttnNoList',
    qs: `cityCode=23&nodeNm=${encodeURIComponent('대전')}&pageNo=1&numOfRows=3&_type=json` },
  { name: '심평원 병원정보', use: 's3 — 병원',
    url: 'http://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList',
    qs: 'sidoCd=110000&sgguCd=110019&pageNo=1&numOfRows=3' },
];

// 어제 날짜 — 단기예보는 아직 발표되지 않은 시각을 물으면 NO_DATA 가 납니다.
// 그건 활용신청과 상관없는 이야기라, 확실히 있는 날짜로 물어봅니다.
function yesterday() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

/**
 * 포털의 대답을 네 가지로 가릅니다.
 *
 * 'NOT SUBSCRIBED' 와 'BAD KEY' 를 굳이 나누지 않는 것은, 포털이 두 경우에 같은
 * 문구를 쓰기 때문입니다. 대신 위의 have:true 줄이 함께 성공하는지를 보면
 * 구별됩니다 — 그쪽이 되는데 이쪽이 안 되면 활용신청 문제입니다.
 */
function verdict(body) {
  const s = String(body || '').replace(/\s+/g, ' ');
  if (/SERVICE_KEY_IS_NOT_REGISTERED|등록되지\s*않은\s*서비스키/i.test(s))
    return { code: 'NOT SUBSCRIBED', ko: '활용신청 안 됨' };
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|일일\s*트래픽|초과/i.test(s))
    return { code: 'QUOTA', ko: '호출 한도 초과' };
  if (/DEADLINE_HAS_EXPIRED|기한만료/i.test(s))
    return { code: 'EXPIRED', ko: '사용 기한 만료' };
  if (/NORMAL[_ ]?SERVICE|<resultCode>0*0<\/resultCode>|"resultCode"\s*:\s*"?0*0"?|<totalCount>/i.test(s))
    return { code: 'OPEN', ko: '됨' };
  if (/SERVICE_ACCESS_DENIED|접근이\s*거부/i.test(s))
    return { code: 'DENIED', ko: '접근 거부' };
  return { code: '?', ko: '알 수 없음' };
}

const detail = (body) => {
  const m = String(body).match(/<returnAuthMsg>([^<]*)|<resultMsg>([^<]*)|"resultMsg"\s*:\s*"([^"]*)|"errMsg"\s*:\s*"([^"]*)/);
  const msg = m ? m.slice(1).filter(Boolean)[0] : '';
  const total = (String(body).match(/<totalCount>(\d+)|"totalCount"\s*:\s*"?(\d+)/) || [])
    .slice(1).filter(Boolean)[0];
  return (total ? '총 ' + total + '건 · ' : '') + String(msg || '').replace(/\s+/g, ' ').slice(0, 60);
};

async function probe(s) {
  const qs = s.qs.replace('__YMD__', yesterday());
  const url = `${s.url}?serviceKey=${encodeURIComponent(KEY)}&${qs}`;
  try {
    const r = await pfetch(url, { timeoutMs: 30_000 });
    const body = await r.text();
    return { ...verdict(body), http: r.status, detail: detail(body) };
  } catch (e) {
    return { code: 'UNREACHABLE', ko: '연결 안 됨', http: null,
             detail: String(e.message || e).slice(0, 60) };
  }
}

(async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const filter = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  if (!KEY) {
    console.error('\n  ✖ DATAGO_KEY 가 없습니다. ieumi-server/.env 에 넣어 주십시오.');
    console.error('    DATAGO_KEY is not set — put the data.go.kr key in ieumi-server/.env\n');
    process.exit(1);
  }

  const list = SERVICES.filter((s) => !filter || (s.name + ' ' + s.use).includes(filter));
  if (!asJson) {
    console.log('\n  공공데이터포털 활용신청 확인 — is this key approved for each service?');
    console.log('  키 길이 ' + KEY.length + '자 · ' + new Date().toISOString().slice(0, 10) + '\n');
  }

  const out = [];
  for (const s of list) {
    const r = await probe(s);
    out.push({ name: s.name, use: s.use, ...r });
    if (asJson) continue;
    const mark = { OPEN: '✔', 'NOT SUBSCRIBED': '✖', QUOTA: '△', EXPIRED: '△',
                   DENIED: '✖', UNREACHABLE: '?', '?': '?' }[r.code] || '?';
    console.log('  ' + mark + ' ' + r.code.padEnd(15) + s.name.padEnd(28)
      + String(s.use).padEnd(22) + r.detail);
  }

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }

  const open = out.filter((r) => r.code === 'OPEN');
  const blocked = out.filter((r) => r.code === 'NOT SUBSCRIBED');
  const baseline = out.filter((r) => SERVICES.find((s) => s.name === r.name && s.have));

  console.log('\n  열림 ' + open.length + ' · 활용신청 안 됨 ' + blocked.length
    + ' · 그 밖 ' + (out.length - open.length - blocked.length));

  // 이 한 줄이 이 도구의 요점입니다.
  if (blocked.length && baseline.some((r) => r.code === 'OPEN')) {
    console.log('\n  → 키는 <정상>입니다. 위에 열린 서비스가 같은 키로 응답했습니다.');
    console.log('    막힌 것은 포털에서 그 서비스에 <활용신청>이 안 된 것입니다.');
    console.log('    키를 새로 받아도 달라지지 않습니다 — 포털에서 활용신청을 눌러야 합니다.');
    console.log('\n    The key is fine: the services above answered with it. The blocked ones');
    console.log('    are not subscribed on the portal, and a new key will not change that.\n');
  } else if (blocked.length) {
    console.log('\n  → 열린 서비스가 하나도 없습니다. 키나 네트워크 문제일 수 있습니다.');
    console.log('    Nothing opened at all — suspect the key itself or the network.\n');
  } else {
    console.log('\n  → 전부 열려 있습니다.  All requested services are approved.\n');
  }
})();
