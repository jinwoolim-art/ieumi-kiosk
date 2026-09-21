// 질문이 들어온 뒤에 꺼내 쓰는 층 — the layer that reads after the question exists.
//
// 008 의 요약은 <질문을 알기 전에> 무엇을 남길지 고르는 일이었습니다. 그래서
// 강좌가 서른 개인 표가 열 줄로 줄었고, 어느 열 줄을 고르든 스무 개는 사라졌습니다.
// 2026-09-18 클라이언트 지적이 그 스무 개 이야기였습니다: "홈페이지에는 수십 가지
// 프로그램이 안내되어 있는데 이음이는 세 개를 못 고릅니다."
//
// 여기서는 순서를 뒤집습니다. 어르신이 물으신 <뒤에> 겹치는 대목만 꺼냅니다.
// 같은 서비스라도 "무슨 강좌 있어요" 와 "목요일에 뭐 해요" 는 서로 다른 조각을
// 데려옵니다.
//
// The summary had to choose what to keep before the question existed, so a
// thirty-row course table became ten lines and twenty courses vanished. This
// inverts the order: the pieces are chosen after the asking, so "which courses"
// and "what happens on Thursday" pull different parts of the same page.
//
// 임베딩을 쓰지 않습니다. 조사(를·에서·부터)가 붙는 한국어에서는 <겹치는 글자>가
// 잘 듣고, 무엇보다 왜 그 조각이 뽑혔는지 눈으로 볼 수 있습니다. 어르신께 잘못
// 안내된 것을 되짚어야 할 때 그 차이가 큽니다.
//
// No embeddings: substring overlap handles Korean's attached particles (강좌/강좌를/
// 강좌는 all contain 강좌) with no model call and no new dependency, and when an
// answer goes wrong it can be traced by eye — which matters when the person who
// got the wrong answer is 84.
const db = require('./db');
const env = require('./env.js');

const BUDGET = Number(env.RETRIEVAL_BUDGET || 3500);   // 프롬프트에 넣을 글자 수
const PER_SERVICE = Number(env.RETRIEVAL_PER_SERVICE || 3);
const CANDIDATES = Number(env.RETRIEVAL_CANDIDATES || 24);
const MIN_SCORE = Number(env.RETRIEVAL_MIN_SCORE || 2);

// 조사를 떼어 냅니다 — "강좌를" 로 찾으면 "강좌" 가 적힌 줄을 놓칩니다.
// 긴 것부터 떼야 '에서' 가 '에' 로 먼저 잘리지 않습니다.
const PARTICLES = [
  '에서는', '으로는', '에게서', '에서', '으로', '에게', '한테', '부터', '까지',
  '처럼', '보다', '이랑', '라고', '이나', '인지', '이고', '하고', '와는', '과는',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '만', '로', '와', '과', '랑',
];

// 질문에만 나오고 자료에는 뜻이 없는 말 — 이런 것이 점수를 끌면 엉뚱한 조각이 옵니다.
const STOP = new Set([
  '뭐가', '무슨', '어떤', '어디', '언제', '얼마', '누구', '그거', '저거', '이거',
  '있어', '있나', '있는', '있을', '있습', '없어', '알려', '주세', '주세요', '해줘',
  '해주', '싶어', '제가', '저는', '그런', '그럼', '우리', '하는', '하나', '대해',
  '대한', '관련', '이야기', '말씀', '그것', '건가', '건데', '인데', '어떻게', '한번',
  '좀요', '그래', '네요', '거예', '거요', '이요', '까요', '나요', '은가', '는가',
  // 인사는 찾을 것이 없습니다 — 그런데도 한 번은 데이터베이스를 다녀오게 됩니다.
  // Greetings retrieve nothing, and without this each one still costs a round trip.
  '안녕', '안녕하세요', '안녕하십니까', '반갑습니다', '고맙습니다', '감사합니다',
  '알겠습니다', '수고하세요', '여보세요',
  'the', 'and', 'what', 'when', 'where', 'how', 'can', 'you', 'tell', 'me', 'about',
  'is', 'are', 'for', 'any', 'some', 'please', 'there', 'that', 'this', 'with',
  'do', 'does', 'have', 'has', 'give', 'show', 'would', 'could', 'like', 'want',
]);

