/* ============================================================================
 * 抢课脚本行为验证（jsdom）
 * ----------------------------------------------------------------------------
 * 构造一个假选课页：
 *   #pick  羽毛球卡片的「选择」按钮   —— 到点后才该被点
 *   #decoy 内容为「确定」的无关按钮   —— 模拟筛选/协议弹窗，待命期绝不能碰
 *
 * 验证三件事：
 *   1. 准点待命期间，两个按钮都不被点击
 *   2. 到点后确实点击「选择」
 *   3. 每次「点击第 N 次」只产生 1 个 click 事件（不能是 2 个）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, 'grab_course.js'), 'utf8');

// 把 SYNC.at 设成约 6 秒后；因为只精确到秒，实际是 5~6 秒后，待命窗口足够观测
const t = new Date(Date.now() + 6000);
const p = (n) => String(n).padStart(2, '0');
const at = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
const code = src.replace("at: '13:00:00'", `at: '${at}'`);

if (code === src) {
  console.error('✗ 没能替换 SYNC.at，请检查 grab_course.js 里的默认值写法');
  process.exit(1);
}

const html = `<!doctype html><html><body>
  <div id="card">
    <div>[083-羽毛球][T9000001]李老师</div>
    <div>已选容量：0/67</div>
    <button id="pick">选择</button>
  </div>
  <div id="dialog"><button id="decoy">确定</button></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

// jsdom 不做布局，offsetParent 恒为 undefined，会让脚本的「可见性检查」全部跳过。
// 补上它，模拟真实浏览器里元素可见的情况。
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { return this.ownerDocument.body; },
  configurable: true,
});

// 统计点击次数
const clicks = { decoy: 0, pick: 0 };
window.document.getElementById('decoy').addEventListener('click', () => clicks.decoy++);
window.document.getElementById('pick').addEventListener('click', () => clicks.pick++);

// 统计脚本自己报告的「点击第 N 次」次数，用于比对是否重复触发
let clickLogs = 0;
const origLog = window.console.log.bind(window.console);
window.console.log = (...a) => {
  const line = a.map(String).join(' ');
  if (/点击「选择」第\s*\d+\s*\/\s*\d+\s*次/.test(line)) clickLogs++;
  origLog(...a);
};

const el = window.document.createElement('script');
el.textContent = code;
window.document.body.appendChild(el);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

console.log(`\n目标时刻 SYNC.at = ${at}（约 6 秒后开抢）\n`);

// ---- 待命期两次采样 ----
setTimeout(() => {
  console.log(`\n[待命期 2.0s]  decoy=${clicks.decoy} pick=${clicks.pick}`);
  check('待命期 2.0s 未误点「确定」', clicks.decoy === 0, `decoy=${clicks.decoy}`);
  check('待命期 2.0s 未点「选择」', clicks.pick === 0, `pick=${clicks.pick}`);
}, 2000);

setTimeout(() => {
  console.log(`\n[待命期 4.0s]  decoy=${clicks.decoy} pick=${clicks.pick}`);
  check('待命期 4.0s 未误点「确定」', clicks.decoy === 0, `decoy=${clicks.decoy}`);
  check('待命期 4.0s 未点「选择」', clicks.pick === 0, `pick=${clicks.pick}`);
}, 4000);

// ---- 到点后 ----
setTimeout(() => {
  console.log(`\n[到点后 15s]   decoy=${clicks.decoy} pick=${clicks.pick} 脚本报告点击=${clickLogs} 次`);
  check('到点后点了「选择」', clicks.pick >= 1, `pick=${clicks.pick}`);
  check('每次点击只触发 1 个 click 事件', clicks.pick === clickLogs,
        `实际 click=${clicks.pick}，脚本报告=${clickLogs}`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 结果：${results.length - bad.length}/${results.length} 通过 =====`);
  try { window.__GRAB__.stop(); } catch (_) { /* ignore */ }
  process.exit(bad.length ? 1 : 0);
}, 15000);
