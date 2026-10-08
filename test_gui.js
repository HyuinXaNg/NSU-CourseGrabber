/* ============================================================================
 * GUI 版（grab_course.gui.js）验证
 * ----------------------------------------------------------------------------
 * 用户的两个核心要求：
 *   1. 界面有「手动点击开始抢课」按钮，点了脚本就运行
 *   2. 运行结束后，显示抢课是否成功
 *
 * 因此重点验证结果状态条的四种结局：
 *   未开始 → 抢课中 → ✅ 抢课成功 / ⛔ 未抢到（并说明原因）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const code = fs.readFileSync(path.join(__dirname, 'grab_course.gui.js'), 'utf8');

const card = (idx, name, teacher, used, cap) => `
  <div class="c"><div>[${idx}-${name}][A${idx}]${teacher}</div>
    <div>已选容量：${used}/${cap}</div><button id="pick${idx}">选择</button></div>`;

/** 带成功提示的页面：点「选择」后弹出成功 toast */
const pageOk = `<!doctype html><html><body>
  ${card('083', '羽毛球', '李老师', 0, 67)}
  <script>
    document.getElementById('pick083').addEventListener('click', function () {
      if (document.querySelector('.el-message')) return;
      var t = document.createElement('div');
      t.className = 'el-message'; t.textContent = '选课成功';
      document.body.appendChild(t);
    });
  <\/script>
</body></html>`;

/** 无任何反馈的页面 */
const pageSilent = `<!doctype html><html><body>
  ${card('083', '羽毛球', '李老师', 0, 67)}
</body></html>`;

/** 已满员的页面 */
const pageFull = `<!doctype html><html><body>
  ${card('083', '羽毛球', '李老师', 67, 67)}
</body></html>`;

/** 没有目标课程的页面 */
const pageEmpty = `<!doctype html><html><body>
  ${card('076', '篮球', '张三', 0, 60)}
</body></html>`;

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
  return { w, d };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`);
};

async function boot(html) {
  const { w, d } = makeDom(html);
  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
  await wait(200);
  return { w, d };
}

(async () => {
  /* ---------- 1. 界面元素 ---------- */
  console.log('\n[1] 界面元素');
  {
    const { w, d } = await boot(pageSilent);
    check('面板已注入 (#__grab_gui)', !!d.getElementById('__grab_gui'));

    const startBtn = d.getElementById('__grab_start');
    check('存在「开始抢课」按钮', !!startBtn, startBtn ? startBtn.textContent : '');

    const rb = d.getElementById('__grab_result');
    check('存在结果状态条 (#__grab_result)', !!rb);
    check('初始显示「未开始」', /未开始/.test(rb.textContent), rb.textContent.replace(/\s+/g, ' '));

    check('暴露 __GRAB_GUI__', !!w.__GRAB_GUI__);
    check('课程列表定位到 1 门', d.querySelectorAll('#__grab_list [data-role="grab"]').length === 1);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 2. 点「开始抢课」后脚本运行 ---------- */
  console.log('\n[2] 点「开始抢课」→ 脚本运行');
  {
    const { w, d } = await boot(pageSilent);
    const clicks = { n: 0 };
    d.getElementById('pick083').addEventListener('click', () => clicks.n++);

    d.getElementById('__grab_start').click();
    await wait(400);
    check('状态变为「抢课中」', w.__GRAB_GUI__.result().state === 'run',
      w.__GRAB_GUI__.result().state);
    await wait(600);
    check('确实点击了「选择」', clicks.n >= 1, `点击 ${clicks.n} 次`);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 3. 成功 → 显示「抢课成功」 ---------- */
  console.log('\n[3] 抢到了 → 显示是否成功');
  {
    const { w, d } = await boot(pageOk);
    d.getElementById('__grab_start').click();
    await wait(1200);

    const r = w.__GRAB_GUI__.result();
    check('结果状态为 ok', r.state === 'ok', r.state);
    check('记录了课程与老师', r.course === '羽毛球' && r.teacher === '李老师',
      `${r.course} / ${r.teacher}`);

    const text = d.getElementById('__grab_result').textContent;
    check('状态条显示「抢课成功」', /抢课成功/.test(text));
    check('状态条显示课程名', /羽毛球/.test(text));
    check('成功后自动停止', w.__GRAB_GUI__.result().state === 'ok');
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 4. 没抢到（无反馈后停止）→ 显示失败与原因 ---------- */
  console.log('\n[4] 没抢到 → 显示失败与原因');
  {
    const { w, d } = await boot(pageSilent);
    d.getElementById('__grab_start').click();
    await wait(800);
    d.querySelectorAll('#__grab_gui button').forEach((b) => {
      if (/停止/.test(b.textContent)) b.click();
    });
    await wait(200);

    const r = w.__GRAB_GUI__.result();
    check('结果状态为 fail', r.state === 'fail', r.state);
    check('给出了原因', !!r.detail, r.detail);
    const text = d.getElementById('__grab_result').textContent;
    check('状态条显示「未抢到」', /未抢到/.test(text));
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 5. 课程已满 → 原因应指出满员 ---------- */
  console.log('\n[5] 课程已满 → 原因指出满员');
  {
    const { w, d } = await boot(pageFull);
    const clicks = { n: 0 };
    d.getElementById('pick083').addEventListener('click', () => clicks.n++);

    d.getElementById('__grab_start').click();
    await wait(2500);
    d.querySelectorAll('#__grab_gui button').forEach((b) => {
      if (/停止/.test(b.textContent)) b.click();
    });
    await wait(200);

    const r = w.__GRAB_GUI__.result();
    check('满员时不点「选择」', clicks.n === 0, `点击 ${clicks.n} 次`);
    check('原因为「已满员」', /满员/.test(r.detail), r.detail);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 6. 找不到课程 → 原因提示检查标签页 ---------- */
  console.log('\n[6] 找不到课程 → 提示检查标签页');
  {
    const { w, d } = await boot(pageEmpty);
    d.getElementById('__grab_start').click();
    await wait(800);
    d.querySelectorAll('#__grab_gui button').forEach((b) => {
      if (/停止/.test(b.textContent)) b.click();
    });
    await wait(200);

    const r = w.__GRAB_GUI__.result();
    check('原因为「找不到课程」', /找不到|体育项目/.test(r.detail), r.detail);
    w.__GRAB_GUI__.destroy();
  }

  /* ---------- 7. destroy 清理 ---------- */
  console.log('\n[7] destroy 清理');
  {
    const { w, d } = await boot(pageSilent);
    // 注意：必须先拿到元素引用。panel.remove() 之后 #__grab_list_title
    // 已脱离文档，d.querySelector 会返回 null，再取 .textContent 就抛 TypeError。
    const titleEl = d.querySelector('#__grab_list_title');
    const titleBefore = titleEl.textContent;

    w.__GRAB_GUI__.destroy();
    check('面板已移除', !d.getElementById('__grab_gui'));

    const extra = d.createElement('div');
    extra.innerHTML = '<div>[084-羽毛球][A2]李四</div><div>已选容量：0/60</div><button>选择</button>';
    d.body.appendChild(extra);
    await wait(900);
    check('destroy 后观察器已断开（不再重建列表）',
      titleEl.textContent === titleBefore,
      `标题 "${titleBefore}" -> "${titleEl.textContent}"`);
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== GUI 版结果：${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
})();
