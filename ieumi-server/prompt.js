// 시스템 프롬프트 — the instructions Ieumi speaks under.
//
// Kept apart from the HTTP server so it can be exercised on its own: what a
// centre selected in the dashboard reaching the conversation intact (§6-P1) is
// a behaviour worth a test, and requiring server.js would start a listener.
const kioskContext = require('./kiosk-context');

// 복지관마다 이음이의 이름·말투가 다릅니다 (PROJECT.md §3-5).
// The center name and the assistant's name are no longer hardcoded — each tenant
// supplies its own, so one server can speak as a different Ieumi per center.
const TONE = {
  warm:     '따뜻하고 다정하게',
  plain:    '담백하고 간결하게',
  cheerful: '밝고 친근하게',
};
const DEFAULT_PERSONA = kioskContext.DEFAULT_PERSONA;

// 복지관이 켜 놓은 서비스 목록 (§3-2, §6-P1).
// The dashboard's "서비스 우선순위" selection is what this renders — the order is
// the order the centre chose, and it is what Ieumi offers first.
// `org` is the organisation that actually runs the service. It comes from the
// centre's catalogue, so naming it is quoting a record rather than guessing —
// which is the difference between Ieumi being useful and Ieumi inventing a
// phone number. The link is deliberately absent: a URL read aloud to a senior
// is noise. It travels by SMS instead (server.js /sms).
const servicesText = (services) => (!services || !services.length)
  ? ''
  : '\n\n[우리 복지관이 안내하는 서비스] — 위에서부터 우선순위입니다\n'
    + services.map((s, i) =>
        `${i + 1}. (${s.category}) ${s.sub} — ${s.description}`
        + (s.org ? ` [담당기관: ${s.org}]` : '')).join('\n');

const buildSystem = (p = {}) => {
  const name = p.ieumi_name || DEFAULT_PERSONA.ieumi_name;
  const center = p.center_name || DEFAULT_PERSONA.center_name;
  const tone = TONE[p.tone] || TONE.warm;
  const region = p.region || '이 지역';
  const services = p.services || [];

  // Only jobs have real listings behind them today; everything else is a
  // description of a service the centre offers, with no live data. The prompt
  // has to make that difference explicit or Ieumi will invent phone numbers.
  const serviceRules = services.length ? `
- 어르신이 "뭘 도와줄 수 있어?"처럼 막연히 물으시면, 위 서비스 목록에서 위에서부터 <두 가지만> 아주 짧게 말하고 "어떤 게 필요하세요?"라고 되묻습니다. 한 가지당 한 마디면 충분합니다. 설명을 길게 붙이거나 전부 나열하지 마세요 — 어르신은 화면이 아니라 귀로 들으십니다.
- 어르신 말씀이 목록의 서비스와 맞으면, 저희가 도와드릴 수 있다고 답하고 담당 선생님께 연결해 드리겠다고 안내합니다.
- 일자리를 제외한 서비스는 아직 실시간 정보가 없습니다. 전화번호·금액·날짜·신청 자격처럼 구체적인 내용은 절대 지어내지 마세요. 목록에 [담당기관]이 적혀 있으면 그 기관 이름은 말해도 됩니다 — 목록에 있는 사실이니까요. 그 밖의 자세한 내용은 "자세한 건 담당 선생님께 전해드릴게요"로 받고, 원하시면 문자로 기관과 인터넷 주소를 보내드리겠다고 안내합니다.
- 목록에 없는 요청도 거절하지 말고 "담당 선생님께 꼭 전해드릴게요"로 받아, 요약에 남깁니다.` : '';

  return `당신은 '${name}', ${center}의 ${tone} 말하는 AI 말벗 도우미입니다.${servicesText(services)}
규칙:
- 어르신께 항상 존댓말로, 짧고 쉽고 ${tone}. 한 번에 1~2문장.
- 어려운 단어·영어·긴 설명 금지. 천천히 또박또박한 느낌.
- 어르신이 일자리를 원하면 목록의 자리를 하나씩 쉽게 소개합니다. 한 번에 한두 개만, 하는 일과 지역 위주로 말하고 더 들어보실지 여쭙니다. 재촉하지 말고 편하게 고르시도록 돕습니다.
- 절대 지어내지 마세요. 목록에 있는 항목만 말합니다. 어르신이 근무시간·자세한 조건 등 목록에 없는 것을 물으면, 모른다고 하지 말고 "그건 문자로 자세히 정리해서 보내드릴게요" 또는 "정확한 건 문자에 있는 담당 기관에 물어보시면 됩니다"라고 안내합니다.
- ${region}에 맞는 자리가 목록에 없으면 정직하게 "${region}에는 지금 열린 자리가 없어서, 가까운 다른 지역 자리를 알려드릴게요"라고 말합니다.
- 안내한 뒤에는 "정리해서 문자로 보내드릴까요?"처럼 문자 발송을 제안합니다.
- 준비 안 된 요청은 "담당 선생님께 꼭 전해드릴게요"로 받습니다.${serviceRules}
답하는 방법 — 반드시 이 순서를 지키세요:
1) 먼저 어르신께 할 말만 그대로 씁니다. 따옴표·괄호·이름표 없이, 소리 내어 읽을 문장만.
2) 그다음 줄을 바꾸고, 마지막 줄에 아래 JSON 한 줄만 덧붙입니다. 설명이나 코드블록은 쓰지 마세요.
{"category":"일자리|건강|복지|일상|행정|기타|긴급","summary":"담당자용 한 줄 요약","offerSms":true|false,"pick":어르신이 관심·선택한 일자리 번호(1부터. 아직 없으면 0),"service":위 서비스 목록에서 해당하는 번호(1부터. 해당 없으면 0)}`;
};

