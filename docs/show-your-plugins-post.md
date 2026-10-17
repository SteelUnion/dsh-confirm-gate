# Show Your Plugins 发帖草稿（待发）

> 状态：草稿，未发布
> 目标分类：Show Your Plugins!

## 标题

```ndsh-confirm-gate: per-turn operation budget — remind, instruct the model to stop, then ask you
```n
## 正文

Unofficial project, independently developed and maintained by a community member. Not affiliated with or endorsed by DeepSeek.

Project: https://github.com/SteelUnion/dsh-confirm-gate
Version: v0.1.0. MIT.

## Why I built it

I run DSH with `danger-full-access`. Not by preference — on Windows the sandbox path returned `0xC0000142` for every `pwsh` call, and full access was the only way to get any work done.

The problem with that is obvious: once the sandbox is out of the picture, nothing counts what the agent does. A turn that starts as "check one thing" can quietly become thirty file writes, and by the time you look at the screen you're reading a diff you never asked for.

I didn't want a harder wall. I wanted an odometer.

## What it does

Counts **persistent operations per turn** and escalates in three tiers:

| Count | What the model gets |
|---|---|
| `1 .. freeLimit` | allowed, plus a short reminder |
| `freeLimit+1 .. hardLimit-1` | allowed, plus a **stop instruction**: halt all operations without confirm |
| `>= hardLimit` | blocked, returns `{ kind: 'ask' }` so DSH asks you for confirmation |

Non-persistent operations — reads, greps, globs, directory listings, status checks, web reads — are **never counted, never reminded, never blocked**. The agent can research as long as it likes; the budget only applies when it starts changing things.

Defaults are `freeLimit: 10`, `hardLimit: 15`, confirm word `confirm`. Every value is configurable per profile — including `freeLimit: 0` if you don't want to hand out a single free write.

## Why counting alone was enough

This was the part I wasn't sure about. I expected the model to keep going until `ask` actually fired.

It didn't. On the 11th persistent operation it received the stop instruction and stopped, reported what it had and what was missing, and asked for confirmation. The budget never had to escalate to a hard block.

That's the design bet: an agent that can see the remaining budget will usually spend it more carefully than one that can't. The `ask` tier is there for when that bet loses, not as the primary mechanism.

## What counts as persistent

Anything after which the world is different: file writes and edits, command execution, subagent/workflow dispatch, outbound messages. Plus a suffix fallback (`write|edit|delete|remove|move|publish|deploy|commit|push`) so tools added later are caught without a config change.

Unknown tools default to non-persistent. Use `include` if you'd rather invert that.

## Install

```
dsh plugin --profile <desktop|web> add file:<path to this repo>
```

Also needs `approval: ask` in the profile's `cordis.patch.yml` — with `approval: never` the `ask` tier gets denied instead of prompting you, and the agent can't ask anything.

## How this differs from the other gates

There are already permission plugins here judged by **path capability** (`dsh-allow`) and by **reversibility** (`dsh-tm-guard`). Both are pre-execute deniers: they decide yes or no per call.

This one never denies on content. It denies on **accumulation**. A call that any of the others would allow is still allowed here — until you've made enough of them in one turn that it's worth a human's attention.

The practical difference: no approval treadmill for the first ten operations, and the agent keeps a usable budget instead of hitting a wall on call one.

## Why not just ask every time

Because that turns a long task into an approval treadmill, and people start approving without reading. `dsh-tm-guard` solves it by auto-approving what's reversible; this solves it by not asking until the count says it's worth asking.

The bet is the same in both cases: an agent with a visible budget behaves better than one being interrogated.

## Status and limits

- 12 integration tests, all passing.
- Verified end-to-end in the real GUI up to the 11th operation (tier 3 never fired in that run, so the `ask` path is tested in unit tests but not observed live).
- **One tool call counts once**, regardless of how many commands it runs. `pwsh` running ten commands costs one unit. This is deliberate — it budgets deliberation, not keystrokes — but it does mean a determined agent can do a lot inside one call.
- Counting is per agent; `subagent` counts against the parent, operations inside a subagent are not counted separately.
- **Not a security boundary.** If a model actively tries to route around it, the counter still only sees one call. It's for cost and drift, not for containment. Use DSH's sandbox for containment.
- `ask` reaches whatever approval answerer is mounted. With the Web GUI that's the browser — the phone won't get it unless the phone can reach the DSH address.

## Two things that cost me hours, in case they save someone else

**1. If your agent retries the same harmless read-only command over and over under `danger-full-access`, check the call payload before blaming the command.**

I spent a while chasing this before finding #9592 and #5611. In full access the model can still serialize `sandbox_permissions` / `justification` onto a call. An empty justification fails with `invalid justification: expected a non-empty sentence`; a non-empty one fails with `not strictly wider than this call's current danger-full-access mode`. Either way the call never executes, and the error doesn't tell the model how to fix it — so it retries.

Nothing to do with this plugin. But it looks like a permission failure and it isn't one, and it burns a turn every time.

**2. `--dump-config` showing your plugin's entry does not mean it loaded.**

The honest check is a probe in the module body writing to a file. Two separate failure modes look identical from the config dump: the bundle was skipped silently, and the bundle loaded but `apply()` threw (that one only shows up on stderr).

Related: the GUI reads a different profile than the CLI does. `dsh web` uses `profiles/web`; the desktop host uses `profiles/desktop`. I installed into the wrong one for several rounds and could not work out why nothing happened.


---

Feedback and bug reports: the repo's Issues. If you try it and the tier-3 `ask` path behaves badly for you, I'd genuinely like to hear about it — that's the one branch I couldn't exercise live.
