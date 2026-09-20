/**
 * L3 桌面端 E2E：档案管理与校验规则（批次 `03`）。
 *
 * 用例来源：docs/testing/desktop/03-profile.md，一个 `it()` 对应一条用例。
 * 编排：test/e2e/support/desktop-host.ts；菜单与对话框：test/e2e/support/navbar-menu.ts、
 * test/e2e/support/config-dialog.ts
 *
 * 运行：pnpm test:e2e:desktop -- --run test/e2e/desktop/03-profile.e2e.ts
 *   前置：`dist/` 已由 `vite build` 产出，且 Debug 二进制经
 *         `tauri build --debug --no-bundle` 构建（必须带 custom-protocol，否则走 devUrl）。
 *
 * 整批共用一个应用实例，走**壳层车道**（`disableDownload: true`）：本批六条用例只触碰
 * 「档案」面板与档案命令层（`get_profiles` / `create_profile` / `set_active_profile` /
 * `disable_dsh_plugin`），都不需要 dsh 服务与 iframe，因此不必付装配与联网的代价。
 *
 * 模块划分与文档一致：`## 1. 档案管理` 的 001/002/004 走界面；`## 2. 档案名称规则、
 * 初始化形态与隔离性` 的 005/011/014 按 G-D03-4 走**命令层 + 磁盘状态断言**。
 *
 * 本批是破坏性最强的一批（新建/删除档案、切换 `active_profile`），因此 `beforeAll`
 * 先做一次**失败关闭**的数据目录归属校验（G-D03-9 / `desktop.test.md` §5.2）：解析出的
 * `data_dir` 必须落在本次运行的隔离根内，否则直接失败而不是在真实 `~/.dsh.dev` 上跑。
 */

import type { DesktopApp } from '../support/desktop-host'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  closeConfigDialog,
  isConfigDialogOpen,
  markConfigDialogPage,
  openConfigTab,
} from '../support/config-dialog'
import { startDesktopApp } from '../support/desktop-host'
import { clickWhenReady } from '../support/navbar-menu'
import {
  MODAL,
  MODAL_CANCEL,
  MODAL_STATUS_ATTR,
  NAVBAR_ROOT,
  PROFILE_NEW,
  PROFILE_NEW_CONFIRM,
  PROFILE_NEW_INPUT,
  PROFILE_ROW,
  PROFILE_ROW_ACTIVE_ATTR,
  PROFILE_ROW_DEFAULT_DESC,
  PROFILE_ROW_ID_ATTR,
  PROFILE_ROW_NAME_ATTR,
  profileRow,
} from '../support/selectors'

/** Rust 侧 `service::profile::Profile` 的序列化形态（camelCase）。 */
interface ProfileInfo {
  id: string
  name: string
  default: boolean
  active: boolean
}

/** 一行档案在 DOM 上暴露的机器可读快照（不依赖文本定位）。 */
interface ProfileRowSnapshot {
  id: string
  name: string
  active: boolean
  hasDefaultDesc: boolean
}

/** Rust 侧 `config::RuntimeInfo`（字段为 snake_case）。 */
interface RuntimeInfo {
  data_dir: string
  auto_download_disabled: boolean
}

/** `create_profile` 的规范化样本：与 `profile/mod.rs:1043` 的断言样本同源。 */
const NORMALIZE_SAMPLES: { name: string, id: string }[] = [
  { name: 'My Work Space', id: 'my-work-space' },
  { name: '  dev--stage  ', id: 'dev-stage' },
  { name: 'a_b-c', id: 'a-b-c' },
]

/** 新档案初始化落盘的四个文件（`profile/mod.rs:879`）。 */
const INIT_PROFILE_FILES = ['.npmrc', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

let app: DesktopApp
let browser: WebdriverIO.Browser
let stop: () => Promise<void>
/** 本次运行开始时正在使用的档案，用例结束一律复位到它。 */
let baselineActiveId = ''
/** 本批新建的档案，用例结束即删除（`web`/`tauri`/`safe` 永不入列）。 */
const createdProfiles = new Set<string>()

/** 档案根目录：`$E2E_HOME/home/.dsh.dev/profiles`（debug 恒用 `<home>/.dsh.dev`）。 */
function profilesRoot(): string {
  return join(app.home, 'home', '.dsh.dev', 'profiles')
}

function profileDir(id: string): string {
  return join(profilesRoot(), id)
}

function readManifest(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(profileDir(id), 'package.json'), 'utf8'))
}

