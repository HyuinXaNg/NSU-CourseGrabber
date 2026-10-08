/* ============================================================================
 * 跨实现一致性测试：一轮只能抢一门
 * ----------------------------------------------------------------------------
 * 背景：错误 9 是"同一类逻辑在不同实现里行为不一致"——面板版遍历所有目标课，
 *       控制台/油猴版只抢第一门。这类 bug 光看一个文件是发现不了的。
 *
 * 所以这里把同一条断言同时跑在三个实现上：
 *   页面上放两门羽毛球（083 / 084）+ 一门篮球（关键词不匹配）
 *   断言：084 一次都不能被点，篮球也一次都不能被点
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = `<!doctype html><html><body>
  <div class="c"><div>[083-羽毛球][A1]李老师</div><div>已选容量：0/67</div><button id="pick083">选择</button></div>
  <div class="c"><div>[084-羽毛球][A2]李四</div><div>已选容量：0/60</div><button id="pick084">选择</button></div>
  <div class="c"><div>[076-篮球][A3]张三</div><div>已选容量：0/60</div><button id="pick076">选择</button></div>
</body></html>`;

function makeDom() {
  const dom = new JSDOM(HTML, {
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
  const clicks = { '083': 0, '084': 0, '076': 0 };
  for (const id of Object.keys(clicks)) {
    d.getElementById('pick' + id).addEventListener('click', () => clicks[id]++);
  }
  return { dom, w, d, clicks };
}

function inject(w, d, code) {
  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const judge = (name, clicks) => {
  const targets = clicks['083'] + clicks['084'];
  const ok = clicks['084'] === 0 && clicks['076'] === 0 && clicks['083'] >= 1;
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '❌'} ${name}：083=${clicks['083']} 084=${clicks['084']} 篮球=${clicks['076']}`
    + (ok ? '' : '  ← 一轮点了多门或点错课'));
};

(async () => {
  /*
   * 1) 面板版 grab_course.ui.js
   */
  console.log('\n[1/3] 面板版 grab_course.ui.js');
  {
    const code = fs.readFileSync(path.join(__dirname, 'grab_course.ui.js'), 'utf8');
    const { w, d, clicks } = makeDom();
    inject(w, d, code);
    await wait(200);
    const btn = [...d.querySelectorAll('#__grab_panel button')].find((b) => /立即抢一次/.test(b.textContent));
    btn.click();
    await wait(3500);
    judge('面板版「立即抢一次」', clicks);
    try { w.__GRAB_UI__.destroy(); } catch (_) { /* ignore */ }
  }

  /*
   * 2) 控制台版 grab_course.js —— 把准点时间设成早已过去，立刻开抢
   */
  console.log('\n[2/3] 控制台版 grab_course.js');
  {
    const code = fs.readFileSync(path.join(__dirname, 'grab_course.js'), 'utf8')
      .replace("at: '13:00:00'", "at: '00:00:01'");
    const { w, d, clicks } = makeDom();
    inject(w, d, code);
    await wait(7000);
    judge('控制台版自动轮询', clicks);
    try { w.__GRAB__.stop(); } catch (_) { /* ignore */ }
  }

  /*
   * 3) 油猴版 grab_course.user.js —— atTime 清空 = 立即开抢
   */
  console.log('\n[3/3] 油猴版 grab_course.user.js');
  {
    const code = fs.readFileSync(path.join(__dirname, 'grab_course.user.js'), 'utf8')
      .replace("atTime: '13:00:00'", "atTime: ''")
      .replace("'dnui_grab_state_v1'", "'dnui_grab_state_mt'");
    const { w, d, clicks } = makeDom();
    inject(w, d, code);
    await wait(150);
    const startBtn = d.querySelector('[data-role="start"]');
    startBtn.click();
    await wait(7000);
    judge('油猴版自动轮询', clicks);
    try { d.querySelector('[data-role="stop"]').click(); } catch (_) { /* ignore */ }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 跨实现一致性：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
