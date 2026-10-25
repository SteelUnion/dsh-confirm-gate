# confirm-gate 全程复盘（面试用）

> 2026-10-17 一天内完成：从零到发布 v0.1.0。
> 这份文档面向「想了解我怎么做工程的人」，不是流水账。
> 每个技术结论都标了证据来源，不写「我觉得」。

---

## 一、我在做什么，为什么值得做

### 问题

DeepSeek Harness（DSH）在 Windows 上，只要开启沙箱，`pwsh` 工具就全部返回
`0xC0000142`（`STATUS_DLL_INIT_FAILED`）。三层原因叠加：策略层、令牌层、启动层。
唯一可用的配置是 `danger-full-access`——完全权限，**没有任何东西拦得住 agent**。

于是出现一个两难：

- 开沙箱 → 工具全废，agent 什么也做不了
- 关沙箱 → agent 可以无限试错、乱改文件、烧光额度，没人记录

**confirm-gate 补的是中间那一层**：不阻止，但**记账**，并在该停的时候让 agent 自己停。

### 定位（重要，别搞混）

**它不是安全边界，是成本边界和方向纠偏机制。**

真正的隔离由 DSH 的 sandbox 提供。这个插件解决的是「没人管账」的问题，
不是「有人恶意突破」的问题。这个定位决定了后面所有的设计取舍。

---

## 二、最终形态

### 三档行为

```
新一轮开始
   │
   ├─ 用户消息含 confirmWord？
   │     ├─ 是 → 整轮放行，不计数、不提醒、不拦
   │     └─ 否 ↓
   │
   ├─ 持久化操作 +1
   │     ├─ 1 ~ freeLimit        → 放行 + 提醒
   │     ├─ freeLimit+1 ~ hard-1 → 放行 + 【指令：立即停止】
   │     └─ >= hardLimit         → { kind: 'ask' } 索要 confirm
   │
   └─ 非持久化操作 → 永不计数
```

### 两个层面的判定

**1. 工具层**：按工具名判定。
写文件、执行命令、派发子代理、外发 = 持久化；读、搜、列目录 = 不持久化。

**2. 命令层**：`pwsh` 不再一律计数，而是**看命令内容**。
`exec.arguments.command` 落在只读白名单（`Get-ChildItem` / `Get-Content` /
`Test-Path` / 纯管道）→ 不计数。

**判定是名字比对，不是 PowerShell 语法解析。** 拿不准一律判持久化——
**只会多计，不会漏拦**。这个方向是故意的。

### 生效范围：沙盒下保持沉默

**每次工具调用时现判**，不是加载时判一次：

| 沙箱模式 | 是否计数 | 为什么 |
|---|---|---|
| `read-only` / `workspace-write` | ❌ | 边界已被沙盒接管，再加一层只会把正常操作拦第二次 |
| `danger-full-access` / `custom` | ✅ | 边界没人管 |
| 读不到 | ✅ | **倾向生效**（见第四节） |

---

## 三、技术底子：DSH 的插件机制

这一节是读 `app.asar` 源码得来的，不是猜的。

### 工具执行流水线

```
agent/pre-step      每步前。messages 是本步增量，不是全历史（DSH 用 claim() 取）
      ↓
tools/pre-execute   执行前，waterfall。返回 allow / deny / ask / cancel
      ↓
tools/execute       真正执行
      ↓
tools/post-execute  执行后，可追加 additionalContexts
```

### `exec` 的真实结构（探针实测，DSH 0.2.0-rc.2）

```json
{
  "keys": ["token","callId","rootCallId","name","signal","agent",
           "deferContext","concludeTurn","arguments"],
  "name": "pwsh",
  "arguments": { "command": "...", "description": "..." }
}
```

**两个要点：**

1. 参数在 **`exec.arguments`**，不是 `params`。我一开始写错，探针白跑一轮。
2. `arguments` 经 `snapshotJsonValue` 深拷贝 + `deepFreeze` 冻结。
   插件读它安全，**改不动它**——所以判定逻辑只能读，不能改写。

### 几个关键 API

| 用途 | 正确写法 |
|---|---|
| 读服务 | `ctx.get('shell')`，**不要** `ctx.shell` |
| 会话当前沙箱模式 | `ctx.sessionProjections.stateOf(session, 'permissions').sandbox` |
| executor 默认模式 | `ctx.shell.sandboxMode`（**默认值，不跟热切换变**） |
| 拿 session | `exec.agent.session` |

### 插件包结构（三个字段缺一不可）

