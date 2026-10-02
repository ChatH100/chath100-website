/* ==========================================================================
   ChatH100 · 留言板
   存储层有两种实现，运行时自动选择：
     RemoteStore —— 连得上 Supabase 时用（留言所有人可见）
     LocalStore  —— 连不上时用（只存在本机浏览器，页面照样能用）
   检测方式：启动时探一次 Supabase 的 messages 表，通了就切远端。
   ========================================================================== */

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  const KEY       = 'chath100.guestbook.v1';       // 本地模式的留言
  const KEY_KEYS  = 'chath100.guestbook.keys';     // 远端模式：自己留言的删除密钥
  const MAX_ENTRIES = 200;
  const MAX_NAME = 20;
  const MAX_TEXT = 300;

  /* ==================================================================
     后端配置：Supabase
     这两个值是**设计上可以公开**的，放在前端代码里没问题。
     权限完全由数据库的行级安全策略（RLS）控制：
       - 所有人可读
       - 所有人可发（长度/空值由 check 约束把关）
       - 只有带着正确 delete-key 的请求能删对应那条
     ⚠️ 绝对不要把 secret key / service_role key 填到这里，
        那个会绕过所有 RLS 策略，等于数据库裸奔。
     ================================================================== */
  const SUPABASE = {
    url:     'https://qgyoopcpfrbemifqyjsj.supabase.co',
    anonKey: 'sb_publishable_pbdWRr0JDgPyYpBYw0bXzQ_K49w5i12',
  };

  /* ==================================================================
     下面两个函数管「删除密钥」在本机的存取。
     密钥原文永远不离开浏览器，上传到数据库的只有它的 SHA-256。
     ================================================================== */

  function loadKeys() {
    try {
      const m = JSON.parse(localStorage.getItem(KEY_KEYS) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch (err) { return {}; }
  }
  function saveKey(id, key) {
    const m = loadKeys(); m[id] = key;
    try { localStorage.setItem(KEY_KEYS, JSON.stringify(m)); } catch (err) { /* 忽略 */ }
  }
  function dropKey(id) {
    const m = loadKeys(); delete m[id];
    try { localStorage.setItem(KEY_KEYS, JSON.stringify(m)); } catch (err) { /* 忽略 */ }
  }

  async function readError(res) {
    try {
      const d = await res.json();
      if (d) {
        if (d.message) return d.message;   // PostgREST 用 message
        if (d.error)   return d.error;     // 本地 Node 版用 error
      }
    } catch (err) { /* 忽略 */ }
    return 'HTTP ' + res.status;
  }

  /* ---------- 删除密钥 ----------
     客户端生成，只把 SHA-256 上传到数据库，原文留在本机 localStorage。
     这样即使数据库整个泄露，别人也拿不到能删留言的凭据。 */
  function newDeleteKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '');
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  async function sha256hex(text) {
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function sbHeaders(extra) {
    return Object.assign({
      apikey: SUPABASE.anonKey,
      Authorization: 'Bearer ' + SUPABASE.anonKey,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  /* ==================================================================
     存储层 ①：Supabase（PostgREST）
       GET    /rest/v1/messages?select=...
       POST   /rest/v1/messages
       DELETE /rest/v1/messages?id=eq.<id>    需要请求头 x-delete-key
     ================================================================== */
  const RemoteStore = {
    name: 'remote',

    async list() {
      const res = await fetch(
        SUPABASE.url + '/rest/v1/messages?select=id,name,text,time&order=time.desc&limit=500',
        { headers: sbHeaders() }
      );
      if (!res.ok) throw new Error(await readError(res));
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    },

    async add(entry) {
      const deleteKey = newDeleteKey();
      const res = await fetch(SUPABASE.url + '/rest/v1/messages', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({
          name: entry.name,
          text: entry.text,
          key_hash: await sha256hex(deleteKey),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));

      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || !row.id) throw new Error('服务器没有返回新留言的 id');
      saveKey(row.id, deleteKey);
      return row;
    },

    async remove(id) {
      const res = await fetch(
        SUPABASE.url + '/rest/v1/messages?id=eq.' + encodeURIComponent(id),
        { method: 'DELETE', headers: sbHeaders({ 'x-delete-key': loadKeys()[id] || '' }) }
      );
      if (!res.ok) throw new Error(await readError(res));

      // 关键差异：RLS 下「没权限」返回的也是 204（删了 0 行），不是 403。
      // 所以不能看状态码，必须回头确认那条还在不在。
      const check = await fetch(
        SUPABASE.url + '/rest/v1/messages?select=id&id=eq.' + encodeURIComponent(id),
        { headers: sbHeaders() }
      );
      if (check.ok) {
        const left = await check.json();
        if (Array.isArray(left) && left.length > 0) {
          throw new Error('删除被服务器拒绝了 —— 这条不是你发的，或本机没有它的删除密钥');
        }
      }
      dropKey(id);
    },

    // 远端模式下只能删自己发的（密钥在本机）
    canDelete(id) { return Boolean(loadKeys()[id]); },
  };

  /* ==================================================================
     存储层 ②：浏览器本地
     ================================================================== */
  const LocalStore = {
    name: 'local',

    async list() {
      try {
        const raw = localStorage.getItem(KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (err) {
        console.warn('[留言板] 读取本地存储失败：', err);
        return [];
      }
    },

    async add(entry) {
      const arr = await LocalStore.list();
      arr.unshift(entry);
      localStorage.setItem(KEY, JSON.stringify(arr.slice(0, MAX_ENTRIES)));
      return entry;
    },

    async remove(id) {
      const arr = await LocalStore.list();
      localStorage.setItem(KEY, JSON.stringify(arr.filter((e) => e.id !== id)));
    },

    canDelete() { return true; },
  };

  /* ==================================================================
     页面
     ================================================================== */
  const form = $('#gbForm');
  if (!form) return;

  const nameEl   = $('#gbName');
  const textEl   = $('#gbText');
  const msgEl    = $('#gbMsg');
  const countEl  = $('#gbCounter');
  const listEl   = $('#gbList');
  const emptyEl  = $('#gbEmpty');
  const totalEl  = $('#gbCount');
  const noticeEl = $('#storageNotice');
  const adminEl    = $('#gbAdmin');
  const tokenEl    = $('#gbAdminToken');
  const clearEl    = $('#gbAdminClear');
  const adminMsgEl = $('#gbAdminMsg');

  let Store = LocalStore;
  let adminToken = '';

  /* ---------- 小工具 ---------- */
  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function setMsg(text, isError) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('is-error', Boolean(isError));
  }

  function setAdminMsg(text, isError) {
    if (!adminMsgEl) return;
    adminMsgEl.textContent = text || '';
    adminMsgEl.classList.toggle('is-error', Boolean(isError));
  }

  /* 面板只在「连上了数据库」且「地址栏带 #admin」时出现。
     普通访客看不到它；本地存储模式下也不会出现（那种模式没有服务端可管）。 */
  function syncAdminPanel() {
    if (!adminEl) return;
    adminEl.hidden = !(Store.name === 'remote' && window.location.hash === '#admin');
  }

  function markInvalid(el, hint) {
    el.setAttribute('aria-invalid', 'true');
    setMsg(hint, true);
    el.focus();
  }

  function clearInvalid(el) {
    if (el.getAttribute('aria-invalid') !== 'true') return;
    el.removeAttribute('aria-invalid');
    setMsg('');
  }

  function updateNotice() {
    if (!noticeEl) return;
    if (Store.name === 'remote') {
      noticeEl.className = 'notice notice-ok';
      noticeEl.textContent =
        '已连接数据库：留言保存在 Supabase 上，所有访客都能看到。' +
        '「删除」只能删你自己发的那几条（密钥存在本机浏览器里，服务器上只有哈希）。';
    } else {
      noticeEl.className = 'notice';
      noticeEl.textContent =
        '这一版是本地存储：留言只存在你自己浏览器里，别人看不到。' +
        '连不上数据库时会自动退回这个模式。';
    }
  }

  /* ---------- 构建一条 ----------
     全程 textContent，绝不拼 innerHTML：留言是用户输入，拼 HTML 等于自开 XSS 口子。 */
  function buildItem(entry) {
    const li = document.createElement('li');
    li.className = 'gb-item';

    const avatar = document.createElement('span');
    avatar.className = 'gb-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    // 首字符若是 HTML 特殊符号（昵称写成 "<img…>" 这种），头像退回「匿」
    const raw = (entry.name || '').trim().charAt(0);
    avatar.textContent = (raw && !/[<>&"'/\\]/.test(raw)) ? raw.toUpperCase() : '匿';

    const body = document.createElement('div');
    body.className = 'gb-item-body';

    const head = document.createElement('div');
    head.className = 'gb-item-head';

    const name = document.createElement('strong');
    name.className = 'gb-item-name';
    name.textContent = entry.name;

    const time = document.createElement('time');
    time.className = 'gb-item-time';
    try { time.dateTime = new Date(entry.time).toISOString(); } catch (err) { /* 忽略 */ }
    time.textContent = formatTime(entry.time);

    head.appendChild(name);
    head.appendChild(time);

    const text = document.createElement('p');
    text.className = 'gb-item-text';
    text.textContent = entry.text;

    body.appendChild(head);
    body.appendChild(text);

    li.appendChild(avatar);
    li.appendChild(body);

    if (Store.canDelete(entry.id)) {
      const del = document.createElement('button');
      del.className = 'gb-del';
      del.type = 'button';
      del.textContent = '删除';
      del.setAttribute('aria-label', '删除 ' + entry.name + ' 的这条留言');
      del.addEventListener('click', () => handleDelete(entry));
      li.appendChild(del);
    }

    return li;
  }

  /* ---------- 整表渲染 ---------- */
  async function render() {
    let items = [];
    try {
      items = await Store.list();
    } catch (err) {
      console.warn(err);
      setMsg('读取留言失败：' + err.message, true);
    }

    listEl.textContent = '';
    items.forEach((entry) => listEl.appendChild(buildItem(entry)));

    totalEl.textContent = items.length + ' 条';
    emptyEl.hidden = items.length > 0;
  }

  /* ---------- 删除 ---------- */
  async function handleDelete(entry) {
    const preview = entry.text.length > 30 ? entry.text.slice(0, 30) + '…' : entry.text;
    if (!window.confirm('确定删除这条留言吗？\n\n' + entry.name + '：' + preview)) return;

    try {
      await Store.remove(entry.id);
      await render();
      setMsg('已删除。', false);
    } catch (err) {
      console.warn(err);
      setMsg('删除失败：' + err.message, true);
    }
  }

  /* ---------- 提交 ---------- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = nameEl.value.trim();
    const content = textEl.value.trim();

    if (!name) { markInvalid(nameEl, '写个昵称吧，随便什么都行。'); return; }
    if (!content) { markInvalid(textEl, '留言还没写呢。'); return; }

    const entry = {
      id:   newId(),
      name: name.slice(0, MAX_NAME),
      text: content.slice(0, MAX_TEXT),
      time: Date.now(),
    };

    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    try {
      await Store.add(entry);
    } catch (err) {
      console.warn(err);
      setMsg('发布失败：' + err.message, true);
      if (btn) btn.disabled = false;
      return;
    }

    form.reset();
    updateCounter();
    nameEl.removeAttribute('aria-invalid');
    textEl.removeAttribute('aria-invalid');
    setMsg('发布成功，谢谢留言。', false);
    if (btn) btn.disabled = false;
    await render();
  });

  /* ---------- 字数计数 + 清除错误态 ---------- */
  function updateCounter() {
    countEl.textContent = textEl.value.length + ' / ' + MAX_TEXT;
  }

  textEl.addEventListener('input', () => { updateCounter(); clearInvalid(textEl); });
  nameEl.addEventListener('input', () => clearInvalid(nameEl));

  /* ---------- 管理员：清空全部 ----------
     走 Supabase 的 RPC，密码在服务端比对后才执行删除。
     前端拿不到任何表结构，也读不到密码哈希。 */
  async function handleClearAll() {
    adminToken = tokenEl ? tokenEl.value : '';

    if (Store.name !== 'remote') {
      setAdminMsg('当前没连上数据库，无法清空。', true);
      return;
    }
    if (!adminToken) {
      setAdminMsg('先填管理员密码。', true);
      if (tokenEl) tokenEl.focus();
      return;
    }

    let n = 0;
    try { n = (await Store.list()).length; } catch (err) { /* 读不到就按 0 算 */ }

    if (!window.confirm('确定要永久删除全部 ' + n + ' 条留言吗？此操作无法撤销。')) return;

    if (clearEl) clearEl.disabled = true;
    try {
      const res = await fetch(SUPABASE.url + '/rest/v1/rpc/clear_all_messages', {
        method: 'POST',
        headers: sbHeaders(),
        body: JSON.stringify({ p_token: adminToken }),
      });
      if (!res.ok) throw new Error(await readError(res));

      // 函数返回 jsonb：成功 {ok:true,deleted:N}，失败 {ok:false,error:"..."}
      // ⚠️ 密码错、被锁定这些「业务失败」也是 HTTP 200，必须看 ok 字段，
      //    不能只看状态码 —— 否则会把「密码错误」当成「清空成功 0 条」。
      const data = await res.json();
      if (!data || data.ok !== true) {
        setAdminMsg((data && data.error) || '清空失败：服务端没有返回预期结果', true);
        return;
      }

      setAdminMsg('已删除 ' + data.deleted + ' 条', false);
      await render();
    } catch (err) {
      console.warn(err);
      setAdminMsg('清空失败：' + err.message, true);
    } finally {
      if (clearEl) clearEl.disabled = false;
    }
  }

  if (tokenEl) {
    tokenEl.addEventListener('input', () => { adminToken = tokenEl.value; });
  }
  if (clearEl) clearEl.addEventListener('click', handleClearAll);
  window.addEventListener('hashchange', syncAdminPanel);

  /* ---------- 探测后端 ----------
     配了 Supabase 就用它；探不通（网络不通 / RLS 没配好 / 浏览器不支持）
     就退回浏览器本地存储，页面照样能用。 */
  async function detectBackend() {
    if (!SUPABASE.url || !SUPABASE.anonKey) return false;
    // 删除密钥的哈希要靠 Web Crypto，没有就没法发帖
    if (!window.crypto || !window.crypto.subtle) return false;

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? window.setTimeout(() => ctrl.abort(), 8000) : 0;
    try {
      const res = await fetch(
        SUPABASE.url + '/rest/v1/messages?select=id&limit=1',
        { headers: sbHeaders(), signal: ctrl ? ctrl.signal : undefined }
      );
      if (!res.ok) {
        console.warn('[留言板] Supabase 探测失败：HTTP ' + res.status + ' ' + (await readError(res)));
        return false;
      }
      Store = RemoteStore;
      return true;
    } catch (err) {
      console.warn('[留言板] Supabase 探测异常，退回本地存储：', err);
      return false;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  /* ---------- 启动 ---------- */
  (async () => {
    updateCounter();
    updateNotice();
    await detectBackend();
    updateNotice();
    syncAdminPanel();      // 必须在 detectBackend 之后，否则不知道是不是连上了
    await render();
  })();
})();
