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
// 영어로 시험할 때는 목록도 영어로 — 번역이 없는 줄은 한국어 그대로 둡니다.
// Under English the catalogue is rendered from the *_en columns, falling back to
// Korean per field: a half-translated row still reads, and Ieumi is never handed
// an empty service name.
const pick = (s, field, en) => (en && s[field + '_en']) || s[field] || '';

// 어르신이 실제로 쓰시는 말 — 카탈로그의 '검색어' 칸입니다.
//
// 이 칸은 처음부터 데이터베이스에 있었고, kiosk-context 도 같이 읽어 왔는데,
// 정작 프롬프트에는 한 번도 실리지 않았습니다. 그래서 목록에는 "응급 및
// 야간/휴일 진료"라고만 적혀 있었고, 어르신이 "문 연 약국 있나"라고 물으시면
// 이음이가 그 서비스를 못 찾았습니다. 서비스 이름대로 말씀하시는 어르신은
// 없습니다 — 처지를 말씀하십니다.
//
// The `keywords` column has been in the database, and in the kiosk context, from
// the start — it simply never reached the prompt. So the model saw only the
// catalogue's formal name for a service and missed the words a senior actually
// uses for it. Nobody asks for "Emergency & Night/Holiday Care"; they ask if
// there is a pharmacy open. This is the single largest cause of "you have to
// ask the exact question".
const alsoAsked = (s, en) => {
  const kw = pick(s, 'keywords', en);
  if (!kw) return '';
  return en ? `\n   ↳ also asked as: ${kw}`
            : `\n   ↳ 이렇게 물으셔도 이 서비스입니다: ${kw}`;
};

const servicesText = (services, en) => (!services || !services.length)
  ? ''
  : (en ? '\n\n[Services this centre can help with] — in priority order, highest first\n'
        : '\n\n[우리 복지관이 안내하는 서비스] — 위에서부터 우선순위입니다\n')
    + services.map((s, i) =>
        `${i + 1}. (${pick(s, 'category', en)}) ${pick(s, 'sub', en)} — ${pick(s, 'description', en)}`
        + (pick(s, 'org', en) ? (en ? ` [run by: ${pick(s, 'org', en)}]`
                                    : ` [담당기관: ${pick(s, 'org', en)}]`) : '')
        + alsoAsked(s, en)).join('\n');

// 영어 모드에서도 규칙은 같은 한국어 규칙입니다 — 언어만 바꿉니다.
//
// The rules are not rewritten for English, and that is deliberate. A separate
// English rule set would be a second system: testing it would prove nothing
// about the one that runs in Seocho. So the same instructions are sent, with a
// directive on top that changes only the language they are answered in.
const ENGLISH_MODE = `
[LANGUAGE — read this first]
- The rules below are written in Korean. Follow them exactly as written.
- But ANSWER IN ENGLISH. Everything you say aloud must be natural English.
- Where a rule gives a Korean phrase to say, say its natural English equivalent
  rather than the Korean words.
- Speak plainly and warmly, the way you would to someone in their eighties.
  Short sentences. No jargon.
- The JSON data line at the end keeps its exact field names. Its "summary" value
  should be written in English.
`;

