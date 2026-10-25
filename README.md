# DiskVision · 磁盘可视化分析与智能清理工具

> 极速磁盘空间可视化 + 智能安全清理 · Electron + Node.js + ECharts · 纯原生 JS，无重型框架，无广告，无后台驻留。

对标 WizTree（可视化）+ SpaceSniffer（树图下钻）+ 轻量 CCleaner（垃圾清理），并把三者合成一个 8MB 级的单页应用。

---

## 一、特性总览

| 模块 | 能力 |
|---|---|
| **全盘极速扫描** | 工作线程内同步 `readdirSync + statSync` 遍历，实测约 **3 万文件/秒**；实时进度、文件数、体积；自动跳过 `$RECYCLE.BIN`、目录联接（junction）、WinSxS 等死锁/循环目录；无权限目录静默计数，绝不崩溃 |
| **矩形树图 Treemap** | 面积 = 体积；8 大类自动配色；悬浮显示路径/大小/类型/修改时间；点击进入子文件夹层层下钻；右键菜单（打开位置 / 删除 / 复制路径 / 加入忽略） |
| **饼图与仪表盘** | 文件类型占比、大文件夹占比；磁盘总容量/已用/剩余/使用率；文件数、文件夹数、扫描耗时 |
| **TOP 排行** | TOP30 最大文件、TOP30 最大文件夹；可按体积/时间/后缀/最小体积筛选；一键定位、一键删除 |
| **智能垃圾清理** | 系统临时、日志、缩略图缓存、浏览器缓存（Chrome/Edge/Firefox/Chromium/Brave/360）、崩溃转储、空文件夹、Windows.old、过期安装包、过期压缩包/镜像、长期闲置大文件 |
| **重复文件** | 体积分桶 → 多线程 MD5 精确比对；分组展示、可选保留、批量删除冗余副本 |
| **安全防误删** | 系统关键目录白名单锁定 + 关键后缀锁定 + 删除二次确认 + **一律移入回收站**（绝不粉碎）+ 单次批量上限 1000 项 |
| **忽略列表** | 永不扫描的文件夹、永不清理的后缀、闲置天数、大文件阈值、索引保留阈值等全部可配置，持久化到 `%APPDATA%\disk-vision\config.json` |

### 安全分级

| 颜色 | 含义 | 能否删除 |
|---|---|---|
| 🟢 绿色 | 临时文件、日志、缓存、缩略图、浏览器缓存、空文件夹 | **可一键清理** |
| 🟡 黄色 | 用户个人文件、过期安装包、闲置大文件、Windows.old | 谨慎删除（需自行确认） |
| 🔴 红色 | `C:\Windows`、`Program Files`、`WinSxS`、`$Recycle.Bin` 等系统目录；`.sys/.dll/.drv/.mui` 等关键后缀 | **永久锁定**，界面禁止勾选，后端二次拒绝 |

---

## 二、目录结构

```
disk-vision/
├── package.json                 # 依赖 + electron-builder 打包配置
├── build/
│   └── icon.ico                 # 打包图标（scripts/make-icon.js 生成，可自行替换）
├── scripts/
│   ├── make-icon.js             # 纯 Node 生成 icon.ico（无第三方依赖）
│   └── vendor-echarts.js        # postinstall：把 echarts 拷到 vendor（离线可用）
├── src/
│   ├── main/                    # ===== 主进程 =====
│   │   ├── main.js              # 窗口创建、生命周期、全局兜底
│   │   ├── ipc.js               # IPC 接口层（唯一对外通道，含安全二次校验）
│   │   ├── scanner.js           # 扫描调度 + Dataset（下钻/排行/统计查询）
│   │   ├── worker.js            # 工作线程：tree / flat / junk / hash 四种任务
│   │   ├── pool.js              # 工作线程池（MD5 并行）
│   │   ├── cleaner.js           # 垃圾目标构造、分组、执行清理
│   │   ├── dup.js               # 重复文件：分桶 + MD5 + 删除冗余
│   │   ├── fsops.js             # 删除/打开/复制（统一走回收站）
│   │   ├── diskinfo.js          # 盘符探测 + 容量（fs.statfs，wmic 兜底）
│   │   └── config.js            # 配置持久化
│   ├── preload/
│   │   └── preload.js           # contextBridge 白名单 API
│   ├── shared/                  # ===== 主进程与渲染进程共用（UMD）=====
│   │   ├── categories.js        # 8 大类 + 后缀映射 + 配色
│   │   ├── safety.js            # 安全分级引擎（红/黄/绿）
│   │   └── rules.js             # 垃圾规则 + 默认忽略列表
│   └── renderer/                # ===== 渲染进程 =====
│       ├── index.html
│       ├── css/style.css        # 深色专业工具风格
│       ├── vendor/echarts.min.js# 本地 ECharts（离线）
│       └── js/
│           ├── util.js          # 格式化 / Toast / 二次确认弹窗
│           ├── api.js           # 全局状态 + 后端 API 封装
│           ├── charts.js        # Treemap / 饼图 / 仪表盘 / 条形图
│           ├── menu.js          # 右键菜单
│           ├── view-treemap.js  # 全盘可视化
│           ├── view-clean.js    # 一键智能清理
│           ├── view-big.js      # 大文件专项
│           ├── view-dup.js      # 重复文件
│           ├── view-dash.js     # 磁盘仪表盘
│           ├── view-ignore.js   # 忽略列表设置
│           └── app.js           # 主控：导航、扫描调度、状态栏、右侧面板
└── tests/selftest.js            # 纯 Node 自测（56 项）
```

---

## 三、运行教程（开发环境）

### 1. 环境

- Node.js **18.18+**（Electron 28 自带 Node 18.18，本机 Node 用于装依赖与打包）
- Windows 10/11

