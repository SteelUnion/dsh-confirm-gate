# dsh-confirm-gate

**在完全权限的主机上，让 AI Agent 可控运行的次数闸框架。**

给 DeepSeek Harness (DSH) 用的运行时插件。提供**每轮对话独立的持久化操作计数器**，在免确认额度用尽后向模型注入停止指令，达到硬上限时索要用户 confirm。

> **这不是安全边界，是成本边界和方向纠偏机制。**
> 它假设你已经给了 Agent 完全权限（`danger-full-access`），目的是让模型在烧 token 和乱改文件之前**有能力自己刹车**。真正的沙箱隔离由 DSH 自己的 sandbox 提供，与本插件互补而非替代。

---

## 一、设计思路

给 Agent 完全权限是必要的——沙箱会让 `pwsh` 这类工具直接崩掉（见[附录](#十附录为什么需要完全权限)）。但完全权限意味着**没有任何东西拦得住它**。

这个插件的假设是：

> **不给硬墙，给计数器和刹车信号。**

因为实测发现：模型在收到明确的「立即停止」指令后会停手（见[实测记录](#八实测记录)）。所以不必在第一次就越权拦住，只要**把额度标上刻度**，模型自己会算。

---

## 二、三档行为

```
每轮对话开始，计数归零
        │
        ▼
   持久化操作 +1
        │
   ┌────┴────┬──────────┬──────────┐
   │         │          │          │
 1..free   free+1..    >= hard   （非持久化）
   │      hard-1        │          │
   ▼         ▼          ▼          ▼
 放行      放行         ask      永不计数
+提醒    +【指令】    索要confirm
```

| 档位 | 行为 |
|---|---|
| `1 ~ freeLimit` | 放行，注入提醒 |
| `freeLimit+1 ~ hardLimit-1` | 放行，注入**指令：立即停止** |
| `>= hardLimit` | 返回 `{ kind: 'ask' }`，走审批通道索要 confirm |

**非持久化操作（读文件、搜索、列目录、查状态）永不计数、永不提醒、永不拦截。**

---

## 三、这个框架能调什么

**所有参数都可调，没有写死的。** 配置写在 profile 的 `cordis.patch.yml`。

### 数值

| 参数 | 默认 | 含义 | 极端配置的效果 |
|---|---|---|---|
| `freeLimit` | `10` | 免确认额度 | 设 `0` → 第 1 次就进指令档 |
| `hardLimit` | `15` | 硬上限，达到即索要 confirm | 设 `1` → 第 1 次就要 confirm |

**约束**：`hardLimit > freeLimit`，否则抛错。

### 识别语

| 参数 | 默认 | 说明 |
|---|---|---|
| `confirmWord` | `confirm` | 用户确认用的词。注入文本与弹框理由都会带上它 |

改这个就能换一套确认语，比如 `dada`、`go`、`批准`。

### 文案

| 参数 | 默认 |
|---|---|
| `reminderText` | `警告，无confirm持久化操作。请向用户索要confirm。` |
| `warningText` | `指令：立即停止所有无 confirm 的持久化操作。不得再执行写入、改文件、执行命令、派发子代理或外发。转而向用户汇报当前进展、缺口与方案，并索要 confirm。` |
| `askReason` | `持久化操作次数已达上限，需要用户 confirm 才能继续。` |

### 计数范围

| 参数 | 默认 | 说明 |
|---|---|---|
| `include` | `[]` | 只统计匹配的工具名（支持 `*` 通配）。空=全统计 |
| `exclude` | `[]` | 排除匹配的工具名 |
| `resetOnUserMessage` | `true` | 收到新的用户消息是否重置计数 |
| `resetOnConfirm` | `false` | **用户只回一句确认时，是否重置计数** |

### `resetOnConfirm` 为什么默认是 `false`

如果用户回一句 `confirm` 也算「新一轮」，那**确认一次就能再白拿一整个额度**，硬上限形同虚设。

默认只认「带内容的新任务」为重置点；单纯一句 `confirm`（前后允许引号、标点、空白）不算。

想要旧行为，设 `true`。

### 配置示例

```yaml
# ~/.dsh/profiles/<你的profile>/cordis.patch.yml
- insert:
    - id: confirm-gate
      name: "@sroada/dsh-confirm-gate"
      config:
        freeLimit: 0          # 一次都不白给
        hardLimit: 3
        confirmWord: 批准
        warningText: 停。无批准不得动写操作，先汇报。
```

---

## 四、什么算「持久化操作」

判定口径：**动作结束后，外部世界是否被改变。**

| 类别 | 工具示例 | 算不算 |
|---|---|---|
| 读文件、列目录、搜索、查状态 | `read` `grep` `glob` `ls` `job-list` | ❌ |
| 只改会话内进度 | `todo-write` | ❌ |
| 联网读 | `web-fetch` `web-search` | ❌ |
| 写文件 | `write` `edit` `str-replace` `apply-patch` | ✅ |
| 执行命令 | `pwsh` `bash` `terminal` `exec` `process` | ✅ |
| 派发 | `subagent` `subagent-fork` `workflow` | ✅ |
| 外发 | `message-send` `webhook-dispatch` | ✅ |

**后缀兜底**：工具名以 `write` / `edit` / `delete` / `remove` / `move` / `publish` / `deploy` / `commit` / `push` 结尾的，一律按持久化处理，用于兜住以后新增的工具。

**未知工具默认判为非持久化**（不拦）。想反过来，用 `include` 限定范围。

---

## 五、它是怎么挂进 DSH 的

### 系统调用对应关系

| 钩子 | 触发时机 | 我能拿到 | 我能返回 |
|---|---|---|---|
| `tools/pre-execute` | 工具执行**前**（waterfall） | `exec.name` `exec.arguments` `exec.agent` `next` | `allow`/`deny`/`ask`/`cancel`，或直接 `return next()` 透传 |
| `tools/post-execute` | 工具执行**后** | 同上 + `result` | 下游结果对象，可追加 `additionalContexts` |
| `agent/pre-step` | 每步调用模型**前** | `agent` `messages` `signal` | `next()` |

**关键实现细节：**

1. **`messages` 是本步新增的，不是全部历史。** DSH 用 `claim()` 取增量，所以「出现 user 消息就重置」不会把每步都重置。
2. **注入用的 `source.kind` 必须是 `'user-approval'`。** 用自定义 kind 可能被下游拒绝；用 `'user'` 会被自己的 `pre-step` 误判成新任务、每步自清。
3. **`return next()` 拿到的就是下游决策，直接透传。** waterfall 不调 `next()` 等于短路整条流水线。

### 包结构（三个字段缺一不可）

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `exports` 里不列 `./cordis.patch.yml` → patch 解析不到，bundle 加载器直接跳过
- `dsh.bundle.patch` 少了 `./` 前缀 → 同样的结果

### 不能导出 `Config`

cordis 的配置解析是：

```js
if (!runtime.Config) return config;                              // 没有 → 原样用
const result = runtime.Config['~standard'].validate(config);     // 有 → 必须是 standard-schema
```

导出普通对象会让它崩在 `.validate`，而且**错误只写 stderr，插件静默失败**。

**本插件刻意不导出 `Config`**，全部校验在 `apply()` 内完成（同样 fail-loud）。

---

## 六、安装

```powershell
dsh plugin --profile <desktop|web> add file:E:/SRoada/confirm-gate
```

**`file:` 是复制，不是链接。改代码后必须 `remove` + `add` 才会更新。**

### ⚠️ 最容易踩的坑：装错 profile

| 启动方式 | 读哪个 profile |
|---|---|
| 桌面图标 / GUI | **`profiles\desktop`** |
| `dsh.cmd web` | `profiles\web` |

**装之前先查进程实际读的是哪个**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select CommandLine
```

看命令行里 `dsh-desktop-host` 后面跟的 profile 路径。

**装错 profile 的症状很有迷惑性**：`--dump-config` 能看到你的条目，配得整整齐齐，但插件**永远不加载**。

### 还要打开审批通道

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      danger-full-access:
        sandbox: danger-full-access
        approval: ask        # 必须是 ask；never 会把 ask 直接拒成 deny
```

---

## 七、怎么确认装好了

**`--dump-config` 显示条目 ≠ 插件被加载。** 唯一的验证方式是模块探针。

插件内留了开关：

```js
// lib/index.js
const DEBUG_PROBE = false;   // 改成 true
```

改成 `true`、重装、重启后，`C:\Users\Administrator\confirm-gate-boot.log` 会记录：

```
module imported
apply() called, raw config = {...}
config validated: freeLimit=10 hardLimit=15 confirmWord=confirm
ctx on=function waterfall=function
registered tools/pre-execute -> disposer=function
registered tools/post-execute -> disposer=function
registered agent/pre-step -> disposer=function
[enter] pre-execute tool=pwsh
```

**看到 `[enter] pre-execute` 才算真正通了。**

---

## 八、实测记录

真机测试（`freeLimit=10` / `hardLimit=15` / `confirmWord=confirm`）：

| 次数 | 实际注入文本 |
|---|---|
| 1 | `警告，无confirm持久化操作。请向用户索要confirm。（本轮第 1/10 次持久化：pwsh）` |
| 5 | `警告，无confirm持久化操作。…（本轮第 5/10 次持久化：pwsh）` |
| 10 | `警告，无confirm持久化操作。…（本轮第 10/10 次持久化：pwsh）` |
| **11** | `指令：立即停止所有无 confirm 的持久化操作。…（识别语：confirm；本轮第 11/15 次持久化：pwsh）` |

**关键观察**：第 11 次收到指令后，模型主动停手并索要 confirm——**框架设计目标达成**。

---

## 九、已知边界

**没验证过的：**

- `12 ~ 15` 次区间的实际表现
- `>= 15` 时 `ask` 能弹出审批框（需要 `approval: ask` 且应答者在线）

**设计上的限制：**

1. **一次工具调用算 1 次**，不管里面执行多少条命令。`pwsh` 一次跑 10 条命令只计 1 次。
2. **`ask` 的弹框位置取决于应答者。** 当前是 Web GUI，**手机收不到**，除非手机能访问 DSH 地址。
3. **`subagent` 算在主 agent 头上**，子代理内部的操作不单独计。
4. **不是安全边界。** 模型如果刻意绕过（比如在 `pwsh` 里用原生命令批量改文件），计数器只会记 1 次。**它防的是无意识的烧 token，不是恶意突破。**

---

## 十、附录：为什么需要完全权限

在 Windows 上，DSH 的沙箱会让 `pwsh` 调用全部返回 `0xC0000142`（`STATUS_DLL_INIT_FAILED`）。三层原因：

1. **策略层** `dsh-sandbox-policy` —— 会话模式决定后续是否启用
2. **令牌层** `dsh-sandbox-windows-acl` —— 复制令牌、剥权限、压 Low 完整性、加能力 SID 和保活组；**缺保活组就在 DLL 初始化期死**
3. **启动层** `dsh-pwsh-sandbox` —— 受限令牌下**必须继承宿主控制台**，自己开控制台即死

`danger-full-access` 会绕过全部三层（官方文档：「绝不咨询提供方」）。

**所以本插件的定位是：当你不得不给完全权限时，起码让它有账可算。**

---

## 许可

MIT
