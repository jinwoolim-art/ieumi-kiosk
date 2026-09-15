// 문자 본문 — the body of a text message, assembled from records.
//
// Kept apart from the HTTP server for the same reason prompt.js is: what a
// senior actually receives is worth a test, and requiring server.js would start
// a listener.
//
// The governing rule here is that nothing in a message comes from the caller.
// The kiosk sends identifiers — a posting id, a service code — and this reads
// the content back from the database and the centre's own catalogue. With real
// SMS keys configured, a body the browser dictates would be an open relay
// pointed at seniors' phones; it is also how an invented job posting used to
// reach a real person.
const jobs = require('./jobs');

// 문자 본문의 항목들 — only the fields this posting actually has.
// The job source carries no wage and no shift, so those lines are simply absent
// rather than printed as "-", which would read like missing data the centre
// forgot to fill in. A senior gets the phone number and how to apply, which is
// what they need to act on it.
function smsLines(j) {
  return [
    ['', [j.gu, j.job].filter(Boolean).join(' · ')],
    ['기관', j.org],
    ['급여', j.pay],
    ['근무', j.work],
    ['대상', j.age],
    ['접수', j.to],
    ['접수방법', j.apply],
    ['근무지', j.place],
    ['기관 주소', j.orgAddr],
    ['문의', j.tel],
  ].filter(([, v]) => v && String(v).trim())
   .map(([label, v]) => `▸ ${label ? label + ' ' : ''}${v}`)
   .join('\n');
}

/**
 * Build the message, or '' when there is nothing truthful to send.
 *
 * Two kinds of call end in a text now, not one. A job posting is read back from
 * the jobs table by id. A welfare, health or daily-living answer is built from
 * the centre's catalogue — the organisation that runs the service and its web
 * address, which is what the client's V03 list added and the reason a senior
 * can be sent something useful for the other 59 services at all.
 */
async function smsContent(persona, { jobId, serviceCode, summary, kind } = {}, deps = jobs) {
  const head = `[${persona.center_name}] ${persona.ieumi_name}`;

  // 일자리와 서비스는 서로를 밀어내지 않습니다 — 한 대화에서 둘 다 나왔으면
  // 문자에도 둘 다 들어갑니다.
  //
  // This used to `return` as soon as a posting resolved, so a conversation that
  // touched both a live posting and a catalogue entry sent the posting and threw
  // the catalogue away — the organisation and link the client's list exists to
  // provide, silently missing. The kiosk sends both identifiers on every send;
  // they are two different things the senior asked about, not two candidates
  // for one slot.
  const row = jobId ? await deps.byId(jobId).catch(() => null) : null;
  // An id the table does not know contributes nothing rather than a message
  // about nothing: an invented posting has to stay unsendable.
  const job = row ? deps.toPromptJob(row) : null;

  // The catalogue is the authority for org and link. A code the centre has not
  // switched on is not in persona.services and resolves to nothing.
  const svc = serviceCode
    ? (persona.services || []).find((s) => s.code === serviceCode)
    : null;

  const clean = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!job && !svc && !clean) return '';

  const followup = kind === 'followup';
  const svcBlock = svc ? [
    `▸ ${svc.sub}`,
    clean,
    svc.org ? `▸ 담당기관 ${svc.org}` : '',
    svc.link ? `▸ 인터넷 ${svc.link}` : '',
  ].filter(Boolean).join('\n') : '';

  // 맺음말은 하나만 — whichever ending fits, never both.
  const close = job && followup ? '정확한 조건은 위 문의처에 확인해 주세요. 건강하세요!'
              : (svc || !job) ? '자세한 것은 담당 선생님께 전해드렸어요. 건강하세요!'
              : '';

  return [
    `${head} ${followup ? '추가 안내' : '안내'}`,
    followup && job ? '아까 문의하신 자세한 내용입니다.' : '',
    job ? smsLines(job) : '',
    // 두 덩어리 사이는 한 줄 띄웁니다 — 어르신이 읽을 때 일자리 안내가 어디서
    // 끝나고 서비스 안내가 어디서 시작하는지 보이게.
    job && svcBlock ? '\n' + svcBlock : svcBlock,
    // 일자리만 있을 때는 요약을 넣지 않습니다 — 위 항목이 이미 그 내용입니다.
    !svc && !job ? clean : '',
    close,
  ].filter(Boolean).join('\n');
}

module.exports = { smsLines, smsContent };
