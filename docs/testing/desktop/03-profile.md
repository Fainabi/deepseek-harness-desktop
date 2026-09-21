# 档案管理与校验规则

> 层级：L3（真实 Tauri 窗口）
> 自动化：`test/e2e/desktop/03-profile.e2e.ts`（已接线）
> 前置：见 `00-overview.md` §5.1；`dist/` 与 debug 二进制已按最新源码重建
> 运行：`pnpm test:e2e:desktop -- --run test/e2e/desktop/03-profile.e2e.ts`
> 车道：真实装配（不置 `disableDownload`）——`03-014` 要在指定档案下做一次真实插件安装，需要可用的 runtime

档案是数据隔离的单位：列表、新建、切换、克隆、删除，以及名称规范化、初始化形态与跨档案隔离。

---

## 1. 档案管理

档案 = `$DSH_HOME/profiles/<id>`（测试中为 `$E2E_HOME/home/.dsh.dev/profiles/<id>`，见 `00-overview.md` §5.3），与官方 dsh CLI 的 profile 语义一致；桌面端把「当前档案」持久化在 store 的 `active_profile`，服务启动与插件管理都以它为准。本文件的重点是**写操作的可见反馈**与**失败不静默**。

---

### 事实基线

| 事实 | 位置 |
| --- | --- |
| 列表真值来自 `get_profiles` 查询 | `src/ui/config/profile.tsx:34-37` |
| 写操作：`create_profile`/`set_active_profile`/`remove_profile`/`clone_profile` | `src/ui/config/profile.tsx:46-61` |
| 写操作后显式 `refetch()`，列表与后端一致 | `src/ui/config/profile.tsx:64-85` |
| 默认档案显示说明文案，且删除入口禁用 | `src/ui/config/profile.tsx:263-267`、`:307-317` |
| 新建「确定」在 `!name.trim()` 或 busy 时禁用 | `src/ui/config/profile.tsx:349` |
| 新建输入框 Enter 触发提交 | `src/ui/config/profile.tsx:337-340` |
| 克隆建议名 `suggestCloneName`：`<base>-<n>`，跳过已占用 id | `src/ui/config/profile.tsx:104-113` |
| 切换档案前弹警告确认框，取消即中止 | `src/ui/config/profile.tsx:144-162` |
| 切换成功后 toast 提供「重启」入口 | `src/ui/config/profile.tsx:165-176` |
| 写操作进行中 `busy` 会禁用所有行内入口 | `src/ui/config/profile.tsx:91`、`:296`、`:308` |
| 备份子视图入口 | `src/ui/config/profile.tsx:241-245`、`:285-294` |

---

### 列表与新建

### [P1] 验证档案列表展示且默认档案标记正确

[Case ID] TC-DSK-L3-03-001
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 03；`src/ui/config/profile.tsx:34-40`、`:254-269`
[自动化] 已接线（`test/e2e/desktop/03-profile.e2e.ts`）
[前置条件] 应用处于 `ready`；至少存在 1 个档案
[测试数据] 选择器 `dsh-profile-row`、`dsh-profile-row-name`、`dsh-profile-row-default-desc`；行标识属性 `data-profile-id`
[测试步骤] 1. 打开「档案」面板。2. 读取档案行数量与每行名称。3. 读取带默认标记的行。
[预期结果] 1. 面板渲染完成。2. 行数量与 `get_profiles` 返回数量一致，行序与返回顺序逐行对应，名称均为非空字符串。3. 恰有一行带默认说明文案，且对应后端 `default == true` 的档案。
[清理] 无（只读）；`DELETE /session/<id>`

### [P1] 验证新建档案后列表出现新项

