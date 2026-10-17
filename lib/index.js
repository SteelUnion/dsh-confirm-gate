/**
 * @sroada/dsh-confirm-gate
 *
 * 单轮持久化操作计数与 confirm 门。
 *
 * 设计约束（Frank 亲定）：
 *   - 计数粒度为「单轮」：一条 user 消息到达即清零，回复完成为一轮结束。
 *   - 非持久化操作（读、列目录、搜索、查状态）不计数、不提醒、不拦。
 *   - 持久化操作按次数分三档：
 *       count <= freeLimit           → allow，静默
 *       freeLimit < count < hardLimit → allow，执行后注入提醒
 *       count >= hardLimit            → ask（索要 confirm）
 *   - 阈值与全部提示语均可配置。
 *
 * 挂载点：
 *   tools/pre-execute  → 计数 + 分档决策（拦在这里，因为此时还能看到工具名与参数）
 *   tools/post-execute → 注入提醒通知（不否决，只补上下文）
 *   agent/pre-step     → 出现新的 user 消息即清零计数
 *
 * @module @sroada/dsh-confirm-gate
 */

export const name = 'confirm-gate';

// ---- 诊断探针 ----
// 用 node:fs 的 ESM 导入，避免本包是 ESM 时 require 不可用。
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 探针开关。设为 true 会在系统临时目录下的 confirm-gate-boot.log
// 记录模块加载与钩子命中，用于排查「插件没生效」类问题。
// 正常使用保持 false，避免持续写磁盘。
const DEBUG_PROBE = true;
/** 探针日志路径：系统临时目录，各平台自动适配。 */
const PROBE_PATH = join(tmpdir(), 'confirm-gate-boot.log');
function probe(msg) {
  if (!DEBUG_PROBE) return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  // 通道 1：stderr（DSH 会把插件 stderr 打到终端）
  try {
    process.stderr.write(`[confirm-gate] ${line}`);
  } catch {
    /* ignore */
  }
  // 通道 2：文件
  try {
    appendFileSync(PROBE_PATH, line);
  } catch {
    /* ignore */
  }
}
// ---- 探针结束 ----

// 模块级加载标记：写在 apply() 之前。
// 若日志里连这条都没有，说明模块根本没被 import —— 问题在加载侧，
// 不在插件逻辑里。这一行就是为了把这两种情况分开。
probe(
  `MODULE LOADED pid=${process.pid} cwd=${process.cwd()} node=${process.version} ` +
    `file=${import.meta.url}`,
);

/**
 * 只读 cmdlet 白名单。
 *
 * 判定原则：**不做 PowerShell 语法解析**，只提取命令名做集合比对。
 * 拿不准就判持久化 —— 只会多拦，不会漏拦。
 *
 * 一条 pwsh 命令被认定为「非持久化」，必须同时满足：
 *   1. 不含任何写入指标（见 WRITE_INDICATORS）
 *   2. 不含调用外部程序的 `&`
 *   3. 每一个命令名都在本白名单内
 *   4. 不含变量赋值以外的语句（赋值视为读，允许）
 */
const READONLY_CMDLETS = new Set([
  // 读取类
  'get-childitem', 'get-item', 'get-content', 'test-path', 'resolve-path',
  'split-path', 'join-path', 'convert-path', 'get-location',
  'get-process', 'get-ciminstance', 'get-wmiobject', 'get-service',
  'get-command', 'get-module', 'get-variable', 'get-help',
  'get-itemproperty', 'get-filehash', 'get-acl', 'get-date',
  'get-host', 'get-psdrive', 'get-member', 'get-unique', 'get-random',
  // 管道处理
  'select-object', 'where-object', 'foreach-object', 'sort-object',
  'group-object', 'measure-object', 'format-table', 'format-list',
  'format-wide', 'format-custom', 'select-string', 'compare-object',
  'tee-object', 'out-string', 'out-host', 'out-null',
  // 输出
  'write-output', 'write-host', 'write-verbose', 'write-warning', 'write-error',
  // 字符串/数值
  'join-string', 'split', 'replace', 'trim', 'tolower', 'toupper',
  'contains', 'startswith', 'endswith', 'substring', 'indexof', 'length',
  // 其他无副作用
  'start-sleep', 'set-location', 'push-location', 'pop-location',
]);

