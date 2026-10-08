/* 校验 destroy 测试是否具备区分能力：
 * 同一段 destroy 场景，分别跑「修复版」和「故意去掉 mo.disconnect() 的版本」。
 * 两者结果必须不同，否则说明测试是假通过。
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync('grab_course.ui.js', 'utf8');

/* 拆除后不再渲染列表，代码里有三层独立保护：
 *   1) destroy() 里的 clearTimeout + mo.disconnect()
 *   2) 观察器回调开头的 if (destroyed || busy) return;
 *   3) 延迟回调里的 if (destroyed) return;
 * 任意一层都能单独挡住，所以只剥一层测不出差别 —— 必须三层全剥，
 * 才能验证这个断言确实有能力识别"完全没保护"的情况。
 */
let n = 0;
const strip = (re, to, src2) => src2.replace(re, () => { n++; return to; });

let broken = src;
broken = strip(/destroyed = true;/, '', broken);
broken = strip(/if \(destroyed\) return;\s*/, '', broken);
broken = strip(/if \(destroyed \|\| busy\) return;/, 'if (busy) return;', broken);
broken = strip(/try \{\s*if \(mo\) \{\s*clearTimeout\(mo\._t\);\s*mo\.disconnect\(\);\s*\}\s*\} catch \(_\) \{ \/\* ignore \*\/ \}/, '', broken);

console.log(`已剥除 ${n} 处保护代码（应为 4），构造出"完全无保护版本":`, broken !== src, '\n');
if (n !== 4) { console.error('✗ 没能正确构造坏版本，校验无意义'); process.exit(1); }

const HTML = `<!doctype html><html><body>
  <div><div>[083-羽毛球][A1]李老师</div><div>已选容量：0/67</div><button>选择</button></div>
</body></html>`;

async function run(code, label) {
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

  const s = d.createElement('script');
  s.textContent = code;
  d.body.appendChild(s);
  await new Promise((r) => setTimeout(r, 300));

  const title = d.querySelector('#__grab_list_title');
  const before = title.textContent;

  w.__GRAB_UI__.destroy();

  // 往页面加第二门羽毛球：观察器若还活着，会把标题改写成（2）
  const ex = d.createElement('div');
  ex.innerHTML = '<div>[084-羽毛球][A2]李四</div><div>已选容量：0/60</div><button>选择</button>';
  d.body.appendChild(ex);
  await new Promise((r) => setTimeout(r, 900));

  const after = title.textContent;
  const passed = after === before;
  console.log(`${label}  "${before}" -> "${after}"   ${passed ? '通过（观察器已断）' : '失败（观察器还活着）'}`);
  return passed;
}

(async () => {
  const a = await run(src, '修复版        ');
  const b = await run(broken, '去掉断开的版本');
  console.log('');
  if (a && !b) console.log('✓ 测试有区分能力：修复版通过，去掉断开的版本失败');
  else console.log('✗ 测试无效：两种版本结果相同，说明这个断言测不出问题');
  process.exit(a && !b ? 0 : 1);
})();
