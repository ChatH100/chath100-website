/* ==========================================================================
   script-lite.js —— 低性能设备的精简脚本
   只在精简版页面里加载（替代 script.js），配合 <html data-lite>。

   砍掉的东西（都是持续占用，弱设备的负担主要来自它们）：
     · 粒子星网 canvas —— 每帧整屏 clearRect + 重绘 + 近邻连线
     · 光标视差       —— 每帧给挂着大模糊的图层重写 transform
     · 自定义光标     —— 常驻 rAF 循环 + transform
     · 开场分屏       —— 全屏合成突变（CSS 侧已隐藏，这里也不再锁滚动）

   保留的东西（这些很便宜，而且删了会缺功能）：
     · 移动端菜单、滚动高亮、滚动进场、提示条、页脚年份、占位链接
   ========================================================================== */
(function () {
  'use strict';

  var D = document;
  var root = D.documentElement;
  var LITE = root.hasAttribute('data-lite') ||
             /[?&]lite=1/.test(location.search);

  // 安全护栏：这个脚本只该用在精简版页面上。万一被误挂到完整版，
  // 立刻退出，避免把完整版的动效也一起关掉。
  if (!LITE) return;

  var $ = function (sel, r) { return (r || D).querySelector(sel); };
  var $$ = function (sel, r) { return Array.prototype.slice.call((r || D).querySelectorAll(sel)); };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  /* ------------------------------------------------ 开场分屏（精简版跳过） */
  (function intro() {
    var overlay = $('#introOverlay');
    if (!overlay) return;
    overlay.classList.add('is-done');
    D.body.classList.remove('is-locked');

    // 开场期间锁了滚动，浏览器会放弃锚点跳转；解锁后补跳一次
    var id = window.location.hash.slice(1);
    if (!id) return;
    var target = D.getElementById(id);
    if (target) target.scrollIntoView({ block: 'start' });
  })();

  /* ------------------------------------------------ 顶部导航 */
  (function navigation() {
    var nav = $('#nav');
    var toggle = $('#navToggle');
    var links = $('#navLinks');

    if (nav) {
      var ticking = false;
      var update = function () {
        nav.classList.toggle('is-stuck', window.scrollY > 12);
        ticking = false;
      };
      update();
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(update);
      }, { passive: true });
    }

    if (toggle && links) {
      var setOpen = function (open) {
        links.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      };

      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!links.classList.contains('is-open'));
      });

      links.addEventListener('click', function (e) {
        if (e.target instanceof Element && e.target.closest('a')) setOpen(false);
      });

      D.addEventListener('click', function (e) {
        if (!links.classList.contains('is-open')) return;
        if (e.target instanceof Element && e.target.closest('.nav-inner')) return;
        setOpen(false);
      });

      D.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && links.classList.contains('is-open')) {
          setOpen(false);
          toggle.focus();
        }
      });

      window.matchMedia('(min-width: 721px)').addEventListener('change', function (e) {
        if (e.matches) setOpen(false);
      });
    }

    // 当前板块高亮
    var navLinks = $$('#navLinks a[href^="#"]');
    if (!navLinks.length || !('IntersectionObserver' in window)) return;

    var map = new Map();
    navLinks.forEach(function (a) {
      var section = D.getElementById(a.getAttribute('href').slice(1));
      if (section) map.set(section, a);
    });

    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (a) { a.classList.remove('is-active'); });
        var active = map.get(entry.target);
        if (active) active.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

    map.forEach(function (_, section) { spy.observe(section); });
  })();

  /* ------------------------------------------------ 滚动进场 */
  (function reveal() {
    var items = $$('.reveal');
    if (!items.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var io = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0 });

    items.forEach(function (el) { io.observe(el); });

    // 兜底：贴底元素可能永远触发不了观察器
    var flush = function () {
      var atBottom = window.innerHeight + window.scrollY >=
                     D.documentElement.scrollHeight - 120;
      if (!atBottom) return;
      items.forEach(function (el) {
        if (el.classList.contains('is-visible')) return;
        el.classList.add('is-visible');
        io.unobserve(el);
      });
    };
    window.addEventListener('scroll', flush, { passive: true });
    window.addEventListener('resize', flush, { passive: true });
    window.addEventListener('load', flush);
  })();

  /* ------------------------------------------------ 提示条 */
  var toast = (function () {
    var el = $('#toast');
    var timer = 0;
    return function (message) {
      if (!el) return;
      el.textContent = message;
      el.classList.add('is-on');
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { el.classList.remove('is-on'); }, 2800);
    };
  })();

  /* ------------------------------------------------ 占位链接 */
  D.addEventListener('click', function (e) {
    if (!(e.target instanceof Element)) return;
    var demo = e.target.closest('[data-demo], a[href="#"]');
    if (!demo) return;
    e.preventDefault();
    toast('这是占位链接 —— 把 href 换成你自己的地址就行。');
  });

  /* ------------------------------------------------ 页脚年份 */
  (function year() {
    var el = $('#year');
    if (el) el.textContent = String(new Date().getFullYear());
  })();

  /* ------------------------------------------------ 精简版徽标：切回完整版 */
  (function badge() {
    var a = $('.lite-badge');
    if (!a) return;
    a.addEventListener('click', function () {
      try { sessionStorage.setItem('perfTier', 'full'); } catch (e) { /* 忽略 */ }
    });
  })();
})();