[Case ID] TC-DSK-L3-03-002
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] 批次 03；`src/ui/config/profile.tsx:194-208`
[自动化] 已接线（同上）
[前置条件] 配置对话框可打开；新建名称未被占用
[测试数据] 名称 `e2e-profile-<时间戳>`（规范化稳定样本：期望 id 与输入同名）
[测试步骤] 1. 点击「新建档案」。2. 在输入框填入测试名称。3. 点击「确定」。4. 等待列表刷新。5. 读取列表行与输入区状态。
[预期结果] 1. 输入框出现并获得焦点（`document.activeElement` 命中 `dsh-profile-new-input`）。2. 输入成功。3. 按钮可点击并被触发。4. 列表刷新完成。5. 出现 `data-profile-id` 为该 id 的行且展示名非空，输入区回到未展开状态（输入框从 DOM 卸载）。
[清理] 无（隔离 home 由 `afterAll` 整体回收）；`DELETE /session/<id>`
[备注] 身份判据取行上的 `data-profile-id`，不比对展示名文本：展示名由 manifest 派生（首字母大写），属 G-D03-7 不覆盖范围。

---

### 切换、克隆与删除

### [P3] 验证切换档案需确认，取消则不切换

[Case ID] TC-DSK-L3-03-004
[层级] L3（真实 Tauri 窗口）
[类型] 异常
[追踪] `src/ui/config/profile.tsx:144-162`；`src/components/modal.tsx:29`
[自动化] 已接线（同上）
[前置条件] 应用处于 `ready`；本用例经 UI 自建目标档案（不触碰 `web`/`tauri`/`safe`）
[测试数据] 目标档案：`e2e-activate-<时间戳>`（本用例新建，非活动档案）；确认框选择器 `[data-modal-status]`、取消按钮 `dsh-modal-cancel`
[测试步骤] 1. 记录当前激活档案。2. 经「新建档案」创建目标档案并点击其行内名称区。3. 在确认框中取消。4. 读取当前激活档案。
[预期结果] 1. 记录成功，且目标档案不是活动档案。2. 出现切换确认框，`data-modal-status` 为 `warning`（警告语义）。3. 确认框关闭并离开 DOM。4. 激活档案未变化。
[清理] 无（隔离 home 由 `afterAll` 整体回收）；`DELETE /session/<id>`
[备注] 点「行内名称区」而非整行坐标点击：行右侧是可点 Chip（备份/克隆/删除），坐标点击有落到 Chip 上的风险。

---

### 选择器契约

| `data-testid` | 元素 | 状态 |
| --- | --- | --- |
| `dsh-profile-row` | 单个档案行（另带 `data-profile-id`） | 已接线 |
| `dsh-profile-row-name` | 行内档案名节点（点它等价于点整行） | 已接线 |
| `dsh-profile-row-default-desc` | 默认档案说明文案 | 已接线 |
| `dsh-profile-new` | 「新建档案」按钮 | 已接线 |
| `dsh-profile-new-input` | 新建名称输入框 | 已接线 |
| `dsh-profile-new-confirm` | 新建「确定」按钮 | 已接线 |
| `dsh-profile-new-cancel` | 新建「取消」按钮 | 已接线 |
| `dsh-profile-clone` | 「克隆」Chip | 已接线 |
| `dsh-profile-clone-input` | 克隆名称输入框 | 已接线 |
| `dsh-profile-clone-confirm` | 克隆「确定」按钮 | 已接线 |
| `dsh-profile-remove` | 「删除」Chip | 已接线 |
| `dsh-profile-backup` | 「备份」Chip | 已接线 |

行标识 `data-profile-id`（档案 id）不是 testid，但按同一契约登记：展示名由 manifest 派生，身份判据只能取 id。

`03-004` 还需要两个**跨批次共用**的弹窗锚点（`src/components/modal.tsx`，overlastic `Modal`）：

| 选择器 | 元素 | 状态 |
| --- | --- | --- |
| `data-modal-status` | 弹窗根节点（值域 `default\|accent\|success\|warning\|danger`） | 已接线 |
| `dsh-modal-cancel` / `dsh-modal-confirm` | 弹窗的取消 / 确认按钮 | 已接线 |

---

### 单元测试层（已从 L3 E2E 裁剪）

本文件下列条目的断言对象是纯逻辑（函数/时序/协议），不需要真实窗口；已从 L3 E2E 台账裁出，保留记录以便由单元测试承接。

