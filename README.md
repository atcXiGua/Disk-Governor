# Disk Governor · Windows 磁盘空间治理

> 本地运行的磁盘清理**决策**工具。不靠"目录名像缓存"猜，而靠"这份内容能不能由程序重新生成"来判断。

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)](https://www.microsoft.com/windows)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#)

---

## 它解决什么问题

C 盘反复告急，用户装几个"一键清理"工具，结果是：

- 把 `WinSxS` 当垃圾删了，系统更新从此失败
- 清了浏览器 `Local Storage`，全站掉登录、密码丢失
- 清完过两三个月又满，因为真正的增长源没被动过
- 报"可释放 18GB"，实际能动的只有 4GB

这类工具的通病是把**"很久没动"**和**"目录名像缓存"**当成可清理依据。但装了三年的游戏、唯一的合同扫描件，也都很久没动。

Disk Governor 换了个判断入口，只问三个问题：

| # | 问题 | 答"否"的后果 |
|---|---|---|
| 1 | 删掉后，程序能不能自己重新生成？ | 不能 → 不许清 |
| 2 | 重新生成要付什么代价？ | 代价高 → 降级为"仅迁移" |
| 3 | 它是不是唯一副本？ | 是 → 直接禁动，不管多大、多久没动 |

---

## 核心设计

### 四层分级

| 层 | 含义 | 处置 | 典型对象 |
|---|---|---|---|
| **L0** | 禁动 | 永不进入清单 | System32、WinSxS、Installer、DriverStore、文档、`.ssh`、浏览器账号数据 |
| **L1** | 零代价 | 可直接清 | 已安装完的更新器包、72 小时前的 Temp、内核转储、包管理器缓存、缩略图库 |
| **L2** | 有代价 | 清前需知情 | 音乐/视频缓存、浏览器缓存、IDE 索引、构建产物 |
| **L3** | 仅迁移 | 只统计，不清理 | 桌面、下载、微信聊天文件、大文件 |

**L2 与 L3 的界线不是体积，是"可不可再生"。** 一个 30GB 的游戏目录不会进清理清单，只会建议移到其他盘。

### 每条规则必须声明四件事

```jsonc
{
  "id": "temp_stale",
  "tier": "L1",              // 分层
  "regenerable": true,       // 删了能否自愈（false 永不可选）
  "requires": { "minAgeHours": 72, "noProcess": [] },  // 前置条件
  "match": { "pathAny": ["/appdata/local/temp/"] }
}
```

硬约束：`selectable === true` 必须同时满足 `regenerable === true` **且** `tier ∈ {L1, L2}`。这条约束有单元测试守着（`_selftest.js`），规则改错会立刻失败。

### 四道闸

```
规则引擎  →  白名单  →  清单生成  →  执行移动
  L0/L3      glob 匹配     二次校验      逐个试打开
  不可选     优先级最高     拒绝越权      重查进程
```

1. **引擎层**：L0/L3/hold 类目根本不可选，界面禁用只是表象
2. **白名单**：优先级高于所有规则，命中即不进入清单
3. **清单层**：生成时校验一次，执行前再校验一次
4. **执行层**：每文件 `r+` 试打开，被占用则跳过；移动前重查进程

### 移动而非删除

清理 = 把文件移到备份目录，保留完整目录结构和 `_移动清单.csv`（原路径逐条记录），并生成 `_还原.ps1`，双击即原样搬回。

只有确认**源路径真的消失**，才计入"已释放"。跨卷移动做过源端回查，避免"报成功但文件还在"。

---

## 快速开始

### 获取

```bash
git clone https://github.com/atcXiGua/Disk-Governor.git
cd Disk-Governor
```

也可以直接下 [源码 zip](https://github.com/atcXiGua/Disk-Governor/archive/refs/heads/master.zip)。**不要**在 `C:\Program Files` 或系统目录下运行，放到普通目录（如 `D:\Tools\`）即可。

### 方式一：便携版（推荐，无需安装 Node）

从 [Releases](https://github.com/atcXiGua/Disk-Governor/releases) 下载 `DiskGovernor-2.0.0-portable-win-x64.zip` 解压，双击：

```
启动.cmd
```

Node 运行时已打包在内（`node.exe`，约 83 MB），复制到任意 Windows 10/11 机器即可运行，不需要安装任何依赖。解压后请保持目录结构不变（`node.exe` 与 `src/` 必须同级）。

### 方式二：源码双击

```
启动.cmd
```

### 方式三：命令行

```bash
node src/server.js
```

浏览器会自动打开 `http://127.0.0.1:7790`。**关掉那个命令行窗口即退出**，不留后台进程、不装服务、不写注册表。

### 要求

- Windows 10 / 11
- 源码运行需 Node.js ≥ 18（零第三方依赖，不需要 `npm install`）
- 端口 7790，被占用会自动顺延至 7800

---

## 使用流程

```
① 扫描      选择盘符或目录，深度去重可选
② 看分层     L1/L2/L3/L0 各占多少，"现在能清"与"需先关程序"分开报
③ 选类目    点"只选 L1"可一键勾选零代价项
④ 生成清单  只生成可确认清单，不动文件
⑤ 试运行    逐文件验证可移动性，不移动
⑥ 执行移动  需显式 confirm
⑦ 记录      历次释放量、备份路径、还原入口
```

**建议不要跳过 ④ 和 ⑤。** 试运行会告诉你真实能腾多少、多少文件被占用，这比估算值可靠。

---

## 目录结构

```
.
├── src/
│   ├── server.js             # 零依赖 HTTP 服务 + 任务调度
│   └── core/
│       ├── rules.js          # 规则加载与校验（失败即拒绝启动）
│       ├── scan.js           # 遍历，跳过重解析点与系统目录
│       ├── classify.js       # 规则引擎、风险分级
│       ├── dedupe.js         # 分层哈希去重 + 相似文件名分组
│       ├── report.js         # 报告组装、阶段预算
│       ├── plan.js           # 白名单、清单、试运行、移动
│       └── procs.js          # 进程检测、NTFS 访问时间状态
│
├── rules/                    # 规则库：一个文件一组，文件名即匹配优先级
│   ├── 01-protected.json     #   L0 禁动（8 条）
│   ├── 02-content.json       #   用户内容与仅迁移（3 条）
│   ├── 03-updates.json       #   更新残留与崩溃转储（4 条）
│   ├── 04-app-caches.json    #   应用缓存（9 条）
│   ├── 05-temp.json          #   临时文件时间窗（2 条）
│   ├── 06-project.json       #   构建产物与日志（2 条）
│   └── 07-fallback.json      #   兜底规则（1 条）
│
├── web/
│   └── index.html            # 单文件界面，离线可用
│
├── test/
│   └── selftest.js           # 36 条路径用例 + 硬约束断言
│
├── docs/
│   ├── strategy.zh-CN.md     # 规则背后的判断依据（人类可读）
│   └── usage.zh-CN.md        # 使用说明
│
├── legacy/
│   └── c-drive-helper/       # v1 早期版本，保留备查
│
├── config.json               # 阈值、白名单、排除规则（不含规则本体）
├── 启动.cmd                   # 源码模式入口
└── package.json
```

---

## 加一条规则

规则是数据，不是代码。新增一条不需要改任何 `.js` 文件。

**1. 选文件**：文件名序号决定优先级，越小越先生效。新增独立规则建议用中间号（如 `04a-xxx.json`）。

**2. 写规则**，七个字段缺一不可：

```jsonc
{
  "id": "example_cache",              // 全局唯一，重复会被加载器拒绝
  "name": "某应用缓存",                 // 报告里显示的名字
  "tier": "L1",                       // L0 禁动 / L1 零代价 / L2 有代价 / L3 仅迁移
  "kind": "clean",                    // clean / deny / hold / migrate
  "regenerable": true,                // 删了程序能否自己长回来
  "match": { "pathAny": ["/example/cache/"] },
  "requires": { "minAgeHours": 72, "noProcess": ["example.exe"] },
  "basis": "播放时自动下载的分片缓存，重看会重新拉取",   // 判断依据，必填
  "advice": "可清理，建议先退出客户端"                  // 处理建议，必填
}
```

**3. 加用例**：在 `test/selftest.js` 的 `CASES` 里加一行 `[相对路径, 期望规则id, 说明]`。

**4. 跑测试**：

```bash
node test/selftest.js
```

### 什么样的规则会被拒绝

加载器与自测会主动挡掉这几类：

- `basis` 少于 8 个字符——没有判断依据的规则等于让你盲删
- `tier: "L0"` 或 `"L3"` 却声明 `kind: "clean"`——禁动层和迁移层不允许清理
- `selectable: true` 但 `regenerable` 不为 `true`，或 tier 不在 L1/L2
- `id` 与已有规则重名
- 规则文件加载失败时**整个工具拒绝启动**，不会带着残缺规则去扫盘

### 为什么文件名顺序不能随便改

匹配是「先命中生效」。`05-temp.json` 里超龄规则必须排在未超龄规则前面，否则 72 小时内的热文件会被当成可清对象；`07-fallback.json` 必须最后，否则兜底规则会抢走本该由精确规则处理的文件。改动文件命名前，先跑自测。

---

## 安全边界

**会碰的**：临时文件、已安装完的更新包、转储、包管理器缓存、客户端缓存、IDE 索引、日志。

**永远不会碰的**：

- `System32` / `WinSxS` / `Installer` / `DriverStore` / `servicing` / `assembly`
- `Program Files` 下已安装程序目录
- 文档、桌面、图片等个人目录（只建议迁移，不清理）
- `.ssh`、`.gnupg`、密钥文件
- 浏览器账号数据：`Local Storage`、`IndexedDB`、`Login Data`、`Cookies`、`Bookmarks`
- 微信 / QQ 的 `FileStorage`（聊天记录）

**不会做的**：注册表清理、权限强改、`ResetBase`、自研驱动、上传任何数据。全部本地运行，不联网。

---

## 已知限制

- **仅 Windows**：依赖 `fs.statfsSync`、`tasklist`、NTFS 访问时间语义
- **访问时间不可靠**：Windows 默认关闭 NTFS 最后访问时间更新，工具会检测并降级为"仅用修改时间"，报告中明确标注
- **去重有边界**：只覆盖 ≥ 1MB 的文件；同尺寸文件超过 60 个的桶会跳过，避免在个别大目录上耗时失控
- **扫描耗时**：C 盘约 40 万文件 / 100 秒（机械硬盘更久）
- **服务端确认不等于界面确认**：绕过界面直接调 API 也会被二次拦截，但 `confirm` 是显式参数，脚本调用时需自行保证

---

## 路线图

- [ ] 规则热重载（改 `config.json` 免重启）
- [ ] 迁移操作可点击（Shell 已知文件夹改到其他盘）
- [ ] 报告导出 HTML / CSV 存档
- [ ] 定时扫描 + 阈值提醒
- [ ] 单文件 exe 打包（node SEA / pkg，免解压目录）
- [x] 便携版分发（Node 运行时随包，免安装）
- [ ] 跨平台（macOS / Linux 的等价目录规则）

---

## 开发

```bash
# 规则自测（改规则后必须跑）
node test/selftest.js

# 语法检查
node --check src/server.js
```

自测覆盖 36 条路径用例：System32、Program Files、文档、`.ssh`、DriverStore 必须被拦；Temp、浏览器缓存、`ProgramData` 必须放行。另有一条硬约束断言：任何可清理项都必须同时满足 `regenerable === true` 且 tier ∈ {L1, L2}。

### 打包

**单文件 exe**（需先安装打包器）：

```bash
npm i -g @yao-pkg/pkg
pkg . --targets node22-win-x64 --output dist/DiskGovernor.exe
```

`package.json` 里的 `pkg.assets` 已声明 `web/`、`rules/`、`config.json`，打包后它们位于只读快照内——`saveConfig()` 会检测到并返回 `persisted: false`，功能正常但配置改动不落盘。

**便携版**（免安装，Node 运行时随包）：

```bash
mkdir -p dist/portable
cp -r src rules web test docs config.json package.json dist/portable/
cp "$(which node)" dist/portable/node.exe
```

约 84 MB，压缩后约 32 MB。**不要**把 `dist/` 提交进仓库，发布时作为 Release 附件上传。

---

## License

[MIT](LICENSE) © 2026 atcXiGua
