# dsh-confirm-gate

**在完全权限的主机上，让 AI Agent 可控运行的次数闸框架。**

[English](README.md) | 中文

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的运行时插件。提供**每轮对话独立的持久化操作计数器**，在免确认额度用尽后向模型注入停止指令，达到硬上限时索要用户 confirm。

> **这不是安全边界，是成本边界和方向纠偏机制。**
> 它假设 Agent 运行在**没有沙盒接管边界**的环境里，目的是让模型在烧 token 和乱改文件之前**有能力自己刹车**。真正的沙箱隔离由 DSH 自己的 sandbox 提供，与本插件互补而非替代。

*约 0.27 USD 的模型花费（作者估算，见 [`dist/COSTS.md`](dist/COSTS.md)）——当天其余的钱花在环境排障和研究上，不在这个插件里。*

打包好的可直接安装版本在 [`dist/`](dist/)。

### 生效范围：沙盒下保持沉默

插件在**每一次工具调用**时现判要不要计数。模式有两个数据源，按优先级：

1. `ctx.sessionProjections.stateOf(session, 'permissions').sandbox` —— 会话**当前**的旋钮值。热切换权限模式时，变的是它。
2. `ctx.shell.sandboxMode` —— executor 的**默认**模式。官方注释原话是 "the sandbox mode this executor applies by default"，它**不跟随热切换**，所以只作回退。

这个区分是必须的：只看默认值的话，切进沙盒再切回来，插件读到的永远是启动时那个值。

两个数据源都通过 `ctx.get(name)` 软探测，**绝不直接读 `ctx.shell`**。cordis 的依赖注入是惰性的，碰没声明的服务属性会抛注入门错误 —— 这条路径上抛一次异常，插件就会**彻底静默失效**。软探测不会抛。

| 沙箱模式 | 是否计数 | 为什么 |
|---|---|---|
| `read-only` | ❌ 不计数 | 边界已被沙盒全部接管 |
| `workspace-write` | ❌ 不计数 | 同上 |
| `danger-full-access` | ✅ 计数 | 边界没人管 |
| `custom` | ✅ 计数 | 自定义组合下边界仍然没人管 |
| `undefined` / 无 shell 服务 | ✅ 计数 | 这个 executor 不沙盒 |
| **两个数据源都读不到** | ✅ 计数 | **倾向生效：静默失效比多提醒糟得多** |

最后一行是刻意的。这不是安全边界，是记账工具，所以两种失效不对称：

- 该沉默时计数 → 多一条提醒，**看得见、改得掉**
- 该计数时沉默 → **插件装着却什么都不做**，日志里还看不出异常

后者严重得多。所以任何读不到的模式，一律按「不沙盒」处理。

说白了：**沙盒下这个插件是多余的 —— 更糟的是，它会把正常操作再拦一次。** 所以它在已经有人记账的地方自动让开。

钩子始终注册，判定按次进行。这就是热切换能生效的原因：会话切进沙盒，下一次调用就安静；切回来，计数立刻恢复，不用重启。

> ### ✅ 现状：已验证，含实时热切换
>
> 在 Windows、DSH `0.2.0-rc.2` 上手工跑过。权限模式是**在会话运行期间实时切换的，全程没重启 DSH**，顺序为 完全 → 工作区 → 只读 → 完全：
>
> | 模式 | 写文件 | `pwsh` | 插件是否计数 |
> |---|---|---|---|
> | `danger-full-access` | ✅ 成功 | ✅ 能跑 | ✅ **1/10 → 2/10 → 3/10** |
> | `workspace-write` | ✅ 成功 | ❌ `0xC0000142` | ❌ 沉默（2 次） |
> | `read-only` | ❌ 沙盒拒绝 | ✅ 能跑 | ❌ 沉默（2 次） |
> | `danger-full-access`（切回） | ✅ 成功 | ✅ 能跑 | ✅ **1/10，计数恢复** |
>
> 两处值得看。中间两行的「沉默」说明分工正确——沙盒该拒绝的拒绝了、该限制的限制了，门控一声不吭。最后一行说明门控**在同一个进程里**回来了，这正是「按次判定而非加载时判定」的意义。
>
> 老实交代一点：在这个部署里 `ctx.get('shell')` 返回 `undefined`，所以「不沙盒」的结论来自**读不到 → 倾向生效**这条兜底分支，而不是真的读到了模式。行为是对的，走的是回退那条路。如果某个部署暴露了 `shell`，走的会是主路径。

### 适合谁

| 场景 | 是否适合 |
|---|---|
| 你给了 Agent 完全权限，怕它无限试错烧 token | ✅ 正是为此 |
| 你希望 Agent 在做满 N 次写操作后主动问你 | ✅ |
| 你希望 `read` / `grep` / 联网查**完全不被打断** | ✅ 非持久化永不计数 |
| 你想用它当沙箱、防住恶意模型 | ❌ 用 DSH 自带 sandbox |
| 你用的是别的 Agent 框架 | ❌ 这是 DSH 插件 |

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
  用户消息含 confirmWord ?
        │
   ┌────┴─────┐
  是          否
   │           │
   ▼           ▼