/**
 * 出现即判定持久化的指标。
 * 重定向、写入型 cmdlet、外部调用、代码执行。
 */
const WRITE_INDICATORS = [
  /\|?\s*>{1,2}/, // > 或 >> 重定向
  /\|?\s*<\s/, // < 输入重定向
  /\bout-file\b/i,
  /\bset-content\b/i,
  /\badd-content\b/i,
  /\bclear-content\b/i,
  /\bnew-item\b/i,
  /\bremove-item\b/i,
  /\bcopy-item\b/i,
  /\bmove-item\b/i,
  /\brename-item\b/i,
  /\bset-item\b/i,
  /\bset-itemproperty\b/i,
  /\bnew-object\b/i,
  /\binvoke-expression\b/i,
  /\binvoke-webrequest\b/i,
  /\binvoke-restmethod\b/i,
  /\biex\b/i,
  /\bstart-process\b/i,
  /\bstop-process\b/i,
  /\bremove-\w+/i,
  /\binstall-\w+/i,
  /\buninstall-\w+/i,
  /\bimport-module\b/i,
  /\bgit\b/i, // git 可能改仓库，一律按持久化
  /\bcmd\b/i,
  /\bnode\b/i,
  /\bpython\b/i,
  /\bnpm\b/i,
  /\bpnpm\b/i,
  /&/, // 调用外部程序（函数内联 `$x.foo()` 也会命中，宁可多拦）
];

/**
 * 判断一条 pwsh 命令是否只读。
 * @param command - exec.arguments.command 原文
 * @returns true 表示只读（不计数）
 */
function isReadOnlyPwshCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return false;

  // 1) 写入指标先扫一遍：命中任一即判持久化
  for (const re of WRITE_INDICATORS) {
    if (re.test(command)) return false;
  }

  // 2) 拆分语句，逐段取首 token 作为命令名
  //    分隔符：; | && || 换行 { }
  const segments = command.split(/[;|\r\n{}]+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  for (const seg of segments) {
    const tok = seg.split(/\s+/)[0] ?? '';
    // 变量赋值、纯字面量、括号表达式：不构成命令，视为读
    if (/^\$[\w:.]+$/.test(tok)) continue;
    if (/^[(\[]/.test(tok)) continue;
    if (/^["'@]/.test(tok)) continue;
    if (/^-/.test(tok)) continue;

    const name = tok.toLowerCase();
    if (!READONLY_CMDLETS.has(name)) return false;
  }
  return true;
}

/**
 * 命令类工具：参数中带 `command` 字段，按命令内容判定持久性。
 * 其余工具（write/edit/read…）按工具名判定。
 */
const COMMAND_TOOLS = new Set(['pwsh', 'pwsh-persistent', 'bash', 'bash-persistent', 'terminal', 'exec']);

/**
 * 一个工具名是否属于「持久化」操作。
 *
 * 判定口径：动作结束后世界是否被改变。
 * 读是非持久化，写是持久化；命令按内容判定（见 isReadOnlyPwshCommand）。
 */
const PERSISTENT_EXACT = new Set([
  // 文件写入类
  'write',
  'edit',
  'str-replace',
  'str-replace-editor',
  'apply-patch',
  'notebook-edit',
  // 执行类（命令**默认**按持久化处理，只读命令由下面放行）
  'pwsh',
  'pwsh-persistent',
  'bash',
  'bash-persistent',
  'terminal',
  'exec',
  'process',
  // 派发类（子代理与工作流会把持久化动作传递下去）
  'subagent',
  'subagent-fork',
  'workflow',
  // 外发类
  'web-fetch-post',
  'webhook-dispatch',
  'message-send',
]);

/**
 * 名称以这些片段结尾的，一律视为持久化。
 * 用于兜住 future 新增工具的常见命名。
 */
const PERSISTENT_SUFFIX = [
  'write',
  'edit',
  'delete',
  'remove',
  'move',
  'publish',
  'deploy',
  'commit',
  'push',
];

/**
 * 明确的非持久化工具，优先级最高（先于后缀规则）。
 * 这些即使名字里带 write/edit 也不拦。
 */
const NON_PERSISTENT = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'list',
  'find',
  'search',
  'status',
  'present',
  'todo-write', // 只改会话内进度，不落盘
  'web-search',  // 注：web-search 不改变外部世界，从持久化集合中剔除
  'web-fetch',
  'get-goal',
  'ask-user-question',
  'load-workspace-dependencies',
  'job-list',
  'job-output',
]);

/**
 * 判断一次工具调用是否持久化。
 *
 * @param toolName - exec.name
 * @param exec - 可选的完整 exec。给出时对命令类工具做内容判定。
 * @returns true 表示持久化（应计数）
 */
export function isPersistent(toolName, exec) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  if (NON_PERSISTENT.has(toolName)) return false;

  // 命令类工具：按命令内容判定。只读命令直接放行，不计数。
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = exec?.arguments?.command;
    if (typeof cmd === 'string' && isReadOnlyPwshCommand(cmd)) return false;
    return true;
  }

  if (PERSISTENT_EXACT.has(toolName)) return true;
  const lower = toolName.toLowerCase();
  return PERSISTENT_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

/**
 * 校验并归一化阈值。
 * fail-loud：配置写错时立刻抛，不静默退化成「永不拦截」。
 */
function validateConfig(config) {
  const freeLimit = config?.freeLimit ?? 10;
  const hardLimit = config?.hardLimit ?? 15;
  if (!Number.isInteger(freeLimit) || freeLimit < 0) {
    throw new Error(`confirm-gate: freeLimit 必须是 >= 0 的整数，收到 ${freeLimit}`);
  }
  if (!Number.isInteger(hardLimit) || hardLimit < 1) {
    throw new Error(`confirm-gate: hardLimit 必须是 >= 1 的整数，收到 ${hardLimit}`);
  }
  if (hardLimit <= freeLimit) {
    throw new Error(
      `confirm-gate: hardLimit (${hardLimit}) 必须大于 freeLimit (${freeLimit})，否则提醒区为空`,
    );
  }
  return {
    freeLimit,
    hardLimit,
    confirmWord: validateConfirmWord(config?.confirmWord ?? DEFAULT_CONFIRM_WORD),
    reminderText: config?.reminderText ?? DEFAULT_REMINDER,
    warningText: config?.warningText ?? DEFAULT_WARNING,
    deniedText: config?.deniedText ?? DEFAULT_DENIED,
    askReason: config?.askReason ?? DEFAULT_ASK_REASON,
    include: config?.include ?? [],
    exclude: config?.exclude ?? [],
    resetOnUserMessage: config?.resetOnUserMessage ?? true,
    // 默认 false：用户回一句 confirm 不应被算作「新一轮任务」，
    // 否则确认一次就能再白拿一整轮额度，硬上限形同虚设。
    resetOnConfirm: config?.resetOnConfirm ?? false,
  };
}

/**
 * 判断一条用户消息是否只是「确认」。
 * 只认识别语本身（大小写不敏感，允许前后空白与标点）。
 */
function isConfirmOnly(text, confirmWord) {
  if (typeof text !== 'string') return false;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`「『【(\[]+|[\s"'`」』】)\]。．.!！?？,，、;；:：]+$/g, '');
  return normalized === confirmWord.trim().toLowerCase();
}

