/* ============================================================================
 * 跨实现一致性测试：最长运行时间上限
 * ----------------------------------------------------------------------------
 * 背景：油猴版原本 DEFAULTS 里没有 maxMinutes、tick() 里也没上限检查，
 *       而它会「刷新后自动续跑」—— 可能无人值守地一直轮询全校共用的教务服务器。
 *       控制台版有 MAX_MINUTES: 120，面板版有 maxMinutes: 120。
 *
 * 这里把三者的上限都改成极小的 0.02 分钟（=1.2 秒），验证都会自动停。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = '<!doctype html><html><body><div id="page">空页面，无课程卡片</div></body></html>';

function makeDom(url) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url,
  });
  const w = dom.window, d = w.document;
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', {
    get() { return d.body; }, configurable: true,
  });
  if (!w.Element.prototype.setPointerCapture) {
    w.Element.prototype.setPointerCapture = function () {};
    w.Element.prototype.releasePointerCapture = function () {};
  }
  return { w, d };
}

const inject = (d, code) => {
  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立 */
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return Date.now() - t0; } catch (_) { /* ignore */ }
    await wait(200);
  }
  return -1;
}

const results = [];
const judge = (name, ms) => {
  const ok = ms >= 0;
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '❌'} ${name}：${ok ? `${ms}ms 后自动停止` : '超时仍未停止'}`);
};

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

(async () => {
  /* 1) 控制台版：MAX_MINUTES */
  console.log('\n[1/3] 控制台版 grab_course.js');
  {
    const code = read('grab_course.js')
      .replace("at: '13:00:00'", "at: '00:00:01'")   // 立即开抢
      .replace('MAX_MINUTES: 120', 'MAX_MINUTES: 0.02');
    const { w, d } = makeDom('https://xk.dnui.edu.cn/x');
    inject(d, code);
    await wait(300);
    const ms = await waitFor(() => w.__GRAB__.status().running === false, 9000);
    judge('控制台版 MAX_MINUTES', ms);
    try { w.__GRAB__.stop(); } catch (_) { /* ignore */ }
  }

  /* 2) 面板版：maxMinutes */
  console.log('\n[2/3] 面板版 grab_course.ui.js');
  {
    const code = read('grab_course.ui.js').replace('maxMinutes: 120', 'maxMinutes: 0.02');
    const { w, d } = makeDom('https://xk.dnui.edu.cn/x');
    inject(d, code);
    await wait(200);
    const btn = [...d.querySelectorAll('#__grab_panel button')].find((b) => /开始/.test(b.textContent));
    btn.click();
    const ms = await waitFor(() => w.__GRAB_UI__.status().phase === '已停止', 9000);
    judge('面板版 maxMinutes', ms);
    try { w.__GRAB_UI__.destroy(); } catch (_) { /* ignore */ }
  }

  /* 3) 油猴版：maxMinutes（本次新加） */
  console.log('\n[3/3] 油猴版 grab_course.user.js');
  {
    const key = 'dnui_grab_state_maxmin';
    const code = read('grab_course.user.js')
      .replace("atTime: '13:00:00'", "atTime: ''")     // 立即开抢
      .replace("'dnui_grab_state_v1'", `'${key}'`);
    const { w, d } = makeDom('https://xk.dnui.edu.cn/x');
    // 预先写入极小上限，模拟"跑满 120 分钟"的场景
    w.localStorage.setItem(key, JSON.stringify({
      keywords: '不存在的课', atTime: '', dryRun: false, running: false, maxMinutes: 0.02,
    }));
    inject(d, code);
    await wait(150);
    d.querySelector('[data-role="start"]').click();
    const ms = await waitFor(() => {
      const s = JSON.parse(w.localStorage.getItem(key) || '{}');
      return s.running === false;
    }, 9000);
    judge('油猴版 maxMinutes', ms);
    try { d.querySelector('[data-role="stop"]').click(); } catch (_) { /* ignore */ }
  }

  /* 4) 对照组：剥掉油猴版新增的上限检查，应当"不会"自动停。
   *    如果对照组也停了，说明上面的断言测不出问题（假通过）。 */
  console.log('\n[对照] 油猴版剥掉 maxMinutes 检查');
  {
    const key = 'dnui_grab_state_maxmin_ctl';
    let stripped = 0;
    const code = read('grab_course.user.js')
      .replace("atTime: '13:00:00'", "atTime: ''")
      .replace("'dnui_grab_state_v1'", `'${key}'`)
      .replace(
        'if (state.maxMinutes > 0 && Date.now() - startedAt > state.maxMinutes * 60000) {',
        () => { stripped++; return 'if (false) { /* 上限检查被故意剥掉 */'; }
      );
    if (stripped !== 1) { console.error('  ✗ 没能剥掉上限检查，对照无意义'); process.exit(1); }

    const { w, d } = makeDom('https://xk.dnui.edu.cn/x');
    w.localStorage.setItem(key, JSON.stringify({
      keywords: '不存在的课', atTime: '', dryRun: false, running: false, maxMinutes: 0.02,
    }));
    inject(d, code);
    await wait(150);
    d.querySelector('[data-role="start"]').click();

    // 反过来等：期望它"一直不停"
    const ms = await waitFor(() => {
      const s = JSON.parse(w.localStorage.getItem(key) || '{}');
      return s.running === false;
    }, 6000);
    const ok = ms === -1;   // 没停 = 对照符合预期
    results.push({ name: '对照组（剥掉检查应不停）', ok });
    console.log(`  ${ok ? '✓' : '❌'} 对照组（剥掉检查应不停）：${ok ? '6 秒内确实没停' : `却停了（${ms}ms）—— 说明断言无区分能力`}`);
    try { d.querySelector('[data-role="stop"]').click(); } catch (_) { /* ignore */ }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 时长上限一致性：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
