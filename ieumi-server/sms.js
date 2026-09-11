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

  if (jobId) {
    const row = await deps.byId(jobId).catch(() => null);
    if (row) {
      const j = deps.toPromptJob(row);
      return kind === 'followup'
        ? `${head} 추가 안내\n아까 문의하신 자세한 내용입니다.\n${smsLines(j)}\n정확한 조건은 위 문의처에 확인해 주세요. 건강하세요!`
        : `${head} 안내\n${smsLines(j)}`;
    }
    // An id that is not in the table produces no message rather than a message
    // about nothing: an invented posting has to be unsendable.
  }

  // The catalogue is the authority for org and link. A code the centre has not
  // switched on is not in persona.services and resolves to nothing.
  const svc = serviceCode
    ? (persona.services || []).find((s) => s.code === serviceCode)
    : null;

  const clean = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!svc && !clean) return '';

  return [
    `${head} 안내`,
    svc ? `▸ ${svc.sub}` : '',
    clean,
    svc && svc.org ? `▸ 담당기관 ${svc.org}` : '',
    svc && svc.link ? `▸ 인터넷 ${svc.link}` : '',
    '자세한 것은 담당 선생님께 전해드렸어요. 건강하세요!',
  ].filter(Boolean).join('\n');
}

module.exports = { smsLines, smsContent };