/**
 * 判断一条用户消息是否**包含**识别语（不要求整句匹配）。
 *
 * 语义：用户消息里出现配置的 confirmWord，即视为对本轮放行。
 * 大小写不敏感。识别语本身可以在配置文件里替换。
 */
function containsConfirm(text, confirmWord) {
  if (typeof text !== 'string') return false;
  const word = confirmWord.trim().toLowerCase();
  if (word.length === 0) return false;
  return text.toLowerCase().includes(word);
}

/**
 * 校验识别语。
 * 识别语会原样出现在注入给我的指令里，必须非空且不含换行，
 * 否则会破坏通知文本结构。
 */
function validateConfirmWord(word) {
  if (typeof word !== 'string' || word.trim().length === 0) {
    throw new Error('confirm-gate: confirmWord 必须是非空字符串');
  }
  if (/[\r\n]/.test(word)) {
    throw new Error('confirm-gate: confirmWord 不能包含换行');
  }
  return word.trim();
}

export const DEFAULT_CONFIRM_WORD = 'confirm';
export const DEFAULT_REMINDER =
  '警告，无confirm持久化操作。请向用户索要confirm。';
/**
 * 超过 freeLimit 后的注入文本。
 * 语义是**指令**而非提醒：立即停止一切无 confirm 的持久化操作。
 */
export const DEFAULT_WARNING =
  '指令：立即停止所有无 confirm 的持久化操作。不得再执行写入、改文件、执行命令、派发子代理或外发。转而向用户汇报当前进展、缺口与方案，并索要 confirm。';
export const DEFAULT_DENIED =
  'persistent operation limit reached; ask the user for confirm before continuing.';
export const DEFAULT_ASK_REASON =
  '持久化操作次数已达上限，需要用户 confirm 才能继续。';

/** 把 * 通配编译成锚定正则，其余元字符按字面匹配。 */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
}

/**
 * 生成本插件注入消息的稳定唯一 id。
 * 不依赖外部 uuid 库；会话内唯一即可。
 */
let noticeSeq = 0;
function noticeId() {
  noticeSeq += 1;
  return `confirm-gate-${Date.now().toString(36)}-${noticeSeq}`;
}

/**
 * 已被沙盒接管的模式。
 *
 * 定位决定：本插件是「没人管的时候给一把尺」。
 * 这两种模式下边界已被 DSH 自己拦住，再加一层计数只会把正常操作也拦一次。
 *
 * 除此之外的一切（danger-full-access、custom、undefined、未知字符串）都生效：
 * 那些情况下没有任何东西在管边界，正需要本插件。
 */
export const SANDBOX_MANAGED_MODES = new Set(['read-only', 'workspace-write']);

/**
 * 读取**会话当前**的沙箱模式。
 *
 * 数据来源按优先级：
 *   1. `ctx.sessionProjections.stateOf(session, 'permissions').sandbox`
 *      —— 会话当前的旋钮值。热切换权限模式时它会立刻变。
 *   2. `ctx.shell.sandboxMode`
 *      —— executor 的**默认**模式。官方注释写明是 "this executor applies by
 *      default"，不随热切换变化，只作为回退。
 *
 * 这个区分是必须的：只用默认值的话，会话里切到沙盒再切回来，插件读到的
 * 永远是启动时的那个值，行为完全错位。
 *
 * 全程 try：属性访问在某些 ctx 形态下会抛注入门错误（cordis 的依赖注入是惰性的，
 * 直接访问没声明 inject 的服务属性会抛）。所以这里一律用 `ctx.get(name)`
 * 做**软探测**，拿不到就返回 undefined，不抛。
 *
 * @param ctx - 插件上下文。
 * @param session - 本次调用所属会话，可缺省。
 * @returns {{ mode: string|undefined, known: boolean, source: string }}
 */
