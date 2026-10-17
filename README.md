# dsh-confirm-gate

**A bounded-run framework that keeps an AI agent accountable on hosts where you had to grant full permissions.**

English | [中文](README.zh-CN.md)

A runtime plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps a **per-turn counter of persistent operations**, injects a stop instruction once the free budget is spent, and asks the user for confirmation at a hard limit.

> **This is not a security boundary. It is a cost boundary and a course-correction mechanism.**
> It assumes the agent is running **without a sandbox holding the boundary**, and its purpose is to give the model **the ability to brake on its own** before it burns tokens or rewrites files. Real sandbox isolation is provided by DSH's own sandbox — complementary to this plugin, not a replacement.

### Scope: it does not activate under a sandbox

The plugin gates itself by the deployment's sandbox mode, read from `ctx.shell.sandboxMode`:

| Sandbox mode | Plugin active? | Why |
|---|---|---|
| `read-only` | ❌ No | The sandbox already holds every boundary |
| `workspace-write` | ❌ No | Same |
| `danger-full-access` | ✅ Yes | Nothing is holding the boundary |
| `custom` | ✅ Yes | A custom mix still leaves the boundary unheld |
| `undefined` (executor does not confine) | ✅ Yes | Same |
| Unreadable (`ctx` threw) | ❌ No | Conservative: assume something else is managing it |

Put plainly: **under a sandbox this plugin would be redundant — and worse, it would interrupt legitimate operations a second time.** So it only installs itself where nothing else is keeping score. If a preset switching the session into a sandbox does not take effect until restart, that is by design — the gate decision is made once, at load.

### Who this is for

| Situation | Fits? |
|---|---|
| You granted full permissions and fear unbounded trial-and-error burning tokens | ✅ That is exactly the case |
| You want the agent to ask after N write operations | ✅ |
| You want `read` / `grep` / web lookups **never interrupted** | ✅ Non-persistent operations are never counted |
| You want to use it as a sandbox against a malicious model | ❌ Use DSH's built-in sandbox |
| You use a different agent framework | ❌ This is a DSH plugin |

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
      name: "@sroada/dsh-confirm-gate"
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
| `Get-ChildItem E:\SRoada -Force` | read-only ✅ |
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

## 9. Known limits

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

## 10. Appendix: why full permissions are needed

On Windows, DSH's sandbox makes every `pwsh` call return `0xC0000142` (`STATUS_DLL_INIT_FAILED`). Three layers are responsible:

1. **Policy layer** `dsh-sandbox-policy` — the session mode decides whether the rest is enabled
2. **Token layer** `dsh-sandbox-windows-acl` — duplicates the token, strips privileges, drops to Low integrity, adds capability SIDs and keep-alive groups; **missing keep-alive groups means death during DLL initialization**
3. **Launch layer** `dsh-pwsh-sandbox` — under a restricted token it **must inherit the host console**; creating its own console is fatal

`danger-full-access` bypasses all three layers ("never consults the provider" per the official docs).

**So this plugin's position is: when you have no choice but to grant full permissions, at least give it an accounting.**

---

## License

MIT