整轮放行   持久化操作 +1
不计数          │
不提醒     ┌────┴────┬──────────┬──────────┐
   │       │         │          │          │
   │     1..free   free+1..    >= hard   （非持久化）
   │       │      hard-1        │          │
   │       ▼         ▼          ▼          ▼
   │     放行      放行         ask      永不计数
   │    +提醒    +【指令】    索要confirm
   └─────────┴─────────┴──────────┘
```

| 档位 | 行为 |
|---|---|
| **消息含 `confirmWord`** | **本轮整轮放行**：不计数、不提醒、不拦 |
| `1 ~ freeLimit` | 放行，注入提醒 |
| `freeLimit+1 ~ hardLimit-1` | 放行，注入**指令：立即停止** |
| `>= hardLimit` | 返回 `{ kind: 'ask' }`，走审批通道索要 confirm |

**非持久化操作（读文件、搜索、列目录、查状态、只读命令）永不计数、永不提醒、永不拦截。**

### 含 confirm 即放行整轮

判据是**消息里出现 `confirmWord` 即可**，不要求整句就是它。

| 用户消息 | 结果 |
|---|---|
| `confirm` | ✅ 放行 |
| `confirm，可以开始` | ✅ 放行 |
| `好的我同意 confirm 你去吧` | ✅ 放行 |
| `CONFIRM` | ✅ 放行（大小写不敏感） |
| `帮我看看这个` | ❌ 不放行，正常计数 |

**放行是整轮的**：一旦命中，本轮剩余所有持久化操作都不计数、不提醒、不拦截。下一条不含识别语的消息到达后，恢复计数。

设计理由：confirm 是对**一件事**的授权，不是对**一次操作**的授权。按笔确认会让模型每敲一条命令就回来问一遍，把一次执行切成十次中断。

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
| `resetOnConfirm` | `false` | 兼容旧行为：是否把「仅一句确认」当作新一轮重置点。**新逻辑下无需开启** |

### 关于 `resetOnConfirm`

早期版本里，用户回一句 `confirm` 只意味着「不重置」，确认完之后额度照样要重新数——于是确认一次只是一次中断的开始。

现在改成**含识别语即整轮放行**，`resetOnConfirm` 保留只为兼容旧配置。除非你明确要「确认后重新给一整轮额度」的旧行为，否则不用动它。

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

### 4.1 按工具名判定

| 类别 | 工具示例 | 算不算 |
|---|---|---|
| 读文件、列目录、搜索、查状态 | `read` `grep` `glob` `ls` `job-list` | ❌ |
| 只改会话内进度 | `todo-write` | ❌ |
| 联网读 | `web-fetch` `web-search` | ❌ |
| 写文件 | `write` `edit` `str-replace` `apply-patch` | ✅ |
| 派发 | `subagent` `subagent-fork` `workflow` | ✅ |
| 外发 | `message-send` `webhook-dispatch` | ✅ |

**后缀兜底**：工具名以 `write` / `edit` / `delete` / `remove` / `move` / `publish` / `deploy` / `commit` / `push` 结尾的，一律按持久化处理，用于兜住以后新增的工具。

**未知工具默认判为非持久化**（不拦）。想反过来，用 `include` 限定范围。

### 4.2 命令类工具按**命令内容**判定

`pwsh` / `bash` 这类工具不再一律计数，而是看**命令本身是不是只读**。

`exec.arguments.command` 落在只读白名单里 → 不计数；否则计数。

| 命令 | 算不算 |
|---|---|
| `Get-ChildItem E:\x` | ❌ 只读 |
| `Get-Content a.txt -Raw` | ❌ 只读 |
| `Get-ChildItem \| Select-Object Name` | ❌ 只读（管道全在白名单） |
| `Get-Item x; Remove-Item y` | ✅ 混进写命令 |
| `Set-Content a.txt "x"` | ✅ |
| `Get-ChildItem > out.txt` | ✅ 重定向 |
| `git status` | ✅ 外部程序 |
| `& "C:\a.exe"` | ✅ 外调 |

**只读白名单**（只比命令名，不做 PowerShell 语法解析）：

`Get-ChildItem` `Get-Item` `Get-Content` `Test-Path` `Resolve-Path` `Split-Path` `Join-Path` `Get-Location` `Get-Date` `Get-Process` `Get-CimInstance` `Get-Service` `Get-Command` `Get-Module` `Get-Variable` `Get-ItemProperty` `Get-FileHash` `Get-Acl` `Get-PSDrive` `Get-Member` `Select-Object` `Where-Object` `ForEach-Object` `Sort-Object` `Group-Object` `Measure-Object` `Select-String` `Compare-Object` `Get-Unique` `Format-Table` `Format-List` `Format-Wide` `Out-String` `Out-Host` `Out-Null` `Write-Output` `Write-Host` `Write-Verbose` `Write-Warning` `Set-Location` `Push-Location` `Pop-Location` `Start-Sleep`

**一律计数**：重定向 `>` `>>` `<`、`Out-File` `Set-Content` `Add-Content` `New-Item` `Remove-Item` `Copy-Item` `Move-Item` `Rename-Item`、`Invoke-Expression`/`iex`、`Start-Process`、`&` 外调、`git` `node` `python` `npm` `pnpm` `cmd`。

**取舍说明**：这不是语法解析器，是**名字比对**。所以 `Get-ChildItem $p.GetFiles()` 这种链式调用会被判成持久化（命中了 `&` 规则之外的方法调用）。**判错的代价是多计一次，不是漏拦**——这个方向是故意的。

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
# <插件目录> 换成你 clone 下来的路径
dsh plugin --profile <desktop|web> add file:<插件目录>
```

