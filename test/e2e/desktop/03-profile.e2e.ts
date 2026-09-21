/**
 * L3 桌面端 E2E：档案管理与校验规则（批次 `03`）。
 *
 * 用例来源：docs/testing/desktop/03-profile.md，一个 `it()` 对应一条用例。
 * 编排：test/e2e/support/desktop-host.ts；菜单操作：test/e2e/support/navbar-menu.ts；
 * 对话框生命周期：test/e2e/support/config-dialog.ts
 *
 * 运行：pnpm test:e2e:desktop -- --run test/e2e/desktop/03-profile.e2e.ts
 *   前置：`dist/` 已由 `vite build` 产出，且 Debug 二进制经
 *         `tauri build --debug --no-bundle` 构建（必须带 custom-protocol，否则走 devUrl）。
 *   本机若已跑着另一个桌面实例（它占着 4445），用 `TAURI_WEBDRIVER_PORT=<空闲端口>` 另开一路。
 *
 * 本文件**整批共用一个应用实例**，且走**真实装配车道**（不置 `disableDownload`）：
 * `03-014` 要在指定档案下做一次真实插件安装，需要可用的 runtime（node/dsh/pnpm），
 * 那正是真实装配的产物。档案面板与 `get_profiles` 等命令本身不依赖装配就绪，因此
 * 其余 5 条同样跑在装配完成之后（与批次 `02` 同车道）。
 *
 * 破坏面：本批会新建档案、在档案目录里装插件、并改写活动档案指向；全部落在
 * `$E2E_HOME/home/.dsh.dev`（`USERPROFILE` 被重定向，见 support/desktop-host.ts），
 * `web`/`tauri`/`safe` 三个内置档案不由用例创建或删除。
 */

import type { DesktopApp } from '../support/desktop-host'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { ensureShellInteractive } from '../support/onboarding'
import { completePreinstall } from '../support/preinstall'
import {
  MODAL_CANCEL,
  MODAL_DIALOG,
  MODAL_STATUS_ATTR,
  NAVBAR_ROOT,
  PROFILE_NEW,
  PROFILE_NEW_CONFIRM,
  PROFILE_NEW_INPUT,
  PROFILE_ROW,
  PROFILE_ROW_DEFAULT_DESC,
  PROFILE_ROW_ID_ATTR,
  PROFILE_ROW_NAME,
  SHELL_IFRAME,
} from '../support/selectors'

/**
 * 014 安装的插件：取预装清单里的公开 npm 包（`resources/preset-plugins.json`）。
 * 依赖键与预设 id 同名（`installed::installed_name` 未声明 `package` 时回落 id）。
 */
const ISOLATION_PLUGIN = 'dshmarket'

/** 新建档案的初始化产物（`service::profile::init_profile_dir`），恰这四个文件。 */
const PROFILE_INIT_FILES = ['.npmrc', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

interface ProfileRow {
  id: string
  name: string
  default: boolean
  active: boolean
}

interface PreinstallPluginRow {
  id: string
  installed: boolean
}

interface RenderedRow {
  id: string
  name: string
  defaultDesc: boolean
}

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

let app: DesktopApp
let browser: WebdriverIO.Browser
let stop: () => Promise<void>

/** 应用内 dsh 数据目录（`config::get_dsh_data_path` = `<USERPROFILE>/.dsh.dev`）。 */
function dshDataDir(): string {
  return join(app.home, 'home', '.dsh.dev')
}

function profilesRoot(): string {
  return join(dshDataDir(), 'profiles')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** 调 Tauri 命令（用例一律经命令层观察/构造后端状态，不绕过 IPC 直接改文件）。 */
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return await browser.execute(
    async (command: string, payload: Record<string, unknown>) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }).__TAURI_INTERNALS__
      return await internals.invoke(command, payload)
    },
    cmd,
    args,
  ) as T
}

async function getProfiles(): Promise<ProfileRow[]> {
  return await invoke<ProfileRow[]>('get_profiles')
}

/** 面板当前渲染的档案行：id / 名称 / 是否带默认档案说明。 */
async function readRenderedRows(): Promise<RenderedRow[]> {
  return await browser.execute(
    (rowSelector: string, nameSelector: string, descSelector: string, idAttr: string) => {
      return Array.from(document.querySelectorAll(rowSelector)).map((row) => {
        const name = row.querySelector(nameSelector)
        return {
          id: row.getAttribute(idAttr) ?? '',
          name: (name?.textContent ?? '').trim(),
          defaultDesc: row.querySelector(descSelector) !== null,
        }
      })
    },
    PROFILE_ROW,
    PROFILE_ROW_NAME,
    PROFILE_ROW_DEFAULT_DESC,
    PROFILE_ROW_ID_ATTR,
  ) as RenderedRow[]
}