/** 从页面上下文调用 Tauri 命令（真实后端，不是 Mock）。 */
async function invokeCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return await browser.execute(async (cmd: string, payload: Record<string, unknown>) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }).__TAURI_INTERNALS__
    return await internals.invoke(cmd, payload)
  }, command, args) as T
}

/** 调用命令并返回失败信息；命令意外成功时直接判失败。 */
async function invokeExpectError(command: string, args: Record<string, unknown>): Promise<string> {
  try {
    await invokeCommand(command, args)
  }
  catch (error) {
    return String((error as Error)?.message ?? error)
  }
  throw new Error(`期望 ${command} 失败，但它成功了`)
}

async function readProfiles(): Promise<ProfileInfo[]> {
  return await invokeCommand<ProfileInfo[]>('get_profiles')
}

async function activeProfileId(): Promise<string> {
  const profiles = await readProfiles()
  return profiles.find(profile => profile.active)?.id ?? ''
}

async function createProfile(name: string): Promise<ProfileInfo> {
  const created = await invokeCommand<ProfileInfo>('create_profile', { name })
  createdProfiles.add(created.id)
  return created
}

async function removeProfileQuietly(id: string): Promise<void> {
  try {
    await invokeCommand('remove_profile', { id })
  }
  catch {
    rmSync(profileDir(id), { recursive: true, force: true })
  }
}

/** 读取全部档案行的机器可读快照（行数、id、展示名、active、是否带默认说明）。 */
async function readRows(): Promise<ProfileRowSnapshot[]> {
  return await browser.execute(
    (rowSel: string, idAttr: string, nameAttr: string, activeAttr: string, descSel: string) => {
      const nodes = Array.from(document.querySelectorAll(rowSel)) as HTMLElement[]
      return nodes.map(node => ({
        id: node.getAttribute(idAttr) ?? '',
        name: node.getAttribute(nameAttr) ?? '',
        active: node.getAttribute(activeAttr) === 'true',
        hasDefaultDesc: Boolean(node.querySelector(descSel)),
      }))
    },
    PROFILE_ROW,
    PROFILE_ROW_ID_ATTR,
    PROFILE_ROW_NAME_ATTR,
    PROFILE_ROW_ACTIVE_ATTR,
    PROFILE_ROW_DEFAULT_DESC,
  )
}

async function waitForRow(id: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    async () => (await readRows()).some(row => row.id === id),
    { timeout, timeoutMsg: `档案列表未出现行：${id}` },
  )
}

/** 打开配置对话框并定位「档案」面板，等列表渲染出至少一行。 */
async function openProfilesPanel(): Promise<void> {
  await openConfigTab(browser, 'profiles')
  await browser.waitUntil(async () => (await readRows()).length > 0, {
    timeout: 15_000,
    timeoutMsg: '「档案」面板未渲染出任何档案行',
  })
}

/**
 * 点击指定档案行触发切换确认。
 *
 * 走页内 `click()` 而不是 WebDriver 的指针点击：行是整卡可点（`Item` 的 `onClick`），
 * 但卡内右侧的 Chip 都 `stopPropagation`，而窄视口下行的几何中心可能正落在
 * Chip/勾选框上——指针点击会随机命中。页内点击直接派发到行根节点，命中稳定。
 */
async function clickRow(id: string): Promise<void> {
  await browser.waitUntil(async () => await (await browser.$(profileRow(id))).isExisting(), {
    timeout: 15_000,
    timeoutMsg: `档案行不存在：${id}`,
  })
  await browser.execute((selector: string) => {
    const node = document.querySelector(selector) as HTMLElement | null
    if (node === null)
      throw new Error(`档案行不存在：${selector}`)
    node.click()
  }, profileRow(id))
}

/** 兜底收起可能残留的确认弹窗；清理失败不改变用例结论。 */
async function dismissModalIfOpen(): Promise<void> {
  const modal = await browser.$(MODAL)
  if (!await modal.isExisting() || !await modal.isDisplayed())
    return
  try {
    await clickWhenReady(browser, MODAL_CANCEL)
    await browser.waitUntil(async () => !(await (await browser.$(MODAL)).isExisting()), {
      timeout: 10_000,
    })
  }
  catch {
    // 兜底清理：把失败留给用例本身报，不在这里二次污染结论
  }
  await browser.pause(400)
}