**`file:` 是复制，不是链接。改代码后必须 `remove` + `add` 才会更新。**

### 换台机器要改什么

**插件本身零配置，即装即用。** 代码里没有任何绝对路径，探针日志走系统临时目录，确认语和阈值全走默认值。

需要你在**新机器**上做的只有两件事，都在 DSH 侧，不在插件里：

| 要改的 | 在哪 | 改成什么 |
|---|---|---|
| `--profile` 名 | 安装命令 | 用新机器 GUI 实际读的那个（先查进程命令行，见下） |
| `approval` | 新机器 profile 的 `cordis.patch.yml` | `ask`（否则超限时 `ask` 会被拒成 `deny`） |

想改阈值/文案，同样是改 profile 的 `cordis.patch.yml`，不用动插件源码。

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

改成 `true`、重装、重启后，**系统临时目录**下的 `confirm-gate-boot.log` 会记录（Windows 是 `%TEMP%`，Linux/macOS 是 `$TMPDIR` 或 `/tmp`）：

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

### 8.1 计数分档（真机，`freeLimit=10` / `hardLimit=15` / `confirmWord=confirm`）

| 次数 | 实际注入文本 |
|---|---|
| 1 | `警告，无confirm持久化操作。请向用户索要confirm。（本轮第 1/10 次持久化：pwsh）` |
| 5 | `警告，无confirm持久化操作。…（本轮第 5/10 次持久化：pwsh）` |
| 10 | `警告，无confirm持久化操作。…（本轮第 10/10 次持久化：pwsh）` |
| **11** | `指令：立即停止所有无 confirm 的持久化操作。…（识别语：confirm；本轮第 11/15 次持久化：pwsh）` |

**关键观察**：第 11 次收到指令后，模型主动停手并索要 confirm——**框架设计目标达成**。

### 8.2 命令级判定（`exec` 结构实测）

通过模块探针抓到的真实结构（DSH `0.2.0-rc.2`）：

```json
{
  "keys": ["token","callId","rootCallId","name","signal","agent","deferContext","concludeTurn","arguments"],
  "name": "pwsh",
  "argsKeys": ["command","description"],
  "arguments": { "command": "Write-Output \"hi\"", "description": "..." }
}
```

**关键点**：参数在 `exec.arguments`（不是 `params`），且经 `snapshotJsonValue` 深拷贝 + `deepFreeze` 冻结——插件读它是安全的，改不动它。

命令判定单测（16 项）：

| 命令 | 判定 |
|---|---|
| `Get-ChildItem E:\SRoada -Force` | 只读 ✅ |
| `Get-ChildItem \| Select-Object Name` | 只读 ✅ |
| `$x = Get-Date; Write-Output $x` | 只读 ✅ |
| `Get-Item x; Remove-Item y` | 持久化 ✅ |
| `Get-ChildItem > out.txt` | 持久化 ✅ |
| `git status` | 持久化 ✅ |
| `& "C:\a.exe"` | 持久化 ✅ |

**16/16 通过。**

### 8.3 含 confirm 放行整轮

离线集成测试（18 项全过）覆盖：放行后连续 30 次持久化操作不拦、不提醒；句中任意位置含识别语都生效；大写 `DADA` 生效；不含识别语的消息撤销放行并恢复计数。

---

## 九、已知边界

**没验证过的：**

- `12 ~ 15` 次区间的实际表现
- `>= 15` 时 `ask` 能弹出审批框（需要 `approval: ask` 且应答者在线）

**设计上的限制：**

1. **一次工具调用算 1 次**，不管里面执行多少条命令。
2. **`ask` 的弹框位置取决于应答者。** 当前是 Web GUI，**手机收不到**，除非手机能访问 DSH 地址。
3. **`subagent` 算在主 agent 头上**，子代理内部的操作不单独计。
4. **不是安全边界。** 模型如果刻意绕过（比如在 `pwsh` 里用原生命令批量改文件），计数器只会记 1 次。**它防的是无意识的烧 token，不是恶意突破。**
5. **命令判定是名字比对，不是语法解析。** 拿不准的一律判持久化——**只多计，不漏拦**。
6. **含识别语即整轮放行是粗粒度的。** 如果用户在讨论时说「我觉得 confirm 这个逻辑有问题」，也会触发放行。这是刻意选的简单规则：把歧义交给用户措辞，而不是让插件猜意图。

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
