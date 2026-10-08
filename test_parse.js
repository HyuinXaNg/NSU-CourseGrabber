/* 解析逻辑自测：用选课页面真实出现的卡片文案，验证脚本里的正则能正确识别
 * 运行： node test_parse.js
 * 说明：直接从 grab_course.js 里「抠出」真实的正则来测，避免测试与实现脱节。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'grab_course.js'), 'utf8');

/** 从源码中取出 `const NAME = <正则>;` 这一行里的正则字面量 */
function extractRe(name) {
  const line = SRC.split(/\r?\n/).find((l) => l.includes(`const ${name} =`));
  if (!line) throw new Error(`源码里找不到 ${name}`);
  const body = line.slice(line.indexOf('=') + 1, line.lastIndexOf(';')).trim();
  // eslint-disable-next-line no-eval
  return eval(body);
}

const LABEL_RE = extractRe('LABEL_RE');
const RATIO_RE = extractRe('RATIO_RE');
const LEFT_RE = extractRe('LEFT_RE');

/** 复刻 grab_course.js 里 parseCard 的逻辑（保持同步） */
function parseCard(cardText) {
  const text = cardText.replace(/\s+/g, ' ');
  const m = text.match(LABEL_RE);
  if (!m) return null;
  const info = { index: m[1], course: m[2], teacherId: m[3], teacher: (m[4] || '').trim(), used: null, cap: null, left: null, free: null };
  const r = text.match(RATIO_RE);
  if (r) { info.used = Number(r[1]); info.cap = Number(r[2]); }
  const l = text.match(LEFT_RE);
  if (l) info.left = Number(l[1]);
  if (info.left !== null) info.free = info.left > 0;
  else if (info.used !== null && info.cap !== null) info.free = info.used < info.cap;
  return info;
}

/* ------------------------------ 用例 ------------------------------ */

// 卡片文案按真实页面文案拼装：标题 / 承担单位 / 周次时间 / 已选容量 / 两个按钮
const card = (title, unit, time, cap) => `${title} 承担单位：${unit} ${time} ${cap} 教学班详情 选择`;

const cases = [
  {
    name: '羽毛球（083，有空位）',
    text: card('[083-羽毛球][T9000001]李老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节|T9000001', '已选容量：0/67'),
    want: { index: '083', course: '羽毛球', teacher: '李老师', used: 0, cap: 67, free: true },
  },
  {
    name: '篮球（076，有空位）',
    text: card('[076-篮球][T9000002]王老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节|T9000002', '已选容量：0/67'),
    want: { index: '076', course: '篮球', teacher: '王老师', used: 0, cap: 67, free: true },
  },
  {
    name: '女子篮球（079，名字带前缀）',
    text: card('[079-女子篮球][T9000003]赵老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节|T9000003', '已选容量：0/67'),
    want: { index: '079', course: '女子篮球', teacher: '赵老师', used: 0, cap: 67, free: true },
  },
  {
    name: '已满（67/67 应判为无空位）',
    text: card('[083-羽毛球][T9000001]李老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节|T9000001', '已选容量：67/67'),
    want: { index: '083', course: '羽毛球', teacher: '李老师', used: 67, cap: 67, free: false },
  },
  {
    name: '剩 1 个名额（66/67 应判为有空位）',
    text: card('[083-羽毛球][T9000001]李老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节|T9000001', '已选容量：66/67'),
    want: { index: '083', course: '羽毛球', teacher: '李老师', used: 66, cap: 67, free: true },
  },
  {
    name: '半角冒号 + 空格容错',
    text: '[083-羽毛球][T9000001]李老师 承担单位：健康医疗科技学院 已选容量: 0 / 67 选择',
    want: { index: '083', course: '羽毛球', teacher: '李老师', used: 0, cap: 67, free: true },
  },
  {
    name: '只显示「剩余名额」的排版',
    text: '[083-羽毛球][T9000001]李老师 承担单位：健康医疗科技学院 剩余名额：5 选择',
    want: { index: '083', course: '羽毛球', teacher: '李老师', left: 5, free: true },
  },
  {
    name: '「剩余名额：0」应判为无空位',
    text: '[083-羽毛球][T9000001]李老师 承担单位：健康医疗科技学院 剩余名额：0 选择',
    want: { index: '083', course: '羽毛球', teacher: '李老师', left: 0, free: false },
  },
  {
    name: '目标匹配：羽毛球不应误伤篮球',
    text: card('[076-篮球][T9000002]王老师', '健康医疗科技学院', '1-16周|星期五|第6节|第7节', '已选容量：0/67'),
    wantCourse: '篮球',
    assertOnly: (info) => info.course.includes('羽毛球') === false,
  },
];

/* ------------------------------ 执行 ------------------------------ */

let pass = 0;
let fail = 0;

for (const c of cases) {
  const got = parseCard(c.text);
  const problems = [];

  if (!got) {
    problems.push('解析结果为 null');
  } else {
    for (const [k, v] of Object.entries(c.want || {})) {
      if (got[k] !== v) problems.push(`${k}: 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(got[k])}`);
    }
    if (c.assertOnly && !c.assertOnly(got)) problems.push('assertOnly 断言失败');
  }

  if (problems.length) {
    fail++;
    console.log(`✗ ${c.name}`);
    for (const p of problems) console.log(`    ${p}`);
    console.log(`    实际解析: ${JSON.stringify(got)}`);
  } else {
    pass++;
    console.log(`✓ ${c.name}`);
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