describe.skipIf(process.platform === 'darwin')('档案管理与校验规则', () => {
  beforeAll(async () => {
    // 本批不触达 dsh 服务与 iframe：禁用自动下载，避免每次运行都做联网版本核对。
    app = await startDesktopApp({ disableDownload: true })
    browser = app.browser
    stop = app.stop
    await (await browser.$(NAVBAR_ROOT)).waitForDisplayed()
    await markConfigDialogPage(browser)

    // 失败关闭（G-D03-9）：本批会新建/删除档案并改写 active_profile，必须先证明
    // 解析出的数据目录落在本次运行的隔离根内，否则绝不动手。
    const info = await invokeCommand<RuntimeInfo>('get_runtime_info')
    expect(
      resolve(info.data_dir).toLowerCase().startsWith(resolve(app.home).toLowerCase()),
      `数据目录逃出隔离根：data_dir=${info.data_dir} home=${app.home}`,
    ).toBe(true)

    baselineActiveId = await activeProfileId()
    expect(baselineActiveId, '未解析出当前档案').not.toBe('')
  }, 300_000)

  afterAll(async () => {
    await stop?.()
  })

  // 每条用例自带前置，不依赖上一条留下的界面状态；档案与 active_profile 一律复位。
  afterEach(async () => {
    await dismissModalIfOpen()
    if (await isConfigDialogOpen(browser))
      await closeConfigDialog(browser)

    if (baselineActiveId !== '' && await activeProfileId() !== baselineActiveId)
      await invokeCommand('set_active_profile', { id: baselineActiveId })

    for (const id of [...createdProfiles]) {
      await removeProfileQuietly(id)
      createdProfiles.delete(id)
    }
  })

  it('TC-DSK-L3-03-001 验证档案列表展示且默认档案标记正确', async () => {
    await openProfilesPanel()

    const [rows, profiles] = [await readRows(), await readProfiles()]

    // 2. 行数量与 get_profiles 返回数量一致，名称均为非空字符串
    expect(rows.length, `行数量与后端返回不一致：rows=${rows.length} profiles=${profiles.length}`)
      .toBe(profiles.length)
    for (const row of rows)
      expect(row.name, `档案行展示名为空：${row.id}`).not.toBe('')

    // 行 id 与后端返回的 id 集合一致（行顺序由后端排序决定，不在此断言）
    expect(rows.map(row => row.id).sort()).toEqual(profiles.map(profile => profile.id).sort())

    // 3. 恰有一行带默认说明文案，且对应后端 default == true 的档案
    const defaultRows = rows.filter(row => row.hasDefaultDesc)
    const backendDefaults = profiles.filter(profile => profile.default)
    expect(backendDefaults.length, '后端返回了多个默认档案').toBe(1)
    expect(defaultRows.length, `带默认说明的行数量不为 1：${defaultRows.map(row => row.id).join(',')}`).toBe(1)
    expect(defaultRows[0].id, '默认说明文案不在后端 default == true 的行上').toBe(backendDefaults[0].id)
  })

  it('TC-DSK-L3-03-002 验证新建档案后列表出现新项', async () => {
    const name = `e2e-profile-${Date.now().toString(36)}`
    await openProfilesPanel()

    // 1. 点击「新建档案」，输入框出现并获得焦点
    await clickWhenReady(browser, PROFILE_NEW)
    const input = await browser.$(PROFILE_NEW_INPUT)
    await input.waitForDisplayed({ timeout: 10_000 })
    const focused = await browser.execute((selector: string) => {
      const node = document.querySelector(selector)
      const active = document.activeElement
      return Boolean(node && active && (node === active || node.contains(active)))
    }, PROFILE_NEW_INPUT)
    expect(focused, '新建输入框出现后未获得焦点').toBe(true)

    // 2. 输入成功（确认按钮从禁用变为可用即证明受控值已落到 state）
    await input.setValue(name)
    await browser.waitUntil(async () => await (await browser.$(PROFILE_NEW_CONFIRM)).isEnabled(), {
      timeout: 10_000,
      timeoutMsg: '输入名称后「确定」仍不可点击',
    })

    // 3. 点击「确定」并等待列表刷新
    await clickWhenReady(browser, PROFILE_NEW_CONFIRM)
    createdProfiles.add(name)
    await waitForRow(name)

    // 4/5. 列表包含测试名称，且输入区回到未展开状态
    expect((await readRows()).some(row => row.id === name), '列表未包含新建档案').toBe(true)
    expect(await (await browser.$(PROFILE_NEW_INPUT)).isExisting(), '新建后输入区未收起').toBe(false)
    expect(await (await browser.$(PROFILE_NEW)).isExisting(), '新建后「新建档案」入口未恢复').toBe(true)
  })

  it('TC-DSK-L3-03-004 验证切换档案需确认，取消则不切换', async () => {
    await openProfilesPanel()

    // 前置：存在至少 2 个档案，且当前激活档案非目标档案
    let profiles = await readProfiles()
    if (!profiles.some(profile => !profile.active)) {
      const filler = `e2e-switch-${Date.now().toString(36)}`
      await createProfile(filler)
      profiles = await readProfiles()
    }

    // 1. 记录当前激活档案
    const before = profiles.find(profile => profile.active)
    expect(before, '未解析出当前激活档案').toBeDefined()
    const target = profiles.find(profile => !profile.active)
    expect(target, '没有可切换的目标档案').toBeDefined()

    // 2. 点击目标档案行：出现切换确认框（警告语义）
    await clickRow(target!.id)
    const modal = await browser.$(MODAL)
    await modal.waitForDisplayed({ timeout: 10_000 })
    expect(await modal.getAttribute(MODAL_STATUS_ATTR), '切换确认框不是警告语义').toBe('warning')

    // 3. 在确认框中取消：确认框关闭
    await clickWhenReady(browser, MODAL_CANCEL)
    await browser.waitUntil(async () => !(await (await browser.$(MODAL)).isExisting()), {
      timeout: 10_000,
      timeoutMsg: '取消后确认框未关闭',
    })
    await browser.pause(400)

    // 4. 激活档案未变化
    expect(await activeProfileId(), '取消切换后激活档案被改动').toBe(before!.id)
  })

  it('TC-DSK-L3-03-005 验证规范化折叠分隔符并保留 ASCII 字母数字', async () => {
    // 1. 依次用三个名称新建档案（命令层，G-D03-4）
    for (const sample of NORMALIZE_SAMPLES) {
      const created = await createProfile(sample.name)
      expect(created.id, `规范化结果不符：${sample.name}`).toBe(sample.id)
    }

    // 2. 每次创建后读取 get_profiles 返回行的 id
    const ids = (await readProfiles()).map(profile => profile.id)
    for (const sample of NORMALIZE_SAMPLES)
      expect(ids, `get_profiles 未包含规范化 id：${sample.id}`).toContain(sample.id)

    // 3. 复查 profiles/ 下的目录名与 id 一致：小写、连续分隔符合并为一个 `-`、首尾 `-` 去除
    const dirs = readdirSync(profilesRoot())
    for (const sample of NORMALIZE_SAMPLES) {
      expect(dirs, `档案目录不存在：${sample.id}`).toContain(sample.id)
      expect(existsSync(profileDir(sample.id)), `档案目录不可用：${sample.id}`).toBe(true)
      // 原始名（含空格/下划线/连续连字符）绝不作为目录名落盘
      expect(dirs).not.toContain(sample.name)
    }
  })

  it('TC-DSK-L3-03-011 验证新档案落盘为四个文件且形态固定', async () => {
    // 前置：profiles/init-check 不存在
    rmSync(profileDir('init-check'), { recursive: true, force: true })

    // 1. 新建档案 init-check
    const created = await createProfile('init-check')
    expect(created.id).toBe('init-check')

    // 2. 目录下恰含四个文件
    const files = readdirSync(profileDir('init-check')).sort()
    expect(files, `初始化文件清单不符：${files.join(',')}`).toEqual([...INIT_PROFILE_FILES].sort())

    // 3. package.json 的 name / private / dependencies / dsh.profile.bundles
    const manifest = readManifest('init-check')
    expect(manifest.name).toBe('dsh-profile-init-check')
    expect(manifest.private).toBe(true)
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])

    // 4. cordis.patch.yml 为 3 行注释加 `[]`
    const patchLines = readFileSync(join(profileDir('init-check'), 'cordis.patch.yml'), 'utf8')
      .trimEnd()
      .split('\n')
    expect(patchLines.length, `cordis.patch.yml 行数不符：${patchLines.length}`).toBe(4)
    expect(patchLines.slice(0, 3).every(line => line.startsWith('#')), 'cordis.patch.yml 前 3 行不是注释').toBe(true)
    expect(patchLines[3]).toBe('[]')

    // 4. pnpm-workspace.yaml 与 .npmrc
    const workspace = readFileSync(join(profileDir('init-check'), 'pnpm-workspace.yaml'), 'utf8')
    for (const expected of ['packages:', 'nodeLinker: hoisted', 'autoInstallPeers: false', 'minimumReleaseAgeExclude', 'zod@4.4.3'])
      expect(workspace, `pnpm-workspace.yaml 缺少：${expected}`).toContain(expected)

    const npmrc = readFileSync(join(profileDir('init-check'), '.npmrc'), 'utf8')
    expect(npmrc).toContain('confirmModulesPurge=false')
  })

  it('TC-DSK-L3-03-014 验证各档案独立持有元数据与依赖目录', async () => {
    // 1. 新建 iso-a 与 iso-b：两份元数据各自独立落盘
    await createProfile('iso-a')
    await createProfile('iso-b')
    expect(readManifest('iso-a').dependencies).toEqual({})
    expect(readManifest('iso-b').dependencies).toEqual({})
    expect(existsSync(join(profileDir('iso-b'), 'node_modules')), 'iso-b 初始不应有依赖目录').toBe(false)

    // 2. 只在 iso-a 下持有该插件：写入依赖条目与 node_modules 产物（G-D03-6 的间接前置），
    //    再用真实命令层断言「插件操作解析到哪个目录」。
    const manifestA = readManifest('iso-a')
    manifestA.dependencies = { 'dsh-e2e-iso': '1.0.0' }
    manifestA.dsh.profile.bundles = [...manifestA.dsh.profile.bundles, 'dsh-e2e-iso']
    writeFileSync(join(profileDir('iso-a'), 'package.json'), `${JSON.stringify(manifestA, null, 2)}\n`)
    mkdirSync(join(profileDir('iso-a'), 'node_modules', 'dsh-e2e-iso'), { recursive: true })
    writeFileSync(
      join(profileDir('iso-a'), 'node_modules', 'dsh-e2e-iso', 'package.json'),
      `${JSON.stringify({ name: 'dsh-e2e-iso', version: '1.0.0' }, null, 2)}\n`,
    )

    // 3. iso-a 为活动档案时：读取与写入都解析到 iso-a
    await invokeCommand('set_active_profile', { id: 'iso-a' })
    const listedUnderA = await invokeCommand<{ id: string }[]>('get_dsh_plugins')
    expect(listedUnderA.map(plugin => plugin.id), 'iso-a 未读到自己的依赖').toContain('dsh-e2e-iso')

    await invokeCommand('disable_dsh_plugin', { id: 'dsh-e2e-iso' })
    expect(existsSync(join(profileDir('iso-a'), 'disabled-plugins.json')), '写入未落在 iso-a').toBe(true)
    expect(readManifest('iso-a').dsh.profile.bundles, 'iso-a 的 bundles 未变').not.toContain('dsh-e2e-iso')
    expect(existsSync(join(profileDir('iso-b'), 'disabled-plugins.json')), '写入落到了 iso-b').toBe(false)

    // 4. 切到 iso-b 后重复：解析目录随之改为 iso-b，iso-b 的元数据与依赖目录不受影响
    await invokeCommand('set_active_profile', { id: 'iso-b' })
    const listedUnderB = await invokeCommand<{ id: string }[]>('get_dsh_plugins')
    expect(listedUnderB.map(plugin => plugin.id), 'iso-b 读到了 iso-a 的依赖').not.toContain('dsh-e2e-iso')
    expect(await invokeExpectError('disable_dsh_plugin', { id: 'dsh-e2e-iso' }))
      .toContain('DISABLE_NOT_INSTALLED')

    expect(readManifest('iso-b').dependencies).toEqual({})
    expect(existsSync(join(profileDir('iso-b'), 'node_modules'))).toBe(false)
  })
})
