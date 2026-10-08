/* ============================================================================
 * 成都东软学院 体育项目 抢课脚本  ——  浏览器控制台版
 * ----------------------------------------------------------------------------
 * 用法:
 *   1. 用 Chrome/Edge 打开选课页面并登录，切到「体育项目」标签页
 *      (网址形如 https://xk.dnui.edu.cn/xsxk/elective/grablesson?batchId=...)
 *   2. 按 F12 -> Console(控制台)
 *   3. 把本文件全部内容粘贴进去，回车
 *   4. 停止：在控制台执行  __GRAB__.stop()
 *      查看状态：__GRAB__.status()    重新扫描一次：__GRAB__.scan()
 *      识别不对时排错：__GRAB__.dump()
 *
 * 第一次运行建议先把 DRY_RUN 改成 true 跑一遍，确认能正确认出羽毛球卡片再正式开抢。
 *
 * 设计原则:
 *   - 不依赖 class 名（学校系统改版后 class 常变），改用「文本特征」定位卡片与按钮
 *   - 带随机抖动 + 间隔下限，避免高频请求把教务服务器打挂
 *   - 只在「已选人数 < 容量」时才点击，满员时安静等待下一轮
 * ========================================================================== */
(() => {
  'use strict';

  /* ==========================  配置区（按需修改）  ========================== */

  const CONFIG = {
    // 目标课程关键词，命中任意一个即可（匹配卡片标题里的课程名，如「羽毛球」）
    TARGETS: ['羽毛球'],

    // true = 只检测、只打印，绝不点击。第一次运行建议设为 true
    DRY_RUN: false,

    // 轮询间隔基准（毫秒）+ 随机抖动（毫秒）。别改太小，校园服务器扛不住
    INTERVAL_MS: 2000,
    JITTER_MS: 800,

    // 最长运行时间（分钟），0 = 不限
    MAX_MINUTES: 120,

    // 单个课程一次命中后最多点几次「选择」
    CLICK_RETRIES: 3,

    // 点击「选择」后，自动确认弹窗的按钮文案（按顺序找）
    CONFIRM_TEXTS: ['确定', '确认', '提交', '是', 'OK'],

    // 是否自动接管原生 window.confirm 弹窗（返回 true）
    AUTO_CONFIRM_NATIVE: true,

    // 日志详细程度：'quiet' 只在有变化时打印 | 'normal' | 'verbose' 每次轮询都打印
    VERBOSITY: 'normal',

    /* ===== 准点开抢（13:00 整这种场景）=====
     * enabled=true 时，脚本先安静待命，到 at 时刻那一瞬间立刻开抢，
     * 并在随后 burstMs 内以 burstIntervalMs 快速重试（因为服务端刚放课，
     * 前几百毫秒往往还在 500/排队，需要连点），之后回落到正常 2 秒轮询。 */
    SYNC: {
      enabled: true,
      at: '13:00:00',        // 目标时刻 HH:MM:SS（今天）
      burstMs: 4000,         // 到点后的爆发期时长（够抢到开窗瞬间，又不会像压测）
      burstIntervalMs: 500,  // 爆发期重试间隔（≈8 次；别低于 300，教务服务器全校共用）
      lateGraceSec: 90,      // 若本机时间已过点但在该秒数内，仍立刻开抢而不是干等到明天
      syncServerClock: true, // 用 HTTP Date 响应头校准本机时钟偏差
    },
  };

  /* ==========================  以下一般不用改  ========================== */

  // 卡片标题特征：[083-羽毛球][T9000001]李老师
  // 教师名用「非空白/非冒号、最多 12 字」收口，避免把后面的「承担单位：…」一起吃进来
  const LABEL_RE = /\[(\d+)-([^\]\r\n]+)\]\[([^\]\r\n]+)\]([^\s\[\r\n|：:]{0,12})/;

  // 容量特征：已选容量：0/67  或  已选：0/67  或  剩余：67
  const RATIO_RE = /(?:已选容量|已选人数|已选)[:：]?\s*(\d+)\s*[/／]\s*(\d+)/;
  const LEFT_RE = /剩余(?:名额|容量)?[:：]?\s*(\d+)/;

  /* 成功 / 失败判定。
   * 必须"先看有没有失败词"，不能只做正向匹配 ——
   * 「选课未成功」里含有「成功」，只正向匹配会把它误判为抢课成功，
   * 脚本随即停止并报告成功，用户以为抢到了、不再重试，实际什么都没选上。 */
  const FAIL_RE = /未成功|不成功|失败|错误|异常|已满|满员|已选过|请勿重复|不可选|已截止|未开始/;
  const OK_RE = /选课成功|已选上|成功/;
  const isOkMsg = (m) => OK_RE.test(m) && !FAIL_RE.test(m);

  const LOG_PREFIX = '%c[抢课]';
  const LOG_STYLE = 'color:#fff;background:#2d6cdf;padding:1px 5px;border-radius:3px';

  const log = (...a) => console.log(LOG_PREFIX, LOG_STYLE, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, LOG_STYLE, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------- 准点同步（时钟校准） ------------------------- */

  let clockOffsetMs = 0;   // 服务器时间 - 本机时间
  let burstUntil = 0;      // 爆发期截止（本机时间戳）

  const now = () => Date.now() + clockOffsetMs;

  /** 解析 "13:00:00" -> 今天该时刻的时间戳 */
  function parseDeadline(at) {
    const m = String(at).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }

  /**
   * 用同源请求的 HTTP `Date` 响应头校准本机时钟。
   * 笔记本时间慢个几秒是抢课失败最常见的原因之一 —— 教务服务器按它自己的
   * 时钟放课，所以「13:00」应该对齐服务器，而不是本机。
   */
  async function syncServerClock() {
    if (!CONFIG.SYNC.syncServerClock) return null;
    const t0 = Date.now();
    try {
      const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
      const d = new Date(res.headers.get('date') || '');
      if (isNaN(d.getTime())) return null;
      clockOffsetMs = d.getTime() + (Date.now() - t0) / 2 - Date.now();  // 粗略扣除往返延迟
      return clockOffsetMs;
    } catch (_) {
      return null;   // 取不到就算了，用本机时间，不阻断抢课
    }
  }

  /** 逼近 deadline：远的用粗睡，近的用 20/5ms 细步，保证落到毫秒级 */
  async function waitUntilDeadline(deadline) {
    while (!stopped) {
      const remain = deadline - now();
      if (remain <= 0) return true;
      if (remain > 300) await sleep(Math.min(remain - 200, 1000));
      else if (remain > 60) await sleep(20);
      else await sleep(5);
    }
    return false;
  }

  /** 本轮结束后该等多久：爆发期用快间隔，之后回到温和的正常轮询 */
  function nextDelay() {
    if (Date.now() < burstUntil) return CONFIG.SYNC.burstIntervalMs;
    return CONFIG.INTERVAL_MS + Math.random() * CONFIG.JITTER_MS;
  }

  /* ---------------------------- 工具函数 ---------------------------- */

  /** 取元素的可点击文案：普通元素用 textContent，input 用 value */
  function textOf(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT') return (el.value || '').trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 元素是否处于禁用/不可见状态 */
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

  /**
   * 在 root 内找出文案匹配的元素（取最内层，避免重复命中父容器）。
   * @param {Element} root
   * @param {string[]} texts 目标文案
   * @param {boolean} exact true=完全相等, false=包含
   */
  function findByText(root, texts, exact = true) {
    const wanted = texts.map((t) => t.trim()).filter(Boolean);
    if (!wanted.length) return [];

    const selector = 'button, a, span, div, input, li, i, em, b, strong, p, label';
    const out = [];

    for (const el of root.querySelectorAll(selector)) {
      const t = textOf(el);
      if (!t || t.length > 24) continue;   // 只接受短文案，避免命中整块容器
      const hit = exact ? wanted.includes(t) : wanted.some((w) => t.includes(w));
      if (!hit) continue;
      // 若子元素已命中，跳过父元素
      const childHit = [...el.children].some((c) => {
        const ct = textOf(c);
        return exact ? wanted.includes(ct) : wanted.some((w) => ct.includes(w));
      });
      if (childHit) continue;
      out.push(el);
    }
    return out;
  }

  /** 从「选择」按钮往上找它所属的课程卡片 */
  function cardOf(btn) {
    let n = btn;
    while (n && n !== document.body && n !== document.documentElement) {
      if (LABEL_RE.test(n.textContent || '')) return n;
      n = n.parentElement;
    }
    return null;
  }

  /** 解析卡片信息 */
  function parseCard(card) {
    const text = (card.textContent || '').replace(/\s+/g, ' ');
    const m = text.match(LABEL_RE);
    if (!m) return null;

    const info = {
      index: m[1],                        // 083
      course: m[2],                       // 羽毛球
      teacherId: m[3],                    // T9000001
      teacher: (m[4] || '').trim(),        // 李老师
      used: null,
      cap: null,
      left: null,
      free: null,
      raw: text,
    };

    const r = text.match(RATIO_RE);
    if (r) { info.used = Number(r[1]); info.cap = Number(r[2]); }
    const l = text.match(LEFT_RE);
    if (l) info.left = Number(l[1]);

    if (info.left !== null) info.free = info.left > 0;
    else if (info.used !== null && info.cap !== null) info.free = info.used < info.cap;
    else info.free = null;               // 解析不到容量，交给用户判断

    return info;
  }

  /** 扫描页面，返回所有目标课程的可选卡片 */
  function scan() {
    const cards = [];
    const seen = new Set();

    for (const btn of findByText(document, ['选择'])) {
      const card = cardOf(btn);
      if (!card || seen.has(card)) continue;

      const info = parseCard(card);
      if (!info) continue;
      if (!CONFIG.TARGETS.some((kw) => info.course.includes(kw))) continue;

      seen.add(card);
      cards.push({ info, card, btn, disabled: isDisabled(btn) });
    }
    return cards;
  }

  /** 读取页面上的提示/toast 文案 */
  function readToasts() {
    const sel = [
      '.layui-layer-msg', '.layui-layer-content', '.el-message', '.ant-message-notice',
      '.van-toast', '.toast', '.message', '.tips', '.alert', '.el-notification',
    ].join(',');
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const t = textOf(el);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * 真实点击（派发完整鼠标事件，兼容只监听 mousedown 的前端框架）。
   * 注意：这里不能再 dispatch 一次 'click' —— 下面的 el.click() 本身就会派发
   * 一个冒泡的 click 事件，两者叠加会让每次点击变成两次，选课系统可能因此
   * 报「请勿重复提交」或弹出两个确认框。
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

  /**
   * 若出现确认弹窗，自动点掉。
   * 安全约束：只认两类按钮，避免把页面上无关的「确定」乱点一通
   * （选课页可能有筛选弹窗、协议弹窗，甚至退课确认键）：
   *   a) 位于弹窗容器内的确认键   —— 任何时候都认
   *   b) 刚点过「选择」的 5 秒内   —— 覆盖弹窗结构识别不出来的情况
   */
  function autoConfirmOnce() {
    const recent = Date.now() - lastPickAt < 5000;
    for (const el of findByText(document, CONFIG.CONFIRM_TEXTS)) {
      if (isDisabled(el)) continue;
      if (!el.offsetParent && el.tagName !== 'BODY') continue;  // 不可见则跳过
      if (!recent && !inDialog(el)) continue;                   // 非弹窗期只认弹窗内的按钮
      log(`自动确认弹窗 -> 「${textOf(el)}」`);
      realClick(el);
      return true;
    }
    return false;
  }

  /* ---------------------------- 主流程 ---------------------------- */

  let stopped = false;
  let timer = null;
  let confirmTimer = null;
  let startedAt = Date.now();
  let pollCount = 0;
  let lastSignature = '';
  let armed = false;      // 待命结束、真正开始抢课之后，才允许「兜底点确认框」
  let starting = false;   // 防止 start() 被重复调用而产生多个并行轮询循环
  let lastPickAt = 0;     // 上次点「选择」的时刻，用于限定自动确认的时间窗

  // 常见弹窗容器（layui / Element / Ant / Vant / 原生 dialog）
  const DIALOG_SEL = '.layui-layer,.layui-layer-page,.layui-layer-btn,.el-dialog,.el-message-box,'
    + '.ant-modal,.van-dialog,[role="dialog"],dialog,.modal,.popup';
  const inDialog = (el) => !!(el && el.closest && el.closest(DIALOG_SEL));

  const describe = (cards) => cards
    .map((c) => `${c.info.course}#${c.info.index}/${c.info.teacher} ${c.info.used ?? '?'}/${c.info.cap ?? '?'}${c.disabled ? '[禁用]' : ''}`)
    .join(' | ');

  function report(cards, force) {
    const sig = describe(cards);
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    log(`第 ${pollCount} 次扫描，发现 ${cards.length} 个目标课程：`);
    for (const c of cards) {
      const cap = c.info.used !== null ? `${c.info.used}/${c.info.cap}` : '未显示容量';
      const state = c.info.free === true ? '✅ 有空位' : c.info.free === false ? '⛔ 已满' : '❓ 容量未识别';
      log(`   ${state}  [${c.info.index}-${c.info.course}] ${c.info.teacher}  已选容量=${cap}${c.disabled ? '  (按钮禁用)' : ''}`);
    }
  }

  async function attempt(cards) {
    const targets = cards.filter((c) => c.info.free !== false && !c.disabled);
    if (!targets.length) return false;

    for (const t of targets) {
      log(`🎯 命中空位：${t.info.course} / ${t.info.teacher}（已选 ${t.info.used ?? '?'}/${t.info.cap ?? '?'}）`);

      if (CONFIG.DRY_RUN) {
        log('   [演练模式] 本应点击「选择」，已跳过');
        continue;
      }

      for (let i = 1; i <= CONFIG.CLICK_RETRIES && !stopped; i++) {
        const before = readToasts().join('|');
        log(`   点击「选择」第 ${i}/${CONFIG.CLICK_RETRIES} 次…`);
        lastPickAt = Date.now();   // 打开自动确认的时间窗
        realClick(t.btn);

        // 弹窗/提示异步出现，轮询观察，最多等 1.8s
        let gotFeedback = false;
        for (let waited = 0; waited < 1800 && !stopped && !gotFeedback; waited += 200) {
          await sleep(200);
          autoConfirmOnce();

          const fresh = readToasts().filter((m) => m && !before.includes(m));
          for (const m of fresh) {
            gotFeedback = true;
            if (isOkMsg(m)) {
              log(`✅ 选课成功！服务器返回：${m}`);
              log('🎉 抢课完成，脚本自动停止。');
              stop();
              return true;
            }
            warn(`服务器返回：${m}`);
          }
        }

        if (gotFeedback) {
          if (!stopped) warn('   本次点击未成功，回到轮询继续观察…');
          return true;
        }
      }

      if (!stopped) warn('   多次点击均无明确反馈，回到轮询继续观察…');
      return true;
    }
    return false;
  }

  async function tick() {
    if (stopped) return;

    if (CONFIG.MAX_MINUTES > 0 && Date.now() - startedAt > CONFIG.MAX_MINUTES * 60000) {
      warn(`已达最长运行时间 ${CONFIG.MAX_MINUTES} 分钟，自动停止。`);
      return stop();
    }

    pollCount++;
    let cards = [];
    try {
      cards = scan();
    } catch (e) {
      warn('扫描出错：', e);
    }

    if (!cards.length) {
      if (CONFIG.VERBOSITY === 'verbose') {
        warn(`第 ${pollCount} 次扫描：页面上没找到含「${CONFIG.TARGETS.join('/')}」的可选卡片。`);
        warn('  → 请确认：① 已切到「体育项目」标签 ② 课程名含关键词 ③ 课程是否在分页的其它页');
      }
    } else {
      report(cards, CONFIG.VERBOSITY === 'verbose');
      // 必须包住：attempt 内部一旦抛错，下面的 setTimeout(tick) 就不会执行，
      // 整个轮询循环会静默死掉（这正是旧版 ReferenceError 的后果）。
      try {
        await attempt(cards);
      } catch (e) {
        warn('点击环节出错（本轮跳过，继续轮询）：', e);
      }
    }

    if (!stopped) {
      timer = setTimeout(tick, nextDelay());
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    armed = false;
    starting = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (confirmTimer) { clearInterval(confirmTimer); confirmTimer = null; }
    log(`已停止（共扫描 ${pollCount} 次，运行 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。`);
  }

  /** 排错用：把识别到的卡片结构打印出来 */
  function dump() {
    const cards = scan();
    log(`dump：识别到 ${cards.length} 个目标卡片`);
    cards.forEach((c, i) => {
      log(`#${i}`, {
        ...c.info,
        buttonTag: c.btn.tagName,
        buttonText: textOf(c.btn),
        cardTag: c.card.tagName,
        cardClass: c.card.className,
      });
      console.log(c.card);
    });
    if (!cards.length) {
      log('没识别到。下面是页面上所有「选择」按钮及其所属卡片文本，用于核对：');
      findByText(document, ['选择']).forEach((btn, i) => {
        const card = cardOf(btn);
        console.log(`#${i}`, { button: textOf(btn), cardText: card ? (card.textContent || '').slice(0, 160) : '(未找到所属卡片)' }, btn);
      });
    }
    return cards;
  }

  /* ---------------------------- 启动 ---------------------------- */

  // 自动接管原生 confirm
  if (CONFIG.AUTO_CONFIRM_NATIVE && !window.__GRAB_CONFIRM_PATCHED__) {
    window.__GRAB_CONFIRM_PATCHED__ = true;
    window.confirm = (msg) => {
      log(`拦截原生 confirm：${msg} -> 自动点「确定」`);
      return true;
    };
  }

  // 兜底：只要屏幕上冒出确认按钮就点掉。
  // 关键：必须等 armed（待命结束）才启用，否则待命期间会误点页面上的
  // 「确定/确认/提交」按钮（比如筛选弹窗、协议弹窗），把页面搞乱。
  function ensureConfirmTimer() {
    if (confirmTimer) return;
    confirmTimer = setInterval(() => {
      if (!armed || stopped || CONFIG.DRY_RUN) return;
      try {
        autoConfirmOnce();
      } catch (e) {
        warn('自动确认出错：', e);   // 绝不能让异常逃逸，否则会每 600ms 刷屏报错
      }
    }, 600);
  }

  ensureConfirmTimer();

  /* ---------------------------- 准点启动 ---------------------------- */

  async function start() {
    if (starting) {
      warn('脚本已在运行中，忽略重复的 start()（否则会产生多个并行轮询循环，停不干净）。');
      return;
    }
    starting = true;
    stopped = false;   // 允许 stop() 之后重新 start()
    armed = false;     // 待命期间一律不点确认框

    if (CONFIG.SYNC.enabled) {
      const deadline = parseDeadline(CONFIG.SYNC.at);
      if (deadline === null) {
        warn(`SYNC.at 格式不对：「${CONFIG.SYNC.at}」，应为 HH:MM:SS。已改为立即开抢。`);
      } else {
        const off = await syncServerClock();
        if (off !== null) {
          log(`时钟校准：本机${off >= 0 ? '慢' : '快'} ${Math.abs(off / 1000).toFixed(2)}s（已对齐服务器时间）`);
        } else {
          warn('拿不到服务器 Date 头，按本机时间计时。请确认本机时钟准确。');
        }

        const remain = deadline - now();
        if (remain > 0) {
          log(`⏳ 待命中：将在 ${CONFIG.SYNC.at} 准点开抢（还有 ${(remain / 1000).toFixed(1)}s）。`);
          log('   待命期间不会发起任何点击，放着不管即可。中止：__GRAB__.stop()');
          const ok = await waitUntilDeadline(deadline);
          if (!ok) { starting = false; return; }            // 待命期间被 stop()
          burstUntil = Date.now() + CONFIG.SYNC.burstMs;
          log(`⏰ 到点！进入 ${CONFIG.SYNC.burstMs}ms 爆发期（每 ${CONFIG.SYNC.burstIntervalMs}ms 重试一次）。`);
        } else if (now() - deadline < CONFIG.SYNC.lateGraceSec * 1000) {
          burstUntil = Date.now() + CONFIG.SYNC.burstMs;
          warn(`已过 ${CONFIG.SYNC.at} 约 ${((now() - deadline) / 1000).toFixed(1)}s，立刻开抢！`);
        } else {
          warn(`今天 ${CONFIG.SYNC.at} 已过去很久，准点逻辑自动关闭，改为立即轮询开抢。`);
        }
      }
    }

    startedAt = Date.now();
    pollCount = 0;
    armed = true;              // 到这一步才允许兜底点确认框
    ensureConfirmTimer();      // stop() 清掉过，这里补回来
    log('▶ 开始轮询抢课。');
    tick();
  }

  startedAt = Date.now();
  window.__GRAB__ = {
    stop,
    scan,
    dump,
    start,
    config: CONFIG,
    status: () => ({
      phase: stopped ? '已停止' : (armed ? (Date.now() < burstUntil ? '爆发期中' : '轮询中') : '准点待命中'),
      running: !stopped,
      armed,
      polls: pollCount,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      clockOffsetMs: Math.round(clockOffsetMs),
      inBurst: Date.now() < burstUntil,
      deadline: parseDeadline(CONFIG.SYNC.at),
      serverNow: new Date(now()).toLocaleTimeString('zh-CN', { hour12: false }),
    }),
  };

  log('脚本已启动。目标：' + CONFIG.TARGETS.join('、') + (CONFIG.DRY_RUN ? '（演练模式，不会真的点选）' : ''));
  const initial = scan();
  if (!initial.length) {
    warn('初次扫描没找到目标课程卡片 —— 请确认「体育项目」标签页已打开且课程在列表里。');
    warn('脚本会继续轮询，课程一出现就自动抢。若一直识别不到，执行 __GRAB__.dump() 查看原因。');
  } else {
    report(initial, true);
  }
  start();
})();
