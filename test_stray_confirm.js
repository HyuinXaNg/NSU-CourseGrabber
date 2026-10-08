/* ============================================================================
 * 安全约束验证：页面上没有目标课程时，绝不能乱点无关的「确定」按钮
 * ----------------------------------------------------------------------------
 * 场景：选课页有筛选/协议弹窗的「确定」键（不在任何弹窗容器内），
 *       但页面上没有羽毛球。脚本已经 armed（立即开抢模式），
 *       此时它不应该点任何东西。
 *
 * 旧行为（无 recent/inDialog 约束）：会每 600ms 点一次「确定」，非常危险
 * —— 万一那是「退课确认」键，就会把课退掉。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, 'grab_course.js'), 'utf8');

// 让 SYNC.at 指向一个早已过去的时刻 -> 走「已过去很久，改为立即轮询」分支，立刻 armed
const code = src
  .replace("at: '13:00:00'", "at: '00:00:01'")
  .replace('VERBOSITY: \'normal\'', 'VERBOSITY: \'verbose\'');

if (code === src) { console.error('✗ 替换失败'); process.exit(1); }

// 注意：没有羽毛球卡片，只有一堆无关的「确定/确认/提交」按钮
const html = `<!doctype html><html><body>
  <div id="filterbar">
    <input id="kw" value="">
    <button id="decoy1">确定</button>
    <button id="decoy2">确认</button>
    <button id="decoy3">提交</button>
  </div>
  <div id="card">
    <div>[076-篮球][T9000004]张三</div>
    <div>已选容量：0/60</div>
    <button id="other">选择</button>
  </div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://xk.dnui.edu.cn/xsxk/elective/grablesson?batchId=test',
});
const { window } = dom;

Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; },
  configurable: true,
});

const hits = { decoy1: 0, decoy2: 0, decoy3: 0, other: 0 };
for (const id of Object.keys(hits)) {
  window.document.getElementById(id).addEventListener('click', () => hits[id]++);
}

const el = window.document.createElement('script');
el.textContent = code;
window.document.body.appendChild(el);

console.log('\n等待 4 秒，观察是否会乱点无关按钮…\n');

setTimeout(() => {
  console.log(`无关「确定」=${hits.decoy1}  「确认」=${hits.decoy2}  「提交」=${hits.decoy3}  非目标「选择」=${hits.other}`);
  const stray = hits.decoy1 + hits.decoy2 + hits.decoy3 + hits.other;
  const ok = stray === 0;
  console.log(ok
    ? '✓ 没有点击任何无关按钮（安全约束生效）'
    : `❌ 乱点了 ${stray} 次无关按钮`);

  try { window.__GRAB__.stop(); } catch (_) { /* ignore */ }
  console.log(`\n===== 安全约束：${ok ? '通过' : '失败'} =====`);
  process.exit(ok ? 0 : 1);
}, 4000);
