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
     图片上传
     只允许 4 种图片，故意排除 svg —— svg 能内嵌 JavaScript，
     直接打开公开链接会在浏览器里执行脚本，是典型的存储型 XSS 载体。
     服务端（存储桶的 allowed_mime_types）会按同一份白名单再拦一道，
     所以前端这层就算被绕过，也放不进来奇怪的东西。
     ================================================================== */
  const BUCKET = 'guestbook-images';

  /* 你可以选最大 20 MB 的源文件，浏览器会先缩小再上传。
     这样做省的是【流量】不是【容量】：留言板每次打开都要下载全部图片，
     存 10 张 20 MB 原图的话，一次访问就是 200 MB，免费额度撑不了几次。 */
  const MAX_SOURCE   = 20 * 1024 * 1024;      // 允许选择的源文件上限
  const MAX_UPLOAD   = 5 * 1024 * 1024;       // 压缩后仍不能超过这个，与桶配置一致
  const MAX_GIF      = 3 * 1024 * 1024;       // GIF 不压缩（会丢动画），单独限小
  const MAX_EDGE     = 1600;                  // 压缩后最长边的像素数
  const JPEG_QUALITY = 0.85;

  const MAX_IMAGES = 10;                      // 最多保留 10 张图，超了删最旧的
  const IMAGE_EXT = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/gif':  'gif',
    'image/webp': 'webp',
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
     图片：识别真实类型、上传
     ================================================================== */

  // 读文件开头几个字节，按「魔数」判断真实类型。
  // 光信 file.type 不够 —— 把 .exe 改名成 .png，浏览器照样报 image/png。
  async function sniffImageType(file) {
    const buf = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const at = (i) => buf[i];

    if (buf.length >= 3 && at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'image/jpeg';
    if (buf.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4E && at(3) === 0x47 &&
        at(4) === 0x0D && at(5) === 0x0A && at(6) === 0x1A && at(7) === 0x0A) return 'image/png';
    if (buf.length >= 4 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
    if (buf.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
        at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';

    return null;
  }

  function readSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 公开读取地址。桶是 public，不需要签名也不需要密钥。
  function imageUrl(path) {
    return SUPABASE.url + '/storage/v1/object/public/' + BUCKET + '/' + encodeURIComponent(path);
  }

  /* ---------- 压缩 ----------
     在浏览器里把图缩小后重编码再上传。
     GIF 直接跳过：canvas 会把动图压成静态图，那就毁了。
     返回的 type 取自【压缩后数据的魔数】，不是我们请求的类型 ——
     有些浏览器不支持 toBlob('image/webp')，会悄悄返回 PNG。 */
  async function compressImage(file, srcType) {
    if (srcType === 'image/gif') {
      return { blob: file, type: 'image/gif', skipped: true };
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      throw new Error('这张图浏览器读不了，换一张试试');
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持图片压缩');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    // PNG 保持 PNG —— 转成 JPEG 会让透明区域变成黑块
    const want = (srcType === 'image/png') ? 'image/png' : srcType;

    let blob = await new Promise((res) => canvas.toBlob(res, want, JPEG_QUALITY));
    if (!blob) throw new Error('图片压缩失败');

    // 压完还是太大就逐步降质量（PNG 降质量没意义，跳过）
    if (want !== 'image/png') {
      for (const q of [0.7, 0.6, 0.5, 0.4]) {
        if (blob.size <= MAX_UPLOAD) break;
        const again = await new Promise((res) => canvas.toBlob(res, want, q));
        if (!again || again.size >= blob.size) break;
        blob = again;
      }
    }

    const type = await sniffImageType(blob);
    if (!type) throw new Error('压缩后不是有效图片，换一张试试');

    return { blob: blob, type: type, skipped: false, w: w, h: h };
  }

  // 上传成功返回 { path, before, after, skipped }，失败抛错。
  // 文件名用 UUID 是为了配合数据库那条 check 约束，也避免任何路径穿越。
  async function uploadImage(file) {
    const srcType = await sniffImageType(file);
    if (!srcType) throw new Error('这不是有效的图片，只接受 jpg / png / gif / webp');

    if (srcType === 'image/gif' && file.size > MAX_GIF) {
      throw new Error('GIF 不能超过 ' + readSize(MAX_GIF) + '（动图不压缩，所以单独限小）');
    }

    const out = await compressImage(file, srcType);

    if (out.blob.size > MAX_UPLOAD) {
      throw new Error('压缩后仍有 ' + readSize(out.blob.size) + '，超过上限 ' +
                      readSize(MAX_UPLOAD) + '，换张小一点的图');
    }

    const path = window.crypto.randomUUID() + '.' + IMAGE_EXT[out.type];

    // 方便在浏览器控制台核对压缩效果
    if (out.skipped) {
      console.info('[留言板] GIF 跳过压缩：' + readSize(file.size));
    } else {
      console.info('[留言板] 已压缩：' + readSize(file.size) + ' → ' + readSize(out.blob.size) +
                   '（' + out.w + '×' + out.h + '）');
    }

    // 存储接口要的是原始文件体，所以不能复用 sbHeaders（那个会设 JSON）
    const res = await fetch(
      SUPABASE.url + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(path),
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE.anonKey,
          Authorization: 'Bearer ' + SUPABASE.anonKey,
          'Content-Type': out.type,
          'x-upsert': 'false',          // 不允许覆盖同名文件
        },
        body: out.blob,
      }
    );
    if (!res.ok) throw new Error(await readError(res));

    return { path: path, before: file.size, after: out.blob.size, skipped: out.skipped };
  }

  /* ---------- 图片上限：只留最新 10 张 ----------
     为什么要前端来删：Supabase 明确要求删除存储对象必须走 Storage API，
     用 SQL 删 storage.objects 只会留下孤儿文件（照样占空间，还更难清理）。
     服务端的 RLS 策略把删除权限锁死在「当前最旧的那一张」，
     所以就算有人直接调这个接口，也删不掉别人的图。 */
  async function trimOldestImage() {
    let items;
    try {
      items = await Store.list();
    } catch (err) {
      return null;           // 读不到列表就不清理，别因此阻断发帖
    }

    const withImg = items.filter((m) => m.image_path);
    if (withImg.length < MAX_IMAGES) return null;

    // list() 是按时间倒序的，最后一条就是最旧的
    const oldest = withImg[withImg.length - 1];

    const res = await fetch(
      SUPABASE.url + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(oldest.image_path),
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE.anonKey,
          Authorization: 'Bearer ' + SUPABASE.anonKey,
        },
      }
    );

    if (!res.ok) {
      console.warn('[留言板] 清理最旧图片失败：HTTP ' + res.status);
      return null;
    }
    return oldest.image_path;
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
        SUPABASE.url + '/rest/v1/messages?select=id,name,text,time,image_path&order=time.desc&limit=500',
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
          image_path: entry.imagePath || null,
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
  const fileEl      = $('#gbFile');
  const fileClearEl = $('#gbFileClear');
  const filePrevEl  = $('#gbFilePreview');
  const fileThumbEl = $('#gbFileThumb');
  const fileMsgEl   = $('#gbFileMsg');

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
    // 本地存储模式下不能传图片（没有服务端可存）
    const remote = Store.name === 'remote';
    if (fileEl) fileEl.disabled = !remote;
    if (fileClearEl && !remote) fileClearEl.hidden = true;

    if (!noticeEl) return;
    if (remote) {
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

    if (entry.image_path) {
      const fig = document.createElement('figure');
      fig.className = 'gb-item-image';

      const img = document.createElement('img');
      img.src = imageUrl(entry.image_path);
      img.alt = entry.name + ' 发的图片';
      img.loading = 'lazy';
      img.decoding = 'async';
      // 图挂了就把整块收起来，别留个破图标占地方
      img.addEventListener('error', () => { fig.hidden = true; }, { once: true });

      fig.appendChild(img);
      body.appendChild(fig);
    }

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

  /* ---------- 图片选择：预览与校验 ---------- */
  function setFileMsg(text, isError) {
    if (!fileMsgEl) return;
    fileMsgEl.textContent = text || '';
    fileMsgEl.classList.toggle('is-error', Boolean(isError));
  }

  let thumbUrl = '';

  function resetFile() {
    if (fileEl) fileEl.value = '';
    if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = ''; }
    if (filePrevEl)  filePrevEl.hidden = true;
    if (fileThumbEl) fileThumbEl.removeAttribute('src');
    if (fileClearEl) fileClearEl.hidden = true;
    setFileMsg('', false);
  }

  if (fileEl) {
    fileEl.addEventListener('change', async () => {
      const file = fileEl.files && fileEl.files[0];
      if (!file) { resetFile(); return; }

      if (file.size > MAX_SOURCE) {
        const m = '图片太大（' + readSize(file.size) + '），最大 ' + readSize(MAX_SOURCE);
        resetFile();
        setFileMsg(m, true);
        return;
      }

      // 看魔数判断真实类型，不看扩展名
      const type = await sniffImageType(file);
      if (!type) {
        resetFile();
        setFileMsg('这不是有效的图片，只接受 jpg / png / gif / webp', true);
        return;
      }

      if (type === 'image/gif' && file.size > MAX_GIF) {
        resetFile();
        setFileMsg('GIF 不能超过 ' + readSize(MAX_GIF) + '（动图不压缩，所以单独限小）', true);
        return;
      }

      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      thumbUrl = URL.createObjectURL(file);
      if (fileThumbEl) fileThumbEl.src = thumbUrl;
      if (filePrevEl)  filePrevEl.hidden = false;
      if (fileClearEl) fileClearEl.hidden = false;

      const note = (type === 'image/gif')
        ? '动图，原样上传'
        : '上传前会压到最长边 ' + MAX_EDGE + 'px';
      setFileMsg('已选：' + (file.name || '图片') + ' · ' + readSize(file.size) + ' · ' + note, false);
    });
  }

  if (fileClearEl) fileClearEl.addEventListener('click', resetFile);

  /* ---------- 提交 ---------- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = nameEl.value.trim();
    const content = textEl.value.trim();

    if (!name) { markInvalid(nameEl, '写个昵称吧，随便什么都行。'); return; }
    if (!content) { markInvalid(textEl, '留言还没写呢。'); return; }

    const file = (fileEl && fileEl.files) ? fileEl.files[0] : null;

    const entry = {
      id:   newId(),
      name: name.slice(0, MAX_NAME),
      text: content.slice(0, MAX_TEXT),
      time: Date.now(),
    };

    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    /* 先传图，再发留言。顺序不能反：
       匿名用户没有 UPDATE 权限，留言一旦发出去就改不了了。
       所以「先发留言再传图」如果图失败，会留下一条永远没有图的留言；
       而「先传图再发留言」最坏只留下一个孤儿文件（≤3MB），
       由管理员偶尔清一下桶就行。两害相权取其轻。 */
    let fileNote = '';

    if (file) {
      // 先腾位：已经有 10 张就先删掉最旧那张，再传新的
      try {
        const removed = await trimOldestImage();
        if (removed) console.info('[留言板] 已达 ' + MAX_IMAGES + ' 张上限，已清理最旧的一张');
      } catch (err) {
        console.warn('[留言板] 清理旧图出错，继续发帖：', err);
      }

      setFileMsg('正在压缩并上传图片……', false);
      try {
        const up = await uploadImage(file);
        entry.imagePath = up.path;
        fileNote = up.skipped
          ? '（图片 ' + readSize(up.after) + '）'
          : '（图片已压缩：' + readSize(up.before) + ' → ' + readSize(up.after) + '）';
      } catch (err) {
        console.warn(err);
        setFileMsg('图片上传失败：' + err.message, true);
        if (btn) btn.disabled = false;
        return;
      }
    }

    try {
      await Store.add(entry);
    } catch (err) {
      console.warn(err);
      setMsg('发布失败：' + err.message, true);
      if (btn) btn.disabled = false;
      return;
    }

    form.reset();
    resetFile();
    updateCounter();
    nameEl.removeAttribute('aria-invalid');
    textEl.removeAttribute('aria-invalid');
    setMsg('发布成功，谢谢留言。' + (fileNote ? ' ' + fileNote : ''), false);
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
