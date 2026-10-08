/* ============================================================================
 * 跨实现一致性测试：成功 / 失败提示的判定
 * ----------------------------------------------------------------------------
 * 反向场景：提示「选课未成功」——绝不能判成成功
 *   （原来的 /成功|已选上|选课成功/ 只做子串匹配，「未成功」里含「成功」，
 *     脚本会停止并报告成功，用户以为抢到了、不再重试，实际什么都没选上）
 *
 * 正向场景：提示「选课成功」——必须仍然判成成功
 *   （这条是防"修过头"：若判定永远为假，脚本会无限重试，比原 bug 更糟）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FAIL_MSG = '选课未成功，请稍后重试';
const OK_MSG = '选课成功';

const html = (msg) => `<!doctype html><html><body>
  <div class="c"><div>[083-羽毛球][A1]李老师</div><div>已选容量：0/67</div>
    <button id="pick">选择</button></div>
  <script>
    document.getElementById('pick').addEventListener('click', function () {
      if (document.querySelector('.el-message')) return;
      var t = document.createElement('div');
      t.className = 'el-message';
      t.textContent = ${JSON.stringify(msg)};
      document.body.appendChild(t);
    });
  <\/script>
</body></html>`;

function makeDom(msg) {
  const dom = new JSDOM(html(msg), {
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

const inject = (d, code) => {
  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const results = [];
const judge = (name, lines, expectSuccess) => {
  const saidOk = lines.some((l) => /选课成功/.test(l));
  const ok = saidOk === expectSuccess;
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '❌'} ${name}`);
};

/** 对每个实现跑同一场景 */
async function runAll(msg, expectSuccess, label) {
  console.log(`\n──── ${label}：提示「${msg}」→ 期望${expectSuccess ? '判为成功' : '不判为成功'}`);

  // 控制台版
  {
    const code = read('grab_course.js')
      .replace("at: '13:00:00'", "at: '00:00:01'")
      .replace('CLICK_RETRIES: 3', 'CLICK_RETRIES: 1');
    const { w, d, lines } = makeDom(msg);
    inject(d, code);
    await wait(3500);
    judge('控制台版', lines, expectSuccess);
    try { w.__GRAB__.stop(); } catch (_) { /* ignore */ }
  }

  // 面板版
  {
    const { w, d, lines } = makeDom(msg);
    inject(d, read('grab_course.ui.js'));
    await wait(200);
    const btn = [...d.querySelectorAll('#__grab_panel button')].find((b) => /立即抢一次/.test(b.textContent));
    btn.click();
    await wait(3500);
    judge('面板版  ', lines, expectSuccess);
    try { w.__GRAB_UI__.destroy(); } catch (_) { /* ignore */ }
  }

  // 油猴版
  {
    const key = 'dnui_grab_state_msg';
    const code = read('grab_course.user.js')
      .replace("atTime: '13:00:00'", "atTime: ''")
      .replace("'dnui_grab_state_v1'", `'${key}'`);
    const { w, d, lines } = makeDom(msg);
    inject(d, code);
    await wait(150);
    d.querySelector('[data-role="start"]').click();
    await wait(3500);
    judge('油猴版  ', lines, expectSuccess);
    try { d.querySelector('[data-role="stop"]').click(); } catch (_) { /* ignore */ }
  }
}

(async () => {
  await runAll(FAIL_MSG, false, '反向场景');
  await runAll(OK_MSG, true, '正向场景');

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 成功/失败判定：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
