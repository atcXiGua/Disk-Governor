# Windows 磁盘清理策略（C 盘为主，可扩展到任意盘符）

> 版本 v1.0 ｜ 2026-11-26 ｜ 适用对象：Windows 10/11 单机，NTFS，100GB 系统盘
> 本文件是**判定规则**，不是操作记录。规则先于工具：工具按本文件的规则跑，规则错了先改规则。

---

## 0. 一条总纲

**唯一可靠的清理依据是「可再生性」，不是目录名、不是文件年龄、不是体积。**

判断一份内容能不能清，只问三个问题：

| 问题 | 能确认 | 不能确认 |
|---|---|---|
| ① 这份内容删掉后，软件/系统/网络能不能自己再生成一份一样的？ | 倾向可清 | 归入"仅迁移"或"禁动" |
| ② 重新生成要付出什么代价？（流量 / 时间 / 登录态 / 历史记录） | 代价低 → 可清；代价高 → 谨慎 | 无代价可衡量 → 人工判断 |
| ③ 它是不是某份数据的**唯一副本**？ | 不是 → 可清 | 是 → 绝不删，只可迁移 |

只要 ③ 的答案是"是唯一副本"，无论目录叫什么、多久没动、多大，都**不进入清理清单**。这一条就能挡掉 90% 的误删。

---

## 1. 四层分级（替代原来笼统的"安全/谨慎/受保护"）

| 层 | 名称 | 定义 | 允许动作 | 是否需要人工确认 |
|---|---|---|---|---|
| **L0** | 禁动 | 删了会导致系统/程序损坏，或属唯一数据副本 | 仅报告 | — |
| **L1** | 可再生·零代价 | 程序/网络可完整重建，重建无感知 | 可直接清理 | 否（清单仍需展示） |
| **L2** | 可再生·有代价 | 能重建，但要重新下载、重建索引、重新登录、丢历史 | 条件清理 | 是，逐项确认 |
| **L3** | 不可再生 | 用户数据、安装包原件、工程源码、聊天记录、密钥 | **只迁移，不删除** | 是 |

**旧版的分级错在两处**：
- 把"长期未用"（≥180 天）直接算成可清理 —— 年龄不等于可再生；
- 把"浏览器缓存 1.6GB"当一个整体 —— 里面混着登录态和站点数据，必须拆到子目录。

**新规则**：`长期未用`、`大文件`、`相似文件名` 三个维度**只产出线索，不产出清理项**。它们只能提升别的规则的置信度，不能单独构成清理理由。

---

## 2. 判定所需字段（工具必须采集，缺一项就不许出结论）

| 字段 | 用途 | 取不到时的处理 |
|---|---|---|
| 绝对路径 | 归属判定 | 丢弃该条 |
| 大小 + 文件数 | 收益估算 | 记为 0，不参与排序 |
| mtime（修改时间） | 活跃度 | 用 ctime 代替并标注 |
| atime（访问时间） | 活跃度（更贴近"是否还在用"） | 关闭了 atime 更新的盘，atime 不可信 → 只用 mtime |
| 是否重解析点/符号链接 | 防重复统计、防跳进别的卷 | 一律跳过，不跟随 |
| 是否被进程占用 | 决定能否移动 | 默认视为占用（保守） |
| 所属应用是否在运行 | 缓存清理前置条件 | 默认视为在运行 |
| 是否命中白名单/保护规则 | 一票否决 | 默认命中 |

---

## 3. 逐目录精确策略（本机实测数据）

> 收益为实测或按体积估算，标注「估」的表示未逐一核验。

### L1 — 可再生·零代价（可直接清）

