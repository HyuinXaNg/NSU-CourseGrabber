// ==UserScript==
// @name         成都东软学院 体育项目 抢课助手
// @namespace    dnui-grab-course
// @version      1.0.0
// @description  在选课页面轮询目标课程（默认「羽毛球」），出现空位自动点「选择」并确认。带悬浮控制面板，刷新页面后自动续跑。
// @author       you
// @match        https://xk.dnui.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ---------------------------------------------------------------------------
 * 安装：装好 Tampermonkey -> 新建脚本 -> 粘贴本文件 -> 保存
 * 然后打开选课页面，右上角会出现控制面板：
 *   1) 在输入框填关键词（默认「羽毛球」，多个用逗号分隔）
 *   2) 点「开始」，面板显示运行状态
 *   3) 抢到后自动停止；想中途停就点「停止」
 *
 * 演练模式勾选后只识别不点击，建议先勾上看一眼识别是否正确。
 * ------------------------------------------------------------------------- */
(() => {
  'use strict';

  const STORE_KEY = 'dnui_grab_state_v1';

  const DEFAULTS = {
    keywords: '羽毛球',
    intervalMs: 2000,
    jitterMs: 800,
    dryRun: false,
    running: false,
    // 准点开抢：留空 = 立即开抢；填 "13:00:00" = 待命到该时刻再开抢
    atTime: '13:00:00',
    burstMs: 4000,
    burstIntervalMs: 500,
    maxMinutes: 120,   // 最长跑多久自动停，0 = 不限（与控制台版/面板版保持一致）
  };

  // ---------------- 状态持久化（页面刷新后自动续跑） ----------------
  const loadState = () => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  };
  const saveState = (s) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
  };

  const state = loadState();

  // ---------------- 文本特征定位（不依赖 class 名） ----------------
  const LABEL_RE = /\[(\d+)-([^\]\r\n]+)\]\[([^\]\r\n]+)\]([^\s\[\r\n|：:]{0,12})/;
  const RATIO_RE = /(?:已选容量|已选人数|已选)[:：]?\s*(\d+)\s*[/／]\s*(\d+)/;
  const LEFT_RE = /剩余(?:名额|容量)?[:：]?\s*(\d+)/;

  /* 成功 / 失败判定。
   * 必须"先看有没有失败词"，不能只做正向匹配 ——
   * 「选课未成功」里含有「成功」，只正向匹配会把它误判为抢课成功。 */
  const FAIL_RE = /未成功|不成功|失败|错误|异常|已满|满员|已选过|请勿重复|不可选|已截止|未开始/;
  const OK_RE = /选课成功|已选上|成功/;
  const isOkMsg = (m) => OK_RE.test(m) && !FAIL_RE.test(m);
  const CONFIRM_TEXTS = ['确定', '确认', '提交', '是', 'OK'];

  // ---------------- 准点同步 ----------------
  let clockOffsetMs = 0;   // 服务器时间 - 本机时间
  let burstUntil = 0;      // 爆发期截止
  const now = () => Date.now() + clockOffsetMs;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseDeadline(at) {
    const m = String(at || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }

  /** 用同源 HEAD 请求的 Date 响应头校准本机时钟（按服务器时钟对齐开抢时刻） */
  async function syncServerClock() {
    const t0 = Date.now();
    try {
      const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
      const d = new Date(res.headers.get('date') || '');
      if (isNaN(d.getTime())) return null;
      clockOffsetMs = d.getTime() + (Date.now() - t0) / 2 - Date.now();
      return clockOffsetMs;
    } catch (_) { return null; }
  }

  /** 逼近 deadline：远粗睡、近细步，保证毫秒级落点 */
  async function waitUntilDeadline(deadline) {
    while (polling) {
      const remain = deadline - now();
      if (remain <= 0) return true;
      if (remain > 300) await sleep(Math.min(remain - 200, 1000));
      else if (remain > 60) await sleep(20);
      else await sleep(5);
    }
    return false;
  }

  /** 爆发期用快间隔，之后回到温和轮询 */
  function nextDelay() {
    if (Date.now() < burstUntil) return state.burstIntervalMs;
    return state.intervalMs + Math.random() * state.jitterMs;
  }

  const textOf = (el) => {
    if (!el) return '';
    if (el.tagName === 'INPUT') return (el.value || '').trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const isDisabled = (el) => {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = `${el.className || ''} ${(el.parentElement && el.parentElement.className) || ''}`;
    if (/(^|[\s_-])(disabled|is-disabled|btn-disabled|layui-btn-disabled|ant-btn-disabled)($|[\s_-])/i.test(cls)) return true;
    try {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return true;
    } catch (_) { /* ignore */ }
    return false;
  };

  function findByText(root, texts, exact = true) {
    const wanted = texts.map((t) => t.trim()).filter(Boolean);
    if (!wanted.length) return [];
    const out = [];
    for (const el of root.querySelectorAll('button, a, span, div, input, li, i, em, b, strong, p, label')) {
      const t = textOf(el);
      if (!t || t.length > 24) continue;
      const hit = exact ? wanted.includes(t) : wanted.some((w) => t.includes(w));
      if (!hit) continue;
      if ([...el.children].some((c) => (exact ? wanted.includes(textOf(c)) : wanted.some((w) => textOf(c).includes(w))))) continue;
      out.push(el);
    }
    return out;
  }

  function cardOf(btn) {
    let n = btn;
    while (n && n !== document.body && n !== document.documentElement) {
      if (LABEL_RE.test(n.textContent || '')) return n;
      n = n.parentElement;
    }
    return null;
  }

  function parseCard(card) {
    const text = (card.textContent || '').replace(/\s+/g, ' ');
    const m = text.match(LABEL_RE);
    if (!m) return null;
    const info = { index: m[1], course: m[2], teacherId: m[3], teacher: (m[4] || '').trim(), used: null, cap: null, left: null };
    const r = text.match(RATIO_RE);
    if (r) { info.used = Number(r[1]); info.cap = Number(r[2]); }
    const l = text.match(LEFT_RE);
    if (l) info.left = Number(l[1]);
    if (info.left !== null) info.free = info.left > 0;
    else if (info.used !== null && info.cap !== null) info.free = info.used < info.cap;
    else info.free = null;
    return info;
  }

  function scan() {
    const keywords = state.keywords.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const cards = [];
    const seen = new Set();
    for (const btn of findByText(document, ['选择'])) {
      const card = cardOf(btn);
      if (!card || seen.has(card)) continue;
      const info = parseCard(card);
      if (!info) continue;
      if (!keywords.some((kw) => info.course.includes(kw))) continue;
      seen.add(card);
      cards.push({ info, card, btn, disabled: isDisabled(btn) });
    }
    return cards;
  }

  /**
   * 真实点击（派发完整鼠标事件，兼容只监听 mousedown 的前端框架）。
   * 注意：这里不能再 dispatch 一次 'click' —— el.click() 本身就会派发一个冒泡的
   * click 事件，两者叠加会让每次点击变成两次，可能触发「请勿重复提交」。
   */
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) { /* ignore */ }
    }
    if (typeof el.click === 'function') {
      el.click();
    } else {
      try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (_) { /* ignore */ }
    }
  }

  function readToasts() {
    const sel = '.layui-layer-msg, .layui-layer-content, .el-message, .ant-message-notice, .van-toast, .toast, .message, .tips, .alert, .el-notification';
    return [...document.querySelectorAll(sel)].map(textOf).filter(Boolean);
  }

  // ---------------- 控制面板 UI ----------------
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647', 'width:264px',
    'background:#fff', 'border:1px solid #d9e1ec', 'border-radius:10px',
    'box-shadow:0 8px 28px rgba(20,40,80,.18)', 'font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif',
    'color:#1f2d3d', 'padding:12px', 'user-select:none',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <b style="font-size:13px">🏸 抢课助手</b>
      <span data-role="toggle" style="cursor:pointer;color:#8a97a8;font-size:15px;line-height:1">–</span>
    </div>
    <div data-role="body">
      <label style="display:block;color:#5a6b80;margin-bottom:3px">课程关键词（逗号分隔）</label>
      <input data-role="kw" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d9e1ec;border-radius:6px;font:13px inherit;outline:none">
      <label style="display:block;color:#5a6b80;margin:9px 0 3px">准点开抢（留空=立即；如 13:00:00）</label>
      <input data-role="at" placeholder="13:00:00" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d9e1ec;border-radius:6px;font:13px inherit;outline:none">
      <label style="display:flex;align-items:center;gap:6px;margin:9px 0 4px">
        <input type="checkbox" data-role="dry"> 演练模式（只识别，不点击）
      </label>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button data-role="start" style="flex:1;padding:7px 0;border:0;border-radius:6px;background:#2d6cdf;color:#fff;font:600 13px inherit;cursor:pointer">开始</button>
        <button data-role="stop" style="flex:1;padding:7px 0;border:1px solid #d9e1ec;border-radius:6px;background:#fff;color:#1f2d3d;font:600 13px inherit;cursor:pointer">停止</button>
      </div>
      <div data-role="status" style="margin-top:10px;padding-top:9px;border-top:1px dashed #e4eaf2;color:#5a6b80;font-size:12px;white-space:pre-wrap;word-break:break-all">未启动</div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (role) => panel.querySelector(`[data-role="${role}"]`);
  const kwInput = $('kw');
  const atInput = $('at');
  const dryBox = $('dry');
  const statusEl = $('status');

  kwInput.value = state.keywords;
  atInput.value = state.atTime || '';
  dryBox.checked = !!state.dryRun;

  atInput.addEventListener('change', () => { state.atTime = atInput.value.trim(); saveState(state); });

  $('toggle').addEventListener('click', () => {
    const body = $('body');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    $('toggle').textContent = hidden ? '–' : '+';
  });

  kwInput.addEventListener('change', () => { state.keywords = kwInput.value; saveState(state); });
  dryBox.addEventListener('change', () => { state.dryRun = dryBox.checked; saveState(state); });

  // ---------------- 引擎 ----------------
  let timer = null;
  let confirmTimer = null;
  let polling = false;
  let armed = false;   // 待命结束、真正开始抢课之后，才允许「兜底点确认框」
  let lastPickAt = 0;  // 上次点「选择」的时刻，用于限定自动确认的时间窗
  let polls = 0;
  let startedAt = 0;

  // 常见弹窗容器（layui / Element / Ant / Vant / 原生 dialog）
  const DIALOG_SEL = '.layui-layer,.layui-layer-page,.layui-layer-btn,.el-dialog,.el-message-box,'
    + '.ant-modal,.van-dialog,[role="dialog"],dialog,.modal,.popup';
  const inDialog = (el) => !!(el && el.closest && el.closest(DIALOG_SEL));

  const setStatus = (msg) => { statusEl.textContent = msg; };
  const log = (...a) => console.log('%c[抢课]', 'color:#fff;background:#2d6cdf;padding:1px 5px;border-radius:3px', ...a);

  /**
   * 自动点掉确认弹窗。
   * 安全约束：只认两类按钮，避免把页面上无关的「确定」乱点一通
   * （选课页可能有筛选弹窗、协议弹窗，甚至退课确认键）：
   *   a) 位于弹窗容器内的确认键   —— 任何时候都认
   *   b) 刚点过「选择」的 5 秒内   —— 覆盖弹窗结构识别不出来的情况
   */
  function autoConfirmOnce() {
    const recent = Date.now() - lastPickAt < 5000;
    for (const el of findByText(document, CONFIRM_TEXTS)) {
      if (isDisabled(el)) continue;
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      if (!recent && !inDialog(el)) continue;
      log('自动确认弹窗 ->', textOf(el));
      realClick(el);
      return true;
    }
    return false;
  }

  function attempt(cards) {
    const targets = cards.filter((c) => c.info.free !== false && !c.disabled);
    if (!targets.length) return false;

    for (const t of targets) {
      log(`🎯 命中空位：${t.info.course} / ${t.info.teacher}（已选 ${t.info.used ?? '?'}/${t.info.cap ?? '?'}）`);
      if (state.dryRun) { log('[演练] 已跳过点击'); continue; }

      const before = readToasts().join('|');
      lastPickAt = Date.now();   // 打开自动确认的时间窗
      realClick(t.btn);

      const t0 = Date.now();
      const check = () => {
        if (!polling) return;
        autoConfirmOnce();
        for (const m of readToasts().filter((x) => !before.includes(x))) {
          if (isOkMsg(m)) {
            log('✅ 选课成功：', m);
            setStatus(`✅ 选课成功\n${t.info.course} / ${t.info.teacher}\n服务器返回：${m}`);
            stop(true);
            return;
          }
          log('服务器返回：', m);
          setStatus(`服务器返回：${m}`);
        }
        if (Date.now() - t0 < 1500) setTimeout(check, 250);
      };
      check();
      return true;
    }
    return false;
  }

  function tick() {
    if (!polling) return;

    // 与控制台版/面板版保持一致：跑满 maxMinutes 自动停。
    // 油猴版会「刷新后自动续跑」，没有这个上限就可能无人值守地一直轮询
    // 全校共用的教务服务器 —— 这正是本文件反复强调要避免的。
    if (state.maxMinutes > 0 && Date.now() - startedAt > state.maxMinutes * 60000) {
      log(`已达最长运行时间 ${state.maxMinutes} 分钟，自动停止。`);
      stop(false);
      return;
    }

    polls++;
    let cards = [];
    try { cards = scan(); } catch (e) { log('扫描出错', e); }

    if (!cards.length) {
      setStatus(`运行中 · 第 ${polls} 次扫描\n未找到「${state.keywords}」的卡片\n请确认已切到「体育项目」标签`);
    } else {
      const brief = cards.map((c) => `[${c.info.index}-${c.info.course}]${c.info.teacher} ${c.info.used ?? '?'}/${c.info.cap ?? '?'}${c.info.free === true ? ' ✅' : c.info.free === false ? ' ⛔' : ' ❓'}`).join('\n');
      setStatus(`运行中 · 第 ${polls} 次扫描（${Math.round((Date.now() - startedAt) / 1000)}s）\n${brief}${state.dryRun ? '\n(演练模式)' : ''}`);
      // 必须包住：attempt 一旦抛错，下面的 setTimeout(tick) 就不会执行，
      // 整个轮询循环会静默死掉。
      try {
        if (!attempt(cards)) log('本轮无空位');
      } catch (e) {
        log('点击环节出错（本轮跳过，继续轮询）：', e);
      }
    }

    if (polling) timer = setTimeout(tick, nextDelay());
  }

  async function start() {
    if (polling) return;
    polling = true;
    polls = 0;
    state.running = true;
    state.keywords = kwInput.value;
    state.atTime = (atInput.value || '').trim();
    state.dryRun = dryBox.checked;
    saveState(state);

    if (!window.__DNUI_CONFIRM_PATCHED__) {
      window.__DNUI_CONFIRM_PATCHED__ = true;
      window.confirm = (msg) => { log('拦截原生 confirm：', msg, '-> 确定'); return true; };
    }
    // 兜底点确认框：必须等 armed（待命结束）才启用，
    // 否则准点待命期间会误点页面上的「确定/确认/提交」按钮。
    if (!confirmTimer) {
      confirmTimer = setInterval(() => {
        if (!armed || !polling || state.dryRun) return;
        try {
          autoConfirmOnce();
        } catch (e) {
          log('自动确认出错：', e);
        }
      }, 600);
    }

    log('启动，目标：', state.keywords, state.dryRun ? '（演练模式）' : '');

    // ---------------- 准点待命 ----------------
    armed = false;
    const deadline = parseDeadline(state.atTime);
    if (deadline !== null) {
      const off = await syncServerClock();
      if (!polling) return;                       // 待命期间被点「停止」
      log(off === null ? '未能校准服务器时钟，按本机时间计时'
                       : `时钟已对齐服务器（本机${off >= 0 ? '慢' : '快'} ${Math.abs(off / 1000).toFixed(2)}s）`);

      const remain = deadline - now();
      if (remain > 0) {
        setStatus(`⏳ 待命：${state.atTime} 准点开抢\n剩余 ${(remain / 1000).toFixed(1)}s\n待命期间不发起任何请求`);
        const ok = await waitUntilDeadline(deadline);
        if (!ok) return;
        burstUntil = Date.now() + state.burstMs;
        log(`⏰ 到点！进入 ${state.burstMs}ms 爆发期`);
      } else if (now() - deadline < 90000) {
        burstUntil = Date.now() + state.burstMs;
        log('已过点，立刻开抢');
      } else {
        log(`今天 ${state.atTime} 已过去很久，改为立即轮询`);
      }
    }

    startedAt = Date.now();
    armed = true;      // 到这一步才允许兜底点确认框
    log('▶ 开始轮询抢课。');
    tick();
  }

  function stop(finished) {
    polling = false;
    armed = false;
    state.running = false;
    saveState(state);
    if (timer) { clearTimeout(timer); timer = null; }
    if (!finished) setStatus(`已停止 · 共扫描 ${polls} 次`);
    log('已停止');
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => stop(false));

  // 页面刷新后自动续跑
  if (state.running) {
    log('检测到上次未完成的任务，自动续跑');
    setTimeout(start, 1200);
  }
})();
