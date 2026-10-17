# dist — 成品目录

> 打包好的可分发版本。源码在这儿，成品也在这儿，不用去别处找。

## 现有成品

| 文件 | 版本 | 大小 | 打包时间 |
|---|---|---|---|
| `dsh-confirm-gate-v0.1.0.zip` | 0.1.0 | 34.3 KB | 2026-10-17 |

### 包内容

```
lib/index.js          25.8 KB   插件主体（唯一运行必需文件）
test/integration.mjs  11.2 KB   离线集成测试，27 项
package.json           1.2 KB   含 dsh.bundle.patch 声明
cordis.patch.yml         443 B   默认挂载配置
README.md             22.3 KB   英文
README.zh-CN.md       20.2 KB   中文
LICENSE                1.1 KB   MIT
```

**不含**：`.git`、`dist`、`docs`、`src`、`node_modules`。

## 怎么用

```powershell
# 解压后进目录，直接装
dsh plugin --profile desktop add file:<解压目录>
```

装完**必须重启 DSH**——`file:` 是复制，不是链接。

## 怎么重新打包

打包脚本在 `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\`，
按 `INCLUDE_DIRS` / `INCLUDE_FILES` 白名单收集文件，不靠 git 导出。

改完代码后重跑一次，版本号从 `package.json` 读。

## 版本命名

`dsh-confirm-gate-v<package.json.version>.zip`

发新版就改 `package.json` 的 `version`，重新打包，旧包保留不删——
出了问题可以退回去。
