/*
 * 이음이 공용 API 클라이언트 — Shared API client for the dashboards.
 *
 * The dashboards used to read and write localStorage directly. Everything now
 * goes through the server so that data is isolated per center and shared across
 * devices (PROJECT.md §6-P0).
 */
(function (global) {
  'use strict';

  var LOGIN_PAGE = '로그인.html';
  var CENTER_KEY = 'ieumi_active_center';   // master only: which center is being viewed
  var me = null;

  function activeCenter() {
    try { return sessionStorage.getItem(CENTER_KEY) || ''; } catch (e) { return ''; }
  }
  function setActiveCenter(id) {
    try { id ? sessionStorage.setItem(CENTER_KEY, id) : sessionStorage.removeItem(CENTER_KEY); } catch (e) {}
  }

  function withCenter(path) {
    // Only master can target another center; the server ignores (and rejects)
    // the parameter for everyone else, so sending it is harmless.
    var c = activeCenter();
    if (!c || !me || me.user.role !== 'master') return path;
    return path + (path.indexOf('?') < 0 ? '?' : '&') + 'center=' + encodeURIComponent(c);
  }

  async function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(withCenter(path), opts);

    if (res.status === 401 && path !== '/api/me') { redirectToLogin(); throw new Error('로그인이 필요합니다.'); }

    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
    return data;
  }

  function redirectToLogin() {
    var here = location.pathname.split('/').pop() + location.search;
    location.href = LOGIN_PAGE + '?next=' + encodeURIComponent(here);
  }

  var API = {
    get:    function (p) { return request('GET', p); },
    post:   function (p, b) { return request('POST', p, b || {}); },
    put:    function (p, b) { return request('PUT', p, b || {}); },
    patch:  function (p, b) { return request('PATCH', p, b || {}); },
    del:    function (p, b) { return request('DELETE', p, b === undefined ? undefined : b); },

    activeCenter: activeCenter,
    setActiveCenter: setActiveCenter,

    /** Who am I? Cached after the first call. */
    me: async function (force) {
      if (me && !force) return me;
      var r = await request('GET', '/api/me');
      me = r && r.user ? r : null;
      return me;
    },

    /**
     * Gate a page. Redirects to the login page when signed out, and shows a
     * plain message when the role is not allowed here.
     * @param {string[]} roles  roles permitted on this page
     */
    guard: async function (roles) {
      var who;
      try { who = await API.me(true); } catch (e) { who = null; }
      if (!who) { redirectToLogin(); throw new Error('unauthenticated'); }
      if (roles && roles.indexOf(who.user.role) < 0) {
        document.body.innerHTML =
          '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:28px;' +
          'border:1px solid #e2e8f0;border-radius:14px;text-align:center">' +
          '<h2 style="margin:0 0 8px">접근 권한이 없습니다</h2>' +
          '<p style="color:#64748b">이 화면은 ' + roles.join(', ') + ' 권한이 필요합니다.<br>' +
          '현재 로그인: <b>' + who.user.name + '</b> (' + who.user.role + ')</p>' +
          '<p><a href="' + LOGIN_PAGE + '">다른 계정으로 로그인</a></p></div>';
        throw new Error('forbidden');
      }
      return who;
    },

    /** 내 비밀번호 변경 — available to every role, from either dashboard. */
    changePassword: async function () {
      var current = prompt('현재 비밀번호를 입력하세요.');
      if (current === null) return;
      var next = prompt('새 비밀번호를 입력하세요. (8자 이상)');
      if (next === null) return;
      if (next.length < 8) { alert('새 비밀번호는 8자 이상이어야 합니다.'); return; }
      if (next !== prompt('확인을 위해 새 비밀번호를 다시 입력하세요.')) {
        alert('두 번 입력한 비밀번호가 서로 다릅니다.');
        return;
      }
      try {
        await request('PATCH', '/api/me/password', { current: current, next: next });
        alert('비밀번호를 변경했습니다.\n다른 기기에서는 다시 로그인해야 합니다.');
      } catch (e) {
        alert(e.message || '비밀번호를 변경하지 못했습니다.');
      }
    },

    logout: async function () {
      try { await request('POST', '/api/logout', {}); } catch (e) {}
      me = null;
      setActiveCenter('');
      location.href = LOGIN_PAGE;
    },

    /** Small sign-in strip: who is logged in, center switcher for master, logout. */
    renderUserBar: function (el, who) {
      if (!el) return;
      var isMaster = who.user.role === 'master';
      var label = { master: '마스터', center_admin: '복지관 관리자', staff: '담당자' }[who.user.role] || who.user.role;
      var centerName = who.center ? who.center.name : (isMaster ? '전체' : '');

      el.innerHTML =
        '<span class="ib-who"><b>' + esc(who.user.name || who.user.username) + '</b> · ' + label + '</span>' +
        (isMaster ? '<select class="ib-center" id="ibCenter"></select>'
                  : '<span class="ib-center-name">' + esc(centerName) + '</span>') +
        '<button class="ib-out" id="ibPw">비밀번호</button>' +
        '<button class="ib-out" id="ibLogout">로그아웃</button>';

      el.querySelector('#ibLogout').onclick = API.logout;
      el.querySelector('#ibPw').onclick = API.changePassword;

      if (isMaster) {
        var sel = el.querySelector('#ibCenter');
        API.get('/api/centers').then(function (r) {
          var cur = activeCenter() || (r.centers[0] && r.centers[0].id) || '';
          setActiveCenter(cur);
          sel.innerHTML = r.centers.map(function (c) {
            return '<option value="' + esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.name) + '</option>';
          }).join('');
          sel.onchange = function () { setActiveCenter(sel.value); location.reload(); };
        }).catch(function () { sel.innerHTML = '<option>복지관 목록 오류</option>'; });
      }
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }
  API.esc = esc;

  global.IeumiAPI = API;
})(window);
