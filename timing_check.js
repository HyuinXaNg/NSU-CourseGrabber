// 复刻脚本里的 parseDeadline / 逼近循环，验证落点精度
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;
function parseDeadline(at) {
  const m = String(at).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
  return d.getTime();
}
(async () => {
  console.log('parseDeadline("13:00:00") ->', new Date(parseDeadline('13:00:00')).toLocaleString('zh-CN'));
  console.log('parseDeadline("13:00")    ->', new Date(parseDeadline('13:00')).toLocaleString('zh-CN'));
  console.log('parseDeadline("")        ->', parseDeadline('')); 
  console.log('parseDeadline("abc")     ->', parseDeadline('abc'));
  // 用一个 3 秒后的假 deadline 验证逼近精度
  const target = Date.now() + 3000;
  let stopped = false;
  while (!stopped) {
    const remain = target - now();
    if (remain <= 0) break;
    if (remain > 300) await sleep(Math.min(remain - 200, 1000));
    else if (remain > 60) await sleep(20);
    else await sleep(5);
  }
  console.log('落点误差:', (now() - target), 'ms  (负数=提前，正数=滞后)');
})();
