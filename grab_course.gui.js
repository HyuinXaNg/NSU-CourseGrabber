// ==UserScript==
// @name         成都东软学院 体育项目 抢课助手 GUI
// @namespace    dnui-grab-course
// @version      3.0.0
// @description  可视化抢课界面：手动点击「开始抢课」运行，结束后显著显示是否抢到（成功/失败及原因）。
// @author       you
// @match        https://xk.dnui.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ============================================================================
 * 这是什么
 * ----------------------------------------------------------------------------
 * 一个住在选课页面里的 GUI 窗口：
 *   1) 点「▶ 开始抢课」→ 脚本开始运行
 *   2) 运行结束后，顶部大状态条明确告诉你「✅ 抢课成功」还是「⛔ 未抢到 + 原因」
 *
 * 为什么不做成独立桌面程序：
 *   xk.dnui.edu.cn 只在校园内网解析，而且必须用你已登录的浏览器会话去点
 *   页面上的 DOM。独立程序既连不上，也拿不到你的登录态。
 *
 * 三种运行方式（任选其一，效果相同）：
 *   A. DevTools Snippets（零安装，推荐）
 *      F12 → Sources → Snippets → New snippet → 粘贴全文 → Ctrl+S
 *      以后右键该 snippet → Run（或 Ctrl+Enter）
 *   B. Tampermonkey：新建脚本 → 粘贴全文 → 保存
 *   C. 控制台：F12 → Console → 粘贴全文 → 回车（首次需先输 allow pasting）
 * ========================================================================== */