async function readRowIds(): Promise<string[]> {
  return (await readRenderedRows()).map(row => row.id)
}

async function waitForRow(id: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await readRowIds()).includes(id), {
    timeout: 20_000,
    timeoutMsg: `${timeoutMsg}：${id}`,
  })
}

/**
 * 点击某一行的**名称区**（等价于点整行，但避开右侧操作 Chip 的 `stopPropagation`）。
 *
 * 用帧内 `HTMLElement.click()` 而非 WDIO 的元素点击：行内右侧是可点 Chip，
 * 坐标点击有落到 Chip 上的风险，那会走进克隆/删除而不是「切换档案」。
 */
async function clickRowName(id: string): Promise<void> {
  await waitForRow(id, '档案行未出现')
  const clicked = await browser.execute(
    (rowSelector: string, nameSelector: string, idAttr: string, targetId: string) => {
      const row = Array.from(document.querySelectorAll(rowSelector))
        .find(item => item.getAttribute(idAttr) === targetId)
      const name = row?.querySelector(nameSelector) as HTMLElement | null
      if (!name)
        return false
      name.click()
      return true
    },
    PROFILE_ROW,
    PROFILE_ROW_NAME,
    PROFILE_ROW_ID_ATTR,
    id,
  ) as boolean
  expect(clicked, `档案行内没有名称节点：${id}`).toBe(true)
}

/**
 * 经 UI 新建一个档案，并等到它出现在列表里。
 *
 * `name` 一律取「规范化稳定」的样本（小写字母、数字、单连字符），因此期望 id 与
 * 输入同名——展示名由 manifest 派生（首字母大写），不作为身份判据（见文档 G-D03-7）。
 */
async function createProfileViaUi(name: string): Promise<void> {
  await clickWhenReady(browser, PROFILE_NEW)
  await browser.waitUntil(
    async () => await browser.execute(
      (selector: string) => document.activeElement === document.querySelector(selector),
      PROFILE_NEW_INPUT,
    ),
    { timeout: 10_000, timeoutMsg: '「新建档案」输入框未获得焦点' },
  )

  const input = await browser.$(PROFILE_NEW_INPUT)
  await input.setValue(name)
  await clickWhenReady(browser, PROFILE_NEW_CONFIRM)
  await waitForRow(name, '新建档案未出现在列表')
}

/** 预装清单里某插件的「已安装」判定（读的是**当前活动档案**的 package.json）。 */
async function preinstallInstalled(pluginId: string): Promise<boolean> {
  const rows = await invoke<PreinstallPluginRow[]>('get_preinstall_plugins')
  const row = rows.find(item => item.id === pluginId)
  expect(row, `预装清单缺少插件：${pluginId}`).toBeTruthy()
  return row?.installed ?? false
}

