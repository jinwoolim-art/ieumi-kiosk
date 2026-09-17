// 언어 전환 — Korean ⇄ English for every page.
//
// 한글 원문을 그대로 키로 씁니다. The dictionary is keyed by the Korean source
// string rather than by an invented code like `btn.save`. Two reasons:
//
//  · 복지관 선생님들이 읽는 것은 한글입니다. The Korean is what the welfare-centre
//    staff actually use, so it stays in the markup as the readable default. A
//    codes-everywhere refactor would replace 600 legible strings with 600
//    opaque ones and make the primary language the hard one to proofread.
//  · JS 가 만들어 내는 문자열도 같이 잡힙니다. Much of both dashboards is built by
//    string concatenation at render time; a walker over the live DOM catches
//    those without touching the render code at all.
//
// 사전에 없는 문장은 한글 그대로 남습니다 — a missing entry degrades to Korean
// rather than to an empty box. `?i18n=debug` lists exactly what is missing, so
// finishing the dictionary is a checklist and never a hunt.
(function () {
  'use strict';

  var DICT = window.I18N_EN || {};
  var PARAM = new URLSearchParams(location.search);
  var DEBUG = PARAM.get('i18n') === 'debug';
  var STORE = 'ieumi_lang';

  function initialLang() {
    var q = PARAM.get('lang');
    if (q === 'en' || q === 'ko') { try { localStorage.setItem(STORE, q); } catch (e) {} return q; }
    try { return localStorage.getItem(STORE) === 'en' ? 'en' : 'ko'; } catch (e) { return 'ko'; }
  }

  var lang = initialLang();
  var missing = Object.create(null);

  // 아예 건드리지 않는 곳 — script/style hold code, not language.
  var SKIP_ALL = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
  // 안쪽 글자는 그대로 두되 placeholder 같은 속성은 번역합니다.
  // A textarea's content belongs to whoever typed it, and code samples must stay
  // verbatim — but their placeholder and title are ours and do need translating.
  // Skipping these wholesale also hid them from the missing-string report, which
  // is how an untranslated placeholder passed as "dictionary complete".
  var SKIP_CHILDREN = { TEXTAREA: 1, CODE: 1, PRE: 1 };

  var hasKorean = /[ㄱ-ㆎ가-힣]/;

  // 일부러 한글로 두는 것 — the import box's example shows the client's real file,
  // which is Korean. Translating it would teach the wrong format. Listed here so
  // the missing-string report stays a true checklist rather than something with
  // a permanent known entry people learn to ignore.
  function keepKorean(s) {
    return s.charAt(0) === '[' && s.indexOf('"id"') > 0;   // the JSON sample
  }

  // 재귀로 들어간 조각은 보고하지 않습니다 — the joined and leading-separator rules
  // call back into lookup for each half. Recording those halves would list a
  // sentence as missing even when it was translated a moment later, and a report
  // with false entries is one people stop reading.
  var depth = 0;

  function lookup(raw) {
    var s = String(raw).trim();
    if (!s || !hasKorean.test(s) || keepKorean(s)) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, s)) return DICT[s];

    // 숫자로 시작하는 말 — "3명", "12건", "60 / 60 선택됨". 화면의 숫자는 계속
    // 바뀌므로 "0명"만 사전에 있어서는 첫 화면 말고는 아무것도 못 바꿉니다.
    // Counts change as the page lives; keying every possible number is
    // impossible, so the number passes through and only the words are looked up.
    var count = s.match(/^([0-9][0-9,.\s/]*?)\s*([ㄱ-ㆎ가-힣].*)$/);
    if (count && Object.prototype.hasOwnProperty.call(DICT, count[2].trim())) {
      return count[1].trim() + ' ' + DICT[count[2].trim()];
    }

    // 숫자만 다른 같은 문장 — "전체 저장 354건" 은 새로고침할 때마다 숫자가 바뀝니다.
    // 숫자를 % 로 바꾼 틀을 사전에서 찾고, 원래 숫자를 순서대로 다시 넣습니다.
    //
    // The same sentence with different numbers is still the same sentence. The
    // dictionary holds the template with % where each number goes, and the live
    // numbers are put back in order — so one entry covers every refresh.
    var nums = [];
    var template = s.replace(/[0-9][0-9,.\-]*/g, function (m) { nums.push(m); return '%'; });
    if (nums.length && Object.prototype.hasOwnProperty.call(DICT, template)) {
      var i = 0;
      return DICT[template].replace(/%/g, function () { return nums[i++] !== undefined ? nums[i - 1] : '%'; });
    }

    // 구분자로 시작하는 조각 — "· 마스터". 앞 조각이 다른 노드에 있습니다.
    var lead = s.match(/^([·:|]|—|→)\s*(.+)$/);
    if (lead) { depth++; var t = lookup(lead[2]); depth--; if (t !== null) return lead[1] + ' ' + t; }

    // 고정된 말 + 자료 — "관리자(운영) 대시보드 · 서초 어르신 행복이음 센터".
    // A label joined to a centre's own name: translate the label, leave the name.
    var joined = s.match(/^(.+?)\s*([·:|]|—|→)\s*(.+)$/);
    if (joined) {
      var head = joined[1].trim(), rest = joined[3].trim();
      var headHit = Object.prototype.hasOwnProperty.call(DICT, head) ? DICT[head] : null;
      depth++; var restHit = lookup(rest); depth--;
      // 한쪽만 아는 경우도 많습니다 — "플레이포 운영자 · 마스터" 는 앞이 사람 이름,
      // 뒤가 역할입니다. Half a hit is still worth taking: names stay as they are
      // and the label around them turns over.
      if (headHit !== null || restHit !== null) {
        return (headHit === null ? head : headHit) + ' ' + joined[2] + ' ' +
               (restHit === null ? rest : restHit);
      }
    }
    // 한 덩어리로는 없지만 줄 단위로는 있을 수 있습니다 — long blocks of help text
    // are often a few sentences that each appear elsewhere on their own.
    if (s.indexOf('\n') >= 0) {
      var lines = s.split('\n'), hit = false;
      var out = lines.map(function (l) {
        var t = l.trim();
        if (!t) return l;
        if (Object.prototype.hasOwnProperty.call(DICT, t)) { hit = true; return l.replace(t, DICT[t]); }
        if (hasKorean.test(t)) missing[t] = (missing[t] || 0) + 1;
        return l;
      });
      return hit ? out.join('\n') : null;
    }
    if (!depth) missing[s] = (missing[s] || 0) + 1;
    return null;
  }

  // 원문을 보관합니다 — keeping the Korean on the node is what makes switching
  // back possible without a reload, and stops a second pass from treating the
  // English as a new key.
  function swapText(node) {
    var original = node.__ko !== undefined ? node.__ko : node.nodeValue;
    if (lang === 'ko') { if (node.__ko !== undefined) node.nodeValue = original; return; }
    var hit = lookup(original);
    if (hit === null) return;
    if (node.__ko === undefined) node.__ko = original;
    node.nodeValue = String(original).replace(String(original).trim(), hit);
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function swapAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var key = '__ko_' + a;
      var original = el[key] !== undefined ? el[key] : el.getAttribute(a);
      if (lang === 'ko') { if (el[key] !== undefined) el.setAttribute(a, original); continue; }
      var hit = lookup(original);
      if (hit === null) continue;
      if (el[key] === undefined) el[key] = original;
      el.setAttribute(a, hit);
    }
    // value 는 버튼에서만 — an input's typed value is the user's, never ours.
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) {
      var v = el.__ko_value !== undefined ? el.__ko_value : el.value;
      if (lang === 'ko') { if (el.__ko_value !== undefined) el.value = v; }
      else { var h = lookup(v); if (h !== null) { if (el.__ko_value === undefined) el.__ko_value = v; el.value = h; } }
    }
  }

  // 문장 중간에 <b> 가 끼어 있으면 텍스트 노드가 조각납니다. 조각을 따로 번역하면
  // 어순이 달라 문장이 깨집니다 — "카테고리 순서는" + <b>…</b> + "입니다."
  //
  // So before descending into a block, try the block's whole sentence. A hit
  // replaces the element's contents outright: the inner bolding is lost, which
  // is a fair price for English that parses. Only blocks whose children are all
  // inline qualify, so this never swallows a panel.
  // DIV 도 포함합니다 — 키오스크 말풍선이 <br> 로 줄을 나눠 놓아서, 줄마다 따로
  // 번역하면 한국어 어순이 그대로 남아 영어가 깨집니다.
  // A div qualifies only when every child is inline (see inlineOnly), so a
  // layout container is never swallowed — but the kiosk's speech bubble, which
  // is text broken by <br>, is translated as the one sentence it actually is.
  var BLOCK = { P: 1, LI: 1, LABEL: 1, H1: 1, H2: 1, H3: 1, H4: 1, TD: 1, TH: 1,
                BUTTON: 1, SUMMARY: 1, DIV: 1 };
  var INLINE = { B: 1, I: 1, EM: 1, STRONG: 1, SPAN: 1, SMALL: 1, U: 1, BR: 1, A: 1, CODE: 1,
                 INPUT: 1, IMG: 1, SVG: 1 };

  function inlineOnly(el) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (!INLINE[c.tagName]) return false;
      // id 가 붙고 글자를 담은 조각은 스크립트가 계속 고쳐 씁니다 — a counter like
      // <span id="cnt">0명</span> would freeze at whatever number the sentence
      // key happened to capture. Leave those to the per-node pass, which
      // re-translates them every time they change.
      //
      // 글자가 없는 것은 해당하지 않습니다: a checkbox carries an id so its label
      // can point at it, and rejecting on that alone left every "<input> 텍스트"
      // label translated in fragments.
      if (c.id && c.textContent.trim()) return false;
    }
    return el.children.length > 0;
  }

  // 아이콘은 글자가 아닙니다 — Material Symbols renders the ligature text
  // ("verified_user") as the icon itself, so it must stay out of the key and
  // survive the replacement.
  // 글자가 아닌 자식 — 아이콘, 체크박스, 그림. 문장을 바꿀 때 이것들은 남겨야
  // 합니다. A checkbox inside its own <label> is the common case: replacing the
  // label's text would delete the control the label exists for.
  var ATOMIC = { INPUT: 1, IMG: 1, SVG: 1, SELECT: 1 };
  function isIcon(n) {
    if (n.nodeType !== 1) return false;
    if (ATOMIC[n.tagName]) return true;
    return !!(n.classList && n.classList.contains('material-symbols-outlined'));
  }

  function sentenceOf(el) {
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (isIcon(n)) continue;
      // <br> 는 공백을 만들지 않습니다 — without this the key comes out as
      // "들고아래" and no human would ever write that into the dictionary.
      if (n.nodeType === 1 && n.tagName === 'BR') { s += ' '; continue; }
      s += n.textContent;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function trySentence(el) {
    if (!BLOCK[el.tagName] || !inlineOnly(el)) return false;
    if (lang === 'ko') {
      if (el.__koHTML !== undefined) { el.innerHTML = el.__koHTML; delete el.__koHTML; }
      return false;
    }
    if (el.__koHTML !== undefined) return true;          // already done
    var flat = sentenceOf(el);
    if (!flat || !hasKorean.test(flat)) return false;
    if (!Object.prototype.hasOwnProperty.call(DICT, flat)) return false;  // 조각 단위가 이어서 봅니다

    var icons = [];
    for (var i = 0; i < el.childNodes.length; i++) if (isIcon(el.childNodes[i])) icons.push(el.childNodes[i]);
    el.__koHTML = el.innerHTML;
    el.innerHTML = '';
    for (var k = 0; k < icons.length; k++) el.appendChild(icons[k]);
    el.appendChild(document.createTextNode(icons.length ? ' ' + DICT[flat] : DICT[flat]));
    return true;
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 1) {
      if (SKIP_ALL[root.tagName]) return;
      // data-nolang — 자료가 들어가는 자리입니다. 서비스 이름, 어르신 성함, 복지관
      // 이름은 사전이 아니라 데이터베이스에서 옵니다.
      //
      // Content regions are filled from the database, which carries its own
      // English columns. Translating them here would make the dictionary a
      // second, silently diverging copy of the catalogue — and it would drown
      // the missing-string report in 200 service descriptions, which is exactly
      // what stops that report from being read.
      if (root.hasAttribute && root.hasAttribute('data-nolang')) return;
      swapAttrs(root);
      if (SKIP_CHILDREN[root.tagName]) return;
      if (trySentence(root)) return;
      for (var i = 0; i < root.childNodes.length; i++) walk(root.childNodes[i]);
    } else if (root.nodeType === 3) {
      swapText(root);
    }
  }

  function apply() {
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'ko');
    walk(document.body);
    if (DEBUG) report();
  }

  function report() {
    var keys = Object.keys(missing).sort();
    if (!keys.length) { console.log('[i18n] 빠진 문장 없음 — dictionary complete for this page'); return; }
    console.log('[i18n] 사전에 없는 문장 ' + keys.length + '개 — missing entries:');
    console.log(JSON.stringify(keys.reduce(function (m, k) { m[k] = ''; return m; }, {}), null, 2));
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'ko';
    try { localStorage.setItem(STORE, lang); } catch (e) {}
    missing = Object.create(null);
    apply();
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: lang } }));
  }

  // 화면 위의 전환 버튼 — deliberately fixed and small. It is a testing and
  // accessibility affordance, not part of the kiosk's visual design, and a
  // senior must never mistake it for something they are meant to press.
  function mountToggle() {
    if (document.getElementById('i18nToggle')) return;
    var b = document.createElement('button');
    b.id = 'i18nToggle';
    b.type = 'button';
    // 자기 자신은 번역 대상이 아닙니다 — the toggle must read in both languages at
    // once, and reporting itself as a missing string is noise in its own report.
    b.setAttribute('data-nolang', '');
    b.setAttribute('aria-label', 'Switch language / 언어 전환');
    b.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;font:600 12px system-ui,sans-serif;'
      + 'padding:6px 10px;border-radius:999px;border:1px solid rgba(0,0,0,.18);background:#fff;color:#0f172a;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.14);cursor:pointer;opacity:.85';
    function label() { b.textContent = lang === 'en' ? 'EN · 한국어로' : '한국어 · EN'; }
    label();
    b.onclick = function () { setLang(lang === 'en' ? 'ko' : 'en'); label(); };
    document.body.appendChild(b);
  }

  // 새로 그려진 부분도 번역합니다 — both dashboards rebuild whole panels after
  // every save, so a one-shot pass at load would translate the page once and
  // then watch it turn back into Korean.
  function observe() {
    if (!window.MutationObserver) return;
    var pending = false;
    new MutationObserver(function (records) {
      if (lang === 'ko') return;
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length || records[i].type === 'characterData') {
          if (pending) return;
          pending = true;
          // rAF 는 탭이 가려져 있으면 멈춥니다 — a hidden or background tab pauses
          // animation frames, so content that arrived while the page was not
          // being looked at stayed Korean until something else woke it up.
          setTimeout(function () { pending = false; walk(document.body); }, 0);
          return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.I18N = {
    get lang() { return lang; },
    set: setLang,
    t: function (ko) { var h = lookup(ko); return h === null ? ko : h; },
    missing: function () { return Object.keys(missing).sort(); },
    apply: apply,
  };

  function boot() { apply(); mountToggle(); observe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