(() => {
  'use strict';

  const TAG = '%c[抢课]';
  const TAG_STYLE = 'color:#fff;background:#2d6cdf;padding:1px 5px;border-radius:3px';

  if (window.__GRAB_GUI__) {
    console.log(TAG, TAG_STYLE, '界面已存在，跳过重复注入。');
    return;
  }
  if (!document.body) {
    console.warn(TAG, TAG_STYLE, '页面还没准备好，请稍后重试。');
    return;
  }

  /* ======================== 配置与持久化 ======================== */

  const STORE_KEY = 'dnui_grab_gui_v3';

  const DEFAULTS = {
    keywords: '羽毛球',
    atTime: '',           // 留空 = 点按钮立即开抢；填 '13:00:00' = 准点开抢
    dryRun: false,
    intervalMs: 2000,
    jitterMs: 800,
    burstMs: 4000,
    burstIntervalMs: 500, // 别低于 300：教务服务器全校共用
    maxMinutes: 120,      // 最长跑多久自动停，0 = 不限
    beep: true,           // 成功时响一声
    collapsed: false,
  };

  const S = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
    catch (_) { return { ...DEFAULTS }; }
  })();
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) { /* ignore */ }
  };

  /* ======================== 文本特征定位 ======================== */

  const LABEL_RE = /\[(\d+)-([^\]\r\n]+)\]\[([^\]\r\n]+)\]([^\s\[\r\n|：:]{0,12})/;
  const RATIO_RE = /(?:已选容量|已选人数|已选)[:：]?\s*(\d+)\s*[/／]\s*(\d+)/;
  const LEFT_RE = /剩余(?:名额|容量)?[:：]?\s*(\d+)/;
  const CONFIRM_TEXTS = ['确定', '确认', '提交', '是', 'OK'];

  // 成功 / 失败判定：必须先看失败词。
  // 「选课未成功」里含有「成功」，只做正向匹配会误判为抢课成功。
  const FAIL_RE = /未成功|不成功|失败|错误|异常|已满|满员|已选过|请勿重复|不可选|已截止|未开始/;
  const OK_RE = /选课成功|已选上|成功/;
  const isOkMsg = (m) => OK_RE.test(m) && !FAIL_RE.test(m);

  const DIALOG_SEL = '.layui-layer,.layui-layer-page,.layui-layer-btn,.el-dialog,.el-message-box,'
    + '.ant-modal,.van-dialog,[role="dialog"],dialog,.modal,.popup';
  const inDialog = (el) => !!(el && el.closest && el.closest(DIALOG_SEL));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function textOf(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT') return (el.value || '').trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = `${el.className || ''} ${(el.parentElement && el.parentElement.className) || ''}`;
    if (/(^|[\s_-])(disabled|is-disabled|btn-disabled|layui-btn-disabled|ant-btn-disabled|van-button--disabled)($|[\s_-])/i.test(cls)) return true;
    try {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function findByText(root, texts, exact = true) {
    const wanted = texts.map((t) => t.trim()).filter(Boolean);
    if (!wanted.length) return [];
    const out = [];
    for (const el of root.querySelectorAll('button, a, span, div, input, li, i, em, b, strong, p, label')) {
      const t = textOf(el);
      if (!t || t.length > 24) continue;
      const hit = exact ? wanted.includes(t) : wanted.some((w) => t.includes(w));
      if (!hit) continue;
      const childHit = [...el.children].some((c) => {
        const ct = textOf(c);
        return exact ? wanted.includes(ct) : wanted.some((w) => ct.includes(w));
      });
      if (childHit) continue;
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
    const info = {
      index: m[1], course: m[2], teacherId: m[3], teacher: (m[4] || '').trim(),
      used: null, cap: null, left: null, free: null,
    };
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
    const kws = S.keywords.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!kws.length) return [];
    const cards = [];
    const seen = new Set();
    for (const btn of findByText(document, ['选择'])) {
      const card = cardOf(btn);
      if (!card || seen.has(card)) continue;
      const info = parseCard(card);
      if (!info) continue;
      if (!kws.some((kw) => info.course.includes(kw))) continue;
      seen.add(card);
      cards.push({ info, card, btn, disabled: isDisabled(btn) });
    }
    return cards;
  }

  function readToasts() {
    const sel = '.layui-layer-msg,.layui-layer-content,.el-message,.ant-message-notice,'
      + '.van-toast,.toast,.message,.tips,.alert,.el-notification';
    return [...document.querySelectorAll(sel)].map(textOf).filter(Boolean);
  }

  /** 真实点击。click 交给 el.click()，不能再 dispatch 一次 click，否则每次点两下。 */
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

  /* ======================== 状态 ======================== */

  let polling = false;
  let armed = false;
  let timer = null;
  let confirmTimer = null;
  let destroyed = false;
  let busy = false;
  let polls = 0;
  let startedAt = 0;
  let burstUntil = 0;
  let lastPickAt = 0;
  let clockOffsetMs = 0;

  // 结果统计，用于「运行结束后告诉你为什么没抢到」
  const stats = { picks: 0, sawFree: 0, sawFull: 0, noCard: 0, lastServerMsg: '' };

  // 结果状态机
  const R = { IDLE: 'idle', WAIT: 'wait', RUN: 'run', OK: 'ok', FAIL: 'fail' };
  let result = { state: R.IDLE, course: '', teacher: '', detail: '', at: 0 };

  const now = () => Date.now() + clockOffsetMs;

  /* ======================== 工具 ======================== */

  const el = (tag, style, props) => {
    const n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (props) Object.assign(n, props);
    return n;
  };

  const hhmmss = (t) => {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  function parseDeadline(at) {
    const m = String(at || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }

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

  /** 自动确认弹窗：只认弹窗容器内的键，或刚点过「选择」5 秒内的键 */
  function autoConfirmOnce() {
    const recent = Date.now() - lastPickAt < 5000;
    for (const e of findByText(document, CONFIRM_TEXTS)) {
      if (isDisabled(e)) continue;
      if (!e.offsetParent && e.tagName !== 'BODY') continue;
      if (!recent && !inDialog(e)) continue;
      log(`自动确认 → 「${textOf(e)}」`);
      realClick(e);
      return true;
    }
    return false;
  }

  /* ======================== 抢课动作 ======================== */

  /** 对一张卡片执行一次抢课，返回 'ok' | 'full' | 'disabled' | 'skipped' | 'unknown' */
  async function grabCard(card) {
    if (!card || card.disabled) return 'disabled';
    if (card.info.free === false) return 'full';
    if (S.dryRun) {
      log(`[演练] 本应点击「选择」：${card.info.course} / ${card.info.teacher}`);
      return 'skipped';
    }

    const label = `${card.info.course} / ${card.info.teacher}`;
    log(`🎯 点击「选择」：${label}`);
    const before = readToasts().join('|');
    lastPickAt = Date.now();
    stats.picks++;
    realClick(card.btn);

    for (let waited = 0; waited < 2000; waited += 200) {
      await sleep(200);
      try { autoConfirmOnce(); } catch (_) { /* ignore */ }

      for (const m of readToasts().filter((x) => x && !before.includes(x))) {
        if (isOkMsg(m)) {
          // ---- 成功 ----
          log(`✅ 抢课成功！${label} —— 服务器返回：${m}`);
          setResult(R.OK, {
            course: card.info.course, teacher: card.info.teacher,
            detail: `服务器返回：${m}`, at: Date.now(),
          });
          notify();
          stop();
          return 'ok';
        }
        log(`服务器返回：${m}`);
        stats.lastServerMsg = m;
        renderLog();
      }
    }
    return 'unknown';
  }

  /** 扫描一轮，只抢第一门有空位的课（多教学班时不会一次选上多门） */
  async function tryOnce(auto) {
    if (busy) return null;
    busy = true;
    let cards = [];
    try {
      cards = scan();
      renderList(cards);

      if (!cards.length) {
        stats.noCard++;
        if (auto) log('未找到目标课程卡片');
      } else {
        const targets = cards.filter((c) => c.info.free !== false && !c.disabled);
        if (!targets.length) {
          stats.sawFull++;
          if (auto) log('本轮无空位，继续等待…');
        } else {
          stats.sawFree++;
          await grabCard(targets[0]);
          if (targets.length > 1 && auto) {
            log(`   （另有 ${targets.length - 1} 门也有空位，本轮不点）`);
          }
        }
      }
    } catch (e) {
      log('本轮出错（已跳过，继续）：' + e.message);
    } finally {
      busy = false;
    }
    return cards;
  }

  /* ======================== 主循环 ======================== */

  const nextDelay = () => (Date.now() < burstUntil
    ? S.burstIntervalMs
    : S.intervalMs + Math.random() * S.jitterMs);

  async function tick() {
    if (!polling) return;

    // 时长上限：避免无人值守时一直轮询全校共用的教务服务器
    if (S.maxMinutes > 0 && Date.now() - startedAt > S.maxMinutes * 60000) {
      log(`已达最长运行时间 ${S.maxMinutes} 分钟，自动停止。`);
      return stop();
    }

    polls++;
    if (result.state === R.RUN && Date.now() >= burstUntil) {
      setResult(R.RUN, { detail: `第 ${polls} 次扫描…` });
    }
    await tryOnce(true);

    if (polling) timer = setTimeout(tick, nextDelay());
  }

  /** 点「开始抢课」后执行 */
  async function start() {
    if (polling) { log('已在运行中。'); return; }

    polling = true;
    armed = false;
    busy = false;
    polls = 0;
    stats.picks = 0; stats.sawFree = 0; stats.sawFull = 0; stats.noCard = 0; stats.lastServerMsg = '';
    result = { state: R.WAIT, course: '', teacher: '', detail: '', at: 0 };
    renderResult();

    if (!window.__GRAB_CONFIRM_PATCHED__) {
      window.__GRAB_CONFIRM_PATCHED__ = true;
      window.confirm = (msg) => { log(`拦截原生 confirm：${msg} → 确定`); return true; };
    }
    if (!confirmTimer) {
      // 兜底点确认框：必须等 armed（待命结束）才生效，
      // 否则准点待命期间会误点页面上无关的「确定」按钮。
      confirmTimer = setInterval(() => {
        if (!armed || !polling || S.dryRun || destroyed) return;
        try { autoConfirmOnce(); } catch (_) { /* ignore */ }
      }, 600);
    }

    log('▶ 开始抢课');

    // ---- 准点待命 ----
    const deadline = parseDeadline(S.atTime);
    if (deadline !== null) {
      const off = await syncServerClock();
      if (!polling || destroyed) return;
      log(off === null
        ? '未能校准服务器时钟，按本机时间计时'
        : `时钟已对齐服务器（本机${off >= 0 ? '慢' : '快'} ${Math.abs(off / 1000).toFixed(2)}s）`);

      const remain = deadline - now();
      if (remain > 0) {
        setResult(R.WAIT, { detail: `${S.atTime} 准点开抢，还有 ${(remain / 1000).toFixed(0)}s` });
        log(`⏳ 待命：${S.atTime} 准点开抢（还有 ${(remain / 1000).toFixed(1)}s），期间不发请求`);
        const ok = await waitUntilDeadline(deadline);
        if (!ok) return;
        burstUntil = Date.now() + S.burstMs;
        log(`⏰ 到点！爆发期 ${S.burstMs}ms`);
      } else if (now() - deadline < 90000) {
        burstUntil = Date.now() + S.burstMs;
        log('已过点，立刻开抢');
      } else {
        log(`今天 ${S.atTime} 已过去很久，改为立即开抢`);
      }
    }

    startedAt = Date.now();
    armed = true;
    setResult(R.RUN, { detail: '正在扫描并抢课…' });
    tick();
  }

  async function waitUntilDeadline(deadline) {
    while (polling && !destroyed) {
      const remain = deadline - now();
      if (remain <= 0) return true;
      if (remain > 300) {
        setResult(R.WAIT, { detail: `${S.atTime} 准点开抢，还有 ${(remain / 1000).toFixed(0)}s` });
        await sleep(Math.min(remain - 200, 500));
      } else if (remain > 60) {
        await sleep(20);
      } else {
        await sleep(5);
      }
    }
    return false;
  }

  /** 停止。若尚未成功，则结算成「未抢到 + 原因」——这就是"运行结束显示是否成功" */
  function stop() {
    const wasRunning = polling;
    polling = false;
    armed = false;
    if (timer) { clearTimeout(timer); timer = null; }

    if (result.state !== R.OK) {
      let why;
      if (stats.sawFree === 0 && stats.sawFull > 0) {
        why = '目标课程已满员（一直没等到空位）';
      } else if (stats.sawFree === 0 && stats.noCard > 0) {
        why = `页面上找不到含「${S.keywords}」的课程，请确认已切到「体育项目」标签`;
      } else if (stats.lastServerMsg) {
        why = `服务器返回：${stats.lastServerMsg}`;
      } else if (stats.picks > 0) {
        why = `点过 ${stats.picks} 次「选择」，但始终没有成功反馈（可能未到开放时间或被限流）`;
      } else {
        why = '未执行任何点击';
      }
      setResult(R.FAIL, { detail: why, at: Date.now() });
    }

    if (wasRunning) log('⏹ 已停止');
    renderResult();
  }

  /* ======================== 结果提示 ======================== */

  let originalTitle = document.title;

  /** 成功后响一声 + 改标签页标题，方便你没盯着屏幕时也能知道 */
  function notify() {
    if (S.beep) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = 880;
          gain.gain.value = 0.12;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.3);
          setTimeout(() => { try { ctx.close(); } catch (_) { /* ignore */ } }, 800);
        }
      } catch (_) { /* 静音失败无所谓 */ }
    }
    try { document.title = '✅ 抢课成功 - ' + originalTitle; } catch (_) { /* ignore */ }
  }

  /* ======================== 界面 ======================== */

  const C = {
    w: 320, bd: '#d9e1ec', fg: '#1f2d3d', sub: '#5a6b80',
    accent: '#2d6cdf', ok: '#0f9d58', fail: '#d93025', wait: '#e37400',
  };

  const panel = el('div', [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647', `width:${C.w}px`,
    'background:#fff', `border:1px solid ${C.bd}`, 'border-radius:10px',
    'box-shadow:0 8px 28px rgba(20,40,80,.22)',
    'font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif', `color:${C.fg}`,
    'user-select:none', 'overflow:hidden',
  ].join(';'));
  panel.id = '__grab_gui';

  const head = el('div', [
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'padding:8px 10px', 'cursor:move', 'background:#f5f8fc', `border-bottom:1px solid ${C.bd}`,
  ].join(';'));
  const title = el('b', 'font-size:12px', { textContent: '🏸 抢课助手' });
  const collapseBtn = el('span', `cursor:pointer;color:${C.sub};font-size:15px;line-height:1;padding:0 3px`, { textContent: '–' });
  head.append(title, collapseBtn);

  const body = el('div', 'padding:10px');

  /* ---- ① 结果状态条（最显眼的位置）---- */
  const resultBox = el('div', [
    'padding:10px', 'border-radius:8px', 'text-align:center',
    'background:#f0f3f8', 'border:1px solid #dde4ee', 'margin-bottom:10px',
  ].join(';'));
  resultBox.id = '__grab_result';
  const resultMain = el('div', 'font:700 15px/1.4 inherit', { textContent: '⏳ 未开始' });
  // white-space:pre-line 必须加，否则 detail 里的 \n 不会换行
  const resultSub = el('div', `font-size:11px;color:${C.sub};margin-top:3px;white-space:pre-line`, { textContent: '点下面的按钮开始' });
  resultBox.append(resultMain, resultSub);

  /* ---- ② 输入区 ---- */
  const inputStyle = `width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid ${C.bd};`
    + 'border-radius:6px;font:12px/1.5 inherit;outline:none;background:#fff;color:inherit';
  const label = (t) => el('div', `color:${C.sub};margin:7px 0 3px;font-size:11px`, { textContent: t });

  const kwInput = el('input', inputStyle, { value: S.keywords, placeholder: '羽毛球（逗号分隔可多个）' });
  const atInput = el('input', inputStyle, { value: S.atTime, placeholder: '留空 = 点按钮立即抢；或填 13:00:00' });

  const dryWrap = el('label', `display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;color:${C.sub}`);
  const dryBox = el('input', '', { type: 'checkbox', checked: !!S.dryRun });
  dryWrap.append(dryBox, document.createTextNode('演练模式（只识别不点击）'));

  /* ---- ③ 按钮：大的「开始抢课」---- */
  const startBtn = el('button', [
    'display:block', 'width:100%', 'margin-top:10px', 'padding:11px 0',
    `border:0`, 'border-radius:8px', `background:${C.accent}`, 'color:#fff',
    'font:700 15px/1.2 inherit', 'cursor:pointer',
  ].join(';'), { textContent: '▶ 开始抢课' });
  startBtn.id = '__grab_start';

  const subRow = el('div', 'display:flex;gap:6px;margin-top:7px');
  const stopBtn = el('button', [
    'flex:1', 'padding:6px 0', `border:1px solid ${C.bd}`, 'border-radius:6px',
    'background:#fff', `color:${C.fg}`, 'font:600 12px/1.5 inherit', 'cursor:pointer',
  ].join(';'), { textContent: '■ 停止' });
  const onceBtn = el('button', [
    'flex:1', 'padding:6px 0', 'border:1px solid #c7dbff', 'border-radius:6px',
    'background:#eef4ff', `color:${C.accent}`, 'font:600 12px/1.5 inherit', 'cursor:pointer',
  ].join(';'), { textContent: '⚡ 抢一次' });
  subRow.append(stopBtn, onceBtn);

  /* ---- ④ 课程列表 ---- */
  const listTitle = el('div', `color:${C.sub};margin:10px 0 4px;font-size:11px`, { textContent: '识别到的课程（0）' });
  listTitle.id = '__grab_list_title';
  const listBox = el('div', `max-height:120px;overflow-y:auto;border:1px solid ${C.bd};border-radius:6px;background:#fff`);
  listBox.id = '__grab_list';

  /* ---- ⑤ 日志 ---- */
  const logBox = el('div', [
    'margin-top:8px', 'max-height:96px', 'overflow-y:auto', 'padding:5px 7px',
    'background:#1f2d3d', 'border-radius:6px', 'color:#c8d6e5',
    'font:11px/1.5 Consolas,Menlo,monospace', 'white-space:pre-wrap', 'word-break:break-all',
    'user-select:text',
  ].join(';'));

  body.append(
    resultBox,
    label('课程关键词'), kwInput,
    label('准点开抢'), atInput,
    dryWrap,
    startBtn, subRow,
    listTitle, listBox, logBox,
  );
  panel.append(head, body);
  document.body.appendChild(panel);

  /* ---- 结果渲染 ---- */
  function setResult(state, opt) {
    result = {
      state,
      course: (opt && opt.course) || result.course,
      teacher: (opt && opt.teacher) || result.teacher,
      detail: (opt && opt.detail) || '',
      at: (opt && opt.at) || result.at,
    };
    renderResult();
  }

  function renderResult() {
    const set = (main, sub, bg, bd, color) => {
      resultMain.textContent = main;
      resultMain.style.color = color;
      resultSub.textContent = sub;
      resultSub.style.color = color;
      resultBox.style.background = bg;
      resultBox.style.borderColor = bd;
    };
    switch (result.state) {
      case R.OK:
        set('✅ 抢课成功', `${result.course} / ${result.teacher}\n${result.detail}`
          + (result.at ? `（${hhmmss(result.at)}）` : ''), '#e8f6ee', '#a8dcc0', C.ok);
        break;
      case R.FAIL:
        set('⛔ 未抢到', result.detail + (result.at ? `\n结束于 ${hhmmss(result.at)}` : ''),
          '#fdecea', '#f5b5ae', C.fail);
        break;
      case R.RUN:
        set('🔄 抢课中…', result.detail || '正在扫描并抢课…', '#eef4ff', '#c7dbff', C.accent);
        break;
      case R.WAIT:
        set('⏳ 待命中', result.detail || '等待到点', '#fff6e5', '#ffd699', C.wait);
        break;
      default:
        set('⏳ 未开始', '点下面的按钮开始', '#f0f3f8', '#dde4ee', C.sub);
    }
  }

  /* ---- 日志 ---- */
  const logs = [];
  function log(msg) {
    logs.push(`${hhmmss(Date.now())} ${msg}`);
    while (logs.length > 200) logs.shift();
    renderLog();
    console.log(TAG, TAG_STYLE, msg);
  }
  function renderLog() {
    logBox.textContent = logs.slice(-10).join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }

  /* ---- 课程列表 ---- */
  const miniBtnStyle = `padding:2px 9px;border:1px solid #c7dbff;border-radius:5px;background:#eef4ff;`
    + `color:${C.accent};font:600 11px/1.6 inherit;cursor:pointer;white-space:nowrap`;

  function renderList(cards) {
    listTitle.textContent = `识别到的课程（${cards.length}）`;
    listBox.textContent = '';
    if (!cards.length) {
      listBox.append(el('div', 'padding:8px;color:#9aa7b8;font-size:11px;white-space:pre-wrap', {
        textContent: `没有找到含「${S.keywords}」的课程卡片。\n请确认已切到「体育项目」标签页。`,
      }));
      return;
    }
    for (const c of cards) {
      const i = c.info;
      const flag = i.free === true ? '✅' : i.free === false ? '⛔' : '❓';
      const row = el('div', 'display:flex;align-items:center;gap:6px;padding:5px 7px;border-bottom:1px solid #eef2f7');
      const text = el('div', 'flex:1;min-width:0;font-size:11px;line-height:1.4');
      text.append(
        el('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          { textContent: `[${i.index}] ${i.course}` }),
        el('div', `color:${C.sub};font-size:10px`,
          { textContent: `${i.teacher || '—'} · ${i.used !== null ? `${i.used}/${i.cap}` : '容量?'} ${flag}${c.disabled ? ' · 按钮禁用' : ''}` }),
      );
      const grabBtn = el('button', miniBtnStyle, { textContent: '抢这门' });
      grabBtn.dataset.role = 'grab';
      grabBtn.addEventListener('click', async () => {
        grabBtn.disabled = true;
        grabBtn.textContent = '…';
        try {
          const fresh = scan().find((x) => x.info.index === i.index && x.info.course === i.course);
          if (!fresh) { log('该课程已不在页面上'); return; }
          const r = await grabCard(fresh);
          if (r === 'full') { log('该课程已满员'); setResult(R.FAIL, { detail: `${i.course} 已满员`, at: Date.now() }); }
          if (r === 'disabled') { log('该课程的「选择」按钮当前不可用'); setResult(R.FAIL, { detail: `${i.course} 的「选择」按钮不可用`, at: Date.now() }); }
        } finally {
          grabBtn.disabled = false;
          grabBtn.textContent = '抢这门';
        }
      });
      row.append(text, grabBtn);
      listBox.append(row);
    }
  }

  /* ---- 拖动 ---- */
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target === collapseBtn) return;
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { head.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, e.clientX - drag.dx));
    const top = Math.max(0, Math.min(window.innerHeight - h, e.clientY - drag.dy));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { head.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  /* ---- 折叠 ---- */
  function applyCollapsed() {
    body.style.display = S.collapsed ? 'none' : '';
    collapseBtn.textContent = S.collapsed ? '+' : '–';
  }
  collapseBtn.addEventListener('click', () => {
    S.collapsed = !S.collapsed;
    save();
    applyCollapsed();
  });
  applyCollapsed();

  /* ---- 输入绑定 ---- */
  kwInput.addEventListener('change', () => {
    S.keywords = kwInput.value.trim() || DEFAULTS.keywords;
    kwInput.value = S.keywords;
    save();
    log(`关键词已设为「${S.keywords}」`);
    renderList(scan());
  });
  atInput.addEventListener('change', () => {
    S.atTime = atInput.value.trim();
    save();
    log(S.atTime ? `准点时间已设为 ${S.atTime}` : '准点时间已清空（点按钮立即抢）');
  });
  dryBox.addEventListener('change', () => {
    S.dryRun = dryBox.checked;
    save();
    log(S.dryRun ? '已开启演练模式' : '已关闭演练模式');
  });

  /* ---- 按钮绑定：这就是「手动点击开始抢课」---- */
  startBtn.addEventListener('click', () => { start(); });
  stopBtn.addEventListener('click', () => { stop(); });
  onceBtn.addEventListener('click', async () => {
    if (busy) { log('上一轮还在进行中，请稍候'); return; }
    log('⚡ 抢一次');
    setResult(R.RUN, { detail: '手动扫描一次…' });
    stats.sawFree = 0; stats.sawFull = 0; stats.noCard = 0; stats.picks = 0; stats.lastServerMsg = '';
    await tryOnce(false);
    if (result.state !== R.OK) stop();
  });

  const onKeydown = (e) => {
    if (e.key === 'Escape' && polling) { log('Esc：停止'); stop(); }
  };
  document.addEventListener('keydown', onKeydown);

  /* ---- 对外 API ---- */
  window.__GRAB_GUI__ = {
    scan, start, stop,
    result: () => ({ ...result }),
    settings: S,
    grab: (index) => {
      const c = scan().find((x) => x.info.index === String(index));
      return c ? grabCard(c) : Promise.resolve(null);
    },
    dump: () => {
      const cards = scan();
      console.log(TAG, TAG_STYLE, `dump：识别到 ${cards.length} 个目标卡片`);
      cards.forEach((c, i) => console.log(`#${i}`, { ...c.info, buttonText: textOf(c.btn) }, c.card));
      if (!cards.length) {
        console.log(TAG, TAG_STYLE, '没识别到。下面是页面上所有「选择」按钮及其卡片文本：');
        findByText(document, ['选择']).forEach((btn, i) => {
          const card = cardOf(btn);
          console.log(`#${i}`, { button: textOf(btn), cardText: card ? (card.textContent || '').slice(0, 160) : '(未找到所属卡片)' }, btn);
        });
      }
      return cards;
    },
    destroy: () => {
      destroyed = true;
      stop();
      if (confirmTimer) { clearInterval(confirmTimer); confirmTimer = null; }
      // 三件事缺一不可：清掉已排队的刷新定时器、断开观察器、摘掉键盘监听。
      // 否则面板移除后它们还在跑，且 panel.contains() 恒为 false，
      // 页面上任何变动都会触发一次 renderList。
      try { if (mo) { clearTimeout(mo._t); mo.disconnect(); } } catch (_) { /* ignore */ }
      document.removeEventListener('keydown', onKeydown);
      try { document.title = originalTitle; } catch (_) { /* ignore */ }
      panel.remove();
      delete window.__GRAB_GUI__;
    },
  };

  /* ---- 启动 ---- */
  renderResult();
  const initial = scan();
  renderList(initial);
  log('界面就绪。关键词：' + S.keywords + (S.atTime ? `，准点 ${S.atTime}` : '，点按钮立即抢'));
  if (!initial.length) log('当前没识别到目标课程 —— 请确认已切到「体育项目」标签页');

  // 页面结构变化时自动刷新列表
  let mo = null;
  try {
    mo = new MutationObserver((muts) => {
      if (destroyed || busy) return;
      // 必须忽略面板自身引起的 DOM 变化，否则 renderList -> 触发 observer -> 死循环
      if (muts.every((m) => panel.contains(m.target))) return;
      clearTimeout(mo._t);
      mo._t = setTimeout(() => {
        if (destroyed) return;
        try { renderList(scan()); } catch (_) { /* ignore */ }
      }, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (_) { /* ignore */ }
})();