### 2. 安装依赖

```bash
cd disk-vision
npm install
```

> Electron 二进制默认从 GitHub 下载；国内建议先设镜像再装：
> ```powershell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> npm install
> ```
> （Linux/macOS：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）

`package.json` 里已配置 `electronDownload.mirror`，若仍慢，显式设置环境变量最稳。

### 3. 启动

```bash
npm start
```

首次启动会看到：左侧导航、中间「尚未扫描」提示、右侧空面板。选择盘符 → 点**开始扫描** → 树图出现。

### 4. 自测（不需要 Electron）

```bash
node tests/selftest.js
```

输出 `通过 56 项，失败 0 项` 即规则引擎、扫描、垃圾识别、重复文件全部正常。

---

## 四、打包教程

### 1. 一键出包（安装版 + 绿色版）

```bash
npm run dist
```

产物在 `dist/`：

| 文件 | 说明 |
|---|---|
| `DiskVision-1.0.0-x64.exe` | NSIS 安装版（可选安装路径、建快捷方式） |
| `DiskVision-1.0.0-便携版.exe` | 绿色免安装，双击即用 |

只想要其中一种：

```bash
npm run dist:installer    # 仅 NSIS 安装包
npm run dist:portable     # 仅绿色版
```

只想快速验证打包内容（不生成安装包）：

```bash
npm run pack              # 输出到 dist/win-unpacked，可直接运行里面的 exe
```

### 2. 换图标

把你的 `icon.ico`（建议 256×256）覆盖 `build/icon.ico` 即可。  
当前图标由 `node scripts/make-icon.js` 生成（品牌渐变 + 圆环），随时可重新生成。

### 3. 打包常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 卡在下载 `electron-v28.x.x-win32-x64.zip` | 设置 `ELECTRON_MIRROR` 镜像（见上） |
| 卡在下载 `winCodeSign` / `nsis` 资源 | 设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` |
| 报 `icon.ico` 不存在 | 执行 `node scripts/make-icon.js` 重新生成 |
| 安装包被杀软误报 | 无签名 exe 的通病；发布建议做代码签名，或在 README/下载页说明 |
| 想减小体积 | `package.json → build.files` 已只打包 `src/**`；不要引入其它 npm 包 |

---

## 五、架构设计说明

### 1. 为什么 UI 永不卡顿

```
渲染进程 (UI)  ──IPC──▶  主进程  ──▶  Worker 线程(扫描/哈希线程池)
                          ▲                │
                          └──── progress ───┘  (150ms 节流推送)
```

- 遍历与 MD5 全部在 `worker_threads` 里跑；
- 工作线程内每处理若干条目 `await setImmediate` 让出一次，保证能收到「停止」指令；
- 进度推送做了 150ms 节流，不会把 IPC 打满；
- 主进程 `UV_THREADPOOL_SIZE` 提到 8~32，异步 IO 更快。

### 2. 内存怎么控制住的

内存里**只保留目录节点 + 超过阈值（默认 1MB）的文件节点**：

- 小文件只累加进 `dir.size / fileCount / 类型统计`，不生成节点；
- 单层子项超过 220 个时，只取体积最大的 220 个，其余合并成「其他 N 项」；
- Worker 回传的是紧凑数组 `[id,parent,name,path,size,…]`，结构化克隆比对象快得多。

因此 100 万文件的盘，常驻内存通常几十 MB，渲染进程更不会爆。

### 3. 安全是"双保险"

1. **前端**：红色项复选框禁用、删除按钮置灰；
2. **后端**：`fsops.trashOne` 再次调用 `Safety.evaluate`，红色直接拒绝并记入失败列表；
3. **删除方式**：统一 `shell.trashItem`（回收站），不调用 `fs.unlink`；
4. **确认**：任何删除都先弹二次确认，列出前 12 条路径与合计体积；
5. **上限**：单次最多 1000 项，防止一次误选全盘。

### 4. 浏览器缓存的安全边界

扫描 Chrome/Edge/Firefox 时**只进入** `Cache / Code Cache / GPUCache / Service Worker / Session Storage / Crashpad` 等缓存子目录；书签、密码、Cookie、扩展数据一律不碰，也不会被计入清理列表。

---

## 六、使用建议与已知限制

- **首次扫描建议先选单个盘**（C 盘最慢，因为系统目录多）。
- 「一键清理安全项」只处理绿色项，可放心点；黄色项建议展开看一眼路径再决定。
- 删除后右下角提示会告诉你释放了多少；需要恢复就点**打开回收站**，右键「还原」。
- 已实现的限制：
  - 垃圾扫描是**定向扫描**（围绕已知垃圾目录），不做全盘规则匹配，这是为了保证速度；
  - 重复文件基于「索引保留阈值」以上的文件（默认 ≥1MB），更小的重复文件不会列出——把「重复文件最小体积」调小即可（会更慢）；
  - 不支持 `C:\$Recycle.Bin` 清理（被列为红色锁定目录，避免误清空）；
  - 不做注册表清理、不做启动项管理（这不是本工具的定位）。

---

## 七、常用命令速查

```bash
npm install            # 装依赖
npm start              # 开发运行
node tests/selftest.js # 规则自测
node scripts/make-icon.js  # 重新生成图标
npm run pack           # 打包到 dist/win-unpacked（不生成安装包）
npm run dist           # 生成 NSIS 安装包 + 绿色版
```

配置与日志位置：

- 用户配置：`%APPDATA%\disk-vision\config.json`
- 卸载：控制面板 → 卸载 DiskVision（绿色版直接删目录即可，无残留、无后台服务）

---

## 八、许可证

MIT。代码可自由修改与商用；作者不对误删数据负责——请善用回收站。
