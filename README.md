# dsh-confirm-gate

![License](https://img.shields.io/badge/license-MIT-blue)
![Zero deps](https://img.shields.io/badge/dependencies-zero-brightgreen)
![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-orange)
![Version](https://img.shields.io/badge/version-0.2.0-lightgrey)

> **Stops your AI agent before it rewrites 20 files and burns a day of budget.**
>
> Install it and every action the model takes is counted. As the budget runs down it
> starts telling the model to brake; at the hard limit the model stops and waits for you
> to type `confirm`. **No kernel changes, no required config.**

English | [中文](README.zh-CN.md) · **v0.2.0**

---

## What it looks like while running

```
The model starts its 11th file change
        ↓
  confirm-gate counts it, past the free budget
        ↓
  Injects into context: "stop now, ask the user for confirm"
        ↓
  The 15th (hard limit) → the tool fails, waits for you
        ↓
  You type confirm → the whole turn is released, counter resets
```

**It is not an interceptor; it is a counter that talks.** The first 10 calls go
unnoticed, 11–14 tell the model to brake on its own, and only the 15th actually stops it.
That gap is what lets the model come to a halt while you are away from the keyboard.

---

## 30-second start

```powershell
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:SteelUnion/dsh-confirm-gate
```

Restart DSH and it is on. To tune the budget, edit `cordis.patch.yml`:

```yaml
- id: confirm-gate
  name: dsh-confirm-gate
  config:
    freeLimit: 10     # first 10 calls go unnoticed
    hardLimit: 15     # the 15th stops and asks you
    confirmWord: confirm
```

---

## What it saves you

| Situation | Without it | With it |
|---|---|---|
| The model loops, rewriting the same file | Burns the whole budget | Warns from the 11th call, stops at the 15th |
| You step away for half an hour | You come back to 200 changed files | It stopped before you got back |
| You want it to continue | No idea how far it got | Reply `confirm` and the whole turn is released |

**This is not a security sandbox** — sandboxing is DSH's own job. This manages **cost and
direction**: it gives the model the ability to brake before it burns money or drifts.

---

## The details start here

**A bounded-run framework that keeps an AI agent accountable on hosts where you had to grant full permissions.**

> **What** — Per-turn counter for persistent operations. Gives the model a brake, not a wall.
> **Verified** — Live hot-switch on Windows (full → workspace-write → read-only → full), no restart. The model stopped itself at 11/15.
> **Cost** — ~$0.27 model spend. Zero external deps, ready-to-install archive in [`dist/`](dist/).
>
> **It steps aside under sandbox / read-only modes** — complementary to DSH's own sandbox, not a replacement.
> **It blocks mid-turn prompts on the WeChat channel** — a turn-based channel cannot carry a mid-turn card; see [section 9](#9-wechat-channel-blocking-mid-turn-interactive-prompts).

A runtime plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps a **per-turn counter of persistent operations**, injects a stop instruction once the free budget is spent, and asks the user for confirmation at a hard limit.

> **Compatibility** — built and verified against DSH `0.2.0-rc.2`; the peer range is `>=0.2.0-rc.2`, so it also loads on `0.2.1-rc.2` and later RC builds. If a future DSH release changes the tool-dispatch hooks this plugin binds to, it will fail loudly rather than silently — see [§7](#7-verifying-the-installation).

> **This is not a security boundary. It is a cost boundary and a course-correction mechanism.**
> It assumes the agent is running **without a sandbox holding the boundary**, and its purpose is to give the model **the ability to brake on its own** before it burns tokens or rewrites files. Real sandbox isolation is provided by DSH's own sandbox — complementary to this plugin, not a replacement.

*Cost figure is an author's estimate — see [`dist/COSTS.md`](dist/COSTS.md). The rest of that day went to environment diagnosis and research, not to this plugin.*

### Scope: it stays silent under a sandbox

The plugin decides, **on every tool call**, whether it should be counting. The mode comes from two sources, in priority order:

1. `ctx.sessionProjections.stateOf(session, 'permissions').sandbox` — the session's **current** knob value. This is what changes when you hot-switch modes mid-conversation.
2. `ctx.shell.sandboxMode` — the executor's **default** mode. Its own documentation calls it "the sandbox mode this executor applies by default"; it does **not** follow a hot switch, so it is only a fallback.

That distinction matters: judged from the default alone, switching into a sandbox and back would leave the plugin reading the value it saw at startup, forever.

Both reads go through `ctx.get(name)`, never `ctx.shell` directly. cordis resolves dependencies lazily, so touching an undeclared service property throws an inject-gate error — and an exception on that path once made the plugin silently do nothing at all. Soft probing cannot throw.

| Sandbox mode | Plugin counts? | Why |
|---|---|---|
| `read-only` | ❌ No | The sandbox already holds every boundary |
| `workspace-write` | ❌ No | Same |
| `danger-full-access` | ✅ Yes | Nothing is holding the boundary |
| `custom` | ✅ Yes | A custom mix still leaves the boundary unheld |
| `undefined` / no shell service | ✅ Yes | This executor does not confine |
| **Unreadable (both sources threw)** | ✅ Yes | **Fail open: a silent no-op is worse than an extra reminder** |

That last row is deliberate. This plugin is an accounting tool, not a security boundary, so the two failure modes are not symmetric:

- counting when it shouldn't → a spurious reminder, immediately visible and fixable
- staying silent when it shouldn't → **the plugin appears installed but does nothing**, and nothing in the logs looks wrong

The second is far worse, so any mode it cannot read counts as "not sandboxed".

Put plainly: **under a sandbox this plugin would be redundant — and worse, it would interrupt legitimate operations a second time.** So it steps aside wherever something else is already keeping score.

Hooks are always registered; the decision is per call. That is what makes hot-switching work: move the session into a sandbox and the gate goes quiet on the very next call; move it back and counting resumes. No restart needed.

> ### ✅ Status: verified, including live hot-switching
>
> Exercised by hand on Windows, DSH `0.2.0-rc.2`. The session's permission mode
> was **switched live, without restarting DSH**, walking the sequence
> full → workspace-write → read-only → full:
>
> | Mode | Write a file | `pwsh` | Gate counted? |
> |---|---|---|---|
> | `danger-full-access` | ✅ succeeds | ✅ runs | ✅ **1/10 → 2/10 → 3/10** |
> | `workspace-write` | ✅ succeeds | ❌ fails with `0xC0000142` | ❌ silent (2 ops) |
> | `read-only` | ❌ sandbox denies | ✅ runs | ❌ silent (2 ops) |
> | `danger-full-access` again | ✅ succeeds | ✅ runs | ✅ **1/10, counting resumed** |
>
> Two things matter here. The silent rows show the division of labour working —
> the sandbox confined or rejected the operation and the gate stayed out of the
> way. The last row shows the gate coming back **in the same process**, which is
> the whole point of deciding per call instead of at load.
>
> Honest caveat: in this deployment `ctx.get('shell')` returned `undefined`, so
> the "not sandboxed" verdict came from the *unreadable, therefore fail open*
> branch rather than from a successfully read mode. The behaviour is correct;
> the path is the fallback one. A deployment that exposes `shell` would take the
> primary path instead.

### Who this is for

| Situation | Fits? |
|---|---|
| You granted full permissions and fear unbounded trial-and-error burning tokens | ✅ That is exactly the case |
| You want the agent to ask after N write operations | ✅ |
| You want `read` / `grep` / web lookups **never interrupted** | ✅ Non-persistent operations are never counted |
| You want to use it as a sandbox against a malicious model | ❌ Use DSH's built-in sandbox |
| You use a different agent framework | ❌ This is a DSH plugin |

### Trade-offs & known limitations

Listed first, because they are the interesting part.

1. **The first N operations have no gate at all.** In the default `freeLimit: 10` configuration, operations 1–10 are allowed with only a reminder. That window is deliberate — it gives the model room to correct itself before being asked to stop. Set `freeLimit: 0` when you want zero tolerance; the plugin then ask-confirms before the very first persistent operation.
2. **`confirm` defends against accidents, not injection.** The threat model is a *trusted user with a fallible model*, where the failure to prevent is unbounded trial-and-error. Prompt injection is a different layer — that is what DSH's approval channel and sandbox are for. Do not deploy this as the only thing between an untrusted input and your filesystem.
3. **The release rule is deliberately coarse.** Any message containing the trigger word releases the entire turn, including a message that merely discusses the word. This is on purpose: ambiguity is resolved by what the user typed, not by the plugin guessing intent.
4. **Command judgement is a name comparison, not a parser.** `Get-ChildItem $p.GetFiles()` is counted as persistent, because the plugin does not evaluate the pipeline. The error direction is chosen: over-count, never under-count.
5. **A tool call is one count**, regardless of how many files it touches.

### Why not X

| Alternative | Why not |
|---|---|
| **Hard-block instead of counting** | Tried first in an OpenClaw build. A wall turns every write into an interruption the user did not ask for. With a counter and an explicit stop instruction, the model does the arithmetic itself — it stopped at 11/15 on its own. The brake works better than the wall. |
| **Plugin-only, no DSH host hooks** | The per-turn count has to come from the **tool-dispatch layer**. A wrapper around the model API cannot see individual tool calls, so it cannot count them. The count lives where the calls live. |
| **Fold it into the sandbox** | Different question, different layer. A sandbox answers "is this allowed?". This answers "how much has happened?". Sitting inside the sandbox would tie a budget to a permission model that changes underneath it. |

---

## 1. Design rationale

Granting full permissions is unavoidable — a sandbox makes tools like `pwsh` fail outright (see [Appendix](#10-appendix-why-full-permissions-are-needed)). But full permissions mean **nothing is holding the agent back**.

The premise of this plugin:

> **Do not build a hard wall. Provide a counter and a brake signal.**

Empirically, the model stops when it receives an explicit "stop now" instruction (see [Field results](#8-field-results)). So there is no need to block it preemptively; you only need to **put ticks on the budget**, and the model will do the arithmetic itself.

---

## 2. Three tiers

```
New turn, counter reset to zero
        │
        ▼
  Does the user message contain confirmWord?
        │
   ┌────┴─────┐
  yes          no
   │           │
   ▼           ▼
release the   persistent operation +1
whole turn         │
(no count,   ┌────┴────┬──────────┬──────────┐
 no remind)  │         │          │          │
   │       1..free  free+1..    >= hard   (non-persistent)
   │         │      hard-1        │          │
   │         ▼         ▼          ▼          ▼
   │       allow     allow       ask      never counted
   │     +reminder +[STOP]   ask for confirm
   └─────────┴─────────┴──────────┘
```

| Tier | Behaviour |
|---|---|
| **Message contains `confirmWord`** | **The whole turn is released**: no counting, no reminders, no blocking |
| `1 ~ freeLimit` | Allowed, reminder injected |
| `freeLimit+1 ~ hardLimit-1` | Allowed, **STOP instruction** injected |
| `>= hardLimit` | Returns `{ kind: 'ask' }` and requests confirmation through the approval channel |

**Non-persistent operations (reading files, searching, listing directories, checking status, read-only commands) are never counted, never reminded about, and never blocked.**

### Containing the word releases the whole turn

The test is **whether `confirmWord` appears in the message at all** — it does not have to be the entire message.

| User message | Result |
|---|---|
| `confirm` | ✅ Released |
| `confirm, go ahead` | ✅ Released |
| `ok I agree, confirm, go for it` | ✅ Released |
| `CONFIRM` | ✅ Released (case-insensitive) |
| `take a look at this for me` | ❌ Not released; normal counting |

**Release applies to the whole turn**: once matched, every remaining persistent operation in that turn is uncounted, unreminded, and unblocked. Counting resumes when a message without the word arrives.

The reasoning: a confirmation authorizes **a task**, not **a single operation**. Counting per operation forces the model to come back and ask after every command, cutting one execution into ten interruptions.

---

## 3. What this framework lets you tune

**Everything is configurable; nothing is hard-coded.** Configuration lives in the profile's `cordis.patch.yml`.

### Numbers

| Parameter | Default | Meaning | Effect of an extreme value |
|---|---|---|---|
| `freeLimit` | `10` | Operations allowed without confirmation | `0` → the first operation already enters the instruction tier |
| `hardLimit` | `15` | Hard limit; confirmation requested on reaching it | `1` → confirmation requested on the first operation |

**Constraint**: `hardLimit > freeLimit`, otherwise an error is thrown.

### The trigger word

| Parameter | Default | Description |
|---|---|---|
| `confirmWord` | `confirm` | The word the user confirms with. It appears in injected text and in the approval reason |

Change it to switch the whole confirmation vocabulary — `dada`, `go`, `approved`, anything.

### Text

| Parameter | Default |
|---|---|
| `reminderText` | `Warning: persistent operation without confirm. Ask the user for confirm.` |
| `warningText` | `Instruction: stop all persistent operations without confirm immediately. Do not perform further writes, file edits, command execution, subagent dispatch or outbound sends. Report current progress, gaps and options to the user instead, and ask for confirm.` |
| `askReason` | `Persistent operation limit reached; user confirmation is required to continue.` |

### Counting scope

| Parameter | Default | Description |
|---|---|---|
| `include` | `[]` | Only count tool names matching these (`*` wildcards supported). Empty = count all |
| `exclude` | `[]` | Exclude matching tool names |
| `resetOnUserMessage` | `true` | Whether a new user message resets the counter |
| `resetOnConfirm` | `false` | Legacy: whether a bare confirmation counts as a reset point. **Not needed under the current logic** |

### About `resetOnConfirm`

In earlier versions, replying `confirm` merely meant "do not reset", so the budget still had to be re-earned afterwards — one confirmation was only the start of another interruption.

It is now **released for the whole turn when the word appears**. `resetOnConfirm` is kept only for backwards compatibility. Unless you explicitly want the old "confirmation grants a fresh full budget" behaviour, leave it alone.

### Example configuration

```yaml
# ~/.dsh/profiles/<your-profile>/cordis.patch.yml
- insert:
    - id: confirm-gate
      name: "dsh-confirm-gate"
      config:
        freeLimit: 0          # give nothing away
        hardLimit: 3
        confirmWord: approved
        warningText: Stop. No writes without approval — report first.
```

---

## 4. What counts as a "persistent operation"

The test: **after the action completes, has the outside world changed?**

### 4.1 Judged by tool name

| Category | Example tools | Counted? |
|---|---|---|
| Reading files, listing, searching, checking status | `read` `grep` `glob` `ls` `job-list` | ❌ |
| Session-only progress | `todo-write` | ❌ |
| Network reads | `web-fetch` `web-search` | ❌ |
| Writing files | `write` `edit` `str-replace` `apply-patch` | ✅ |
| Dispatch | `subagent` `subagent-fork` `workflow` | ✅ |
| Outbound | `message-send` `webhook-dispatch` | ✅ |

**Suffix fallback**: tool names ending in `write` / `edit` / `delete` / `remove` / `move` / `publish` / `deploy` / `commit` / `push` are always treated as persistent, to catch tools added later.

**Unknown tools default to non-persistent** (not blocked). To invert that, constrain the scope with `include`.

### 4.2 Command tools are judged by **command content**

`pwsh` / `bash` are no longer counted unconditionally — the plugin inspects **whether the command itself is read-only**.

If `exec.arguments.command` falls within the read-only whitelist → not counted; otherwise counted.

| Command | Counted? |
|---|---|
| `Get-ChildItem E:\x` | ❌ read-only |
| `Get-Content a.txt -Raw` | ❌ read-only |
| `Get-ChildItem \| Select-Object Name` | ❌ read-only (whole pipeline whitelisted) |
| `Get-Item x; Remove-Item y` | ✅ a write command is mixed in |
| `Set-Content a.txt "x"` | ✅ |
| `Get-ChildItem > out.txt` | ✅ redirection |
| `git status` | ✅ external program |
| `& "C:\a.exe"` | ✅ external invocation |

**Read-only whitelist** (command names only; no PowerShell parsing):

`Get-ChildItem` `Get-Item` `Get-Content` `Test-Path` `Resolve-Path` `Split-Path` `Join-Path` `Get-Location` `Get-Date` `Get-Process` `Get-CimInstance` `Get-Service` `Get-Command` `Get-Module` `Get-Variable` `Get-ItemProperty` `Get-FileHash` `Get-Acl` `Get-PSDrive` `Get-Member` `Select-Object` `Where-Object` `ForEach-Object` `Sort-Object` `Group-Object` `Measure-Object` `Select-String` `Compare-Object` `Get-Unique` `Format-Table` `Format-List` `Format-Wide` `Out-String` `Out-Host` `Out-Null` `Write-Output` `Write-Host` `Write-Verbose` `Write-Warning` `Set-Location` `Push-Location` `Pop-Location` `Start-Sleep`

**Always counted**: redirection `>` `>>` `<`, `Out-File` `Set-Content` `Add-Content` `New-Item` `Remove-Item` `Copy-Item` `Move-Item` `Rename-Item`, `Invoke-Expression`/`iex`, `Start-Process`, `&` invocation, `git` `node` `python` `npm` `pnpm` `cmd`.

**On the trade-off**: this is not a parser, it is a **name comparison**. Hence a chained call such as `Get-ChildItem $p.GetFiles()` is treated as persistent. **The cost of a wrong judgement is one extra count, never a missed block** — that direction is deliberate.

---

## 5. How it hooks into DSH

### Hook correspondence

| Hook | Fires | Available to me | I can return |
|---|---|---|---|
| `tools/pre-execute` | **Before** tool execution (waterfall) | `exec.name` `exec.arguments` `exec.agent` `next` | `allow`/`deny`/`ask`/`cancel`, or just `return next()` to pass through |
| `tools/post-execute` | **After** tool execution | Same as above + `result` | A downstream result object, optionally with appended `additionalContexts` |
| `agent/pre-step` | Before every model call | `agent` `messages` `signal` | `next()` |

**Critical implementation details:**

1. **`messages` is this step's increment, not the whole history.** DSH uses `claim()` to take the delta, so "reset whenever a user message appears" does not reset on every step.
2. **Injected notices must use `source.kind: 'user-approval'`.** A custom kind may be rejected downstream; using `'user'` would make the plugin's own `pre-step` treat it as a new task and reset itself every step.
3. **`return next()` yields the downstream decision — pass it through.** Not calling `next()` in a waterfall short-circuits the entire pipeline.

### Package structure (all three fields are required)

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

- Omitting `./cordis.patch.yml` from `exports` → the patch cannot be resolved and the bundle loader skips it entirely
- Omitting the `./` prefix in `dsh.bundle.patch` → same result

### Do not export `Config`

cordis resolves configuration as:

```js
if (!runtime.Config) return config;                              // absent → use as-is
const result = runtime.Config['~standard'].validate(config);     // present → must be standard-schema
```

Exporting a plain object crashes on `.validate`, and **the error only goes to stderr — the plugin fails silently**.

**This plugin deliberately does not export `Config`**; all validation happens inside `apply()` (still fail-loud).

---

## 6. Installation

```powershell
# replace <plugin-dir> with the path you cloned
dsh plugin --profile <desktop|web> add file:<plugin-dir>
```

**`file:` copies, it does not link. After changing code you must `remove` + `add` for it to take effect.**

### Moving to another machine

**The plugin itself needs zero configuration.** There are no absolute paths in the code, probe logs go to the system temp directory, and the trigger word and thresholds all use defaults.

Only two things must be done on the **new machine**, both on the DSH side, not in the plugin:

| What | Where | Set to |
|---|---|---|
| `--profile` name | The install command | The one the new machine's GUI actually reads (check the process command line, below) |
| `approval` | The new machine's profile `cordis.patch.yml` | `ask` (otherwise `ask` is rejected as `deny` when the limit is hit) |

To change thresholds or wording, edit the profile's `cordis.patch.yml` — never the plugin source.

### ⚠️ The easiest trap: installing into the wrong profile

| How it starts | Profile it reads |
|---|---|
| Desktop icon / GUI | **`profiles\desktop`** |
| `dsh.cmd web` | `profiles\web` |

**Check which one the process actually reads before installing:**

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select CommandLine
```

Look at the profile path following `dsh-desktop-host` in the command line.

**The symptom of installing into the wrong profile is deceptive**: `--dump-config` shows your entry, neatly configured, while the plugin **never loads**.

### Also open the approval channel

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      danger-full-access:
        sandbox: danger-full-access
        approval: ask        # must be ask; never rejects ask directly as deny
```

---

## 7. Verifying the installation

**`--dump-config` showing the entry is NOT proof the plugin loaded.** The only verification is a module probe.

The plugin ships with a switch:

```js
// lib/index.js
const DEBUG_PROBE = false;   // set to true
```

Set it to `true`, reinstall, restart — and `confirm-gate-boot.log` in the **system temp directory** records (Windows `%TEMP%`, Linux/macOS `$TMPDIR` or `/tmp`):

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

**Seeing `[enter] pre-execute` is the only proof it is genuinely working.**

---

## 8. Field results

### 8.1 Tier behaviour (real machine, `freeLimit=10` / `hardLimit=15` / `confirmWord=confirm`)

| Count | Injected text |
|---|---|
| 1 | `Warning: persistent operation without confirm. Ask the user for confirm. (turn operation 1/10: pwsh)` |
| 5 | `Warning: … (turn operation 5/10: pwsh)` |
| 10 | `Warning: … (turn operation 10/10: pwsh)` |
| **11** | `Instruction: stop all persistent operations without confirm immediately. … (trigger word: confirm; turn operation 11/15: pwsh)` |

**Key observation**: on receiving the instruction at the 11th operation, the model stopped on its own and asked for confirmation — **the design goal was achieved**.

### 8.2 Command-level judgement (`exec` shape, measured)

The real structure captured by a module probe (DSH `0.2.0-rc.2`):

```json
{
  "keys": ["token","callId","rootCallId","name","signal","agent","deferContext","concludeTurn","arguments"],
  "name": "pwsh",
  "argsKeys": ["command","description"],
  "arguments": { "command": "Write-Output \"hi\"", "description": "..." }
}
```

**Key points**: arguments live in `exec.arguments` (not `params`), and they are deep-copied via `snapshotJsonValue` and then `deepFreeze`d — the plugin can read them safely and cannot mutate them.

Command-judgement unit tests (16):

| Command | Judgement |
|---|---|
| `Get-ChildItem E:\work -Force` | read-only ✅ |
| `Get-ChildItem \| Select-Object Name` | read-only ✅ |
| `$x = Get-Date; Write-Output $x` | read-only ✅ |
| `Get-Item x; Remove-Item y` | persistent ✅ |
| `Get-ChildItem > out.txt` | persistent ✅ |
| `git status` | persistent ✅ |
| `& "C:\a.exe"` | persistent ✅ |

**16/16 passing.**

### 8.3 Containing the word releases the whole turn

Offline integration tests (18/18 passing) cover: 30 consecutive persistent operations after release without blocking or reminding; the trigger word anywhere in the sentence; uppercase `DADA`; and revocation plus resumption of counting on a message without the word.

---

## 9. WeChat channel: blocking mid-turn interactive prompts

**The WeChat channel is turn-based.** It runs a whole turn, gets the final reply, and only then sends one message to the user. A prompt raised mid-turn has nowhere to land.

| | Desktop Web GUI | WeChat channel |
|---|---|---|
| Mid-turn prompt | ✅ An answerer exists; the user clicks | ❌ The turn is still running; the user cannot receive it |
| Outcome | Works | **The turn hangs; both sides wait** |

So this plugin denies tools that raise mid-turn interaction (currently `ask-user-question`) **on WeChat sessions**, and tells the model to ask in **plain text** inside its normal reply instead, waiting for the user's next message.

### How it knows the session is WeChat

**No configuration, no guessing.** The WeChat channel plugin (`dsh-wechat-queue`) publishes its own ownership check as a cordis service:

```js
ctx.provide('wechatQueue', {
  owns(sessionId) { return ownsSessions.has(id); },
});
```

This plugin soft-probes that service with `ctx.get('wechatQueue')` and asks it about `exec.agent.session.id`.

**`owns` reads an in-memory set, populated after the session is created and before the turn runs.** So the answer at `tools/pre-execute` is always current — there is no "just restarted, not registered yet" window.

### The value is `deny`, not `block`

This one matters, and it was learned the hard way.

`tools/pre-execute` is a waterfall, and DSH honours exactly four return values:

| Value | Effect |
|---|---|
| `allow` | Proceed |
| `ask` | Route through the approval channel |
| **`deny` + `reason`** | **Do not run; `reason` reaches the model as `Error: <reason>`** |
| `cancel` | Do not run, but **cannot carry a reason** |

`block` is a legal value for `tools/post-execute`, **but not for `pre-execute`** — it is neither `ask` nor a value carrying a `reason`, so it is read as "no denial reason" and the call is dispatched **as if nothing happened**.

`deny` rather than `cancel`, because only `deny` can deliver the reason to the model. `cancel` is mute: the model sees an aborted call with no explanation, retries the same tool, and gets stopped again.

### Three conservative rules

When an accurate answer is unavailable, the session is treated as **not** WeChat:

1. No `wechatQueue` service → do not block
2. No `session.id` → do not block
3. `owns()` throws → do not block

**The bias is "rather miss than misfire".** The two failures are not symmetric:

- **Misfire** → the desktop session loses prompting, **breaking a capability that already worked**
- **Miss** → we are back to not having this feature at all

### What you will see

Asking the model for options in a WeChat session returns:

```
Error: 指令：当前会话是微信通道，不能发起中途交互选项。……请立刻改用纯文本提问
```

**That is not a crash — it is the guard working.** The model then rewrites the question as plain text.

### Limitations

- **Requires the channel plugin to provide the `wechatQueue` service.** Without it the guard degrades to not blocking, and this plugin will not error.
- **Only the service name `wechatQueue` is recognised.** Other channels (Slack, Discord, …) need their own same-named service, or a branch added here.
- **WeChat will never have clickable options.** That is an inherent cost of a turn-based channel, not something this plugin can work around.

---

## 10. The DSH core contracts this plugin relies on

Every contract below was confirmed by reading the DSH source and by running it on a real machine. **None of it is documented upstream**, and all of it is what an upgrade is most likely to change.

### 10.1 The `tools/pre-execute` return contract

**Authoritative implementation**: `prepareExecution()` in `@deepseek-ai/dsh-tools`.

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
// falls through → dispatch
```

| Value | Runs? | What the model sees |
|---|---|---|
| `{ kind: 'allow' }` | ✅ | Normal tool result |
| `{ kind: 'ask', reason }` | Depends on approval | Rejection reason if denied |
| **`{ kind: 'deny', reason }`** | ❌ | **`Error: <reason>`, `isError: true`** |
| `{ kind: 'cancel' }` | ❌ | "Aborted before dispatch", **no reason** |
| Anything else (including `block`) | ✅ **runs anyway** | Normal tool result |

**That last row is the trap.** `block` is legal for `tools/post-execute` and illegal here. DSH does not complain about the unknown value — it simply reaches `dispatch`. You think you blocked; nothing happened.

### 10.2 Waterfall and `next()`

`tools/pre-execute` is a **waterfall**: each listener receives the current decision, may rewrite it, or `return next()` to pass it through.

- **Not calling `next()` short-circuits the whole pipeline** — no later listener runs.
- This plugin calls `return next()` for anything it does not care about, and returns a `deny` object when it rejects (deliberately without calling `next()`, because it already holds the final decision).

### 10.3 Monotonic guards vs. `deny`

DSH has a second layer, `tools.guard()`, which is **monotonic**: it can only deny, never allow.

```js
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason;
```

**A `deny` skips the guard check** — a rejection reason is already present, so asking the guards would be redundant. **`allow` continues into them.**

### 10.4 `ctx.provide()` is the only way to register a service

To ask another plugin "is this session yours?", this plugin needs a cordis service. **There is exactly one correct way to register one:**

```js
ctx.provide('wechatQueue', { owns(sessionId) { … } });
```

Internally that is `ctx.reflect.provide(name, value, check)`, which:

- declares `reflect.props[name]` as `{ type: 'service' }` itself
- registers on the **current fiber**, and unregisters automatically when that fiber unloads

**Two plausible-looking alternatives both prevent the plugin from starting:**

| Form | Result |
|---|---|
| `export const provide = ['wechatQueue']` | ❌ **cordis never reads ESM exports** — the declaration does nothing |
| `ctx.set('wechatQueue', {...})` | ❌ `ctx.set` only **mutates** a declared property; with `reflect.props[name]` absent it throws `cannot set property "..." without provide` |

**The error means "this property was never declared as a service", not "you forgot the provide array".** Move to `ctx.provide`; do not keep editing the array.

### 10.5 Services are injected lazily — always soft-probe

cordis injects lazily: **touching a service property not named in `inject` throws an injection-gate error** rather than returning `undefined`.

So this plugin reads the service like this:

```js
const svc = typeof ctx?.get === 'function' ? ctx.get('wechatQueue') : undefined;
```

**Use `ctx.get(name)`; never write `ctx.wechatQueue` directly.** One throw on this path silently disables the guard — and leaves nothing in the log.

### 10.6 What `exec` carries

Fields this plugin actually uses from the `tools/pre-execute` `exec`:

| Field | Use |
|---|---|
| `exec.name` | Is this an interactive tool? |
| `exec.arguments` | Command content, for persistence classification |
| `exec.agent` | The calling agent |
| `exec.agent.session.id` | **Session id** — the argument to `wechatQueue.owns()` |

**`exec.agent` may be `undefined`** (some calls have no agent context); this plugin allows those unconditionally.

### 10.7 `agent/pre-step` messages are a delta

`messages` holds **messages added in this step**, not the full history; DSH takes the delta via `claim()`.

**That is what makes "reset the counter on a new user message" work.** With the full history, every step would see the same old message and the counter would reset forever.

### 10.8 `source.kind` on injected messages

When this plugin injects a reminder:

```js
source: { kind: 'user-approval', form: 'notice', … }
```

- **Use a kind already declared in `MessageSourceMap`**; a custom kind may be rejected downstream
- **Do not use `'user'`** — this plugin's own `pre-step` would read it as a fresh user message and clear the count every step

### 10.9 Sandbox mode needs two sources

| Priority | Source | Note |
|---|---|---|
| 1 | `ctx.sessionProjections.stateOf(session, 'permissions').sandbox` | The session's **current** value; follows hot-switches |
| 2 | `ctx.shell.sandboxMode` | The executor's **default**; does **not** follow hot-switches |

**Reading only the second one is wrong**: switch into a sandbox and back, and you keep reading the value from process start.

---

## 11. Known limits

**Not yet verified:**

- Actual behaviour in the `12 ~ 15` range
- Whether `ask` actually surfaces an approval prompt at `>= 15` (requires `approval: ask` and a responder online)

**Design limitations:**

1. **One tool call counts as 1**, regardless of how many commands it runs.
2. **Where the `ask` prompt appears depends on the responder.** Currently the Web GUI — **not reachable from a phone** unless the phone can access the DSH address.
3. **`subagent` counts against the main agent**; operations inside a subagent are not counted separately.
4. **Not a security boundary.** A model that deliberately works around it (say, batch-renaming files with a native command inside `pwsh`) only registers 1 count. **It guards against unconscious token burn, not malicious escape.**
5. **Command judgement is a name comparison, not a parser.** Anything uncertain is judged persistent — **over-counts only, never misses a block**.
6. **Releasing on the trigger word is coarse-grained.** If the user says "I think there's a problem with this confirm logic" while discussing, that also releases the turn. This is a deliberately simple rule: ambiguity is resolved by the user's wording rather than by the plugin guessing intent.

---

## 12. Appendix: why full permissions are needed

On Windows, DSH's sandbox makes every `pwsh` call return `0xC0000142` (`STATUS_DLL_INIT_FAILED`). Three layers are responsible:

1. **Policy layer** `dsh-sandbox-policy` — the session mode decides whether the rest is enabled
2. **Token layer** `dsh-sandbox-windows-acl` — duplicates the token, strips privileges, drops to Low integrity, adds capability SIDs and keep-alive groups; **missing keep-alive groups means death during DLL initialization**
3. **Launch layer** `dsh-pwsh-sandbox` — under a restricted token it **must inherit the host console**; creating its own console is fatal

`danger-full-access` bypasses all three layers ("never consults the provider" per the official docs).

**So this plugin's position is: when you have no choice but to grant full permissions, at least give it an accounting.**

---

## Contributing

PRs and issues are welcome. Suggestions are especially useful on the two open items listed under [Known limits](#9-known-limits) — behaviour in the `12 ~ 15` range, and whether `ask` surfaces correctly once a responder is online.

This is also a candidate for a formal upstream PR to DeepSeek Harness as a low-cost capability proof. If the maintainers would rather host it in-tree, that discussion is welcome.

---

## License

MIT