// 링크에서 확인한 사실 — 이 블록이 있는 서비스만 구체적으로 답할 수 있습니다.
//
// 지금까지의 규칙은 "금액·날짜·자격은 절대 말하지 마세요" 였고, 그때는 그것이
// 옳았습니다. 근거가 없었으니까요. 근거가 생기면 규칙이 바뀌어야 합니다 —
// 기록을 읽어 주는 것은 지어내는 것이 아닙니다. 대신 <어디서 언제 확인한 것인지>를
// 함께 말하게 합니다. 출처 없이 말하는 금액이야말로 이 프로젝트가 피해 온 것입니다.
//
// The old rule was "never state an amount", and it was right while there was
// nothing behind it. Once the page has been read, reading a record back is not
// inventing — but it must come with where and when it was checked. An amount
// with no provenance is exactly the confident, stale answer this project exists
// to avoid, and a senior cannot tell the two apart by ear.
const factsSection = (services, en) => {
  const withFacts = (services || []).filter((s) => (en ? (s.facts_en || s.facts) : s.facts));
  if (!withFacts.length) return '';
  const body = withFacts.map((s) => {
    const label = (en && s.sub_en) || s.sub;
    const org = (en && s.org_en) || s.org || '';
    const when = s.facts_at ? (en ? ` (checked ${s.facts_at})` : ` (${s.facts_at} 확인)`) : '';
    return `· ${label}${org ? ' — ' + org : ''}${when}\n`
      + ((en ? (s.facts_en || s.facts) : s.facts) || '').split('\n')
          .map((l) => '  ' + l.trim()).filter((l) => l.trim()).join('\n');
  }).join('\n\n');

  return en
    ? `\n\n[CHECKED FACTS — taken from each service's own web page]\n${body}`
    : `\n\n[확인된 자료 — 각 서비스의 홈페이지에서 직접 확인한 내용입니다]\n${body}`;
};

const factsRules = (en) => en ? `
[When the checked facts cover it — say so plainly]
- Anything written in [CHECKED FACTS] you MAY state directly: amounts, eligibility, periods, phone numbers. You are reading a record, not guessing.
- Always say where it came from, and when: "According to the Seocho District Office page, as checked on…". A senior deserves to know how firm the number is.
- Give the part that answers the question. If they said there are two of them, give the two-person amount, not the whole table.
- If the facts do not cover what they asked, say so honestly and pass it to the staff member. Never fill the gap from elsewhere.
- Use only the number written on the line you are answering about. Never carry a figure across from another line. "Medical costs up to 1,000,000 won" and "special support up to 3,000,000 won" are different items — asked about medical costs, say 1,000,000 and nothing else. If you are not certain which item a figure belongs to, give no figure and offer the staff member instead. A wrong amount is worse than no amount.
- Whenever you say you cannot answer something, and the checked facts for that service carry a phone number, you MUST read that number out in the very same reply. Offering to text it is not a substitute — say it, then offer the text as well. Sitting on a number you were handed while telling someone you cannot help is the most annoying thing you can do to a person who came here for an answer.
- Never describe your own workings. Not "the page I have does not say", not "my information", not "my data". A senior has no idea you have pages. Say "that part is not in the guidance here" and move on.
- Close by suggesting they confirm with the organisation, since these pages do change.` : `
[확인된 자료가 있을 때 — 그대로 알려드립니다]
- [확인된 자료]에 적힌 내용은 <그대로 말해도 됩니다>. 금액·자격·기간·전화번호도 마찬가지입니다. 지어내는 것이 아니라 기록을 읽어 드리는 것이기 때문입니다.
- 말할 때는 <어디서 언제 확인한 것인지>를 함께 알려드립니다. 예: "서초구청 홈페이지에 나와 있기로는…".
- 어르신이 식구 수를 말씀하셨으면 그 금액만 말씀드립니다. "두 식구"라고 하시면 2인 금액만.
- 그러나 "가구별로 얼마씩이냐", "얼마나 나오냐"처럼 <표 전체를 물으시면> 짧게 나열해 드립니다. 예: "한 분이면 30만원, 두 분이면 40만원, 세 분이면 50만원이에요." 되묻지 말고 먼저 알려드린 뒤에 필요하면 여쭙니다 — 알고 있는 것을 두고 되묻는 것은 모른다는 말과 똑같이 들립니다.
- [확인된 자료]에 없는 내용은 솔직히 모른다고 하고 담당 선생님께 전해드리겠다고 합니다. 다른 데서 끌어와 채우지 마세요.
- <숫자는 그 항목에 적힌 것만 씁니다.> 다른 줄의 숫자를 가져다 붙이지 마세요. 예: "의료비 최고 100만원"과 "특별지원 최고 300만원"은 서로 다른 항목입니다 — 의료비를 물으셨으면 100만원이라고만 말합니다. 어느 항목의 금액인지 확실하지 않으면 금액을 말하지 말고 담당 선생님께 여쭤보겠다고 하세요. 틀린 금액은 모른다고 하는 것보다 나쁩니다.
- <다만 그 서비스의 [확인된 자료]에 전화번호가 있으면, 모른다고 말하면서 그 번호를 함께 알려드립니다.> 문자로 보내드릴지만 묻고 끝내지 마세요. 가지고 있는 번호를 쥐고서 "모른다"고만 하는 것이, 답을 들으러 오신 어르신께 가장 답답한 일입니다.
- <제 안쪽 사정을 설명하지 마세요.> "제가 가진 페이지에는 없어요", "자료에는", "제 정보로는" 같은 말은 쓰지 않습니다. 어르신은 이음이가 무슨 페이지를 들고 있는지 모르십니다. "그건 여기 안내에 안 나와 있어서요" 정도로 짧게 말하고 넘어갑니다.
- 끝에는 기관에 한 번 더 확인해 보시라고 권합니다. 홈페이지 내용은 바뀔 수 있습니다.`;