| Case ID | 用例 | 裁剪原因 |
| --- | --- | --- |
| `TC-DSK-L3-03-003` | 验证克隆档案的建议名称不与现有 id 冲突（`suggestCloneName` 的 `<base>-<n>` 算法） | 纯逻辑断言，下沉单元测试层 |

### 追踪矩阵

| 实现位置 | 覆盖 Case ID | 类型 |
| --- | --- | --- |
| ``src/ui/config/profile.tsx:34-40`、`:254-269`` | `TC-DSK-L3-03-001` | 正向 |
| ``src/ui/config/profile.tsx:194-208`` | `TC-DSK-L3-03-002` | 正向 |
| ``src/ui/config/profile.tsx:144-162`` | `TC-DSK-L3-03-004` | 异常 |

---

### 缺口与假设

- **G-D03-1**：TC-DSK-L3-03-004 只覆盖「取消不切换」。**确认后切换 + 服务重启**的完整链路未覆盖，因为它会触发一次真实服务重启并改变后续用例的前置状态；如需覆盖，应放在独立批次并显式复位 `active_profile`。
- **G-D03-2**：~~档案的物理落盘未断言~~ → 已由 `03-005`（目录名）、`03-011`（4 个文件与内容）、`03-014`（依赖与 `node_modules`）在磁盘层断言；本节仍不重复断言落盘。
- **G-D03-3**：`busy` 期间所有行内入口禁用（`profile.tsx:91`）未单独建用例，属「单例约束」类边界，已从 L3 台账裁剪。
- **G-D03-10**：`03-001`/`03-002`/`03-004` 只经 UI 断言，`03-005`/`03-011`/`03-014` 经命令层构造（G-D03-4）。两条路线都跑在同一份真实装配车道里，因此 `03-001` 的行序断言同时约束了「列表查询结果」与「DOM 渲染顺序」。
- **G-D03-11**：`03-004` 的目标档案由用例经 UI 自建，而不是复用 `web` 行或上一条用例的产物：`web` 行在目录缺失时是**合成行**（`mod.rs:254`），且取消失败会真的把活动档案切到内置档案上；自建目标让用例可单独运行且不触碰 `web`/`tauri`/`safe`。
- **假设**：`get_profiles` 至少返回 1 个档案（默认档案始终存在）；若测试环境为空，TC-DSK-L3-03-001 需先创建。

---

## 2. 档案名称规则、初始化形态与隔离性

本文件只覆盖**后端规则面**：名称规范化、创建与克隆的校验顺序及错误码、初始化落盘的四个文件、以及档案之间的隔离边界。界面呈现与写操作反馈归「档案管理」模块，此处不重复断言。

---

### 事实基线

