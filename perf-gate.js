/* ==========================================================================
   perf-gate.js —— 打开页面前的性能判定（精简版分发）
   必须放在 <head> 里、且在 <link rel="stylesheet"> 之前，越早越好。

   作用：判断这台设备能不能扛住"全特效版"。扛不住就替换到 -lite 页面，
        避免先加载重资源、再卡死（低端设备上"先渲染再降级"是来不及的）。

   判定顺序（任一命中即判为弱设备）：
     1. URL 显式指定        ?lite=1 强制精简    ?full=1 强制完整
     2. 本次会话已判过      用 sessionStorage 记住结论，避免来回跳
     3. WebGL 不可用 / 只有软件渲染  -> 直接精简
     4. 显存或渲染器字符串命中低端名单
     5. 帧耗时微基准：连续绘制 + rAF 采样，中位帧时超过阈值 -> 精简

   设计约束：
     · 同步执行、总耗时上限约 150ms，不会让首屏出现可感知的白屏
     · 任何异常都保守地按"能跑完整版"处理，避免误伤正常设备
     · 支持 ?full=1 手动覆盖，防止误判把好设备降级
   ========================================================================== */
(function () {
  'use strict';

  var W = window, D = document;

  /* ---------- 可调参数 ----------
     判据目标：**流畅的给完整版，有一点卡的给精简版**。
     所以阈值是按"能否稳住 60fps"划的，不是按"能不能跑"划的。

     调参依据（实测踩过的坑）：
       门禁执行时页面正在解析 HTML、跑脚本、加载样式表，首帧抖动很大。
       早期参数（丢弃 2 帧 / 预算 150ms / 阈值 13ms）会把 RTX 5060 这类
       好设备也误判成弱设备——实测报出 slow:22.2ms/8f。
       改成"多丢热身帧 + 放长窗口"后，实测稳态 5.5~5.6ms，判定稳定。

     调参方向：
       想更保守（更少设备走精简版）-> slowFrameMs 调到 20~24
       想更激进（更多设备走精简版）-> 调到 15 左右
       想完全不错杀 -> slowFrameMs 设成 999，只用硬性判据 */
  var CFG = {
    frameBudgetMs: 500,    // 采样时长
    hardCapMs: 700,        // 硬上限，超过就用已有样本判，绝不拖长首屏
    warmupFrames: 8,       // 丢弃前几帧（解析/样式计算/首帧初始化都在这段）
    minFrames: 16,         // 尽量凑够这么多帧再判
    minFramesOk: 10,       // 至少这么多帧才敢下"弱"的结论

    /* 流畅度判据：60Hz 下一帧 16.7ms。
       median > 16.8ms 说明连最简单的绘制都稳不住 60fps —— 那这个页面的
       全特效（大半径模糊 + 混合模式 + 粒子）必然明显掉帧，直接给精简版。
       p90 > 33ms 说明有可感知的卡顿尖峰，同样给精简版。
       两项都是"或"的关系：任一超标即判弱。 */
    slowFrameMs: 16.8,
    p90FrameMs: 33.0,

    /* 高分辨率惩罚：像素越多，模糊和合成的开销按面积增长。
       1600x900 ≈ 1.44MP 为基准，超过 3.5 倍（约 5MP，对应 2560x1440 以上）
       时把阈值收紧，因为这类屏幕上的全特效明显更吃力。 */
    hiDpiPixels: 3500000,
    hiDpiTighten: 0.82,    // 收紧系数：阈值乘以它

    minCores: 4,           // 逻辑核心数低于此值判为弱设备
    minMemoryGB: 4,        // deviceMemory 低于此值判为弱设备
    liteSuffix: '-lite'    // index.html -> index-lite.html
  };

  /* ---------- 工具 ---------- */
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(W.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function flag(name) {
    var v = param(name);
    return v === '1' || v === 'true' || v === '';
  }
  function safeStorage(fn) { try { return fn(); } catch (e) { return null; } }

  /* 当前页面对应的精简版文件名 */
  function liteHref() {
    var path = W.location.pathname;
    var file = path.substring(path.lastIndexOf('/') + 1) || 'index.html';
    if (/\.html?$/i.test(file)) {
      file = file.replace(/\.html?$/i, CFG.liteSuffix + '.html');
    } else {
      file = 'index' + CFG.liteSuffix + '.html';
    }
    return file + W.location.search.replace(/[?&](full|lite)=[^&#]*/g, '').replace(/^&/, '?') + W.location.hash;
  }

  function isLitePage() {
    return new RegExp(CFG.liteSuffix.replace('-', '\\-') + '\\.html?$', 'i').test(W.location.pathname);
  }

  /* ---------- 1. 显式指定优先 ---------- */
  if (flag('full')) {
    safeStorage(function () { sessionStorage.setItem('perfTier', 'full'); });
    return;
  }
  if (flag('lite')) {
    if (!isLitePage()) { W.location.replace(liteHref()); }
    return;
  }
  if (isLitePage()) return;   // 已经在精简版页面上，不再判定

  /* ---------- 2. 本次会话的记忆 ---------- */
  var remembered = safeStorage(function () { return sessionStorage.getItem('perfTier'); });
  if (remembered === 'lite') { W.location.replace(liteHref()); return; }
  if (remembered === 'full') return;

  /* ---------- 判定结果 ---------- */
  var decided = false;
  function goLite(reason) {
    if (decided) return;
    decided = true;
    safeStorage(function () { sessionStorage.setItem('perfTier', 'lite'); });
    safeStorage(function () { sessionStorage.setItem('perfWhy', String(reason)); });
    W.location.replace(liteHref());
  }
  function goFull() {
    if (decided) return;
    decided = true;
    safeStorage(function () { sessionStorage.setItem('perfTier', 'full'); });
  }

  /* ---------- 3. 硬件基本盘 ---------- */
  try {
    // 双核及以下的机器跑这套全特效必然不流畅
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < CFG.minCores) {
      goLite('cores:' + navigator.hardwareConcurrency); return;
    }
    if (navigator.deviceMemory && navigator.deviceMemory < CFG.minMemoryGB) {
      goLite('mem:' + navigator.deviceMemory); return;
    }
  } catch (e) { /* 忽略 */ }

  /* ---------- 4. WebGL 可用性与渲染器 ---------- */
  var gl = null;
  try {
    var c = D.createElement('canvas');
    gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  } catch (e) { gl = null; }

  if (!gl) { goLite('no-webgl'); return; }

  var renderer = '';
  try {
    var ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) || '');
  } catch (e) { /* 忽略 */ }

  if (/swiftshader|software|llvmpipe|basic render/i.test(renderer)) {
    goLite('software-renderer:' + renderer); return;
  }

  /* 明确撑不住全特效的核显 / 老独显。
     注意 Intel 的命名：HD Graphics 后面跟 4 位数字（如 5500 = Broadwell 2015），
     UHD Graphics 后面跟 3 位（如 620 = Skylake 2015）。这两代跑本页全特效
     的大半径模糊会明显掉帧，直接给精简版。 */
  if (/SwiftShader|llvmpipe|Software Adapter/i.test(renderer)) { goLite('software:' + renderer); return; }
  if (/HD Graphics\s*(2|3|4|5|6)\d{3}/i.test(renderer)) { goLite('old-igpu-4digit:' + renderer); return; }   // HD 2000~6999
  if (/UHD Graphics\s*(5|6)\d{2}\b/i.test(renderer)) { goLite('old-igpu-uhd:' + renderer); return; }        // UHD 5xx / 6xx
  if (/GMA\s?(3|4|5|6|9|X)|Mali-[34]\d{2}|Adreno\s*\(TM\)\s*[123]\d{2}|PowerVR SGX|Vivante/i.test(renderer)) {
    goLite('ancient-gpu:' + renderer); return;
  }
  if (/Intel.*(HD|UHD) Graphics (500|505|510|515|520|530|540|600|605|610|615|620|630)\b/i.test(renderer)) {
    goLite('weak-igpu:' + renderer); return;
  }

  /* 像素量：模糊与合成的开销按面积增长。
     高分辨率屏上同一张页面要处理多得多的像素，全特效更容易卡。 */
  var pixels = 0;
  try {
    var w = (W.screen && W.screen.width) || W.innerWidth || 0;
    var h = (W.screen && W.screen.height) || W.innerHeight || 0;
    var dpr = W.devicePixelRatio || 1;
    pixels = w * h * dpr * dpr;
  } catch (e) { pixels = 0; }

  /* 只有一块"还行的" GPU 却在驱动很高分辨率的屏，也要按弱处理：
     例如 4K 屏（约 8.3MP × dpr²）用中端核显，全特效必然吃力。 */
  if (pixels > CFG.hiDpiPixels * 2 &&
      /Intel|UHD|HD Graphics|Vega|Radeon.*Graphics/i.test(renderer)) {
    goLite('hidpi-igpu:' + Math.round(pixels / 1e6) + 'MP:' + renderer); return;
  }

  /* ---------- 5. 帧耗时微基准 ---------- */
  var canvas = D.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:256px;height:256px;pointer-events:none;';
  var ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
  if (!ctx) { goFull(); return; }

  (D.body || D.documentElement).appendChild(canvas);

  var frames = [];
  var t0 = 0, last = 0, rafId = 0, finished = false, seen = 0;

  function cleanup() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    try { canvas.parentNode.removeChild(canvas); } catch (e) { /* 忽略 */ }
  }

  function draw() {
    // 逐帧累积一点变换 + 多次填充，制造接近真实页面的合成压力
    for (var i = 0; i < 60; i++) {
      ctx.fillStyle = (i & 3) === 0 ? 'rgba(120,40,255,0.06)' : 'rgba(0,90,255,0.03)';
      ctx.fillRect((i * 7) % 256, (i * 11) % 256, 96, 96);
    }
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, 256, 256);
    ctx.globalAlpha = 1;
  }

  function judge() {
    if (finished) return;
    finished = true;
    cleanup();
    // 样本不足就不下"弱"的结论 —— 宁可让弱设备多跑一次完整版，也不误伤好设备
    if (frames.length < CFG.minFramesOk) { goFull(); return; }

    var sorted = frames.slice().sort(function (a, b) { return a - b; });
    var n = sorted.length;
    var median = sorted[Math.floor(n / 2)];
    var p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))];

    // 高分辨率屏收紧阈值：同样的笔触在更多像素上更吃力
    var thresh = CFG.slowFrameMs;
    var p90thresh = CFG.p90FrameMs;
    if (pixels > CFG.hiDpiPixels) {
      thresh = thresh * CFG.hiDpiTighten;
      p90thresh = p90thresh * CFG.hiDpiTighten;
    }

    /* 判据：稳不住 60fps（median 超标）**或**存在可感知卡顿尖峰（p90 超标）。
       目标是"流畅给完整版、有一点卡给精简版"，所以两项取"或"。 */
    if (median > thresh) {
      goLite('not-smooth:' + median.toFixed(1) + 'ms/' + n + 'f');
    } else if (p90 > p90thresh) {
      goLite('stutter-p90:' + p90.toFixed(1) + 'ms/' + n + 'f');
    } else {
      goFull();
    }
  }

  function step(now) {
    if (!t0) { t0 = now; last = now; rafId = requestAnimationFrame(step); return; }
    draw();
    var dt = now - last;
    last = now;
    seen++;
    // 前若干帧丢弃：这段时间里浏览器还在解析文档、计算样式、加载样式表，
    // 帧时会明显偏高，拿它做判据会把好设备误判成弱设备。
    if (seen > CFG.warmupFrames) frames.push(dt);

    var overBudget = (now - t0) >= CFG.frameBudgetMs && frames.length >= CFG.minFrames;
    var hardStop = (now - t0) >= CFG.hardCapMs;
    if ((overBudget || hardStop) && frames.length >= CFG.minFramesOk) { judge(); return; }
    if (hardStop) { judge(); return; }
    rafId = requestAnimationFrame(step);
  }

  try {
    // 页面在后台时 rAF 不触发，测不出东西，直接按完整版处理
    if (D.hidden) { goFull(); return; }
    rafId = requestAnimationFrame(step);
    // 兜底：极端情况下 rAF 迟迟不来，按完整版处理，别让页面干等
    setTimeout(function () { if (!decided) { judge(); } }, CFG.hardCapMs + 250);
  } catch (e) {
    cleanup();
    goFull();
  }
})();