| 目标路径 | 内容 | 判定条件（缺一不可） | 动作 | 收益 | 代价 |
|---|---|---|---|---|---|
| `%LOCALAPPDATA%\*-updater\*.exe|*.msi|*.nupkg` | 已装完的更新安装包 | 扩展名匹配 且 文件名含版本号 且 该版本 ≤ 当前已装版本 | 移出 | 2.34 GB（已做） | 无 |
| `%LOCALAPPDATA%\Temp\**` | 临时文件 | **mtime 与 atime 均 > 72 小时** 且 未被占用 | 移出 | 0.79 GB | 无 |
| `C:\Windows\Temp\**` | 系统临时文件 | 同上，需管理员 | 移出 | 估 0.1–0.3 GB | 无 |
| `C:\Windows\LiveKernelReports\*.dmp` | 内核实时转储 | 无对应蓝屏时间点的排查需求 | 移出 | 0.83 GB（已做） | 丢失历史崩溃现场 |
| `C:\Windows\Minidump\*.dmp` | 蓝屏小型转储 | 同上 | 移出 | 估 <0.1 GB | 同上 |
| `C:\Windows\MEMORY.DMP` | 完整内存转储 | 仅在**近期无蓝屏**且不需送修分析时 | 移出 | 估 0.5–2 GB | 无法再分析该次蓝屏 |
| `%LOCALAPPDATA%\CrashDumps\**` | 应用崩溃转储 | 崩溃已过去 > 7 天 | 移出 | 估 0.1–0.5 GB | 丢失崩溃现场 |
| `%LOCALAPPDATA%\pip\Cache` | pip 下载缓存 | 无 pip 进程运行 | 移出 | 0.20 GB（已做） | 下次装包重下 |
| `%LOCALAPPDATA%\npm-cache` | npm 缓存 | 无 node/npm 进程 | 移出 | 估 0.3–1 GB | 同上 |
| `%LOCALAPPDATA%\Yarn\Cache`、`pnpm\store` | 同上 | 同上 | 移出 | 估 0.2–1 GB | 同上 |
| `%LOCALAPPDATA%\Microsoft\Windows\INetCache` | IE/系统组件缓存 | 无 | 移出 | 估 0.1–0.3 GB | 无 |
| `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db` | 缩略图缓存 | 资源管理器重启后自动重建 | 移出 | 估 0.2–0.8 GB | 首次浏览缩略图变慢 |
| `C:\Windows\SoftwareDistribution\Download\**` | 已装完的更新包 | 无正在进行的 Windows 更新 | 移出 | 估 0.3–1.5 GB | 无（已装更新不回滚） |

**Temp 的时间窗为什么从"早于今天"改成 72 小时**：上一版清了 314 个"早于今天零点"的文件，其中包含当天早上产生的、可能仍被某进程引用的文件。72 小时窗 + 占用检测，误伤率接近 0，少清的体量可忽略。

### L1 但必须精确到子目录 — 浏览器缓存

**只允许清这些子目录**（allowlist，其余一律不动）：

```
<User Data>\<Profile>\Cache\**
<User Data>\<Profile>\Code Cache\**
<User Data>\<Profile>\GPUCache\**
<User Data>\<Profile>\Service Worker\CacheStorage\**
<User Data>\ShaderCache\**
<User Data>\GrShaderCache\**
```

**绝不能碰**（这是上一版最大的隐患）：

