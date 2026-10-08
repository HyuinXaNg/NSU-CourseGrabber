/* ============================================================================
 * GUI 版一致性测试：新实现不能重蹈旧覆辙
 * ----------------------------------------------------------------------------
 * grab_course.gui.js 是全新写的实现，之前的 12 个修复有可能没被带过来。
 * 这里把三个最容易复发的断言一次性跑在它身上：
 *
 *   A. 一轮只抢一门（错误 9：多教学班被全部点一遍）
 *   B. 有最长运行时间上限（错误 11：油猴版曾漏掉，会无限轮询）
 *   C. 失败提示不误判成成功（错误 12：「选课未成功」含「成功」）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'grab_course.gui.js'), 'utf8');

function makeDom(html) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://xk.dnui.edu.cn/xsxk/elective/grablesson?batchId=t',
  });
  const w = dom.window, d = w.document;
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', {
    get() { return d.body; }, configurable: true,
  });
  if (!w.Element.prototype.setPointerCapture) {
    w.Element.prototype.setPointerCapture = function () {};
    w.Element.prototype.releasePointerCapture = function () {};
  }
  const lines = [];
  const orig = w.console.log.bind(w.console);
  w.console.log = (...a) => { lines.push(a.map(String).join(' ')); orig(...a); };
  return { w, d, lines };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return Date.now() - t0; } catch (_) { /* ignore */ }
    await wait(200);
  }
  return -1;
}

async function boot(html, code = SRC) {
  const { w, d, lines } = makeDom(html);
  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
  await wait(200);
  return { w, d, lines };
}

const btnByText = (d, re) => [...d.querySelectorAll('#__grab_gui button')].find((b) => re.test(b.textContent));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

const CARD = (idx, teacher, used, cap) => `
  <div class="c"><div>[${idx}-羽毛球][A${idx}]${teacher}</div>
    <div>已选容量：${used}/${cap}</div><button id="pick${idx}">选择</button></div>`;

(async () => {
  /* ---------------- A. 一轮只抢一门 ---------------- */
  console.log('\n[A] 一轮只抢一门（错误 9）');
  {
    const html = `<!doctype html><html><body>
      ${CARD('083', '李老师', 0, 67)}
      ${CARD('084', '李四', 0, 60)}
      <div class="c"><div>[076-篮球][A076]张三</div><div>已选容量：0/60</div><button id="pick076">选择</button></div>
    </body></html>`;
    const { w, d } = await boot(html);
    const clicks = { '083': 0, '084': 0, '076': 0 };
    for (const id of Object.keys(clicks)) {
      d.getElementById('pick' + id).addEventListener('click', () => clicks[id]++);
    }
    btnByText(d, /抢一次/).click();
    await wait(3500);
    check('只点第一门，且不碰非目标课程',
      clicks['083'] >= 1 && clicks['084'] === 0 && clicks['076'] === 0,
      `083=${clicks['083']} 084=${clicks['084']} 篮球=${clicks['076']}`);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------------- B. 最长运行时间上限 ---------------- */
  console.log('\n[B] 最长运行时间上限（错误 11）');
  {
    const EMPTY = '<!doctype html><html><body><div>空页面</div></body></html>';
    const code = SRC.replace('maxMinutes: 120', 'maxMinutes: 0.02');   // = 1.2 秒
    const { w, d } = await boot(EMPTY, code);
    d.getElementById('__grab_start').click();
    const ms = await waitFor(() => w.__GRAB_GUI__.result().state === 'fail', 9000);
    check('跑满上限会自动停并结算为未抢到', ms >= 0, ms >= 0 ? `${ms}ms 后停止` : '超时未停');
    w.__GRAB_GUI__.destroy();
  }
  {
    // 反向对照：剥掉上限检查后应当"不会"自动停
    const EMPTY = '<!doctype html><html><body><div>空页面</div></body></html>';
    let stripped = 0;
    const code = SRC.replace(
      'if (S.maxMinutes > 0 && Date.now() - startedAt > S.maxMinutes * 60000) {',
      () => { stripped++; return 'if (false) { /* 上限检查被故意剥掉 */'; }
    );
    if (stripped !== 1) { console.error('  ✗ 没能剥掉上限检查，对照无意义'); process.exit(1); }
    const { w, d } = await boot(EMPTY, code.replace('maxMinutes: 120', 'maxMinutes: 0.02'));
    d.getElementById('__grab_start').click();
    const ms = await waitFor(() => w.__GRAB_GUI__.result().state === 'fail', 6000);
    check('对照组：剥掉检查后确实不停', ms === -1, ms === -1 ? '6 秒内确实没停' : `却停了（${ms}ms）`);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------------- C. 失败提示不误判成成功 ---------------- */
  console.log('\n[C] 失败提示不误判成成功（错误 12）');
  const withToast = (msg) => `<!doctype html><html><body>
    ${CARD('083', '李老师', 0, 67)}
    <script>
      document.getElementById('pick083').addEventListener('click', function () {
        if (document.querySelector('.el-message')) return;
        var t = document.createElement('div');
        t.className = 'el-message'; t.textContent = ${JSON.stringify(msg)};
        document.body.appendChild(t);
      });
    <\/script>
  </body></html>`;

  {
    const { w, d, lines } = await boot(withToast('选课未成功，请稍后重试'));
    d.getElementById('__grab_start').click();
    await wait(3000);
    const saidOk = lines.some((l) => /抢课成功/.test(l));
    check('「选课未成功」不判为成功', !saidOk && w.__GRAB_GUI__.result().state !== 'ok',
      `result=${w.__GRAB_GUI__.result().state}`);
    w.__GRAB_GUI__.destroy();
  }
  {
    const { w, d, lines } = await boot(withToast('选课成功'));
    d.getElementById('__grab_start').click();
    await wait(3000);
    const saidOk = lines.some((l) => /抢课成功/.test(l));
    check('正向对照：「选课成功」仍判为成功', saidOk && w.__GRAB_GUI__.result().state === 'ok',
      `result=${w.__GRAB_GUI__.result().state}`);
    w.__GRAB_GUI__.destroy();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== GUI 版一致性：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
