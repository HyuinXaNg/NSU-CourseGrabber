// ==UserScript==
// @name         成都东软学院 体育项目 抢课助手（面板版）
// @namespace    dnui-grab-course
// @version      2.0.0
// @description  选课页面浮动控制面板：列出目标课程与余量，可单门手动抢，也可准点自动抢。带日志窗、可拖拽。
// @author       you
// @match        https://xk.dnui.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ============================================================================
 * 三种手动运行方式（任选一种，效果相同）：
 *
 *  A. 开发者工具 Snippets（零安装，推荐日常用）
 *     1) 打开选课页 → F12 → Sources → Snippets → New snippet
 *     2) 粘贴本文件全文 → Ctrl+S 保存
 *     3) 以后每次只要右键该 snippet → Run（或 Ctrl+Enter）
 *
 *  B. Tampermonkey
 *     装好扩展 → 新建脚本 → 粘贴全文 → 保存，页面右上角自动出现面板
 *
 *  C. 控制台直接粘贴
 *     F12 → Console → 粘贴全文 → 回车（首次需先输入 allow pasting）
 *
 * 注意：本文件顶部虽是 UserScript 头，但它只是注释，控制台粘贴同样能跑。
 * ========================================================================== */
(() => {
  'use strict';

  const TAG = '%c[抢课]';
  const TAG_STYLE = 'color:#fff;background:#2d6cdf;padding:1px 5px;border-radius:3px';

  // 重复注入保护：Snippets 手滑点两次、或油猴 + 粘贴同时命中时，只保留第一个面板
  if (window.__GRAB_UI__) {
    console.log(TAG, TAG_STYLE, '面板已存在，跳过重复注入。');
    return;
  }

  if (!document.body) {
    console.warn(TAG, TAG_STYLE, '页面还没准备好（document.body 不存在），请稍后重试。');
    return;
  }

  /* ======================== 配置与持久化 ======================== */

  const STORE_KEY = 'dnui_grab_ui_v2';

  const DEFAULTS = {
    keywords: '羽毛球',
    atTime: '',          // 留空 = 立即开抢；填 '13:00:00' = 准点开抢
    dryRun: false,       // 演练模式：只识别不点击
    intervalMs: 2000,    // 常态轮询间隔
    jitterMs: 800,
    burstMs: 4000,       // 到点后爆发期时长
    burstIntervalMs: 500,// 爆发期重试间隔（别低于 300）
    maxMinutes: 120,     // 自动跑多久后停，0 = 不限
    collapsed: false,
    pos: null,           // { left, top }
  };

  const S = (() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  })();

  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) { /* ignore */ }
  };

  /* ======================== 文本特征定位 ======================== */

  // 卡片标题特征：[083-羽毛球][T9000001]李老师
  const LABEL_RE = /\[(\d+)-([^\]\r\n]+)\]\[([^\]\r\n]+)\]([^\s\[\r\n|：:]{0,12})/;
  // 容量：已选容量：0/67  或  已选：0/67
  const RATIO_RE = /(?:已选容量|已选人数|已选)[:：]?\s*(\d+)\s*[/／]\s*(\d+)/;
  // 剩余名额：5
  const LEFT_RE = /剩余(?:名额|容量)?[:：]?\s*(\d+)/;

  /* 成功 / 失败判定。
   * 必须"先看有没有失败词"，不能只做正向匹配 ——
   * 「选课未成功」里含有「成功」，只正向匹配会把它误判为抢课成功，
   * 脚本随即停止并报告成功，用户以为抢到了、不再重试，实际什么都没选上。 */
  const FAIL_RE = /未成功|不成功|失败|错误|异常|已满|满员|已选过|请勿重复|不可选|已截止|未开始/;
  const OK_RE = /选课成功|已选上|成功/;
  const isOkMsg = (m) => OK_RE.test(m) && !FAIL_RE.test(m);
  // 自动确认的按钮文案
  const CONFIRM_TEXTS = ['确定', '确认', '提交', '是', 'OK'];

  // 常见弹窗容器（layui / Element / Ant / Vant / 原生 dialog）
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
    if (/(^|[\s_-])(disabled|is-disabled|btn-disabled|layui-btn-disabled|ant-btn-disabled|van-button--disabled)($|[\s_-])/i.test(cls)) {
      return true;
    }
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

  /** 扫描页面，返回所有命中的目标课程卡片 */
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

  /**
   * 真实点击。
   * 只 dispatch pointer/mouse 的 down/up，click 交给 el.click() —— 否则每次点击
   * 会触发两个 click 事件，可能被选课系统判定为「重复提交」。
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

  /* ======================== 引擎状态 ======================== */

  let polling = false;
  let armed = false;        // 待命结束、真正开始抢课之后才允许兜底点确认框
  let stopped = true;
  let timer = null;
  let confirmTimer = null;
  let polls = 0;
  let startedAt = 0;
  let burstUntil = 0;
  let lastPickAt = 0;       // 上次点「选择」的时刻
  let clockOffsetMs = 0;    // 服务器时间 - 本机时间
  let busy = false;         // 防止 attempt 重入
  let destroyed = false;    // 面板已拆除：任何异步回调都要立即放弃

  const now = () => Date.now() + clockOffsetMs;

  /* ======================== 各种小工具 ======================== */

  const el = (tag, style, props) => {
    const n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (props) Object.assign(n, props);
    return n;
  };

  function parseDeadline(at) {
    const m = String(at || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }

  /** 用同源 HEAD 请求的 Date 响应头校准本机时钟 */
  async function syncServerClock() {
    const t0 = Date.now();
    try {
      const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
      const d = new Date(res.headers.get('date') || '');
      if (isNaN(d.getTime())) return null;
      clockOffsetMs = d.getTime() + (Date.now() - t0) / 2 - Date.now();
      return clockOffsetMs;
    } catch (_) {
      return null;
    }
  }

  async function waitUntilDeadline(deadline) {
    while (polling) {
      const remain = deadline - now();
      if (remain <= 0) return true;
      if (remain > 300) {
        setStatus(`⏳ 待命中 · ${S.atTime} 还有 ${(remain / 1000).toFixed(1)}s`);
        await sleep(Math.min(remain - 200, 500));
      } else if (remain > 60) {
        await sleep(20);
      } else {
        await sleep(5);
      }
    }
    return false;
  }

  /**
   * 自动点掉确认弹窗。
   * 安全约束：只认两类按钮，避免把页面上无关的「确定」乱点
   * （选课页可能有筛选弹窗、协议弹窗，甚至退课确认键）：
   *   a) 位于弹窗容器内的确认键 —— 任何时候都认
   *   b) 刚点过「选择」的 5 秒内 —— 覆盖弹窗结构识别不出来的情况
   */
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

  /** 对一张卡片执行一次抢课，返回 'ok' | 'full' | 'disabled' | 'unknown' | 'skipped' */
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
    realClick(card.btn);

    // 弹窗/提示异步出现，轮询观察最多 2 秒
    for (let waited = 0; waited < 2000; waited += 200) {
      await sleep(200);
      try { autoConfirmOnce(); } catch (e) { log('自动确认出错：' + e.message); }

      const fresh = readToasts().filter((m) => m && !before.includes(m));
      for (const m of fresh) {
        if (isOkMsg(m)) {
          log(`✅ 选课成功！${label} —— 服务器返回：${m}`);
          setStatus(`✅ 选课成功\n${label}\n${m}`);
          stop();
          return 'ok';
        }
        log(`服务器返回：${m}`);
      }
    }
    return 'unknown';
  }

  /** 扫描一轮，并对所有有空位的目标课程尝试抢课；返回本轮识别到的卡片 */
  async function tryOnce(auto) {
    if (busy) return null;
    busy = true;
    let cards = [];
    try {
      cards = scan();
      renderList(cards, auto);
      const targets = cards.filter((c) => c.info.free !== false && !c.disabled);
      if (!targets.length) {
        if (auto) log(cards.length ? '本轮无空位，继续等待…' : '未找到目标课程卡片');
      } else {
        // 每轮只抢第一门有空位的课。
        // 页面上同一门课常有多个教学班（羽毛球就可能有 083/084…），
        // 全部点一遍会一次选上多门体育课 —— 轻则被教务系统拒绝，
        // 重则真的都选上了、还得手动退课。
        // 想指定某一门，用列表里对应行的「手动抢」。
        await grabCard(targets[0]);
        if (targets.length > 1 && auto) {
          log(`   （另有 ${targets.length - 1} 门也显示有空位，本轮不点；要指定请点列表里那行的「手动抢」）`);
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

    if (S.maxMinutes > 0 && Date.now() - startedAt > S.maxMinutes * 60000) {
      log(`已达最长运行时间 ${S.maxMinutes} 分钟，自动停止。`);
      return stop();
    }

    polls++;
    await tryOnce(true);

    if (polling) {
      if (Date.now() >= burstUntil && armed) setStatus(`🔄 轮询中 · 第 ${polls} 次`);
      timer = setTimeout(tick, nextDelay());
    }
  }

  async function start() {
    if (polling) { log('已在运行中。'); return; }
    polling = true;
    stopped = false;
    armed = false;
    polls = 0;
    save();

    if (!window.__GRAB_CONFIRM_PATCHED__) {
      window.__GRAB_CONFIRM_PATCHED__ = true;
      window.confirm = (msg) => { log(`拦截原生 confirm：${msg} → 确定`); return true; };
    }
    if (!confirmTimer) {
      // 兜底点确认框：必须等 armed（待命结束）才生效，
      // 否则准点待命期间会误点页面上无关的「确定」按钮。
      confirmTimer = setInterval(() => {
        if (!armed || !polling || S.dryRun) return;
        try { autoConfirmOnce(); } catch (_) { /* ignore */ }
      }, 600);
    }

    const deadline = parseDeadline(S.atTime);
    if (deadline !== null) {
      const off = await syncServerClock();
      if (!polling) return;
      log(off === null
        ? '未能校准服务器时钟，按本机时间计时'
        : `时钟已对齐服务器（本机${off >= 0 ? '慢' : '快'} ${Math.abs(off / 1000).toFixed(2)}s）`);

      const remain = deadline - now();
      if (remain > 0) {
        log(`⏳ 待命：${S.atTime} 准点开抢（还有 ${(remain / 1000).toFixed(1)}s），期间不发任何请求`);
        setStatus(`⏳ 待命中 · ${S.atTime}`);
        const ok = await waitUntilDeadline(deadline);
        if (!ok) return;
        burstUntil = Date.now() + S.burstMs;
        log(`⏰ 到点！爆发期 ${S.burstMs}ms（每 ${S.burstIntervalMs}ms 重试）`);
      } else if (now() - deadline < 90000) {
        burstUntil = Date.now() + S.burstMs;
        log('已过点，立刻开抢');
      } else {
        log(`今天 ${S.atTime} 已过去很久，改为立即开抢`);
      }
    }

    startedAt = Date.now();
    armed = true;
    setStatus('🔄 轮询中');
    log('▶ 开始');
    tick();
  }

  function stop() {
    if (stopped) return;
    polling = false;
    armed = false;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    setStatus(`⏹ 已停止 · 共扫描 ${polls} 次`);
    log('⏹ 已停止');
  }

  /* ======================== 界面 ======================== */

  const P = {
    width: 300,
    top: 16,
    right: 16,
    bg: '#fff',
    bd: '#d9e1ec',
    fg: '#1f2d3d',
    sub: '#5a6b80',
    accent: '#2d6cdf',
  };

  const panel = el('div', [
    'position:fixed', 'z-index:2147483647', `width:${P.width}px`,
    `background:${P.bg}`, `border:1px solid ${P.bd}`, 'border-radius:10px',
    'box-shadow:0 8px 28px rgba(20,40,80,.18)',
    'font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif', `color:${P.fg}`,
    'user-select:none', 'overflow:hidden',
  ].join(';'));
  panel.id = '__grab_panel';

  // 位置：优先用上次保存的，否则右上角
  if (S.pos && typeof S.pos.left === 'number') {
    panel.style.left = `${S.pos.left}px`;
    panel.style.top = `${S.pos.top}px`;
  } else {
    panel.style.right = `${P.right}px`;
    panel.style.top = `${P.top}px`;
  }

  const head = el('div', [
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'padding:8px 10px', 'cursor:move', 'background:#f5f8fc',
    `border-bottom:1px solid ${P.bd}`,
  ].join(';'));

  const title = el('b', 'font-size:12px', { textContent: '🏸 抢课助手' });
  const headBtns = el('div', 'display:flex;gap:6px;align-items:center');
  const collapseBtn = el('span', `cursor:pointer;color:${P.sub};font-size:15px;line-height:1;padding:0 2px`, { textContent: '–' });
  headBtns.append(collapseBtn);
  head.append(title, headBtns);

  const body = el('div', 'padding:10px');

  const inputStyle = `width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid ${P.bd};`
    + 'border-radius:6px;font:12px/1.5 inherit;outline:none;background:#fff;color:inherit';

  const label = (t) => el('div', `color:${P.sub};margin:8px 0 3px;font-size:11px`, { textContent: t });

  const kwInput = el('input', inputStyle, { value: S.keywords, placeholder: '羽毛球（逗号分隔可多个）' });
  const atInput = el('input', inputStyle, { value: S.atTime, placeholder: '留空=立即抢；如 13:00:00' });

  const dryWrap = el('label', 'display:flex;align-items:center;gap:6px;margin-top:9px;cursor:pointer;color:' + P.sub);
  const dryBox = el('input', '', { type: 'checkbox', checked: !!S.dryRun });
  dryWrap.append(dryBox, document.createTextNode('演练模式（只识别，不点击）'));

  const btnRow = el('div', 'display:flex;gap:6px;margin-top:10px');
  const mkBtn = (text, bg, fg, bd) => el('button', [
    'flex:1', 'padding:6px 0', `border:1px solid ${bd || 'transparent'}`, 'border-radius:6px',
    `background:${bg}`, `color:${fg}`, 'font:600 12px/1.5 inherit', 'cursor:pointer',
  ].join(';'), { textContent: text });

  const startBtn = mkBtn('▶ 开始', P.accent, '#fff');
  const stopBtn = mkBtn('■ 停止', '#fff', P.fg, P.bd);
  const onceBtn = mkBtn('⚡ 立即抢一次', '#eef4ff', P.accent, '#c7dbff');
  btnRow.append(startBtn, stopBtn);

  const onceRow = el('div', 'display:flex;margin-top:6px');
  onceBtn.style.flex = '1';
  onceRow.append(onceBtn);

  const statusBox = el('div', [
    'margin-top:9px', 'padding:6px 8px', 'background:#f5f8fc', 'border-radius:6px',
    `color:${P.sub}`, 'font-size:11px', 'min-height:28px',
  ].join(';'), { textContent: '未启动' });

  const listTitle = el('div', `color:${P.sub};margin:10px 0 4px;font-size:11px`, { textContent: '识别到的课程（0）' });
  const listBox = el('div', [
    'max-height:132px', 'overflow-y:auto', 'border:1px solid ' + P.bd, 'border-radius:6px',
    'background:#fff',
  ].join(';'));
  listBox.id = '__grab_list';
  listTitle.id = '__grab_list_title';

  const logBox = el('div', [
    'margin-top:8px', 'max-height:104px', 'overflow-y:auto', 'padding:5px 7px',
    'background:#1f2d3d', 'border-radius:6px', 'color:#c8d6e5',
    'font:11px/1.5 Consolas,Menlo,monospace', 'white-space:pre-wrap', 'word-break:break-all',
    'user-select:text',
  ].join(';'));

  body.append(
    label('课程关键词'), kwInput,
    label('准点开抢'), atInput,
    dryWrap, btnRow, onceRow, statusBox,
    listTitle, listBox, logBox,
  );
  panel.append(head, body);
  document.body.appendChild(panel);

  function setStatus(msg) { statusBox.textContent = msg; }

  /* ---- 日志 ---- */
  const logs = [];
  function log(msg) {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const line = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${msg}`;
    logs.push(line);
    while (logs.length > 200) logs.shift();
    logBox.textContent = logs.slice(-12).join('\n');
    logBox.scrollTop = logBox.scrollHeight;
    console.log(TAG, TAG_STYLE, msg);
  }

  /* ---- 课程列表 ---- */
  const rowStyle = 'display:flex;align-items:center;gap:6px;padding:5px 7px;border-bottom:1px solid #eef2f7';
  const miniBtnStyle = `padding:2px 9px;border:1px solid #c7dbff;border-radius:5px;background:#eef4ff;`
    + `color:${P.accent};font:600 11px/1.6 inherit;cursor:pointer;white-space:nowrap`;

  function renderList(cards, auto) {
    listTitle.textContent = `识别到的课程（${cards.length}）`;
    listBox.textContent = '';

    if (!cards.length) {
      const empty = el('div', 'padding:8px;color:#9aa7b8;font-size:11px;white-space:pre-wrap', {
        textContent: '没有找到含「' + S.keywords + '」的课程卡片。\n请确认已切到「体育项目」标签页；若课程在其它页，先翻页或先搜索过滤。',
      });
      listBox.append(empty);
      return;
    }

    for (const c of cards) {
      const i = c.info;
      const capText = i.used !== null ? `${i.used}/${i.cap}` : '容量?';
      const flag = i.free === true ? '✅' : i.free === false ? '⛔' : '❓';

      const row = el('div', rowStyle);
      const text = el('div', 'flex:1;min-width:0;font-size:11px;line-height:1.4');
      const name = el('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', {
        textContent: `[${i.index}] ${i.course}`,
      });
      const meta = el('div', `color:${P.sub};font-size:10px`, {
        textContent: `${i.teacher || '—'} · ${capText} ${flag}${c.disabled ? ' · 按钮禁用' : ''}`,
      });
      text.append(name, meta);

      const grabBtn = el('button', miniBtnStyle, { textContent: auto ? '手动抢' : '立即抢' });
      grabBtn.dataset.role = 'grab';
      grabBtn.addEventListener('click', async () => {
        grabBtn.disabled = true;
        grabBtn.textContent = '…';
        try {
          // 重新扫描定位，避免用到过期的 DOM 引用
          const fresh = scan().find((x) => x.info.index === i.index && x.info.course === i.course);
          if (!fresh) { log('该课程已不在页面上，可能已被选满或翻页了'); return; }
          const r = await grabCard(fresh);
          if (r === 'full') log('该课程已满员，无法选择');
          if (r === 'disabled') log('该课程的「选择」按钮当前不可用');
        } finally {
          grabBtn.disabled = false;
          grabBtn.textContent = auto ? '手动抢' : '立即抢';
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
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let left = e.clientX - drag.dx;
    let top = e.clientY - drag.dy;
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { head.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    S.pos = { left: panel.offsetLeft, top: panel.offsetTop };
    save();
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
    renderList(scan(), polling);
  });
  atInput.addEventListener('change', () => {
    S.atTime = atInput.value.trim();
    save();
    log(S.atTime ? `准点时间已设为 ${S.atTime}` : '准点时间已清空（立即开抢）');
  });
  dryBox.addEventListener('change', () => {
    S.dryRun = dryBox.checked;
    save();
    log(S.dryRun ? '已开启演练模式（不会真的点选）' : '已关闭演练模式');
  });

  startBtn.addEventListener('click', () => { start(); });
  stopBtn.addEventListener('click', () => { stop(); });

  onceBtn.addEventListener('click', async () => {
    if (busy) { log('上一轮还在进行中，请稍候'); return; }
    log('⚡ 手动抢一次');
    await tryOnce(false);
  });

  /* ---- 键盘：Esc 停止 ---- */
  const onKeydown = (e) => {
    if (e.key === 'Escape' && polling) { log('Esc：停止'); stop(); }
  };
  document.addEventListener('keydown', onKeydown);

  /* ---- 对外 API ---- */
  window.__GRAB_UI__ = {
    scan, start, stop,
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
          console.log(`#${i}`, {
            button: textOf(btn),
            cardText: card ? (card.textContent || '').slice(0, 160) : '(未找到所属卡片)',
          }, btn);
        });
      }
      return cards;
    },
    settings: S,
    status: () => ({
      phase: polling ? (armed ? '轮询中' : '准点待命中') : '已停止',
      polls, dryRun: S.dryRun, keywords: S.keywords, atTime: S.atTime,
      clockOffsetMs: Math.round(clockOffsetMs),
      serverNow: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }),
    }),
    destroy: () => {
      destroyed = true;
      stop();
      if (confirmTimer) { clearInterval(confirmTimer); confirmTimer = null; }
      // 三件事缺一不可：
      //  1) clearTimeout —— 注入面板时 body 变化已排了一个 400ms 后的 renderList，
      //     不清掉的话它会在 destroy 之后照跑一次（实测确实会，让列表"复活"）
      //  2) disconnect —— panel 已脱离文档，contains() 恒为 false，
      //     不解除则页面上任何变动都会重建列表，白烧 CPU 且引用无法回收
      //  3) 摘掉键盘监听
      try {
        if (mo) {
          clearTimeout(mo._t);
          mo.disconnect();
        }
      } catch (_) { /* ignore */ }
      document.removeEventListener('keydown', onKeydown);
      panel.remove();
      delete window.__GRAB_UI__;
    },
  };

  /* ---- 启动 ---- */
  const initial = scan();
  renderList(initial, false);
  log('面板就绪。关键词：' + S.keywords + (S.atTime ? `，准点 ${S.atTime}` : '，立即模式'));
  if (!initial.length) {
    log('当前没识别到目标课程卡片 —— 请确认已切到「体育项目」标签页');
  } else {
    for (const c of initial) {
      const cap = c.info.used !== null ? `${c.info.used}/${c.info.cap}` : '容量未识别';
      log(`  ${c.info.free === false ? '⛔ 已满' : '✅ 有空位'} [${c.info.index}] ${c.info.course} ${c.info.teacher} ${cap}`);
    }
  }

  // 页面结构变化时自动刷新列表（选课系统常异步渲染）
  let mo = null;
  try {
    mo = new MutationObserver((muts) => {
      if (destroyed || busy) return;
      // 关键：必须忽略面板自身引起的 DOM 变化。
      // 否则 renderList() 改 DOM -> 触发 observer -> 又 renderList -> 死循环。
      if (muts.every((m) => panel.contains(m.target))) return;
      clearTimeout(mo._t);
      mo._t = setTimeout(() => {
        if (destroyed) return;
        try { renderList(scan(), polling); } catch (_) { /* ignore */ }
      }, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (_) { /* ignore */ }
})();