| 事实 | 位置 |
| --- | --- |
| 规范化 `normalize_profile_id`：小写 → 仅保留 ASCII 字母数字 → ` `/`-`/`_` 记为待插入分隔符、连续分隔符合并为一个 `-`、仅在输出非空时插入 → 其余字符丢弃 → 去首尾 `-` | `src-tauri/src/service/profile/mod.rs:289` |
| 规范化断言样本 `My Work Space`/`  dev--stage  `/`中文档案`/`a_b-c` | `src-tauri/src/service/profile/mod.rs:1043` |
| `create` 五项校验顺序与错误码（空名 → 规范化为空 → 长度 → 保留名 → 目录已存在） | `src-tauri/src/service/profile/mod.rs:308` |
| 唯一保留名 `web`；64 上限比较的是规范化后的 id | `src-tauri/src/service/profile/mod.rs:42`、`:320` |
| 引导档案 `tauri`、安全档案 `safe`（`create` 不拦截） | `src-tauri/src/service/profile/mod.rs:51`、`:59` |
| `clone_with_root` 对显式名走同一套五项校验（含 64 上限与 `web` 保留） | `src-tauri/src/service/profile/mod.rs:569` |
| 新档案初始化写入 4 个文件 | `src-tauri/src/service/profile/mod.rs:879` |
| 清单来源 `web_profile_manifest` | `src-tauri/src/service/profile/mod.rs:707` |
| `cordis.patch.yml` / `pnpm-workspace.yaml` / `.npmrc` 内容 | `src-tauri/src/service/profile/mod.rs:888` |
| 写权限预检 `perm::ensure_dir_writable(dir, "PROFILE_MKDIR")` 先于落盘 | `src-tauri/src/service/profile/mod.rs:884` |
| 半初始化目录的核心 web 层自愈 `ensure_profile_core_bundles` | `src-tauri/src/service/profile/mod.rs:732` |
| `create` 的目录判存（已存在即 `PROFILE_EXISTS`，不幂等） | `src-tauri/src/service/profile/mod.rs:324` |
| 档案目录 `$DSH_HOME/profiles/<id>`（测试中为 `$E2E_HOME/home/.dsh.dev/profiles/<id>`，见 `00-overview.md` §5.3） | `src-tauri/src/service/profile/mod.rs:99` |
| 启动与插件操作按 `active_profile` 解析该目录 | `src-tauri/src/service/plugin/installed.rs:37` |
| 列表行字段 `id`/`name`/`default`/`active` 与命令注册 | `src-tauri/src/service/profile/mod.rs:85`；`src-tauri/src/bridge/profile.rs:11`；`src-tauri/src/desktop/builder.rs:901` |
| 展示名 `manifest_display_name`（去 `dsh-profile-` 前缀、回落 id、首字母大写） | `src-tauri/src/service/profile/mod.rs:224`、`:1104` |
| 列表跳过点目录与 `node_modules`；`web` 目录缺失时合成行 | `src-tauri/src/service/profile/mod.rs:254` |
| 排序：默认档案在前，其余按 id 字典序 | `src-tauri/src/service/profile/mod.rs:283` |
| `active_profile` 回退 `web`（空值/等于 `web`/目录缺失） | `src-tauri/src/service/profile/mod.rs:211` |
| `set_active` 错误码 | `src-tauri/src/service/profile/mod.rs:337` |
| `remove` 删除守卫 | `src-tauri/src/service/profile/mod.rs:532` |
| home 层 `$DSH_HOME/cordis.patch.yml` 作用于所有档案（含安全档案）；测试路径同受 §5.3 约束 | `src-tauri/src/bridge/lifecycle.rs:349` |
| 档案面板列表、active 标记与克隆对话框 | `src/ui/config/profile.tsx:254`、`:285`、`:104` |

---

### 名称规范化

### [P1] 验证规范化折叠分隔符并保留 ASCII 字母数字

[Case ID] TC-DSK-L3-03-005
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:289`；`src-tauri/src/service/profile/mod.rs:1043`
[自动化] 已接线（`test/e2e/desktop/03-profile.e2e.ts`）
[前置条件] 应用处于 `ready`（真实装配车道）；`$E2E_HOME/home/.dsh.dev/profiles` 可写（§5.3）
[测试数据] 名称 `My Work Space`、`"  dev--stage  "`（引号仅标示首尾各两个空格，实际名称不含引号）、`a_b-c`
[测试步骤] 1. 依次用三个名称新建档案。2. 每次创建后读取 `create_profile` 返回行与 `get_profiles` 的 `id`。3. 复查 `profiles/` 下的目录名。
[预期结果] 1. 三次创建均成功返回。2. 对应 `id` 依次为 `my-work-space`、`dev-stage`、`a-b-c`。3. 目录名与 `id` 一致：小写、连续分隔符合并为一个 `-`、首尾 `-` 被去除，且不存在未规范化的目录。
[清理] 无（隔离 home 由 `afterAll` 整体回收）；`DELETE /session/<id>`

---

### 初始化形态与幂等

### [P1] 验证新档案落盘为四个文件且形态固定

[Case ID] TC-DSK-L3-03-011
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:879`、`:707`、`:888`
[自动化] 已接线（`test/e2e/desktop/03-profile.e2e.ts`）
[前置条件] 应用处于 `ready`（真实装配车道）；`profiles/init-check` 不存在
[测试数据] 名称 `init-check`
[测试步骤] 1. 经 `create_profile` 新建档案 `init-check`。2. 读取该档案目录下的文件清单。3. 读取 `package.json` 的 `name`/`private`/`dependencies`/`dsh.profile.bundles`。4. 读取 `cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`。
[预期结果] 1. 创建成功且目录存在。2. 目录下恰含 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`.npmrc`。3. `name` 为 `dsh-profile-init-check`；`private` 为 `true`；`dependencies` 为空对象；`dsh.profile.bundles` 为 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。4. `cordis.patch.yml` 为 3 行注释加 `[]`（共 4 行）；`pnpm-workspace.yaml` 含 `packages`、`nodeLinker: hoisted`、`autoInstallPeers: false`、`minimumReleaseAgeExclude: zod@4.4.3`；`.npmrc` 含 `confirmModulesPurge=false`。
[清理] 无（隔离 home 由 `afterAll` 整体回收）；`DELETE /session/<id>`