```json
{
  "type": "module",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `exports` 缺 `./cordis.patch.yml` → patch 解析不到，bundle 加载器直接跳过
- `dsh.bundle.patch` 少了 `./` 前缀 → 同样跳过

### 不能导出 `Config`

cordis 的配置解析：

```js
if (!runtime.Config) return config;                            // 没有 → 原样用
const result = runtime.Config['~standard'].validate(config);   // 有 → 必须是 standard-schema
```

导出普通对象会让它在 `.validate` 崩掉，**而且错误只写 stderr，插件静默失败**。

**本插件刻意不导出 `Config`**，全部校验在 `apply()` 内完成，同样 fail-loud。

---

## 四、这一天的四个 bug（面试重点）

### Bug 1：`exec.params` 字段名错

**现象**：探针文件不生成。
**原因**：我按习惯猜字段名 `exec.params`，实际是 `exec.arguments`。
**代价**：1 轮。
**教训**：**先打印全结构，再按结构取。** 不要假设第三方对象的字段名。

### Bug 2：改的是运行中的文件，不是仓库源文件

**现象**：测试全过，但真机没变化。
**原因**：`file:` 安装是**复制**不是链接，存在两份：

```
E:\work\confirm-gate\lib\index.js                        ← 测试读这个
C:\...\profiles\desktop\node_modules\dsh-confirm-gate\index.js  ← 运行时跑这个
```

我改了其中一份，测试测的是另一份。**测试通过 ≠ 测的是新代码。**
**代价**：2 轮。
**做法**：改完用 hash 比对两份，不看大小（大小可能巧合相同）。

### Bug 3：静默失效（最贵的一个）

**现象**：插件加载了、钩子注册了、每次调用都触发了，**但从来不计数**。

**链条**：

```
ctx.shell                  → 抛注入门错误（cordis 依赖注入是惰性的）
      ↓
try/catch 吞掉             → known = false
      ↓
判定「有东西在管」         → gate inactive
      ↓
每次调用都跳过             → 插件在跑，却永远沉默
```

**三个错误叠在一起**：

1. 直接读 `ctx.shell`——没在 `inject` 里声明，cordis 抛错
2. catch 吞掉异常，读不到 → 看起来只是「未知」
3. 把「未知」当成「不安全」，选了保守沉默

**为什么它最贵（5 轮）**：日志看起来完全正常，没有报错，
插件该注册的都注册了。这种 bug 靠猜永远找不到。

**怎么找到的**：三层探针。

```js
// 第 1 层：模块顶层 —— 证明被 import 了
probe(`MODULE LOADED pid=${process.pid} file=${import.meta.url}`);

// 第 2 层：apply() 内 —— 证明初始化了
probe(`apply() called, config=${JSON.stringify(config)}`);

// 第 3 层：钩子入口 —— 证明被调用了
probe(`[enter] pre-execute tool=${exec?.name}`);
```

日志里三层都在，还多一条 `gate inactive: (unknown — threw)`，问题直接锁定。

**修法两条**：

```js
// 1. 软探测，不抛
const shell = typeof ctx.get === 'function' ? ctx.get('shell') : ctx.shell;

// 2. 读不到时倾向生效，不是沉默
if (!known) return { active: true };   // fail open
```

### Bug 4：判定写在 `apply()` 里，热切换跟不上

**现象**：会话里切换权限模式，插件行为不变。
**原因**：`apply()` 只在加载时跑一次。判定写在那里 = 冻结在启动那一刻。
**修法**：判定移进 `pre-execute` / `post-execute`，**每次调用现读**。
**代价**：每步多一次属性访问，可以忽略。

**附带发现**：`ctx.shell.sandboxMode` 是**默认值**，
官方注释写明 `"the sandbox mode this executor applies by default"`，
**不跟热切换变**。要读会话当前值必须用 `sessionProjections`。

---

## 五、设计取舍（面试可能追问的地方）

### 为什么 fail open 而不是 fail closed？

**因为这不是安全边界。**

| 失效方式 | 代价 |
|---|---|
| 该沉默时报警 | 多一条提醒，**看得见、改得掉** |
| 该报警时沉默 | **插件装着却什么都不做**，日志看不出异常 |

对记账工具，后者严重得多。**安全边界才该 fail-closed。**

Bug 3 就是 fail-closed 选错方向的后果。

### 为什么 confirm 放行整轮，而不是一笔一确认？

confirm 是对**一件事**的授权，不是对**一次操作**的授权。

按笔确认会让 agent 每敲一条命令就回来问一遍，把一次执行切成十次中断。
用户原话：「我给了 confirm 还是被计数，那不是白给了。」

代价：含识别语即放行是粗粒度的，讨论时提到 confirm 也会触发。**刻意选简单规则**，
把歧义交给用户措辞，而不是让插件猜意图。

### 为什么命令判定不做语法解析？

插件跑在 DSH 进程内（ESM 模块），调不到 PowerShell 的 AST 解析器。

所以只能**提取命令名做集合比对**：

```
按 ; | && || 换行 { } 切分段 → 取每段第一个 token → 是否在白名单里
```

不完美：`Get-ChildItem $p.GetFiles()` 会被判成持久化。
**但错的方向是多计一次，不是漏拦。** 这是有意选的失效方向。

### 为什么沙盒下要让开？

沙盒已经管住边界了，再加一层计数 = **把正常操作拦第二次**，纯属添乱。

用户原话：「如果权限有限，这个钩子没必要挂上去，
到时候人家沙盒操作持久化都被拦截，很蠢。」

---

## 六、验证：怎么证明它真的能用

### 离线测试：27 项，全过

```
261 行 test/integration.mjs
  ├─ 三档行为与计数
  ├─ 非持久化不计数
  ├─ 含 confirm 放行整轮（连续 30 次不拦）
  ├─ 大小写不敏感 / 句中任意位置
  ├─ 热切换双向（默认全权+会话沙盒 → 静默；反向 → 计数）
  └─ 两个数据源都读不到 → 仍生效
