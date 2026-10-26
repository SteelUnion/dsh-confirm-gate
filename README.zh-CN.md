# dsh-confirm-gate

![License](https://img.shields.io/badge/license-MIT-blue)
![Zero deps](https://img.shields.io/badge/dependencies-zero-brightgreen)
![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-orange)
![Version](https://img.shields.io/badge/version-0.2.0-lightgrey)

> **你的 AI 助手一口气改 20 个文件、烧掉一整天额度之前，会先停下来问你一句。**
>
> 装上它，模型每动一次手就记一笔。额度快用完时它开始提醒自己刹车，
> 到硬上限就停下来等你回一句 `confirm`。
> **不用改 DSH 内核，没有必填配置。**
>
> *Stops your AI agent before it rewrites 20 files and burns a day of budget —
> it counts, warns, then asks you to type `confirm` before going further.*

[English](README.md) | 中文 · **v0.2.0**

---

## 它跑起来是这样的

```
模型发起第 11 次文件修改
        ↓
  confirm-gate 记一笔，超了免确认额度
        ↓
  往上下文注入：「立刻停止，向用户索要 confirm」
        ↓
  第 15 次（硬上限）→ 工具失败，等用户回 confirm
        ↓
  用户回一句 confirm → 整轮放行，计数器清零
```

**它不是拦截器，是一个会说话的计数器**：前 10 次不管，
11–14 次提醒模型自己刹车，15 次才真拦。这样模型有机会在你去喝咖啡的时候自己停下来。

---


## 三十秒上手

```powershell
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:SteelUnion/dsh-confirm-gate
```

装完重启 DSH 就生效。想调额度就改 `cordis.patch.yml`：

```yaml
- id: confirm-gate
  name: dsh-confirm-gate
  config:
    freeLimit: 10     # 前 10 次不管
    hardLimit: 15     # 第 15 次停下来问你
    confirmWord: confirm
```

---

## 它替你省什么

| 场景 | 没有它 | 有它 |
|---|---|---|
| 模型陷入循环、反复改同一个文件 | 一路烧到额度用完 | 第 11 次开始提醒，第 15 次停下 |
| 你离开电脑半小时 | 回来发现改了两百个文件 | 停在你回来之前 |
| 想让它继续 | 不知道它跑到哪了 | 回一句 `confirm`，整轮放行 |

**它不是安全沙箱**——沙箱是 DSH 自己的事。它管的是**成本与方向**：
让模型在烧钱和跑偏之前，有能力自己刹车。

---

## 下面开始是细节

**在完全权限的主机上，让 AI Agent 可控运行的次数闸框架。**

> **是什么** — 按轮统计持久化操作。给模型一个刹车，不是一堵墙。
> **已验证** — Windows 真机热切换（full → workspace-write → read-only → full），全程不重启；模型在第 11/15 次**自己停下来了**。
> **成本** — 约 0.27 USD 模型花费。零外部依赖，[`dist/`](dist/) 里有可直接安装的包。
>
> **沙盒 / 只读模式下它自动让位** —— 与 DSH 自带沙盒互补，不是替代。
> **微信通道里拦掉中途选项** —— 回合制通道承载不了半路弹卡，见[第九节](#九微信通道拦截中途交互选项)。

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的运行时插件。提供**每轮对话独立的持久化操作计数器**，在免确认额度用尽后向模型注入停止指令，达到硬上限时索要用户 confirm。

> **兼容性** — 在 DSH `0.2.0-rc.2` 上开发并验证；peer 范围写成 `>=0.2.0-rc.2`，所以 `0.2.1-rc.2` 及之后的 RC 版本也能装。如果将来某个 DSH 版本改动了本插件绑定的工具派发钩子，它会**明确报错**，不会静默失效——见[第五节验证方法](#七怎么确认装好了)。

> **这不是安全边界，是成本边界和方向纠偏机制。**
> 它假设 Agent 运行在**没有沙盒接管边界**的环境里，目的是让模型在烧 token 和乱改文件之前**有能力自己刹车**。真正的沙箱隔离由 DSH 自己的 sandbox 提供，与本插件互补而非替代。

*成本数字是作者估算，见 [`dist/COSTS.md`](dist/COSTS.md)。当天其余的钱花在环境排障和研究上，不在这个插件里。*

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

### 取舍与已知局限

先说取舍，因为那才是有意思的部分。

1. **前 N 次完全没有闸。** 默认 `freeLimit: 10`，第 1~10 次只提醒不拦。这个窗口是**故意留的** —— 给模型自己纠错的空间。要零容忍就把 `freeLimit` 设成 `0`，插件会在第一次持久化操作前就索要确认。
2. **`confirm` 防的是误操作，不是注入。** 威胁模型是「信任的用户 + 会犯错的模型」，要防的失败是无限试错。提示注入是另一层的事 —— 那是 DSH 的审批通道和沙箱负责的。**别把它当成不信任输入和你文件系统之间唯一的东西。**
3. **放行规则粗。** 任何含识别语的消息放行整轮，包括只是在讨论这个词的消息。这是故意的：歧义按用户打出来的字解决，不靠插件猜意图。
4. **命令判定是名字比对，不是解析器。** `Get-ChildItem $p.GetFiles()` 会被判成持久化，因为插件不解析管道。错误方向是选过的：**宁可多计，不可漏拦。**
5. **一次工具调用算一次**，不管它动了几个文件。

### 为什么没选别的

| 另一个方案 | 为什么不用 |
|---|---|
| **硬拦截，不计数** | 第一版在 OpenClaw 里试过。一堵墙会把每次写操作变成用户没要求的打断。改成计数 + 明确的停止指令后，模型自己会算账 —— 第 11/15 次它自己停了。**刹车比墙好用。** |
| **纯插件、不挂 DSH 的钩子** | 每轮计数必须来自**工具派发层**。包一层模型 API 看不到单次工具调用，也就数不了。计数得放在调用发生的地方。 |
| **塞进沙箱里** | 两个问题、两层东西。沙箱回答「这件事许不许」，这个回答「已经做了多少」。塞进沙箱，预算就会绑在一个随时会变的权限模型上。 |

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
      name: "dsh-confirm-gate"
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
| `Get-ChildItem E:\work -Force` | 只读 ✅ |
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

## 九、微信通道：拦截中途交互选项

**微信通道是回合制的。** 它把一整轮跑完、拿到最终回复，才发一条消息给用户。中途弹出的选项没有地方落。

| | 桌面 Web GUI | 微信通道 |
|---|---|---|
| 中途弹选项 | ✅ 有应答方，用户直接点 | ❌ 这一轮还在跑，用户收不到 |
| 后果 | 正常 | **整轮挂住，双方一起等** |

所以本插件在**微信会话**里拦掉会发起中途交互的工具（当前是 `ask-user-question`），并让模型改用**纯文本**把问题写进正常回复里，等用户下一条消息作答。

### 它怎么知道这是微信会话

**不靠配置，不靠猜。** 微信通道插件（`dsh-wechat-queue`）通过 cordis 服务把自己的归属判断暴露出来：

```js
ctx.provide('wechatQueue', {
  owns(sessionId) { return ownsSessions.has(id); },
});
```

本插件用 `ctx.get('wechatQueue')` 软探测这个服务，再拿 `exec.agent.session.id` 去问。

**`owns` 读的是内存集合，登记时机在「会话建好之后、这一轮开跑之前」。** 所以在 `tools/pre-execute` 里问到的一定是准的，不存在「刚重启还没登记」的空窗。

### 拦截返回值是 `deny`，不是 `block`

这一点很关键，也踩过：

`tools/pre-execute` 是 waterfall，DSH 只认四种返回值：

| 返回值 | 效果 |
|---|---|
| `allow` | 执行 |
| `ask` | 走审批通道 |
| **`deny` + `reason`** | **不执行，`reason` 以 `Error: <reason>` 交回模型** |
| `cancel` | 不执行，但**带不了原因** |

`block` 是 `tools/post-execute` 的合法值，**在 `pre-execute` 里是非法值**——既不是 `ask` 也取不到 `reason`，会被当成「没有拒绝理由」直接派发，**工具照常执行**。

选 `deny` 而不是 `cancel`，是因为只有 `deny` 能把原因送进模型上下文。`cancel` 是哑的：模型只看到一个中止结果，很可能原地重试，于是再被拦一次。

### 三条保守原则

拿不到准确答案时，一律当作「**不是**微信会话」：

1. 拿不到 `wechatQueue` 服务 → 不拦
2. 拿不到 `session.id` → 不拦
3. `owns()` 抛异常 → 不拦

**方向是「宁可漏拦，绝不误拦」。** 两种失效不对称：

- **误拦** → 桌面会话失去选项功能，**本来正常的能力被弄坏**
- **漏拦** → 回到没有这个功能的状态

失向这边，是因为「多拦一次」的代价比「弄坏一个正常功能」高。

### 你会看到什么

在微信会话里让模型用选项时，工具直接返回：

```
Error: 指令：当前会话是微信通道，不能发起中途交互选项。……请立刻改用纯文本提问
```

**这不是报错，是拦截生效。** 模型随后会用文字把问题重写一遍发给你。

### 局限

- **需要那个通道插件提供 `wechatQueue` 服务。** 没有它就退化成不拦——本插件不会因此报错。
- **只认服务名 `wechatQueue`。** 别的通道（Slack、Discord……）要接，得各自提供同名服务，或在本插件里加分支。
- **微信里永远没有可点的选项。** 这是回合制通道的固有代价，不是本插件能绕开的。

---

## 十、用到的 DSH 核心逻辑

这一节把本插件依赖的 DSH 内部契约逐条写下来。**它们是文档没写、靠读源码和真机实测确认的东西**，也是升级 DSH 后最可能变的地方。

### 10.1 `tools/pre-execute` 的返回值契约

**权威实现位置**：`@deepseek-ai/dsh-tools` 的 `prepareExecution()`。

```js
const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec,
                                      () => Promise.resolve({ kind: 'allow' }));
if (decision.kind === 'cancel') {
  return await next({ kind: 'post-result', result: toolAbortedBeforeDispatchResult() });
}
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason;
if (denialReason !== undefined) {
  return await next({ kind: 'post-result',
    result: { content: [{ type: 'text', text: `Error: ${denialReason}` }], isError: true }});
}
// 落到这里 → dispatch
```

**逐值语义：**

| 返回值 | 是否执行 | 模型看到什么 |
|---|---|---|
| `{ kind: 'allow' }` | ✅ | 正常工具结果 |
| `{ kind: 'ask', reason }` | 视审批结果 | 审批被拒 → 拒绝原因 |
| **`{ kind: 'deny', reason }`** | ❌ | **`Error: <reason>`，`isError: true`** |
| `{ kind: 'cancel' }` | ❌ | 「调用前已中止」，**没有原因** |
| 其它任何值（含 `block`） | ✅ **照常执行** | 正常工具结果 |

**最后一行是最容易踩的。** `block` 在 `tools/post-execute` 里是合法值，在 `pre-execute` 里不是。DSH 不会对非法值报错，只会走到 `dispatch` 那一步——**你以为拦了，其实什么都没发生。**

### 10.2 waterfall 与 `next()`

`tools/pre-execute` 是 **waterfall** 事件：每个监听者拿到本轮的当前结论，可以改写，也可以 `return next()` 直接透传。

- **不调 `next()` 就是短路整条流水线**，后面的监听者全都收不到。
- **本插件的写法**：不关心的情况一律 `return next()`；要拒绝时返回 `deny` 对象，**不调 `next()`**——因为已经给出终局结论。

### 10.3 单调 guard 与 `deny` 的关系

DSH 在 waterfall 之外还有一层 `tools.guard()`，它是**单调**的：只能拒绝，不能放行。

```js
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason;
```

**`deny` 会跳过 guard 检查**——本插件已给出拒绝理由，没必要再问一遍 guard。**`allow` 才继续走 guard。**

### 10.4 `ctx.provide()` 是注册服务的唯一入口

本插件要问别的插件「这个会话是不是你的」，得靠 cordis 服务。**注册服务的正确写法只有一种：**

```js
ctx.provide('wechatQueue', { owns(sessionId) { … } });
```

它的内部实现是 `ctx.reflect.provide(name, value, check)`：

- 会自行把 `reflect.props[name]` 声明成 `{ type: 'service' }`
- 注册在**当前 fiber** 上，fiber 卸载时**自动注销**，不需要手工清理

**两种错误写法，都会让插件整个不启动：**

| 写法 | 结果 |
|---|---|
| `export const provide = ['wechatQueue']` | ❌ **cordis 不读 ESM 导出**，这条声明零效果 |
| `ctx.set('wechatQueue', {...})` | ❌ `ctx.set` 只能**改**已声明的属性，`reflect.props[name]` 不存在时直接抛 `cannot set property "..." without provide` |

**报错说的是「这个属性还没被声明成服务」，不是「你没在 provide 数组里写」。** 看到这句就去换 `ctx.provide`，别在数组上找办法。

### 10.5 服务是惰性注入的，必须软探测

cordis 的依赖注入是惰性的：**碰一个没在 `inject` 里声明的服务属性，会抛注入门错误**，不是返回 `undefined`。

所以本插件读 `wechatQueue` 时：

```js
const svc = typeof ctx?.get === 'function' ? ctx.get('wechatQueue') : undefined;
```

**用 `ctx.get(name)` 软探测，绝不直接写 `ctx.wechatQueue`。** 这条路径上抛一次异常，拦截就会彻底静默失效——而且日志里看不出来。

### 10.6 `exec` 里有什么

`tools/pre-execute` 拿到的 `exec` 结构（本插件实际用到的字段）：

| 字段 | 用途 |
|---|---|
| `exec.name` | 工具名，判「是不是交互类工具」 |
| `exec.arguments` | 参数，判断是否为持久化命令时用 |
| `exec.agent` | 发起调用的 agent |
| `exec.agent.session.id` | **会话 id**，问 `wechatQueue.owns()` 用的就是它 |

**`exec.agent` 可能是 `undefined`**（某些调用没有 agent 上下文），本插件对此一律放行。

### 10.7 `agent/pre-step` 的 `messages` 是增量

`messages` 是**本步新增的消息**，不是完整历史。DSH 用 `claim()` 取增量。

**这个语义决定了「出现新 user 消息就重置计数」能工作**：如果 `messages` 是完整历史，那每一步都会看到同一条旧消息，计数会被无限重置。

### 10.8 注入消息的 `source.kind`

本插件往上下文里注入提醒时，用的是：

```js
source: { kind: 'user-approval', form: 'notice', … }
```

- **必须用 `MessageSourceMap` 里已声明过的 kind**，自定义 kind 可能被下游拒绝
- **不能用 `'user'`**——自己的 `pre-step` 会把它当成用户的新消息，每步都自清计数

### 10.9 沙盒模式要读两个源

| 优先级 | 源 | 说明 |
|---|---|---|
| 1 | `ctx.sessionProjections.stateOf(session, 'permissions').sandbox` | 会话**当前**值，热切换时跟着变 |
| 2 | `ctx.shell.sandboxMode` | executor 的**默认**值，**不跟随热切换** |

**只看第 2 个会错**：切进沙盒再切回来，读到的永远是启动时那个值。

---

## 十一、已知边界

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

## 十二、附录：为什么需要完全权限

在 Windows 上，DSH 的沙箱会让 `pwsh` 调用全部返回 `0xC0000142`（`STATUS_DLL_INIT_FAILED`）。三层原因：

1. **策略层** `dsh-sandbox-policy` —— 会话模式决定后续是否启用
2. **令牌层** `dsh-sandbox-windows-acl` —— 复制令牌、剥权限、压 Low 完整性、加能力 SID 和保活组；**缺保活组就在 DLL 初始化期死**
3. **启动层** `dsh-pwsh-sandbox` —— 受限令牌下**必须继承宿主控制台**，自己开控制台即死

`danger-full-access` 会绕过全部三层（官方文档：「绝不咨询提供方」）。

**所以本插件的定位是：当你不得不给完全权限时，起码让它有账可算。**

---

## 参与

欢迎 PR 和 issue。特别欢迎针对[已知边界](#九已知边界)里那两条未验证项的补充 —— `12 ~ 15` 区间行为，以及审批人在线时 `ask` 是否正常弹出。

它同时也是**向上游 DeepSeek Harness 提正式 PR** 的候选，作为一次低成本的能力证明。如果维护者更愿意把它收进主仓，这个讨论我们随时可以开。

---

## 许可

MIT
