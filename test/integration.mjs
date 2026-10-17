/**
 * 离线集成测试：用假 ctx 模拟 DSH 的钩子流水线。
 * 验证：清零、计数、分档、ask 触发、非持久化不计数。
 */
import { apply, isPersistent } from '../../confirm-gate/lib/index.js';

// ---- 假 ctx：只收集监听器 ----
const handlers = {};
const ctx = {
  on(event, fn) {
    handlers[event] = fn;
  },
};

apply(ctx, { freeLimit: 3, hardLimit: 5, confirmWord: 'dada' }); // 小阈值 + 自定义识别语

const agent = { id: 'fake-agent' };
const nextAllow = async () => ({ kind: 'accept' });

/** 模拟一次工具执行，返回 pre-execute 的决策 */
async function runTool(toolName) {
  const exec = { name: toolName, agent, arguments: {} };
  return handlers['tools/pre-execute'](exec, nextAllow);
}

/** 模拟一次 post-execute，返回注入的通知文本 */
async function runPost(toolName) {
  const exec = { name: toolName, agent, arguments: {} };
  const out = await handlers['tools/post-execute'](exec, {}, nextAllow);
  const notice = out?.additionalContexts?.[0];
  return notice?.content?.[0]?.text;
}

/** 模拟新一轮用户消息到达 */
async function newUserTurn() {
  return handlers['agent/pre-step'](
    { agent, messages: [{ id: 'm1', role: 'user', source: { kind: 'user' } }] },
    nextAllow,
  );
}

/** 模拟用户只回了一句确认（内容可指定） */
async function confirmTurn(text = 'dada') {
  return handlers['agent/pre-step'](
    {
      agent,
      messages: [{ id: 'mc', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    },
    nextAllow,
  );
}

/** 模拟用户发来带内容的真实新任务 */
async function taskTurn(text = '帮我改一下配置文件') {
  return handlers['agent/pre-step'](
    {
      agent,
      messages: [{ id: 'mt', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    },
    nextAllow,
  );
}

const results = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

async function main() {
  // 新一轮开始
  await newUserTurn();

  console.log('--- 持久化操作 1..5（freeLimit=3, hardLimit=5）---');
  const decisions = [];
  const notices = [];
  for (let i = 1; i <= 5; i++) {
    const d = await runTool('write');
    const t = await runPost('write');
    decisions.push(d?.kind ?? 'allow');
    notices.push(t);
    console.log(`  #${i} 决策=${d?.kind ?? 'allow'}  通知=${t ? t.slice(0, 30) + '…' : '(无)'}`);
  }

  check('第1-3次放行', decisions.slice(0, 3), ['accept', 'accept', 'accept']);
  check('第4-5次索要confirm', decisions.slice(3, 5), ['accept', 'ask']);
  check('第1次有提醒', typeof notices[0], 'string');
  const askDecision = await runTool('write');
  check('第4次是指令且含识别语', notices[3].includes('立即停止') && notices[3].includes('dada'), true);
  check('ask 理由含识别语', String(askDecision?.reason).includes('dada'), true);

  console.log('\n--- 非持久化操作不计数 ---');
  const before = notices.length;
  for (let i = 0; i < 20; i++) await runTool('read');
  const afterRead = await runTool('write'); // 第6次（计数已到5，再+1=6）
  console.log(`  读20次后，write 决策=${afterRead?.kind ?? 'allow'}（应仍为 ask，说明读没清零也没增计）`);
  check('读不重置也不累加', afterRead?.kind, 'ask');

  console.log('\n--- 新用户消息（真实任务）重置计数 ---');
  await taskTurn();
  const afterReset = await runTool('write');
  console.log(`  真实任务后 write 决策=${afterReset?.kind ?? 'accept'}`);
  check('真实新任务重置计数', afterReset?.kind ?? 'accept', 'accept');

  console.log('\n--- 只回一句确认时，计数应保留（resetOnConfirm 默认 false）---');
  // 先推到 ask 档：freeLimit=3, hardLimit=5
  for (let i = 0; i < 5; i++) await runTool('write');
  const beforeConfirm = await runTool('write');
  check('耗尽后为 ask', beforeConfirm?.kind, 'ask');
  await confirmTurn('dada'); // 只回识别语
  const afterConfirmOnly = await runTool('write');
  check('仅确认不重置，仍为 ask', afterConfirmOnly?.kind, 'ask');

  console.log('\n--- 带内容的确认语句不应被误判为「仅确认」---');
  await confirmTurn('dada，顺便把这个也改了'); // 含识别语但有其他内容
  const afterMixed = await runTool('write');
  check('含其他内容视为新任务，回到额度内', afterMixed?.kind ?? 'accept', 'accept');

  console.log('\n--- 分类函数 ---');
  check('read 非持久化', isPersistent('read'), false);
  check('write 持久化', isPersistent('write'), true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} (${results.length} checks) =====`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