function readSandboxMode(ctx, session) {
  // 0) 会话投影：当前值（最准，热切换跟着它变）
  if (session !== undefined && session !== null) {
    try {
      const sp = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : ctx?.sessionProjections;
      if (sp !== undefined && sp !== null && typeof sp.stateOf === 'function') {
        const state = sp.stateOf(session, 'permissions');
        if (state !== undefined && state !== null && state.sandbox !== undefined) {
          return { mode: state.sandbox, known: true, source: 'session' };
        }
      }
    } catch {
      /* 投影不可用时继续回退 */
    }
  }
  // 1) executor 默认值：软探测，避免注入门抛错
  try {
    const shell = typeof ctx?.get === 'function' ? ctx.get('shell') : ctx?.shell;
    if (shell !== undefined && shell !== null) {
      const mode = shell.sandboxMode;
      // 拿到 shell 就算 known；mode 可能是 undefined（表示该 executor 不沙盒）
      return { mode, known: true, source: 'shell-default' };
    }
    // 连 shell 服务都没有 → 这个组合不沙盒命令，等价完全放行
    return { mode: undefined, known: true, source: 'no-shell-service' };
  } catch {
    return { mode: undefined, known: false, source: 'unreadable' };
  }
}

/** 日志用：把模式描述成可读字符串。 */
function describeMode(mode, known, source) {
  if (!known) return '(unknown — threw)';
  if (mode === undefined) return `(unconfined / undefined · ${source})`;
  return `${mode} · ${source}`;
}

/**
 * 本次调用是否应当计数。
 *
 * **每次执行前现读**，不缓存 —— 这就是热切换能跟着变的原因。
 *
 * @param ctx - 插件上下文。
 * @param exec - 本次工具调用。
 * @returns {{ active: boolean, mode: string|undefined, known: boolean, source: string }}
 */
function gateState(ctx, exec) {
  const session = exec?.agent?.session;
  const { mode, known, source } = readSandboxMode(ctx, session);
  // 读不到模式时**倾向于生效**。
  //
  // 这不是安全边界，漏挂的代价是「该提醒的时候没提醒」，
  // 而误判为沙盒的代价是「插件完全沉默，等于没装」。
  // 两害相权，宁可多提醒，也不能静默失效 —— 静默失效最难排查
  // （这个 bug 就是这么来的：每次调用都 gate inactive，日志里看不到异常）。
  if (!known) return { active: true, mode, known, source };
  // 只有**明确**处于沙盒接管的模式才不生效。
  const managed = typeof mode === 'string' && SANDBOX_MANAGED_MODES.has(mode);
  return { active: !managed, mode, known, source };
}

/**
 * 安装监听器。
 * @param ctx - 插件上下文；监听器随其释放。
 * @param config - 已由调用方传入的原始配置。
 */