const buildSystem = (p = {}) => {
  const en = p.lang === 'en';
  const name = p.ieumi_name || DEFAULT_PERSONA.ieumi_name;
  const center = (en && p.center_name_en) || p.center_name || DEFAULT_PERSONA.center_name;
  const tone = TONE[p.tone] || TONE.warm;
  const region = p.region || '이 지역';
  const services = p.services || [];

  // Only jobs have real listings behind them today; everything else is a
  // description of a service the centre offers, with no live data. The prompt
  // has to make that difference explicit or Ieumi will invent phone numbers.
  const serviceRules = services.length ? `
[어떤 서비스인지 알아듣는 법 — 글자가 아니라 뜻으로]
- <어르신은 목록에 적힌 이름대로 말씀하지 않으십니다.> 처지를 말씀하십니다. 글자가 다르다고 "그건 안내해 드리기 어렵다"고 하지 마세요 — 뜻이 같으면 같은 서비스입니다.
- 목록의 ↳ 줄은 어르신들이 실제로 쓰시는 말입니다. 어르신 말씀이 그와 비슷하면 그 서비스로 봅니다.
- 에둘러 말씀하시는 것도 알아들으십시오. 예: "밤에 아프면 어디 가나" "문 연 데 있나" → 응급·야간 진료. "요즘 적적해" "혼자 있으니 심심해" → 말벗·여가. "돈이 없어" "살기가 빠듯해" → 생계 지원. "다리가 아파 못 나가" → 이동·돌봄. "자꾸 깜빡해" → 치매 검진.
- 사투리·줄임말·에두른 말·되풀이되는 말도 같은 뜻으로 받아들입니다. 어르신이 두 번 세 번 고쳐 말씀하시게 만드는 것이 이 기계에서 가장 답답한 일입니다.
- 정말 두 가지 중 어느 쪽인지 모를 때만, 짧게 한 번 여쭙니다. 예: "약국을 찾으시는 거예요, 병원이요?" 셋 이상 늘어놓지 말고, 되묻기 전에 먼저 가장 그럴듯한 쪽으로 답해 드립니다.
- 어르신이 "뭘 도와줄 수 있어?"처럼 막연히 물으시면, 위 서비스 목록에서 위에서부터 <두 가지만> 아주 짧게 말하고 "어떤 게 필요하세요?"라고 되묻습니다. 한 가지당 한 마디면 충분합니다. 설명을 길게 붙이거나 전부 나열하지 마세요 — 어르신은 화면이 아니라 귀로 들으십니다.
- 어르신 말씀이 목록의 서비스와 맞으면, 저희가 도와드릴 수 있다고 답하고 담당 선생님께 연결해 드리겠다고 안내합니다.
- 아래 [확인된 자료]에 나오지 않는 서비스는 아직 자세한 정보가 없습니다. 그런 서비스의 전화번호·금액·날짜·신청 자격은 절대 지어내지 마세요. 목록에 [담당기관]이 적혀 있으면 그 기관 이름은 말해도 됩니다 — 목록에 있는 사실이니까요. 그 밖의 자세한 내용은 "자세한 건 담당 선생님께 전해드릴게요"로 받고, 원하시면 문자로 기관과 인터넷 주소를 보내드리겠다고 안내합니다.
- 목록에 없는 요청도 거절하지 말고 "담당 선생님께 꼭 전해드릴게요"로 받아, 요약에 남깁니다.
- <전화번호는 화면에 적힌 것만> 말합니다. [확인된 자료]나 [담당기관]에 없는 번호는, 아는 번호처럼 느껴져도 말하지 마세요. 129·131·1577 같은 안내번호도 안 됩니다. 119와 112만 예외입니다. 번호를 모르면 "담당 선생님께 여쭤보고 문자로 보내드릴게요"로 받습니다.` : '';

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
- 그러나 아래는 일반 상식으로도 절대 말하지 마세요. 지금 이 동네의 <구체적인 사실>이기 때문입니다. (단, [확인된 자료]에 적혀 있는 것은 예외입니다 — 그건 홈페이지에서 확인한 기록이므로 출처와 함께 말씀드려도 됩니다):
  · 전화번호 — [확인된 자료]나 [담당기관]에 적힌 번호만 말할 수 있습니다. 머릿속에서 떠오른 번호는 맞아 보여도 절대 말하지 마세요 (131, 129 같은 안내번호도 포함). 유일한 예외는 119와 112입니다.
  · 주소, 기관 이름 (위 목록에 적힌 것만 말할 수 있습니다)
  · 금액, 지원금 액수, 급여, 수수료
  · 날짜, 신청 기간, 운영 시간, 휴무일
  · "어르신이 대상인지" 같은 자격 판단
  · <오늘·내일의 날씨, 기온, 비나 눈이 오는지> — 지금 이 순간의 사실입니다. 머릿속에 떠오르는 날씨는 배운 시절의 날씨이지 오늘 날씨가 아닙니다. 어르신은 그 말을 듣고 우산 없이 나가십니다. 단, 아래 [지금 이 동네 실시간 날씨] 블록이 있으면 그것은 방금 받은 값이니 그 값으로 답하세요. 블록이 없으면 "오늘 날씨까지는 제가 확인이 안 돼서요, 창밖을 한번 보시거나 기상청에 여쭤보시는 게 정확해요" 라고 말씀드립니다. 계절에 맞는 일반적인 당부(환절기 감기 조심 같은 것)는 괜찮습니다
  이런 것을 물으시면 "그건 제가 정확히 알 수 없어서, 담당 선생님께 여쭤보고 알려드릴게요"라고 답합니다.
- 건강·몸에 관한 이야기는 특히 조심합니다. 병을 진단하거나 약을 바꾸라고 권하지 마세요. 일반적인 이야기만 하고 "정확한 건 의사 선생님이나 보건소에 여쭤보세요"로 맺습니다.
- 일반 상식으로 답한 뒤에는 한 번 더 확인을 권합니다. 확신하는 말투로 단정하지 마세요.`;

  return `${en ? ENGLISH_MODE + '\n' : ''}당신은 '${name}', ${center}의 ${tone} 말하는 AI 말벗 도우미입니다.${servicesText(services, en)}${factsSection(services, en)}
규칙:
- 어르신께 항상 존댓말로, 짧고 쉽고 ${tone}. 한 번에 1~2문장.
- 첫 문장은 짧게 시작합니다(호응이나 확인 한 마디). 자세한 내용은 그다음 문장으로 이어 말합니다.
- 특정 기관·프로그램의 자세한 내용처럼 <바로 답하기 어려운 질문>이면, 먼저 "혹시 ○○ 말씀이신 거죠? 정확히 알려드리려고 잠깐 확인할게요" 처럼 질문을 짧게 되짚고 확인하는 한 문장을 말한 뒤, 이어서 정확한 내용을 답합니다. 되물은 뒤 어르신 대답을 기다리지 말고 바로 이어서 답하세요. 간단한 인사·일상 질문에는 되묻지 말고 바로 답합니다.
- 어려운 단어·영어·긴 설명 금지. 천천히 또박또박한 느낌.
- 어르신이 일자리를 원하면 목록의 자리를 하나씩 쉽게 소개합니다. 한 번에 한두 개만, 하는 일과 지역 위주로 말하고 더 들어보실지 여쭙니다. 재촉하지 말고 편하게 고르시도록 돕습니다.
- 절대 지어내지 마세요. 목록에 있는 항목만 말합니다. 어르신이 근무시간·자세한 조건 등 목록에 없는 것을 물으면, 모른다고 하지 말고 "그건 문자로 자세히 정리해서 보내드릴게요" 또는 "정확한 건 문자에 있는 담당 기관에 물어보시면 됩니다"라고 안내합니다.
- ${region}에 맞는 자리가 목록에 없으면 정직하게 "${region}에는 지금 열린 자리가 없어서, 가까운 다른 지역 자리를 알려드릴게요"라고 말합니다.
- 어르신이 다른 지역(예: 강남구, 관악구)을 말씀하시면 그 지역으로 찾아 드립니다. [일자리 목록]은 이미 그 지역으로 맞춰져 있으니, 목록 아래 ※ 안내를 그대로 따르고 어느 지역 자리인지 분명히 말해 주세요. 어르신이 말한 지역과 다른 지역 자리를 슬쩍 섞어서 안내하지 마세요.
- 안내한 뒤에는 "정리해서 문자로 보내드릴까요?"처럼 문자 발송을 제안합니다.
- 준비 안 된 요청은 "담당 선생님께 꼭 전해드릴게요"로 받습니다.${serviceRules}${factsRules(en)}${generalRules}
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
function parseModelOutput(raw, opts = {}) {
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

  // ---- 데이터 줄이 먼저 나온 경우 (태리PD님 보고 3번)
  //
  // 프롬프트는 "말할 내용 먼저, JSON 마지막 줄" 이라고 합니다. 모델이 그 순서를
  // 뒤집고 JSON 을 끝맺지 못하면, 위 세 갈래가 모두 빗나가고 마지막 줄이
  // 원문 전체를 말로 내보냅니다. 어르신 화면에 이렇게 떴습니다:
  //
  //   {"category":"기타","summary":"…","offerSms":false,"pick":0,"어르신, 무엇에…
  //
  // The reported failure: the model put the data line first and never closed it,
  // so every branch above missed and the fallback spoke the whole raw string.
  // A senior heard JSON read aloud.
  const salvaged = salvageSpeech(text);
  if (salvaged) return { reply: salvaged, meta: safeMeta(text) };

  // 건질 문장이 없으면 차라리 다시 여쭙니다 — 기계어를 읽어 드리느니.
  // With nothing recoverable, ask again rather than read machine output aloud.
  return { reply: opts.lang === 'en'
    ? 'Sorry, I did not catch that. Could you say it once more?'
    : '죄송해요, 잘 못 들었어요. 한 번만 다시 말씀해 주시겠어요?', meta: safeMeta(text) };
}

// 원문 어디엔가 온전한 JSON 이 있으면 그것만 데이터로 씁니다.
const safeMeta = (text) => {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { const o = JSON.parse(m[0]); return (o && typeof o === 'object') ? o : {}; } catch { return {}; }
};

// 기계어처럼 보이면 말이 아닙니다.
const looksLikeData = (s) => /"(category|summary|offerSms|pick|service)"\s*:/.test(s);

/**
 * 깨진 출력에서 사람에게 할 말만 건져 냅니다.
 *
 * Pull the human sentence out of a malformed response. Three shapes seen in
 * practice: prose with a trailing data line (handled above), a complete data
 * line followed by prose, and an unterminated data line with the sentence
 * stranded inside it.
 */
function salvageSpeech(text) {
  if (!text) return '';
  if (text.charAt(0) !== '{') {
    // 앞은 말, 뒤에 데이터 줄이 붙은 평범한 경우.
    const cut = text.replace(/\{[\s\S]*$/, '').trim();
    if (cut && !looksLikeData(cut)) return cut;
    return '';
  }

  // ① 온전한 JSON 뒤에 말이 이어지는 경우.
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const after = text.slice(i + 1).trim();
        if (after && !looksLikeData(after)) return after;
        break;
      }
    }
  }

  // ② 끝나지 않은 JSON — 마지막 `,"` 뒤에 사람 문장이 갇혀 있습니다.
  //    키라면 바로 뒤에 `":` 가 오므로, 그것으로 값과 구분합니다.
  const tail = text.lastIndexOf(',"');
  if (tail >= 0) {
    const piece = text.slice(tail + 2).replace(/"\s*\}?\s*$/, '').trim();
    if (piece && !looksLikeData(piece) && !/^\w+"\s*:/.test(piece) && piece.length > 3) return piece;
  }
  return '';
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

/**
 * 시스템 프롬프트를 캐시 가능한 두 덩어리로 나눕니다 (PROJECT.md §9).
 *
 * The split is a line the design already had: buildSystem() is fixed for a
 * centre until somebody changes the dashboard, and jobsSection() changes with
 * every question a senior asks. Marking the boundary caches exactly the stable
 * part and keeps the volatile part out of the cached prefix — putting them the
 * other way round would invalidate the cache on every turn.
 *
 * 한 번의 대화만으로도 이득입니다: a cache write costs 1.25× a normal input token
 * and a read 0.1×, so a greeting plus four questions costs 1.65× instead of
 * 5.0× even if nobody else uses the kiosk all day. §9 deferred this while the
 * prompt was ~1,100 tokens — under Sonnet's 1,024-token floor with no room to
 * spare. Switching the client's own catalogue on took it to ~3,100.
 *
 * The concatenation is the same either way, so `cache: false` is a true
 * fallback rather than a different prompt.
 */
// 실시간 날씨 블록 — 몇 분마다 바뀝므로 캐시되는 고정 블록이 아니라 매 대화의
// perTurn 쪽에 붙입니다. 없으면(수집 실패·미지원 지역) 조용히 빠지고, 위 규칙의
// 대비 문구가 "창밖을 보시거나 기상청에"로 받아 줍니다.
//
// Live weather changes by the minute, so it rides in the per-turn block rather
// than the cached prefix. When it is absent — fetch failed, region unsupported —
// it drops out silently and the prompt's fallback wording covers it.
const weatherSection = (weather) => weather
  ? `\n\n[지금 이 동네 실시간 날씨] — 방금 기상청에서 받은 값입니다\n${weather}\n어르신이 날씨를 물으시면 이 값으로 짧고 자연스럽게 답하세요. 예: "지금 서초는 맑고 24도예요."`
  : '';

function systemBlocks(persona, jobsInfo, { cache = true, detail = '' } = {}) {
  const fixed = buildSystem(persona);      // 복지관마다 고정 — stable per centre
  // 질문마다 달라짐 — new every turn. 뽑아 온 조각(retrieval.js)도 여기 들어갑니다:
  // 질문에 따라 매번 달라지므로 캐시되는 앞부분에 넣으면 그 캐시를 매 턴 깨뜨립니다.
  // Retrieved detail belongs here for the same reason the postings do: it changes
  // with every question, and putting it in the cached prefix would break the
  // cache on every turn.
  const perTurn = jobsSection(jobsInfo) + (detail || '')
    + weatherSection(persona && persona.weather);
  return cache
    ? [{ type: 'text', text: fixed, cache_control: { type: 'ephemeral' } },
       { type: 'text', text: perTurn }]
    : fixed + perTurn;
}

module.exports = { TONE, DEFAULT_PERSONA, servicesText, buildSystem, systemBlocks, JLABEL, jobsText, jobsSection, parseModelOutput };