| 目录 | 里面是什么 | 删了会怎样 |
|---|---|---|
| `Login Data` / `Login Data For Account` | 保存的密码 | 密码全丢 |
| `Web Data` | 自动填充、支付卡 | 表单要重填 |
| `Bookmarks` | 书签 | 书签丢失 |
| `History` | 历史记录 | 历史清空 |
| `Preferences` / `Local State` | 全部设置、扩展配置 | 设置重置 |
| `Local Storage\` / `IndexedDB\` | **站点登录态**（大量网站靠这个保持登录） | 全站掉登录 |
| `Network\Cookies` | Cookie | 掉登录 |
| `Extensions\` | 已装扩展 | 扩展被删 |

实测 Chrome `User Data\Default` 有 2.78GB，但**真正属于纯缓存的部分通常只占 40–60%**，剩余是站点数据与扩展。收益按 1.2–1.6GB 估，不要按 2.78GB 估。

优先做法：浏览器内「清除浏览数据」只勾"缓存的图片和文件"，其余全不勾。

### L1 — 但需先退出客户端

| 目标 | 内容 | 前置条件 | 动作 | 收益 |
|---|---|---|---|---|
| `%APPDATA%\SodaMusic\LunaCacheV2\**` | 汽水音乐音频缓存 | 客户端进程已退出 | 移出 | **5.13 GB** |
| `%APPDATA%\Tencent\xwechat\...\cache`、`...\log` | 微信缓存与日志 | 微信已退出 | 移出 | 估 0.3–0.8 GB |
| 各 Electron 应用的 `Cache`、`GPUCache`、`Code Cache` | 渲染缓存 | 对应应用已退出 | 移出 | 估 0.5–2 GB |

> 汽水音乐这 5.13GB 是本次最大单笔收益，优先在客户端「设置 → 存储/清理缓存」点一次，比手删安全。

### L2 — 可再生·有代价（需逐项确认）

| 目标 | 代价 | 精确规则 | 收益 |
|---|---|---|---|
| `%LOCALAPPDATA%\JetBrains\IntelliJIdea2023.2\{caches,index,log,tmp}` | 下次打开重建索引，大型项目 5–20 分钟 | **只删这四个子目录，`config`/`plugins`/`options` 必须保留**；先确认无 `idea64.exe` | 2.81 GB |
| `%LOCALAPPDATA%\JetBrains\*\`（其它版本） | 同上 | 若该版本已不再使用，整目录移出 | 估 0.5–2 GB |
| `~/.gradle/caches`、`~/.m2/repository` | 下次构建重新下载，可能 10–60 分钟 | 确认无 java/gradle 进程 | 估 1–3 GB |
| `%LOCALAPPDATA%\Docker`、WSL `ext4.vhdx` | 镜像/发行版数据 | **不用手删**，用 `wsl --manage <distro> --set-sparse true` 或 `diskpart` 压缩虚拟磁盘；或 `docker system prune` | 估 2–20 GB |
| `%LOCALAPPDATA%\Packages\*\LocalCache` | UWP 应用缓存 | 逐应用确认 | 估 0.3–1 GB |
| `C:\Windows\WinSxS`（10.57GB） | 无法回滚已装更新（仅 `/ResetBase` 时） | **禁止手删**。`Dism /Online /Cleanup-Image /StartComponentCleanup`；`/ResetBase` 单独决策 | 估 2–4 GB 实收 |
| `C:\Windows\System32\DriverStore\FileRepository`（4.5GB） | 旧驱动不可回退 | 仅当同一设备存在 3 个以上版本时，`pnputil /delete-driver oemXX.inf /uninstall` 删最旧 | 估 0.5–2 GB |
| 重复文件（实测 128 组 / 1.49GB） | 需人工判定留哪份 | **绝不自动删**。建议规则：保留 mtime 更早的、路径更浅的、不在 Temp/Downloads 的；其余列入待确认 | 估 1–1.5 GB |
| 相似文件名分组 | — | **仅提示**，不构成清理理由（`report_v2.docx` 与 `report_v3.docx` 往往都要留） | 0 |

**WinSxS 的一个关键事实**：10.57GB 是硬链接去重前的统计，实际独占约 4–6GB。任何按 10.57GB 估收益的报表都是错的。

### L3 — 只迁移，不删除

| 目标 | 为什么不能删 | 正确动作 | 收益 |
|---|---|---|---|
| `Downloads`（1.6GB） | 其中多为唯一副本 | 只处理"安装包类"：`*.exe/*.msi/*.zip` 且同名程序已安装 且 mtime > 90 天 → 移到 `D:\归档\安装包\`；文档/图片/压缩包一律不动 | 估 0.5–1 GB |
| `Desktop`（1.4GB） | 用户工作文件 | 右键 → 属性 → 位置 → 移动到 `D:\Desktop`（不要剪切） | 1.4 GB |
| `Documents`、`Pictures`、`Videos` | 同上 | 同上方式改位置 | 视体量 |
| `%APPDATA%\Tencent\xwechat\...\msg\file`、`FileStorage` | 聊天文件，唯一副本 | 只用微信「设置 → 文件管理 → 更改路径」到 D 盘，历史文件迁移；缓存用客户端清 | 估 1 GB |
| 大文件 ≥1GB（实测 5.14GB 分布） | 用途未知 | 只出清单，人工判定 | — |
| 长期未用文件（实测 5.99GB） | 年龄≠可再生 | 只作为线索：属 L1/L2 目录 → 提升置信度；属 L3 → 提示"考虑归档" | — |

### L0 — 禁动清单（工具必须硬阻断）

```
C:\Windows\System32\**            C:\Windows\SysWOW64\**
C:\Windows\WinSxS\**              ← 只允许 DISM，不允许文件级删除
C:\Windows\Installer\**           ← 手删会导致程序无法卸载/修复
C:\Windows\System32\DriverStore\** ← 只允许 pnputil
C:\Windows\Boot\**  C:\Windows\Fonts\**
C:\Program Files\**  C:\Program Files (x86)\**   ← 程序本体，只能走卸载
C:\Program Files\WindowsApps\**   ← TrustedInstaller 保护，只能走"设置→应用"
C:\ProgramData\Microsoft\**       ← 系统级配置
C:\Users\*\Documents\**  Desktop\**  Pictures\**  Videos\**
C:\Users\*\.ssh\**  .gnupg\**  .aws\**  .config\**  ← 密钥
C:\Users\*\.workbuddy\**  WorkBuddy\**  ← 工具与项目数据
C:\$Recycle.Bin\**（用回收站清空，不手删）
任何 *.vhd/*.vhdx（用对应工具压缩）
```

补充硬规则：
- 路径含 `\Windows\` 且不在上面 L1/L2 白名单内 → 一律 L0
- 文件被任何进程持有句柄 → 本轮跳过，不重试
- 位于重解析点/挂载点之后 → 不跟随
- 单次清理总量超过阈值（建议 20GB）→ 强制二次确认

---

## 4. 预算与目标

| 阶段 | 动作 | 预计回收 | 累计可用（起点 10.89GB） |
|---|---|---|---|
| 一 | L1 全部（更新器、Temp、转储、包缓存、缩略图） | 3–4 GB | 14–15 GB |
| 二 | 汽水音乐 5.13 + 微信/Electron 缓存 0.8 | 5.9 GB | **20–21 GB** |
| 三 | 浏览器缓存 1.2 + IntelliJ 2.8 + 其它 JetBrains | 4–5 GB | 25–26 GB |
| 四 | DISM 组件清理 + 旧驱动 | 2.5–6 GB | 28–32 GB |
| 五 | 桌面/下载/微信路径迁移到 D | 3.5 GB | **31–35 GB** |

**目标线**：C 盘常态可用 ≥ 20GB（20%）。低于 15GB 就会出现更新失败、临时文件写不进、SSD 写入放大。
**不必追求更多**：系统盘留 30% 空闲对寿命和性能最有利，超过这个数继续清理的边际收益很低。

---

## 5. 执行顺序（严格按此序，风险递增）

1. 先做快照：记录 C 盘可用、各目录体积 → 存 `D:\C盘清理备份\yyyyMMdd\`
2. L1 批量（更新器 + Temp + 转储 + 包缓存）—— 零风险
3. 退出汽水音乐，清 `LunaCacheV2` —— 单笔最大，风险极低
4. 浏览器内清缓存（只勾缓存）
5. 退出 IntelliJ，清 caches/index/log —— 有重建代价
6. 收工一次，观察 24 小时：常用软件是否正常、是否有掉登录
7. 管理员执行 `Dism /Online /Cleanup-Image /StartComponentCleanup`
8. 迁移桌面/下载/微信路径到 D 盘（治本）
9. 重复文件：出清单，人工确认后处理
10. 观察满 7 天，才考虑删除 D 盘备份

**第 6 步不可跳过。** 一次清太多且不观察，出问题时无法定位是哪一步造成的。

---

## 6. 回滚设计

- 所有清理动作 = **移动到** `D:\C盘清理备份\yyyyMMdd-HHmmss\<类别>\`，保留原始相对路径
- 同时写 `_移动清单.csv`：`src, dst, bytes, movedAt`
- 恢复命令（一条）：
  ```powershell
  Import-Csv 'D:\C盘清理备份\<时间戳>\_移动清单.csv' |
    ForEach-Object { if (Test-Path $_.dst) { Move-Item $_.dst $_.src -Force } }
  ```
- 删除类动作（DISM、卸载）不可回滚 → 必须先做系统还原点或确认有还原能力

---

## 7. 防复发（比清理更重要）

这次"再次告急"的根因不是清得不干净，是**几个目录只增不减**：

| 增长源 | 增长率 | 治理方式 |
|---|---|---|
| 汽水音乐缓存 | 无上限 | 客户端设置里限制缓存上限（若有）或每月手动清；存储路径改到 D |
| 浏览器缓存 | 随浏览线性增长 | 开启自动清理或每季度清一次 |
| Electron 应用 `*-updater` | 每次更新留一个完整包 | 每次更新后清；或定期任务 |
| IntelliJ 索引 | 随项目数增长 | 定期清 caches |
| 微信文件 | 随聊天增长 | 路径改 D，定期归档 |
| Windows 更新缓存 | 每月 | 存储感知或 DISM 每季度 |
| 桌面/下载 | 随使用增长 | 路径改 D，或每月归零 |

**两个一劳永逸的设置**：
1. 开启「存储感知」，配置为：临时文件 30 天、回收站 30 天、下载 60 天（下载那条需确认不误清）
2. 桌面、下载、文档、微信文件、汽水音乐存储路径全部指向 D 盘

---

## 8. 这套策略对工具的要求（下一版改什么）

工具不该改界面，该改**规则模型**。具体要求：

1. **类目从"目录名"改为"可再生性"**
   每个类目必须显式声明 `tier: L0|L1|L2|L3` 和 `regenerable: true|false`，没有 `regenerable` 字段的类目不允许进入清理清单。

2. **`长期未用` / `大文件` / `相似文件名` 降级为"线索"**
   新增 `kind: "hint"`，只出现在报告的"待判断"区，**不进 plan 的候选集**。这是精细化最核心的一条改动。

3. **缓存类目改为子目录 allowlist**
   `paths` 字段从"目录前缀"改成"精确子目录列表 + 排除列表"，浏览器那条必须列出 `Cache / Code Cache / GPUCache / ServiceWorker/CacheStorage` 并显式排除 `Local Storage / IndexedDB / Login Data / Web Data / Cookies`。

4. **每条规则带 `requires`**
   ```json
   { "id": "sodamusic-cache", "tier": "L1", "regenerable": true,
     "paths": ["%APPDATA%\\SodaMusic\\LunaCacheV2"],
     "requires": { "processNotRunning": ["SodaMusic.exe"], "minAgeHours": 0 },
     "action": "move", "estGB": 5.13 }
   ```
   规则里能声明前置条件，工具就有能力判断"客户端还在跑 → 本轮跳过"，而不是硬清然后报错。

5. **收益估算必须去重**
   WinSxS 用 `dism` 的实收值，不用目录体积；重复文件不计入"可释放"，单列为"待确认"。

6. **报告要有"每项的判断依据"字符串**
   形如：`命中规则 sodamusic-cache；路径可再生；进程未运行；atime 3 天前 → L1 可清`。没有依据的条目一律不展示为可清理。

7. **plan 与 clean 分离且默认 dryRun**
   已是现状，保持。`move` 必须显式 `confirm:true`，且服务端二次校验白名单。

---

## 9. 结论一句话

**不要按"哪里大就清哪里"来做，要按"删了它自己能不能长回来"来做。**
凡能长回来的，清得再狠也不出事；凡长不回来的，哪怕只有 1MB 也不许动，只能迁移。

按本策略执行，C 盘可从当前 10.89GB 稳定到 30GB 左右，且不需要碰任何系统组件。
