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
const DEBUG_PROBE = false;
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

/**
 * 一个工具名是否属于「持久化」操作。
 *
 * 判定口径：动作结束后世界是否被改变。
 * 该判断必须与 Frank 在 OpenClaw 中的 A2 门控定义一致 ——
 * 读是非持久化，写是持久化；执行命令一律按持久化处理。
 */
const PERSISTENT_EXACT = new Set([
  // 文件写入类
  'write',
  'edit',
  'str-replace',
  'str-replace-editor',
  'apply-patch',
  'notebook-edit',
  // 执行类（命令可能改文件、装东西、联网）
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

export function isPersistent(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  if (NON_PERSISTENT.has(toolName)) return false;
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
 * 只认识别语本身（大小写不敏感，允许前后空白与标点），
 * 避免把「confirm 之后我们再讨论别的」这类正常指令误判成确认。
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
    const toolName = exec?.name;
    if (!isPersistent(toolName) || !tracked(toolName)) return next();

    const agent = exec?.agent;
    if (agent === undefined || agent === null) return next();

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

    if (!isPersistent(toolName) || !tracked(toolName)) return downstream;
    const agent = exec?.agent;
    if (agent === undefined || agent === null) return downstream;

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
   * 每步前：出现新的 user 消息即视为新一轮开始，清零。
   *
   * 用 source.kind === 'user' 判定「真人消息」，
   * 我们自己注入的 notice 标记为 kind: 'user-approval'，不会误触发清零。
   */
  reg('agent/pre-step', ({ agent, messages }, next) => {
    if (cfg.resetOnUserMessage && Array.isArray(messages)) {
      // 只认「真人新任务」重置：source.kind === 'user'。
      // 我们自己注入的 notice 用 'user-approval'，不会被误判。
      const userTexts = [];
      for (const m of messages) {
        if (m?.source?.kind !== 'user') continue;
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        userTexts.push(text);
      }
      if (userTexts.length > 0) {
        // resetOnConfirm 为 false（默认）时，单纯一句确认不重置计数，
        // 否则确认一次就能再白拿一整轮额度。
        const onlyConfirm = !cfg.resetOnConfirm && userTexts.every((t) => isConfirmOnly(t, cfg.confirmWord));
        if (!onlyConfirm) counters.delete(agent);
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
