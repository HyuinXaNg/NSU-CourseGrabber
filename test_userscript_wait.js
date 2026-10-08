/* ============================================================================
 * 油猴版（grab_course.user.js）行为验证
 * ----------------------------------------------------------------------------
 * 同样的假选课页，但这次走面板：点「开始」后应进入准点待命，
 * 待命期间不能点任何按钮；到点后才点「选择」。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, 'grab_course.user.js'), 'utf8');

const t = new Date(Date.now() + 6000);
const p = (n) => String(n).padStart(2, '0');
const at = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;

let code = src.replace("atTime: '13:00:00'", `atTime: '${at}'`);
if (code === src) {
  console.error('✗ 没能替换 atTime 默认值');
  process.exit(1);
}
// 防止旧 localStorage 状态干扰：把持久化键前缀改掉
code = code.replace("'dnui_grab_state_v1'", "'dnui_grab_state_test'");

const html = `<!doctype html><html><body>
  <div id="card">
    <div>[083-羽毛球][T9000001]李老师</div>
    <div>已选容量：0/67</div>
    <button id="pick">选择</button>
  </div>
  <div id="dialog"><button id="decoy">确定</button></div>
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

const clicks = { decoy: 0, pick: 0 };
window.document.getElementById('decoy').addEventListener('click', () => clicks.decoy++);
window.document.getElementById('pick').addEventListener('click', () => clicks.pick++);

let clickLogs = 0;
const origLog = window.console.log.bind(window.console);
window.console.log = (...a) => {
  const line = a.map(String).join(' ');
  // 油猴版 attempt() 每点一次「选择」就打印一行「🎯 命中空位」
  if (/命中空位/.test(line)) clickLogs++;
  origLog(...a);
};

const el = window.document.createElement('script');
el.textContent = code;
window.document.body.appendChild(el);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

console.log(`\n目标时刻 atTime = ${at}（约 6 秒后开抢）`);

// 点面板上的「开始」
const startBtn = window.document.querySelector('[data-role="start"]');
if (!startBtn) { console.error('✗ 没找到面板的开始按钮'); process.exit(1); }
startBtn.click();
console.log('已点击面板「开始」\n');

setTimeout(() => {
  console.log(`[待命期 2.0s]  decoy=${clicks.decoy} pick=${clicks.pick}`);
  check('待命期未误点「确定」', clicks.decoy === 0, `decoy=${clicks.decoy}`);
  check('待命期未点「选择」', clicks.pick === 0, `pick=${clicks.pick}`);
}, 2000);

setTimeout(() => {
  console.log(`\n[待命期 4.0s]  decoy=${clicks.decoy} pick=${clicks.pick}`);
  check('待命期 4.0s 未误点「确定」', clicks.decoy === 0, `decoy=${clicks.decoy}`);
  check('待命期 4.0s 未点「选择」', clicks.pick === 0, `pick=${clicks.pick}`);
}, 4000);

setTimeout(() => {
  console.log(`\n[到点后 15s]   decoy=${clicks.decoy} pick=${clicks.pick} 脚本报告点击=${clickLogs} 次`);
  check('到点后点了「选择」', clicks.pick >= 1, `pick=${clicks.pick}`);
  check('每次点击只触发 1 个 click 事件', clicks.pick === clickLogs,
        `实际 click=${clicks.pick}，脚本报告=${clickLogs}`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 油猴版结果：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
}, 15000);