---

### 隔离性与回退

### [P1] 验证各档案独立持有元数据与依赖目录

[Case ID] TC-DSK-L3-03-014
[层级] L3（真实 Tauri 窗口）
[类型] 正向
[追踪] `src-tauri/src/service/profile/mod.rs:99`；`src-tauri/src/service/plugin/installed.rs:37`
[自动化] 已接线（`test/e2e/desktop/03-profile.e2e.ts`）
[前置条件] 应用处于 `ready`（真实装配车道）；网络或本地包源可用；runtime 已装配（node/dsh/pnpm 可用）
[测试数据] 档案 `iso-a`、`iso-b`；插件 `dshmarket`（`src-tauri/resources/preset-plugins.json` 的公开 npm 包，依赖键与预设 id 同名）
[测试步骤] 1. 新建 `iso-a` 与 `iso-b`。2. 把 `iso-a` 设为活动档案后经 `install_preinstall_plugins` 安装该插件，再读取两个档案的 `package.json` 与 `node_modules`。3. 在 `iso-a` 与 `iso-b` 分别为活动档案时读 `get_preinstall_plugins` 的 `installed` 判定，并复查 `iso-a` 的安装产物仍在。
[预期结果] 1. 两个档案目录均创建成功。2. 依赖条目只出现在 `iso-a` 的 `package.json` 与 `node_modules` 中，`iso-b` 不受影响（无依赖条目、无 `node_modules`）。3. 解析目录由 `active_profile` 决定：活动档案为 `iso-a` 时判定已安装、切到 `iso-b` 后判定未安装、切回后重新可见，而 `iso-a` 的产物始终保留。
[清理] 无（隔离 home 由 `afterAll` 整体回收）；`DELETE /session/<id>`
[备注] 安装走真实 `dsh plugin --profile <active> add`（会先停服务），因此本用例排在文件末尾并单独放宽超时。

### 单元测试层（已从 L3 E2E 裁剪）

本文件下列条目的断言对象是纯逻辑（函数/时序/协议），不需要真实窗口；已从 L3 E2E 台账裁出，保留记录以便由单元测试承接。

