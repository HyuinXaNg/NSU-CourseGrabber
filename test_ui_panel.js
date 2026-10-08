/* ============================================================================
 * 面板版（grab_course.ui.js）验证
 * ----------------------------------------------------------------------------
 * 1. 面板能正常注入
 * 2. 课程列表能识别出羽毛球卡片
 * 3. 点「立即抢」只触发 1 个 click 事件
 * 4. renderList 不会自我触发死循环（面板自身的 DOM 变化必须被忽略）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const code = fs.readFileSync(path.join(__dirname, 'grab_course.ui.js'), 'utf8');

const html = `<!doctype html><html><body>
  <div id="card">
    <div>[083-羽毛球][T9000001]李老师</div>
    <div>已选容量：0/67</div>
    <button id="pick">选择</button>
  </div>
  <div id="card2">
    <div>[076-篮球][T9000004]张三</div>
    <div>已选容量：0/60</div>
    <button id="pick2">选择</button>
  </div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://xk.dnui.edu.cn/xsxk/elective/grablesson?batchId=test',
});
const { window } = dom;
const doc = window.document;

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; },
  configurable: true,
});
// jsdom 没实现 pointer capture
if (!window.Element.prototype.setPointerCapture) {
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
}

const clicks = { pick: 0, pick2: 0 };
doc.getElementById('pick').addEventListener('click', () => clicks.pick++);
doc.getElementById('pick2').addEventListener('click', () => clicks.pick2++);

const el = doc.createElement('script');
el.textContent = code;
doc.body.appendChild(el);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(200);

  const panel = doc.getElementById('__grab_panel');
  check('面板已注入', !!panel);
  if (!panel) { process.exit(1); }

  check('暴露 window.__GRAB_UI__', !!window.__GRAB_UI__);

  const api = window.__GRAB_UI__;
  const cards = api.scan();
  check('识别到 1 个羽毛球卡片', cards.length === 1, `实际 ${cards.length}`);
  check('卡片信息正确',
    cards.length === 1 && cards[0].info.index === '083' && cards[0].info.course === '羽毛球',
    cards.length ? `[${cards[0].info.index}] ${cards[0].info.course} ${cards[0].info.teacher} ${cards[0].info.used}/${cards[0].info.cap}` : '');

  const listTitle = panel.querySelector('#__grab_list_title');
  const listBox = panel.querySelector('#__grab_list');
  check('列表标题显示数量', !!listTitle && /（1）/.test(listTitle.textContent),
    listTitle ? listTitle.textContent : '(未找到)');
  check('列表里有 1 行课程', !!listBox && listBox.querySelectorAll('[data-role="grab"]').length === 1,
    listBox ? `${listBox.querySelectorAll('[data-role="grab"]').length} 行` : '(未找到列表)');

  // ---- 死循环检测 ----
  // 判据不是「重建次数必须为 0」，而是「重建次数不随时间增长」：
  // 真正的死循环是 400ms 一轮，6 秒会有 ~15 次；一次性的稳定重建则始终很少。
  let rebuilds = 0;
  const outside = [];
  const watcher = new window.MutationObserver(() => { rebuilds++; });
  if (!listBox) { console.error('✗ 没定位到列表容器，死循环检测无效'); process.exit(1); }
  watcher.observe(listBox, { childList: true });

  // 诊断：面板之外到底有什么变化触发了刷新
  const spy = new window.MutationObserver((muts) => {
    for (const m of muts) {
      if (panel.contains(m.target)) continue;
      outside.push(`${m.type}@<${m.target.tagName}${m.target.id ? '#' + m.target.id : ''}>`);
    }
  });
  spy.observe(doc.body, { childList: true, subtree: true });

  await wait(2500);
  const at25 = rebuilds;
  await wait(3500);
  const at60 = rebuilds;
  watcher.disconnect();
  spy.disconnect();

  check('renderList 不随时间无限重建', at60 <= 2,
    `2.5s 时 ${at25} 次，6s 时 ${at60} 次（死循环会是 ~15 次）`);
  if (outside.length) {
    console.log(`  ℹ 面板外触发的 DOM 变化：${[...new Set(outside)].join(', ')}`);
  }

  // ---- 点课程行里的「立即抢」 ----
  const grabBtn = listBox.querySelector('[data-role="grab"]');
  check('课程行里有「立即抢」按钮', !!grabBtn, grabBtn ? grabBtn.textContent : '(未找到)');

  if (grabBtn) {
    grabBtn.click();
    await wait(2600);
    check('点课程行「立即抢」触发 1 次 click', clicks.pick === 1, `pick=${clicks.pick}`);
    check('不会误点非目标课程', clicks.pick2 === 0, `pick2=${clicks.pick2}`);
  }

  // ---- 工具栏「⚡ 立即抢一次」 ----
  const onceBtn = [...panel.querySelectorAll('button')].find((b) => /立即抢一次/.test(b.textContent));
  check('工具栏有「立即抢一次」', !!onceBtn);
  if (onceBtn) {
    const before = clicks.pick;
    onceBtn.click();
    await wait(2600);
    check('「立即抢一次」再触发 1 次 click', clicks.pick === before + 1, `pick=${clicks.pick}`);
  }

  // ---- 开始 / 停止 ----
  const startBtn = [...panel.querySelectorAll('button')].find((b) => /开始/.test(b.textContent));
  const stopBtn = [...panel.querySelectorAll('button')].find((b) => /停止/.test(b.textContent));
  check('有开始/停止按钮', !!startBtn && !!stopBtn);

  if (startBtn && stopBtn) {
    startBtn.click();
    await wait(300);
    check('开始后状态为轮询中', /轮询中|待命/.test(api.status().phase), api.status().phase);
    stopBtn.click();
    await wait(100);
    check('停止后状态为已停止', api.status().phase === '已停止', api.status().phase);
  }

  // ---- 清理：destroy 必须真正断开观察器 ----
  const titleBefore = listTitle.textContent;
  api.destroy();
  check('destroy 后面板已移除', !doc.getElementById('__grab_panel'));

  // 若 MutationObserver 没断开：panel 已脱离文档 -> panel.contains() 恒为 false
  // -> 下面这次新增卡片会触发 renderList，把标题从「（1）」改写成「（2）」。
  // 标题不变 => 观察器确实断了。
  const extra = doc.createElement('div');
  extra.innerHTML = '<div>[084-羽毛球][T9000005]李四</div>'
    + '<div>已选容量：0/60</div><button>选择</button>';
  doc.body.appendChild(extra);
  await wait(900);
  check('destroy 后观察器已断开（不再重建列表）',
    listTitle.textContent === titleBefore,
    `标题 "${titleBefore}" -> "${listTitle.textContent}"`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 面板版结果：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