```

**测试用的假 ctx 必须是真实 ctx 的形状。** 我一开始用 `{ on() {} }`，
没有 `get()` 方法——测试全过，真机全挂。改成软探测形状后才对齐。

### 真机热切换：三模式逐步验证，全程不重启

| 模式 | 写文件 | `pwsh` | 计数 | 证据 |
|---|---|---|---|---|
| `danger-full-access` | ✅ | ✅ | ✅ | 1/10 → 2/10 → 3/10 |
| `workspace-write` | ✅ | ❌ 0xC0000142 | ❌ 静默 | 2 次操作 0 警告 |
| `read-only` | ❌ 沙盒拒绝 | ✅ | ❌ 静默 | 2 次操作 0 警告 |
| 切回 `danger-full-access` | ✅ | ✅ | ✅ | **1/10，同一进程内恢复** |

**最后一行是最关键的证据**：同一进程、不重启，门控回来了。
这直接证明「按次判定」是对的。

### 诚实的保留

这个部署里 `ctx.get('shell')` 返回 `undefined`，
所以「不沙盒」的结论来自 **fail-open 兜底分支**，不是真的读到了模式。
行为正确，路径是回退那条。这条也写进了 README。

---

## 七、数字

| 项 | 值 |
|---|---|
| 开发周期 | 1 天 |
| `lib/index.js` | 716 行 |
| 测试 | 261 行 / 27 项 |
| 提交 | 11 次 |
| 成品包 | 35 KB |
| **插件本体花费** | **约 0.27 USD**（估算） |
| 当天总消耗 | 6.92 CNY ≈ 1.04 USD（含 OpenClaw 与其他工作） |

**0.27 USD 是估算，不是账单。** 依据：余额差值 + 汇率 1 CNY = 0.15 USD，减去
OpenClaw 占用（约 0.26 USD），再按约 35% 归到插件本体。其余花在环境排障、
架构研究、社区回复、配置调整上——那些是一次性投入，后面能复用。

---

## 八、如果面试官问这些，我这么答

**Q：为什么不做成沙箱，而是做计数？**
A：沙箱解决「不许做」，计数解决「做太多」。DSH 在 Windows 上沙箱会让工具全废，
用户被迫开完全权限——这时缺的不是另一道墙，而是一本账。定位不同，不能互相替代。

**Q：你的插件的 bug 里，哪个最难查？**
A：静默失效那个。插件加载了、钩子注册了、调用触发了，就是不干活，日志看起来全正常。
根因是 cordis 懒注入抛错被 catch 吞掉，加上我把「读不到」误判成「不安全」。
三层探针才定位。这件事改变了我对「保守」的理解——**对记账工具，静默比吵闹危险**。

**Q：怎么验证一个插件真的生效？**
A：`--dump-config` 显示条目**不算证据**，它只渲染配置树。
唯一可靠的是模块顶层写文件探针。我的三层探针（加载 / 初始化 / 钩子触发）
能把问题定位到具体哪一环。

**Q：怎么保证测试是真的在测新代码？**
A：`file:` 安装是复制，存在两份文件。我踩过「改了 A，测的是 B」的坑。
现在改完用 hash 比对两份，不看大小。另外假 ctx 必须模拟真实 ctx 的形状——
我用过于简化的假对象，测试全过但真机全挂。

**Q：0.27 USD 这个数怎么来的？**
A：估算，不是账单。余额差值 6.92 CNY × 0.15 = 1.04 USD，减 OpenClaw 约 0.26，
DSH 侧 0.78，再按工作量归约 35% 到插件本体。**我在 README 里明确标了 estimated**，
因为拿一个不说清口径的低数字当卖点是误导。

---

## 九、资产位置

| 内容 | 路径 |
|---|---|
| 源码仓库 | `E:\work\confirm-gate\` |
| GitHub | `https://github.com/SteelUnion/dsh-confirm-gate` |
| 成品包 | `dist\dsh-confirm-gate-v0.1.0.zip` |
| Release 附件 | `releases/download/v0.1.0/dsh-confirm-gate-v0.1.0.zip` |
| 花费记录 | `dist\COSTS.md` |
| 展示帖草稿 | `docs\show-your-plugins-post.md` |
| 运行时安装位置 | `~\.dsh\profiles\{desktop,web}\node_modules\dsh-confirm-gate\` |