| Case ID | 用例 | 裁剪原因 |
| --- | --- | --- |
| `TC-DSK-L3-03-006` | 验证非字母数字字符被丢弃而非转为 `-` | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-007` | 验证空名与规范化后为空的名称返回不同错误码 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-008` | 验证 64 字符上限按规范化结果比较 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-009` | 验证保留名与已存在目录不会被静默重建 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-010` | 验证只有 `web` 被保留，引导与安全档案名不被拦截 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-012` | 验证重复初始化幂等且不覆盖用户编辑 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-013` | 验证半初始化目录被补齐核心层，不可写目录在预检阶段报错 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-015` | 验证活动档案回退与删除守卫的错误码 | 纯逻辑断言，下沉单元测试层 |
| `TC-DSK-L3-03-016` | 验证 home 层补丁跨档案生效 | 纯逻辑断言，下沉单元测试层 |

---

### 追踪矩阵

| 实现位置 | 覆盖 Case ID | 类型 |
| --- | --- | --- |
| ``src-tauri/src/service/profile/mod.rs:289`；`src-tauri/src/service/profile/mod.rs:1043`` | `TC-DSK-L3-03-005` | 正向 |
| ``src-tauri/src/service/profile/mod.rs:879`、`:707`、`:888`` | `TC-DSK-L3-03-011` | 正向 |
| ``src-tauri/src/service/profile/mod.rs:99`；`src-tauri/src/service/plugin/installed.rs:37`` | `TC-DSK-L3-03-014` | 正向 |

---

### 缺口与假设

- **G-D03-4**：本文件全部用例经命令层（`create_profile` / `set_active_profile` / `get_profiles` / 克隆）与磁盘状态断言；界面呈现与提示文案归「档案管理」模块，不重复断言。
- **G-D03-5**：`create` 不拦截 `tauri`（`mod.rs:51`）与 `safe`（`mod.rs:59`），用户可占用引导与安全档案名。被占用后引导流程与安全模式的实际行为未验证，属已知边界。
- **G-D03-6**：~~「插件操作解析到哪个目录」当前无只读出口~~ → 接线结论：出口是 `get_preinstall_plugins`。它经 `installed::list_installed` 读 `profile_dir_of(active_profile)` 的 `package.json`（`installed.rs:37-42`），因此同一次调用在两个活动档案下给出不同的 `installed` 判定，无需借日志或安装产物旁证；安装产物仍被复查，用来区分「解析目标变了」与「产物被删了」。
- **G-D03-7**：列表的展示名（`mod.rs:224`、`:1104`）、跳过点目录与 `node_modules`、`web` 目录缺失时的合成行、默认优先排序（`mod.rs:254`、`:283`）不在本文件 12 个 Case 内。`03-002` 因此只断言「展示名非空」，身份判据取行上的 `data-profile-id`。
- **G-D03-8**：TC-DSK-L3-03-013 需构造不可写目录（改属主/权限），Windows 上需管理员；接线时按平台选择可用手段。
- **G-D03-12**：`03-014` 是仓库里第一处真实插件安装的 E2E：安装走 `install_preinstall_plugins` → `dsh plugin --profile <active> add`，会**先停掉运行中的服务**（`install/mod.rs:214-234`），因此该用例排在文件末尾（其后没有依赖服务的断言），并单独放宽超时（900s）。安装耗时随包体与 pnpm 的 allowBuilds 重试变化，是整批最慢的一条。
- **假设**：本文件全部路径均在 `$E2E_HOME` 之下（`00-overview.md` §5.3）。文中 `$DSH_HOME/profiles/<id>` 指 `$E2E_HOME/home/.dsh.dev/profiles/<id>`（debug）。**不得**依赖设置 `DSH_HOME` 来隔离——debug 构建恒用 `<home>/.dsh.dev` 并忽略 `DSH_HOME`（`src-tauri/src/config/runtime.rs:471-485`），隔离只能靠重定向 `USERPROFILE`/`HOME`；`web`、`tauri`、`safe` 档案不得由用例创建或删除。
- **G-D03-9**：本文件是**破坏性最强**的一批用例（新建/删除档案、改写 home 层补丁）。所有用例必须在重定向后的 `$E2E_HOME/home/.dsh.dev` 内运行；在脚手架实现 §5.3 的重定向与失败关闭校验之前**不得执行**。
- **G-D03-13**：本批走真实装配车道（`03-014` 需要 runtime），因此 `beforeAll` 会过一次预装引导（跳过）并等 iframe 挂载。本机若已跑着另一个桌面实例，它同样占着 WebDriver 端口 4445；`test/e2e/support/desktop-host.ts` 现在按 `TAURI_WEBDRIVER_PORT` 取端口（默认 4445），可用该变量另开一路，无需结束用户实例。