// 어르신은 홈페이지에 적힌 말로 물으시지 않습니다.
//
// "몇 시에 문 여나요" 와 "운영시간 평일 09:00~18:00" 은 겹치는 글자가 <하나도>
// 없습니다. 글자만 맞춰서는 영영 만나지 못합니다. 프롬프트에는 이미 같은 규칙이
// 있습니다 — "어르신은 목록에 적힌 이름대로 말씀하지 않으십니다. 처지를
// 말씀하십니다." 찾는 쪽에도 같은 것이 있어야 합니다.
//
// 임베딩이 해 주는 일이지만, 어르신이 실제로 물으시는 것은 열 몇 가지로 모입니다.
// 그 열 몇 가지를 적어 두는 편이 모델 호출보다 빠르고, 틀렸을 때 고치기 쉽습니다.
//
// "What time do you open" and "운영시간 평일 09:00~18:00" share not one character.
// The prompt already carries this rule for the model; the search needs it too.
// Embeddings would do it, but what seniors actually ask collapses to about a
// dozen shapes, and a dozen written-down shapes are faster than a model call and
// far easier to correct when one is wrong.
const EXPAND = [
  [/몇\s*시|시간|언제|여[나느]|열[어리]|닫|운영|영업|휴[관무]/, ['운영시간', '시간', '평일', '휴관']],
  [/얼마|비용|값|돈|무료|공짜|수강료|요금|가격/,               ['수강료', '요금', '무료', '비용']],
  [/강좌|수업|배우|프로그램|교실|강의|클래스|뭐.*배/,          ['강좌', '프로그램', '교실', '수업']],
  [/시간표|일정|요일|스케줄|며칠/,                             ['시간표', '요일', '일정']],
  [/전화|번호|연락|통화/,                                      ['전화', '연락처']],
  [/어디|주소|위치|찾아|가는\s*길|오시는/,                      ['주소', '위치', '오시는']],
  [/신청|접수|등록|모집|넣[으을]|어떻게.*하[면나]/,            ['신청', '접수', '모집']],
  [/자격|대상|누가|나이|살인데|되나|될까/,                      ['대상', '자격', '이상']],
];

/**
 * 질문에서 찾을 말을 뽑습니다.
 *
 * 조사를 뗀 것과 원래 것을 <둘 다> 넣습니다. '시간표를' 은 떼면 '시간표' 지만,
 * '오전' 처럼 떼면 안 되는 말도 있어서 한쪽만 믿을 수 없습니다.
 */
function terms(question) {
  const found = new Set();
  const q = String(question || '');
  for (const [re, add] of EXPAND) if (re.test(q)) add.forEach((a) => found.add(a));
  for (const m of String(question || '').matchAll(/[가-힣]{2,}|[A-Za-z][A-Za-z0-9]{1,}|\d{1,2}시|\d{4}/g)) {
    const raw = m[0].toLowerCase();
    if (raw.length < 2 || STOP.has(raw)) continue;
    found.add(raw);
    if (/^[가-힣]+$/.test(raw)) {
      for (const p of PARTICLES) {
        if (raw.length > p.length + 1 && raw.endsWith(p)) {
          const stem = raw.slice(0, -p.length);
          if (stem.length >= 2 && !STOP.has(stem)) found.add(stem);
          break;
        }
      }
    }
  }
  return [...found].slice(0, 14);
}

/**
 * 이 복지관이 켜 둔 서비스들의 조각 중, 질문과 겹치는 것을 가져옵니다.
 *
 * 경계는 서비스 id 목록입니다 — persona.services 는 이 복지관이 켠 것만 담고
 * 있으므로, 그 id 로만 찾으면 다른 복지관의 자료에는 구조적으로 닿지 않습니다
 * (§3-1). 질문 문자열을 믿고 넓히는 일은 하지 않습니다.
 */
