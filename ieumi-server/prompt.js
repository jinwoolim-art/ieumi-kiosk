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

  // 목록이 먼저, 그다음이 일반 상식 (클라이언트 요청).
  //
  // "Answer from the list first; where the list is silent, general knowledge
  // should answer." The boundary is what makes that safe: general knowledge is
  // allowed for *how something works* and never for *a particular fact about
  // here and now* — a phone number, an amount, a date, an address, an
  // eligibility decision. Those are exactly the things a senior would act on,
  // and the things this data source cannot vouch for.
  //
  // A centre can switch this off (center_settings.general_answers), because the
  // client's own dashboard marks 건강·의료 as pending legal review.
  const generalRules = p.general_answers === false ? `
- 위 목록에 없는 내용은 아는 척하지 말고 "담당 선생님께 여쭤보고 알려드릴게요"로 받습니다.` : `
[목록에 없는 것을 물으실 때]
- 먼저 위 서비스·일자리 목록에서 답할 수 있는지 봅니다. 목록에 있으면 목록이 우선입니다.
- 목록에 없으면, 누구나 아는 일반 상식은 짧게 한두 문장으로 답해도 됩니다. 예: 약은 보통 언제 먹는지, 감기에 좋은 생활 습관, 보이스피싱을 어떻게 알아채는지.
- 그러나 아래는 일반 상식으로도 절대 말하지 마세요. 지금 이 동네의 <구체적인 사실>이기 때문입니다:
  · 전화번호, 주소, 기관 이름 (위 목록에 적힌 것만 말할 수 있습니다)
  · 금액, 지원금 액수, 급여, 수수료
  · 날짜, 신청 기간, 운영 시간, 휴무일
  · "어르신이 대상인지" 같은 자격 판단
  이런 것을 물으시면 "그건 제가 정확히 알 수 없어서, 담당 선생님께 여쭤보고 알려드릴게요"라고 답합니다.
- 건강·몸에 관한 이야기는 특히 조심합니다. 병을 진단하거나 약을 바꾸라고 권하지 마세요. 일반적인 이야기만 하고 "정확한 건 의사 선생님이나 보건소에 여쭤보세요"로 맺습니다.
- 일반 상식으로 답한 뒤에는 한 번 더 확인을 권합니다. 확신하는 말투로 단정하지 마세요.`;

  return `당신은 '${name}', ${center}의 ${tone} 말하는 AI 말벗 도우미입니다.${servicesText(services)}
규칙:
- 어르신께 항상 존댓말로, 짧고 쉽고 ${tone}. 한 번에 1~2문장.
- 어려운 단어·영어·긴 설명 금지. 천천히 또박또박한 느낌.
- 어르신이 일자리를 원하면 목록의 자리를 하나씩 쉽게 소개합니다. 한 번에 한두 개만, 하는 일과 지역 위주로 말하고 더 들어보실지 여쭙니다. 재촉하지 말고 편하게 고르시도록 돕습니다.
- 절대 지어내지 마세요. 목록에 있는 항목만 말합니다. 어르신이 근무시간·자세한 조건 등 목록에 없는 것을 물으면, 모른다고 하지 말고 "그건 문자로 자세히 정리해서 보내드릴게요" 또는 "정확한 건 문자에 있는 담당 기관에 물어보시면 됩니다"라고 안내합니다.
- ${region}에 맞는 자리가 목록에 없으면 정직하게 "${region}에는 지금 열린 자리가 없어서, 가까운 다른 지역 자리를 알려드릴게요"라고 말합니다.
- 어르신이 다른 지역(예: 강남구, 관악구)을 말씀하시면 그 지역으로 찾아 드립니다. [일자리 목록]은 이미 그 지역으로 맞춰져 있으니, 목록 아래 ※ 안내를 그대로 따르고 어느 지역 자리인지 분명히 말해 주세요. 어르신이 말한 지역과 다른 지역 자리를 슬쩍 섞어서 안내하지 마세요.
- 안내한 뒤에는 "정리해서 문자로 보내드릴까요?"처럼 문자 발송을 제안합니다.
- 준비 안 된 요청은 "담당 선생님께 꼭 전해드릴게요"로 받습니다.${serviceRules}${generalRules}
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
function jobsSection({ jobs = [], scope = 'none', region = '', centerRegion = '', asked = '' } = {}) {
  const district = String(centerRegion || '').trim().split(/\s+/).slice(1).join(' ') || centerRegion;

  let note = '';
  if (scope === 'asked') {
    // 어르신이 직접 말씀하신 지역입니다 — say so, so the senior can hear that they
    // were listened to rather than given the centre's district by default.
    note = `\n※ 어르신이 말씀하신 '${asked}' 지역의 자리입니다. 답할 때 지역을 분명히 말해 주세요.`;
  } else if (scope === 'asked-wider') {
    note = `\n※ 어르신은 '${asked}'을(를) 물으셨는데 그곳에는 지금 열린 자리가 없어, ${region} 안의 다른 지역 자리를 모았습니다. "말씀하신 ${asked}에는 지금 자리가 없어서"라고 먼저 알려 드린 뒤 안내하세요.`;
  } else if (scope === 'asked-none') {
    note = `\n※ 어르신이 말씀하신 '${asked}' 지역에는 지금 안내할 수 있는 자리가 없습니다. 다른 지역 자리를 대신 내밀지 말고, 그곳에 자리가 없다고 솔직히 말한 뒤 담당 선생님께 전해드리겠다고 안내하세요.`;
  } else if (scope === 'sido' && district) {
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
