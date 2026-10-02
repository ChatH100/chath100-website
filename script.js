/* ==========================================================================
   ChatH100 · 个人主页 —— 交互脚本
   纯原生 JS，无依赖。所有功能都做了「元素不存在就跳过」的防御，
   所以你删掉某段 HTML 也不会报错。
   ========================================================================== */

(() => {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer  = window.matchMedia('(pointer: fine)').matches;

  /* ==================================================================
     动态背景开关
     不想要哪一层，把对应项改成 false 就行，例如 particles: false。
     “减少动效”偏好下会自动全部关掉。
     ================================================================== */
  const BG = {
    aurora:          true,    // 极光：两层反向旋转的锥形渐变
    parallax:        true,    // 光斑随光标产生视差
    grid:            true,    // 流动网格 + 扫描光束
    particles:       true,    // canvas 粒子星网
    particleDensity: 22000,   // 多少像素一个粒子，越大越稀疏
    particleMax:     90,      // 粒子上限（性能保护）
    linkDistance:    132,     // 多近才连线
  };

  /* ---------------------------------------------------------------- 开场分屏 */
  (function intro() {
    const overlay = $('#introOverlay');
    if (!overlay) return;

    const finish = () => {
      overlay.classList.add('is-done');
      document.body.classList.remove('is-locked');

      // 开场期间 body 锁了滚动，浏览器会因此放弃锚点跳转
      // （典型场景：从 talk.html 点「关于」进到 index.html#about）。
      // 解锁后补跳一次，保证真的落到对应板块。
      const id = window.location.hash.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ block: 'start' });
    };

    if (reduceMotion) { finish(); return; }

    document.body.classList.add('is-locked');
    // CSS 动画：延迟 0.35s + 时长 1.15s，留一点余量
    window.setTimeout(finish, 1650);
    window.addEventListener('pagehide', finish, { once: true });
  })();

  /* ---------------------------------------------------------------- 动态背景 */
  (function background() {
    const root = document.documentElement;

    // 按配置关掉对应的层（CSS 里靠 .no-xxx 生效）
    if (!BG.aurora)    root.classList.add('no-aurora');
    if (!BG.grid)      root.classList.add('no-grid');
    if (!BG.particles) root.classList.add('no-particles');

    // “减少动效”下，canvas 和视差都不启动（CSS 动画也已被关掉）
    if (reduceMotion) { root.classList.add('no-particles'); return; }

    // 触屏设备不做视差：手指滑动同样会触发 pointermove，
    // 结果是每帧都给挂着 blur(90px) 的图层重写 transform，纯属浪费。
    const depths = $$('.depth').map((el) => ({
      el,
      depth: parseFloat(el.dataset.depth) || 0,
    })).filter((d) => BG.parallax && finePointer && d.depth > 0);

    /* ---------- 粒子星网 ---------- */
    // 这个 canvas 每帧都要整屏 clearRect + 重绘，是持续的填充率开销。
    // 触屏设备上把粒子放稀、画布分辨率封顶 1x（1.5x 的像素量是它的 2.25 倍）。
    const coarse       = window.matchMedia('(pointer: coarse)').matches;
    const density      = coarse ? BG.particleDensity * 2.4 : BG.particleDensity;
    const maxParticles = coarse ? Math.min(48, BG.particleMax) : BG.particleMax;
    const dprCap       = coarse ? 1 : 1.5;

    const canvas = BG.particles ? $('#particles') : null;
    let ctx = null;
    let dots = [];
    let w = 0, h = 0;

    function buildParticles() {
      const count = Math.max(24, Math.min(maxParticles,
        Math.round((w * h) / density)));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.5 + 0.6,
      }));
    }

    function resize() {
      if (!canvas) return;
      w = window.innerWidth;
      h = window.innerHeight;
      // 高清屏上封顶，兼顾清晰度和性能（触屏封 1x，桌面 1.5x）
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      canvas.width  = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildParticles();
    }

    let mouseX = -9999, mouseY = -9999;

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;

        // 飘出边界就从对面绕回来
        if (d.x < -12) d.x = w + 12; else if (d.x > w + 12) d.x = -12;
        if (d.y < -12) d.y = h + 12; else if (d.y > h + 12) d.y = -12;

        // 光标轻轻推开
        const dx = d.x - mouseX, dy = d.y - mouseY;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 19600 && dist2 > 0.01) {
          const dist = Math.sqrt(dist2);
          const push = ((140 - dist) / 140) * 0.45;
          d.x += (dx / dist) * push;
          d.y += (dy / dist) * push;
        }
      }

      // 近邻连线
      const link = BG.linkDistance;
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i];
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > link * link) continue;
          const alpha = (1 - Math.sqrt(dist2) / link) * 0.22;
          ctx.strokeStyle = `rgba(150, 170, 255, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // 粒子本体
      ctx.fillStyle = 'rgba(210, 220, 255, 0.55)';
      for (const d of dots) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* ---------- 视差 ---------- */
    let tx = 0, ty = 0, cx = 0, cy = 0;

    window.addEventListener('pointermove', (e) => {
      if (!finePointer) return;          // 触屏上没有“光标”，这个位置没有意义
      mouseX = e.clientX;
      mouseY = e.clientY;
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
      tx = 0; ty = 0;
      mouseX = -9999; mouseY = -9999;
    });

    function applyParallax() {
      cx += (tx - cx) * 0.055;
      cy += (ty - cy) * 0.055;
      const scroll = window.scrollY || 0;
      for (const d of depths) {
        const ox = -cx * d.depth;
        const oy = -cy * d.depth + scroll * d.depth * 0.0022;
        const tf = `translate3d(${ox.toFixed(2)}px, ${oy.toFixed(2)}px, 0)`;
        // 值没变就不写。原来无条件赋值，等于每帧都让这几个图层样式失效一次。
        if (tf !== d.lastTransform) {
          d.el.style.transform = tf;
          d.lastTransform = tf;
        }
      }
    }

    /* ---------- 单一 rAF 循环；标签页切走时停掉，省电 ---------- */
    let rafId = 0;

    function tick() {
      rafId = 0;
      if (document.hidden) return;
      if (ctx) draw();
      if (depths.length) applyParallax();
      rafId = window.requestAnimationFrame(tick);
    }

    function start() {
      if (!rafId && !document.hidden) rafId = window.requestAnimationFrame(tick);
    }

    document.addEventListener('visibilitychange', start);
    window.addEventListener('resize', () => {
      resize();
      applyParallax();
    }, { passive: true });

    if (canvas) resize();
    if (canvas || depths.length) start();
  })();

  /* ---------------------------------------------------------------- 自定义光标 */
  (function cursor() {
    const ball = $('#cursorBall');
    if (!ball || !finePointer || reduceMotion) return;

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let ballX = mouseX;
    let ballY = mouseY;
    let visible = false;

    window.addEventListener('pointermove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (!visible) { visible = true; ball.classList.add('is-on'); }
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
      visible = false;
      ball.classList.remove('is-on');
    });

    // 悬停在可交互元素上时放大
    const HOT = 'a, button, input, [data-cursor]';
    document.addEventListener('pointerover', (e) => {
      if (e.target instanceof Element && e.target.closest(HOT)) ball.classList.add('is-hot');
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target instanceof Element && e.target.closest(HOT)) ball.classList.remove('is-hot');
    });

    (function loop() {
      // 缓动跟随，产生拖尾感
      ballX += (mouseX - ballX) * 0.2;
      ballY += (mouseY - ballY) * 0.2;
      ball.style.transform = `translate3d(${ballX}px, ${ballY}px, 0) translate(-50%, -50%)`;
      window.requestAnimationFrame(loop);
    })();
  })();

  /* ---------------------------------------------------------------- 顶部导航 */
  (function navigation() {
    const nav    = $('#nav');
    const toggle = $('#navToggle');
    const links  = $('#navLinks');

    // 滚动后加深底色
    if (nav) {
      let ticking = false;
      const update = () => {
        nav.classList.toggle('is-stuck', window.scrollY > 12);
        ticking = false;
      };
      update();
      window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(update);
      }, { passive: true });
    }

    // 移动端菜单
    if (toggle && links) {
      const setOpen = (open) => {
        links.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      };

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(!links.classList.contains('is-open'));
      });

      links.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('a')) setOpen(false);
      });

      document.addEventListener('click', (e) => {
        if (!links.classList.contains('is-open')) return;
        if (e.target instanceof Element && e.target.closest('.nav-inner')) return;
        setOpen(false);
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && links.classList.contains('is-open')) {
          setOpen(false);
          toggle.focus();
        }
      });

      // 回到桌面宽度时复位，避免菜单状态残留
      window.matchMedia('(min-width: 721px)').addEventListener('change', (e) => {
        if (e.matches) setOpen(false);
      });
    }

    // 当前所在板块高亮
    const navLinks = $$('#navLinks a[href^="#"]');
    if (!navLinks.length || !('IntersectionObserver' in window)) return;

    const map = new Map();
    navLinks.forEach((a) => {
      const section = document.getElementById(a.getAttribute('href').slice(1));
      if (section) map.set(section, a);
    });

    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((a) => a.classList.remove('is-active'));
        const active = map.get(entry.target);
        if (active) active.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

    map.forEach((_, section) => spy.observe(section));
  })();

  /* ---------------------------------------------------------------- 滚动进场 */
  (function reveal() {
    const items = $$('.reveal');
    if (!items.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const io = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0 });

    items.forEach((el) => io.observe(el));

    // 兜底：底部预留区域会让贴底的元素永远触发不了观察器，
    // 页面滑到底时强制放行，保证内容不会永久隐身。
    const flush = () => {
      const atBottom = window.innerHeight + window.scrollY >=
                       document.documentElement.scrollHeight - 120;
      if (!atBottom) return;
      items.forEach((el) => {
        if (el.classList.contains('is-visible')) return;
        el.classList.add('is-visible');
        io.unobserve(el);
      });
    };
    window.addEventListener('scroll', flush, { passive: true });
    window.addEventListener('resize', flush, { passive: true });
    window.addEventListener('load', flush);
  })();

  /* ---------------------------------------------------------------- 提示条 */
  const toast = (() => {
    const el = $('#toast');
    let timer = 0;
    return (message) => {
      if (!el) return;
      el.textContent = message;
      el.classList.add('is-on');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove('is-on'), 2800);
    };
  })();

  /* --------------------------------------------- 占位链接（还没做的页面） */
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;

    const demo = e.target.closest('[data-demo], a[href="#"]');
    if (!demo) return;

    e.preventDefault();
    toast('这是占位链接 —— 把 href 换成你自己的地址就行。');
  });

  /* ---------------------------------------------------------------- 页脚年份 */
  (function year() {
    const el = $('#year');
    if (el) el.textContent = String(new Date().getFullYear());
  })();

})();