async function search(serviceIds, question, { limit = CANDIDATES } = {}) {
  const t = terms(question);
  if (!t.length || !serviceIds.length) return [];

  // 제목이 본문보다 무겁습니다 — '2026년 2학기 강좌' 라는 제목 한 줄이, 본문
  // 어딘가를 '강좌' 가 스치는 것보다 훨씬 강한 신호입니다.
  //
  // 다만 <제목만> 무거우면 속습니다. '효도버스 노선 시간표' 라는 제목의 공지가
  // 있었는데, 정작 시간표는 그림 안에 있어서 본문에는 시각이 한 줄도 없었습니다.
  // 그런데도 제목 점수만으로, 실제 시각이 가득한 조각(그림에서 옮겨 적은 것)을
  // 밀어냈습니다. 어르신은 "8시 30분부터 5시 30분까지 다녀요" 라는 두루뭉술한
  // 답을 듣고, 정류장별 시각은 못 들으셨습니다.
  //
  // 그래서 두 가지를 더 봅니다.
  //   ① 시각을 물으셨으면 <시각이 적힌> 조각을, 금액을 물으셨으면 금액이 적힌
  //      조각을 올려 줍니다. 제목의 약속이 아니라 본문의 내용을 봅니다.
  //   ② 본문이 거의 없는 조각은 내립니다 — 대개 제목과 부스러기뿐입니다.
  //
  // A notice titled "효도버스 노선 시간표" carried no times at all (they were in an
  // image) and still outranked the transcription that was full of them, on title
  // score alone. So: reward a chunk that actually contains the kind of thing being
  // asked for, and demote one that is little more than its own title.
  const wantsTime  = /몇\s*시|시간|언제|출발|도착|운행|시간표|열|닫/.test(String(question || ''));
  const wantsMoney = /얼마|비용|수강료|요금|값|무료|가격/.test(String(question || ''));

  return db.all(
    `SELECT c.url, c.title, c.kind, c.heading, c.body, c.chars, c.service_id,
            s.sub, s.org,
            to_char(ss.fetched_at, 'YYYY-MM-DD') AS at,
            (SELECT count(*) FROM unnest($2::text[]) q WHERE c.heading ILIKE '%' || q || '%') * 3
          + (SELECT count(*) FROM unnest($2::text[]) q WHERE c.body    ILIKE '%' || q || '%')
          + CASE WHEN $4 AND c.body ~ '[0-9]{1,2}:[0-9]{2}' THEN 4 ELSE 0 END
          + CASE WHEN $5 AND c.body ~ '[0-9][0-9,]*\\s*원'   THEN 4 ELSE 0 END
          + CASE WHEN length(c.body) < 120 THEN -3 ELSE 0 END
              AS score
       FROM source_chunks c
       JOIN services s        ON s.id = c.service_id
       LEFT JOIN service_sources ss ON ss.id = c.source_id
      WHERE c.service_id = ANY($1::uuid[])
      ORDER BY score DESC, c.kind, c.ord
      LIMIT $3`,
    [serviceIds, t, limit, wantsTime, wantsMoney]);
}

/**
 * 프롬프트에 넣을 [자세한 자료] 한 덩어리를 만듭니다.
 *
 * 한 서비스가 예산을 다 먹지 않게 막습니다. 어르신이 물으신 것이 한 기관 이야기여도,
 * 근처 기관의 같은 강좌가 함께 보이는 편이 낫습니다 — 그리고 '안내' 같은 흔한
 * 말 하나로 한 페이지가 통째로 들어차는 것을 막아 줍니다.
 */
async function forQuestion(persona, question, { budget = BUDGET } = {}) {
  const services = (persona && persona.services) || [];
  const ids = services.map((s) => s.id).filter(Boolean);
  if (!ids.length) return '';

  let rows;
  try { rows = await search(ids, question); }
  catch { return ''; }   // 조각이 없어도 대화는 이어집니다 — 요약은 그대로 갑니다

  const perService = new Map();
  const picked = [];
  let used = 0;

  for (const r of rows) {
    if (Number(r.score) < MIN_SCORE) continue;
    const n = perService.get(r.service_id) || 0;
    if (n >= PER_SERVICE) continue;
    const size = (r.body || '').length + 80;
    if (used + size > budget) continue;
    perService.set(r.service_id, n + 1);
    picked.push(r);
    used += size;
  }
  if (!picked.length) return '';

  const body = picked.map((r) => {
    // 그림에서 옮겨 적은 것은 그렇다고 밝힙니다. 이음이가 "홈페이지에 적혀
    // 있기로는" 이라고 말할 때, 그것이 포스터였다면 그것도 사실입니다.
    const what = r.kind === 'image' ? '안내문(그림)' : (r.title || r.heading || '페이지');
    return `· ${r.sub}${r.org ? ' — ' + r.org : ''} / ${what}${r.at ? ` (${r.at} 확인)` : ''}\n`
         + r.body.split('\n').map((l) => '  ' + l).join('\n');
  }).join('\n\n');

  return `\n\n[자세한 자료 — 어르신이 지금 물으신 것과 관련된 대목만 뽑았습니다]
아래는 각 기관 홈페이지(또는 그 홈페이지의 안내문 그림)에서 그대로 옮겨 온 것입니다.
- 여기 적힌 것은 <그대로 말씀드려도 됩니다.> 강좌 이름, 요일과 시간, 수강료, 정원, 모집기간 모두 마찬가지입니다.
- 어르신이 "뭐가 있나" 하고 물으시면 <실제 이름을 들어> 두세 개만 말씀드립니다. "여러 가지가 있어요" 는 아무 답도 아닙니다.
- 여기 없는 것은 지어내지 마세요. 표에 빈칸이면 그 시간에는 없는 것입니다.
- 영어로 답할 때는 아래 내용을 영어로 옮겨 말씀드립니다.
${body}`;
}

module.exports = { forQuestion, search, terms, BUDGET };