describe.skipIf(process.platform === 'darwin')('档案管理与校验规则', () => {
  beforeAll(async () => {
    app = await startDesktopApp()
    browser = app.browser
    stop = app.stop
    await (await browser.$(NAVBAR_ROOT)).waitForDisplayed()
    // 页面级标记：整个用例期间都应存在，用来区分「弹层被收起」与「webview 被重载」
    await markConfigDialogPage(browser)
    // 首次装配要先过「安装推荐插件」引导，服务才会被拉起（引导自身的用例归批次 08）
    await completePreinstall(browser)
    // iframe 只在 serviceHealthy 时渲染；014 的真实插件安装需要这份 runtime
    await (await browser.$(SHELL_IFRAME)).waitForDisplayed({ timeout: 300_000 })
    // 首次进入 dsh 会弹「内测声明」/「添加 API Key」两个弹层，遮罩镜像到导航栏后壳层不可点
    await ensureShellInteractive(browser)
  }, 900_000)

  afterAll(async () => {
    await stop?.()
  })

  // 每条用例自带开/关，不依赖上一条留下的对话框状态
  afterEach(async () => {
    if (await isConfigDialogOpen(browser))
      await closeConfigDialog(browser)
  })

  it('TC-DSK-L3-03-001 验证「档案」面板列表与 get_profiles 一致且默认说明唯一', async () => {
    await openConfigTab(browser, 'profiles')

    const profiles = await getProfiles()
    expect(profiles.length, '后端没有任何档案').toBeGreaterThan(0)

    // 面板先渲染出行（`Panel.Loadable` 的加载态下是空列表），再比对
    await browser.waitUntil(async () => (await readRenderedRows()).length > 0, {
      timeout: 20_000,
      timeoutMsg: '「档案」面板未渲染任何档案行',
    })

    const rows = await readRenderedRows()
    expect(rows.length, `行数与 get_profiles 不一致（后端 ${profiles.length}）`).toBe(profiles.length)
    // 行序即后端顺序：逐行 id 必须一一对应
    expect(rows.map(row => row.id)).toEqual(profiles.map(profile => profile.id))

    for (const row of rows)
      expect(row.name, `档案名称为空：${row.id}`).not.toBe('')

    const withDefaultDesc = rows.filter(row => row.defaultDesc)
    expect(withDefaultDesc.length, '带默认说明的行不唯一').toBe(1)
    expect(withDefaultDesc[0].id).toBe(profiles.find(profile => profile.default)?.id)
  })

  it('TC-DSK-L3-03-002 验证「新建档案」聚焦输入框、创建成功后列表刷新', async () => {
    await openConfigTab(browser, 'profiles')

    const id = `e2e-profile-${Date.now()}`
    await createProfileViaUi(id)

    const row = (await readRenderedRows()).find(item => item.id === id)
    if (!row)
      throw new Error(`列表未渲染新建档案：${id}`)
    expect(row.name, '新建档案的展示名为空').not.toBe('')

    // 输入区回到收起态（触发入口重新渲染，内联输入框卸载）
    await browser.waitUntil(async () => !(await (await browser.$(PROFILE_NEW_INPUT)).isExisting()), {
      timeout: 10_000,
      timeoutMsg: '新建输入区未收起',
    })

    // 后端与 UI 一致
    expect((await getProfiles()).map(profile => profile.id)).toContain(id)
  })

  it('TC-DSK-L3-03-004 验证切换档案前出现警告确认框，取消后活动档案不变', async () => {
    await openConfigTab(browser, 'profiles')

    // 目标档案由本用例自建：不依赖上一条用例的产物，也不碰 web/tauri/safe
    const target = `e2e-activate-${Date.now()}`
    await createProfileViaUi(target)

    const activeBefore = (await getProfiles()).find(profile => profile.active)?.id
    expect(activeBefore, '当前没有活动档案').toBeTruthy()
    expect(activeBefore, '新建档案不应成为活动档案').not.toBe(target)

    await clickRowName(target)

    await browser.waitUntil(async () => await (await browser.$(MODAL_DIALOG)).isExisting(), {
      timeout: 10_000,
      timeoutMsg: '点击非活动档案后未出现切换确认框',
    })
    const dialog = await browser.$(MODAL_DIALOG)
    expect(
      await dialog.getAttribute(MODAL_STATUS_ATTR),
      '切换确认框不是警告语义',
    ).toBe('warning')

    await clickWhenReady(browser, MODAL_CANCEL)
    await browser.waitUntil(async () => !(await (await browser.$(MODAL_DIALOG)).isExisting()), {
      timeout: 10_000,
      timeoutMsg: '确认框取消后未离场',
    })

    expect((await getProfiles()).find(profile => profile.active)?.id, '取消后活动档案被改动了').toBe(activeBefore)
  })

  it('TC-DSK-L3-03-005 验证档案名规范化与磁盘目录名一致', async () => {
    const samples = [
      { name: 'My Work Space', id: 'my-work-space' },
      { name: '  dev--stage  ', id: 'dev-stage' },
      { name: 'a_b-c', id: 'a-b-c' },
    ]

    for (const sample of samples) {
      const created = await invoke<ProfileRow>('create_profile', { name: sample.name })
      expect(created.id, `规范化结果不符：${JSON.stringify(sample.name)}`).toBe(sample.id)
      expect(existsSync(join(profilesRoot(), sample.id)), `档案目录未创建：${sample.id}`).toBe(true)
      expect((await getProfiles()).map(profile => profile.id)).toContain(sample.id)
    }

    // 复查磁盘上的目录名：与规范化 id 逐一对齐（不是原始输入名）
    const dirs = readdirSync(profilesRoot())
    for (const sample of samples) {
      expect(dirs, `profiles/ 下缺少目录：${sample.id}`).toContain(sample.id)
      expect(dirs, `profiles/ 下出现了未规范化的目录：${sample.name}`).not.toContain(sample.name)
    }
  })

  it('TC-DSK-L3-03-011 验证新建档案的初始化文件与内容', async () => {
    const id = 'init-check'
    const dir = join(profilesRoot(), id)

    await invoke<ProfileRow>('create_profile', { name: id })
    expect(existsSync(dir)).toBe(true)

    // 目录下恰含 4 个文件（未安装任何插件）
    expect(readdirSync(dir).sort()).toEqual([...PROFILE_INIT_FILES].sort())

    const manifest = readJson<ProfileManifest>(join(dir, 'package.json'))
    expect(manifest.name).toBe('dsh-profile-init-check')
    expect(manifest.private).toBe(true)
    expect(manifest.dependencies, '新档案不应带依赖').toEqual({})
    expect(manifest.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])

    // 补丁层：3 行注释 + 空数组
    const patchLines = readText(join(dir, 'cordis.patch.yml')).trimEnd().split('\n')
    expect(patchLines).toHaveLength(4)
    expect(patchLines.slice(0, 3).every(line => line.startsWith('#'))).toBe(true)
    expect(patchLines[3]).toBe('[]')

    const workspace = readText(join(dir, 'pnpm-workspace.yaml'))
    expect(workspace).toContain('packages:')
    expect(workspace).toContain('nodeLinker: hoisted')
    expect(workspace).toContain('autoInstallPeers: false')
    expect(workspace).toContain('minimumReleaseAgeExclude:')
    expect(workspace).toContain('zod@4.4.3')

    expect(readText(join(dir, '.npmrc'))).toContain('confirmModulesPurge=false')
  })

  it('TC-DSK-L3-03-014 验证档案间依赖与插件操作解析目录互相隔离', async () => {
    const isoA = 'iso-a'
    const isoB = 'iso-b'
    const dirA = join(profilesRoot(), isoA)
    const dirB = join(profilesRoot(), isoB)

    // 1. 两个档案
    await invoke<ProfileRow>('create_profile', { name: isoA })
    await invoke<ProfileRow>('create_profile', { name: isoB })
    expect(existsSync(dirA), 'iso-a 未创建').toBe(true)
    expect(existsSync(dirB), 'iso-b 未创建').toBe(true)

    // 2. 在 iso-a 下真实安装一个插件（会停服 → 跑 dsh plugin --profile iso-a add）
    await invoke<ProfileRow>('set_active_profile', { id: isoA })
    await invoke<void>('install_preinstall_plugins', { installIds: [ISOLATION_PLUGIN], uninstallIds: [] })

    const manifestA = readJson<ProfileManifest>(join(dirA, 'package.json'))
    const manifestB = readJson<ProfileManifest>(join(dirB, 'package.json'))
    expect(Object.keys(manifestA.dependencies ?? {}), 'iso-a 未落依赖条目').toContain(ISOLATION_PLUGIN)
    expect(existsSync(join(dirA, 'node_modules', ISOLATION_PLUGIN)), 'iso-a 未落安装产物').toBe(true)
    expect(Object.keys(manifestB.dependencies ?? {}), 'iso-b 被写入了依赖').not.toContain(ISOLATION_PLUGIN)
    expect(existsSync(join(dirB, 'node_modules')), 'iso-b 出现了 node_modules').toBe(false)

    // 3. 插件操作的解析目录由 active_profile 决定：`get_preinstall_plugins` 读的是
    //    `profile_dir_of(active_profile)`（src-tauri/src/service/plugin/installed.rs:37），
    //    因此同一次调用在两个活动档案下给出不同的「已安装」判定。
    expect(await preinstallInstalled(ISOLATION_PLUGIN), 'iso-a 活动时应判定为已安装').toBe(true)
    await invoke<ProfileRow>('set_active_profile', { id: isoB })
    expect(await preinstallInstalled(ISOLATION_PLUGIN), 'iso-b 活动时不应看到 iso-a 的依赖').toBe(false)
    // 只是解析目标变了，iso-a 的产物必须原样保留
    expect(existsSync(join(dirA, 'node_modules', ISOLATION_PLUGIN))).toBe(true)
    await invoke<ProfileRow>('set_active_profile', { id: isoA })
    expect(await preinstallInstalled(ISOLATION_PLUGIN), '切回 iso-a 后应重新可见').toBe(true)
  }, 900_000)
})
