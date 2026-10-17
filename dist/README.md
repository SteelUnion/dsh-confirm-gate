# dist — 成品与项目历程

> 打包好的可分发版本 + 这个项目是怎么来的。源码在这儿，成品也在这儿。

---

## 项目

**dsh-confirm-gate** — DeepSeek Harness 的持久化操作计数门控。

**定位一句话**：不是安全边界，是成本边界。沙箱解决「不许做」，它解决「做太多」。

**起因**：DSH 在 Windows 上开沙箱会让 `pwsh` 全部崩成 `0xC0000142`，
用户被迫开完全权限——这时 agent 可以无限试错、乱改文件，没人记账。

| | |
|---|---|
| 仓库 | https://github.com/SteelUnion/dsh-confirm-gate |
| 许可 | MIT |
| 当前版本 | v0.1.1 |
| 开发周期 | 1 天（2026-10-17） |
| 规模 | 716 行代码 / 27 项测试 |
| 花费 | 约 0.27 USD（估算，见 `COSTS.md`） |

---

## 项目历程

| 阶段 | 做了什么 | 结论 |
|---|---|---|
| 1. 排障 | `pwsh` 全部 `0xC0000142` | DSH Windows 沙箱三层限制；`danger-full-access` 旁路全部 |
| 2. 调研 | 读 `app.asar` 源码 | 搞清 `tools/pre-execute` 流水线、`exec` 结构、插件包格式 |
| 3. 实现 | 三档计数 + confirm 门 | 1~10 提醒 → 11+ 停止指令 → 15 索要确认 |
| 4. 返工① | 用户：「给了 confirm 还被计数」 | 改成**含识别语放行整轮** |
| 5. 返工② | `Get-ChildItem` 也算持久化 | 改成**命令级判定**，只读白名单不计数 |
| 6. 返工③ | 沙盒下会重复拦截 | 改成**沙盒接管时不生效** |
| 7. **修静默失效** | 插件在跑却从不计数 | cordis 懒注入抛错被吞 → 改 `ctx.get()` + **fail open** |
| 8. 修热切换 | 切模式行为不变 | 判定从加载时移到**每次调用**；读会话当前值而非默认值 |
| 9. 验证 | 三模式真机热切换 | full → workspace-write → read-only → full，全程不重启 |
| 10. 发布 | 双语 README + 成品包 | GitHub Release 附件可直接下载 |

**最贵的一步是第 7 步**：日志看起来完全正常，靠三层探针才定位。
细节见 `../docs/retrospective-zh.md`。

---

## 现有成品

| 文件 | 版本 | 大小 | 日期 |
|---|---|---|---|
| `dsh-confirm-gate-v0.1.1.zip` | 0.1.1 | 35.2 KB | 2026-10-17 |
| `dsh-confirm-gate-v0.1.0.zip` | 0.1.0 | 34.3 KB | 2026-10-17 |

v0.1.0 只留在这里做对照；它在 GitHub Release 上有永久副本，随时可下载。

### 包内容

```
lib/index.js          25.2 KB   插件主体（唯一运行必需文件）
test/integration.mjs  11.0 KB   离线集成测试，27 项
package.json           1.3 KB   含 dsh.bundle.patch 与 peerDependencies
cordis.patch.yml         443 B   默认挂载配置
README.md             22.0 KB   英文
README.zh-CN.md       20.0 KB   中文
LICENSE                1.0 KB   MIT
```

**不含**：`.git`、`dist`、`docs`、`node_modules`、打包脚本。

## 怎么用

```powershell
# 解压后进目录，直接装
dsh plugin --profile desktop add file:<解压目录>
```

装完**必须重启 DSH**——`file:` 是复制，不是链接。

## 怎么重新打包

```powershell
node pack.mjs
```

脚本在仓库根目录，白名单收文件（`INCLUDE` 数组，不用通配），版本号从 `package.json` 读，输出到 `dist/dsh-confirm-gate-v<version>.zip`。

两个设计点：**时间戳固定**，同样的输入打出同样的字节；**版本交叉校验**，文件名和包内 `package.json` 不一致就直接报错——防止再出现「文件名 v0.1.1、包里 0.1.0」。

## 版本命名

`dsh-confirm-gate-v<package.json.version>.zip`

发新版就改 `package.json` 的 `version`，重新打包，旧包保留不删——出问题能退回去。