/**
 * 모델 출력 해석 — split the model's output into what Ieumi says and the data
 * the dashboards need.
 *
 * The spoken part comes first precisely so it can be streamed: a reply wrapped
 * inside a JSON object cannot start being spoken until the object is closed,
 * and that wait is the delay §3-6 is about. Older output (one JSON object with
 * `reply` inside) is still understood, so nothing breaks if a model ignores the
 * instruction.
 */
function parseModelOutput(raw) {
  // The prompt asks for no code blocks, and the model mostly complies — but not
  // always, and a stray ``` fence would otherwise be read aloud. Unwrap fences
  // before looking for the data line.
  const text = String(raw || '')
    .replace(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g, '$1')
    .replace(/```/g, '')
    .trim();

  const at = text.lastIndexOf('\n{');
  if (at >= 0) {
    try {
      const meta = JSON.parse(text.slice(at + 1));
      const reply = text.slice(0, at).trim();
      if (reply) return { reply, meta };
    } catch { /* fall through */ }
  }

  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const o = JSON.parse(obj[0]);
      if (o && o.reply) return { reply: String(o.reply).trim(), meta: o };
    } catch { /* fall through */ }
  }

  // Nothing parseable: treat it all as speech rather than saying nothing.
  return { reply: text.replace(/\{[\s\S]*\}\s*$/, '').trim() || text, meta: {} };
}


// gu = where the work is (the feed's own workPlcNm). orgAddr = the employer's
// office, which is often a different city — labelled so it is never read out as
// the workplace.
const JLABEL = {gu:'근무 지역',job:'하는 일',org:'기관/회사',pay:'급여',work:'근무시간·형태',age:'연령',to:'접수마감',place:'근무지',orgAddr:'기관 주소(근무지 아님)',tel:'문의',apply:'접수방법',note:'참고(비교용)'};
const jobsText = (jobs) => (!jobs || !jobs.length) ? '(일자리 목록 없음)'
  : jobs.map((j, i) => `${i + 1}. ` + Object.entries(j)
      .filter(([k, v]) => v && k !== 'link' && k !== 'id')
      .map(([k, v]) => `${JLABEL[k] || k}: ${v}`).join(' / ')).join('\n');

/**
 * 일자리 목록 블록 — the jobs section of the prompt, with an honest note about
 * where the postings came from.
 *
 * `scope` says how the list was found: the centre's own district, a widening to
 * the whole province, or nothing at all. Ieumi has to be able to tell a senior
 * "there is nothing in 서초 right now, so here is 강북" — which is only possible
 * if the prompt knows that is what happened.
 */
function jobsSection({ jobs = [], scope = 'none', region = '', centerRegion = '' } = {}) {
  const district = String(centerRegion || '').trim().split(/\s+/).slice(1).join(' ') || centerRegion;

  let note = '';
  if (scope === 'sido' && district) {
    note = `\n※ ${district}에는 지금 열린 자리가 없어, ${region}의 다른 지역 자리를 모았습니다. 어르신께 이 사실을 먼저 알려 주세요.`;
  } else if (scope === 'none') {
    note = '\n※ 지금 안내할 수 있는 자리가 없습니다. 지어내지 말고, 담당 선생님께 전해드리겠다고 안내하세요.';
  }

  // The source has no wage and no shift information for any posting. Saying so
  // here is what stops Ieumi filling the gap with something plausible.
  const caution = jobs.length
    ? '\n※ 이 목록에는 급여와 근무시간 정보가 없습니다. 어르신이 물으시면 "급여와 근무시간은 제가 알 수 없어서, 문의처에 여쭤보시면 정확합니다"라고 안내하고, 절대 지어내지 마세요.'
    : '';

  return `\n\n[일자리 목록]\n${jobsText(jobs)}${note}${caution}`;
}

module.exports = { TONE, DEFAULT_PERSONA, servicesText, buildSystem, JLABEL, jobsText, jobsSection, parseModelOutput };
