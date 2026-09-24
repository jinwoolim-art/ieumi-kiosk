// 목소리를 7월 원본(vian 남성, 속도 0)으로 되돌립니다. DB만 수정(크레딧 0).
// 변경 전 값 백업 출력 → 언제든 되돌리기 가능.
//   node db/set-voice.js
const db = require('./index');

const SLUG = 'seocho';
const SPEAKER = 'vian';   // 7월 원본 화자(클로바 프리미엄 남성, 부드러움)
const SPEED = 0;          // 7월 원본 속도(0=기본)

(async () => {
  if (!db.DATABASE_URL) { console.error('\n  ✖ DATABASE_URL 없음\n'); process.exit(1); }

  const q = `SELECT s.voice_speaker, s.voice_speed
               FROM center_settings s JOIN centers c ON c.id = s.center_id
              WHERE c.slug = $1`;
  const [before] = await db.all(q, [SLUG]);
  if (!before) { console.error(`\n  ✖ ${SLUG} 센터 설정을 찾을 수 없습니다.\n`); process.exit(1); }

  console.log('\n=== 변경 전 (❗ 되돌리려면 적어두세요) ===');
  console.log(`  voice_speaker: ${before.voice_speaker}   voice_speed: ${before.voice_speed}`);

  await db.query(
    `UPDATE center_settings SET voice_speaker = $1, voice_speed = $2
      WHERE center_id = (SELECT id FROM centers WHERE slug = $3)`,
    [SPEAKER, SPEED, SLUG]);

  const [after] = await db.all(q, [SLUG]);
  console.log('\n=== 변경 후 (7월 원본 목소리) ===');
  console.log(`  voice_speaker: ${after.voice_speaker}   voice_speed: ${after.voice_speed}`);
  console.log('\n  ✅ 완료. 서버 재시작 없이 다음 대화부터 바로 vian 목소리로 나옵니다.\n');
  process.exit(0);
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