export function apply(ctx, config) {
  probe(`apply() called, raw config = ${JSON.stringify(config)}`);
  let cfg;
  try {
    cfg = validateConfig(config);
    probe(`config validated: freeLimit=${cfg.freeLimit} hardLimit=${cfg.hardLimit} confirmWord=${cfg.confirmWord}`);
  } catch (err) {
    probe(`CONFIG INVALID: ${err && err.message}`);
    throw err;
  }
  const includePatterns = cfg.include.map(wildcardToRegExp);
  const excludePatterns = cfg.exclude.map(wildcardToRegExp);

  // ---- 生效范围门：钩子总是挂上，判定移进每次调用 ----
  //
  // 这里**不做**一次性判断。原因：DSH 的权限模式可以在会话里热切换，
  // 而 apply() 只在加载时跑一次。若在此处 return，切到沙盒再切回来，
  // 插件就永远沉默了 —— 判定时机错误。
  //
  // 现在的做法：钩子一律挂上，每次 pre/post-execute 里用 gateState() 现读模式。
  // 代价是每步一次属性访问，可以忽略。
  try {
    const initial = readSandboxMode(ctx, undefined);
    probe(`load: sandboxMode=${describeMode(initial.mode, initial.known, initial.source)} (decided per call)`);
  } catch {
    /* 探针本身不能影响加载 */
  }

  // 诊断：确认 ctx 具备 on/waterfall 能力（每一步都单独 try，getter 抛错也不能中断）
  try {
    const dOn = typeof ctx?.on;
    const dWf = typeof ctx?.waterfall;
    probe(`ctx on=${dOn} waterfall=${dWf}`);
  } catch (e) {
    probe(`ctx probe threw: ${e && e.message}`);
  }

  /** 是否纳入计数。include 为空表示全纳入；exclude 优先。 */
  function tracked(toolName) {
    if (includePatterns.length > 0 && !includePatterns.some((p) => p.test(toolName))) {
      return false;
    }
    return !excludePatterns.some((p) => p.test(toolName));
  }

  /** 包一层注册，把任何异常写进探针再原样抛出。 */
  function reg(event, handler) {
    try {
      const d = ctx.on(event, handler);
      probe(`registered ${event} -> disposer=${typeof d}`);
      return d;
    } catch (e) {
      probe(`REGISTER FAILED ${event}: ${e && e.message}`);
      throw e;
    }
  }

  /**
   * 按 agent 记录本轮已发生的持久化调用次数。
   * 用 WeakMap，agent 释放即回收，不需要手动清理。
   */
  const counters = new WeakMap();

  function bump(agent) {
    const next = (counters.get(agent) ?? 0) + 1;
    counters.set(agent, next);
    return next;
  }

  function currentCount(agent) {
    return counters.get(agent) ?? 0;
  }

  // 只记第一次命中，避免探针日志被刷爆
  let preSeen = false;
  let postSeen = false;
  // 沙盒接管导致跳过的日志，每个加载只写一次
  let gateSkippedLogged = false;

  /**
   * 本轮是否已被用户 confirm 放行。
   * agent → true。置位后本轮所有持久化操作直接放行，不计数、不提醒、不拦。
   * 下一条用户消息到达时清除。
   */
  const confirmed = new WeakMap();

  /**
   * 执行前：计数并分档。
   * 只有持久化操作会计数；非持久化直接让 next() 决定。
   */
  reg('tools/pre-execute', async (exec, next) => {
    probe(`[enter] pre-execute tool=${exec?.name} argCount=? typeofNext=${typeof next}`);
    if (!preSeen) {
      preSeen = true;
      probe(`HOOK pre-execute fired, tool=${exec?.name} hasAgent=${exec?.agent != null}`);
    }

    // 每次现读权限模式：热切换要能跟上。
    const gate = gateState(ctx, exec);
    if (!gate.active) {
      if (!gateSkippedLogged) {
        gateSkippedLogged = true;
        probe(`gate inactive: ${describeMode(gate.mode, gate.known, gate.source)} — skipping`);
      }
      return next();
    }

    const toolName = exec?.name;
    if (!isPersistent(toolName, exec) || !tracked(toolName)) return next();

    const agent = exec?.agent;
    if (agent === undefined || agent === null) return next();

    // 本轮已被 confirm 放行：一律通过，不计数。
    if (confirmed.get(agent) === true) {
      probe(`confirmed turn: allow ${toolName} without counting`);
      return next();
    }

    const count = bump(agent);

    if (count >= cfg.hardLimit) {
      // 达上限：索要 confirm。ask 会走审批通道，用户点确认才放行。
      return {
        kind: 'ask',
        reason: `${cfg.askReason}（识别语：${cfg.confirmWord}；本轮第 ${count} 次：${toolName}）`,
      };
    }

    // 未达上限：放行，提醒在 post-execute 注入。
    return next();
  });

  /**
   * 执行后：把提醒补进上下文。
   * 不否决调用（downstream 已有结论），只追加 additionalContexts。
   */
  reg('tools/post-execute', async (exec, _result, next) => {
    probe(`[enter] post-execute tool=${exec?.name}`);
    if (!postSeen) {
      postSeen = true;
      probe(`HOOK post-execute fired, tool=${exec?.name} hasAgent=${exec?.agent != null}`);
    }
    const toolName = exec?.name;
    const downstream = await next();

    // 每次现读权限模式：热切换要能跟上。
    const gate = gateState(ctx, exec);
    if (!gate.active) return downstream;

    if (!isPersistent(toolName, exec) || !tracked(toolName)) return downstream;
    const agent = exec?.agent;
    if (agent === undefined || agent === null) return downstream;

    // 本轮已被 confirm 放行：不注入任何提醒。
    if (confirmed.get(agent) === true) return downstream;

    const count = currentCount(agent);
    if (count === 0) return downstream;

    let text;
    if (count > cfg.freeLimit) {
      // 超出额度：这是指令，不是提醒。语义为「立即停止无 confirm 的操作」。
      text = `${cfg.warningText}（识别语：${cfg.confirmWord}；本轮第 ${count}/${cfg.hardLimit} 次持久化：${toolName}）`;
    } else {
      text = `${cfg.reminderText}（本轮第 ${count}/${cfg.freeLimit} 次持久化：${toolName}）`;
    }

    const notice = {
      id: noticeId(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        // 使用 MessageSourceMap 中已声明的合法 kind，
        // 语义为「系统要求用户决定」，避免自定义 kind 被下游拒绝。
        kind: 'user-approval',
        form: 'notice',
        summary: `持久化 ${count}/${cfg.hardLimit} · ${toolName}`,
        producer: 'confirm-gate',
      },
    };

    if (downstream?.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [notice, ...(downstream.additionalContexts ?? [])],
      };
    }
    return {
      ...downstream,
      additionalContexts: [notice, ...(downstream.additionalContexts ?? [])],
    };
  });

  /**
   * 每步前：出现新的 user 消息即视为新一轮开始。
   *
   * 两条规则：
   *   1. 消息**包含** confirmWord → 本轮放行（confirmed 置位），不计数、不提醒、不拦。
   *   2. 消息不含 confirmWord → 清除放行标记，并清零计数，恢复正常计数模式。
   *
   * 用 source.kind === 'user' 判定「真人消息」，
   * 我们自己注入的 notice 标记为 kind: 'user-approval'，不会误触发。
   */
  reg('agent/pre-step', ({ agent, messages }, next) => {
    if (!Array.isArray(messages)) return next();

    for (const m of messages) {
      if (m?.source?.kind !== 'user') continue;
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');

      if (containsConfirm(text, cfg.confirmWord)) {
        // 命中识别语：本轮全部放行。
        confirmed.set(agent, true);
        counters.delete(agent);
        probe(`CONFIRMED turn for agent; word="${cfg.confirmWord}"`);
      } else {
        // 新的普通消息：撤销放行，恢复计数。
        confirmed.delete(agent);
        if (cfg.resetOnUserMessage) counters.delete(agent);
      }
    }
    return next();
  });
}

/**
 * 关于「不导出 Config」的说明（踩过的坑）
 *
 * cordis 的 resolveConfig 逻辑是：
 *   if (!runtime.Config) return config;                          ← 没有就原样用
 *   runtime.Config['~standard'].validate(config)                 ← 有就必须实现 standard-schema
 *
 * 因此导出普通对象 `export const Config = {...}` 会让 cordis 报
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 * 插件初始化失败，且错误只写到 stderr，`--dump-config` 完全看不到。
 *
 * 本插件的全部配置校验由 apply() 内的 validateConfig 完成，同样 fail-loud，
 * 所以这里刻意**不导出 Config**，让 cordis 跳过 schema 校验。
 * @see cordis resolveConfig
 */
