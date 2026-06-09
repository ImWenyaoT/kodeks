// frontend/lib/server/config.test.ts
// 配置与模型解析层保真测试：逐用例移植自 Python tests/test_config.py。
//  · 全部 test_config.py 用例（含 1 个 4 参数化）一一对应,期望值取自 Python 断言。
//  · tmp 目录用 Node fs/os 临时目录复刻 pytest tmp_path;假 home 用 setHomeResolverForTesting 复刻 monkeypatch Path.home。
// 门禁:这些用例全过 = 与 Python 行为完全一致。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_DEEPSEEK_MODEL,
  ModelConfigurationError,
  loadConfiguredModelCatalog,
  loadModelRuntimeEnv,
  resolveKodeksConfigPath,
  resolveModelClientOptions,
  setHomeResolverForTesting,
} from './config'

/** 每个用例独立的临时根目录(复刻 pytest tmp_path)。 */
let tmpRoot: string

/** 在测试临时目录下创建一个唯一 tmp 根(复刻 pytest tmp_path 隔离)。 */
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kodeks-config-'))
})

/** 清理临时目录,避免泄漏到下个用例。 */
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 写入 JSON 文件(自动创建父目录),复刻 Python config_path.write_text(json.dumps(...))。 */
function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), 'utf-8')
}

describe('test_config.py 移植', () => {
  it('test_model_catalog_only_exposes_deepseek: 目录仅保留 DeepSeek(含内置默认)', () => {
    const configPath = join(tmpRoot, 'config.json')
    writeJson(configPath, {
      model: {
        primary: 'qwen/qwen3.6',
        providers: {
          qwen: {
            api: 'chat-completions',
            baseURL: 'http://127.0.0.1:8010/v1',
            apiKey: 'local-placeholder',
            models: [{ id: 'qwen3.6', name: 'Qwen 3.6' }],
          },
          deepseek: {
            api: 'chat-completions',
            baseURL: 'https://api.deepseek.com',
            apiKey: 'deepseek-placeholder',
            models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
          },
        },
      },
    })

    const catalog = loadConfiguredModelCatalog({ KODEKS_CONFIG_PATH: configPath })

    expect(catalog.primary).toBe(`deepseek/${DEFAULT_DEEPSEEK_MODEL}`)
    expect(catalog.models.map((model) => model.ref)).toEqual([
      `deepseek/${DEFAULT_DEEPSEEK_MODEL}`,
      'deepseek/deepseek-v4-flash',
    ])
    expect(catalog.models[0].requiresBridge).toBe(true)
  })

  it('test_config_expands_env_and_deepseek_provider: 配置把 DeepSeek provider ref 映射到 env 契约', () => {
    const configPath = join(tmpRoot, 'config.json')
    writeJson(configPath, {
      model: {
        primary: 'deepseek/deepseek-v4-pro',
        providers: {
          deepseek: {
            api: 'chat-completions',
            baseURL: '${DEEPSEEK_BASE_URL}',
            apiKey: 'deepseek-placeholder',
            models: [{ id: 'deepseek-v4-pro' }],
          },
        },
      },
    })

    const env = loadModelRuntimeEnv(
      {
        KODEKS_CONFIG_PATH: configPath,
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      },
      'deepseek/deepseek-v4-pro',
    )

    expect(env.KODEKS_MODEL_PROVIDER).toBe('moonbridge')
    expect(env.KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe('https://api.deepseek.com')
    expect(env.KODEKS_CHAT_COMPLETIONS_MODEL).toBe('deepseek-v4-pro')
  })

  it('test_requested_deepseek_model_ref_selects_upstream_model: 请求 ref 选定上游模型', () => {
    const env = loadModelRuntimeEnv(
      { DEEPSEEK_API_KEY: 'deepseek-placeholder' },
      'deepseek/deepseek-v4-flash',
    )

    expect(env.KODEKS_MODEL_PROVIDER).toBe('moonbridge')
    expect(env.KODEKS_CHAT_COMPLETIONS_MODEL).toBe('deepseek-v4-flash')
  })

  it('test_workspace_dotenv_configures_runtime_env: workspace .env 配置基本 env 契约', () => {
    const workspace = join(tmpRoot, 'workspace')
    mkdirSync(workspace)
    writeFileSync(
      join(workspace, '.env'),
      [
        '# local development secrets',
        'export DEEPSEEK_API_KEY=dotenv-placeholder',
        'DEEPSEEK_BASE_URL="https://dotenv.example.com"',
        'DEEPSEEK_MODEL=dotenv-model # inline comment',
      ].join('\n'),
      'utf-8',
    )

    const env = loadModelRuntimeEnv({ KODEKS_WORKSPACE_ROOT: workspace })

    expect(env.KODEKS_CHAT_COMPLETIONS_API_KEY).toBe('dotenv-placeholder')
    expect(env.KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe('https://dotenv.example.com')
    expect(env.KODEKS_CHAT_COMPLETIONS_MODEL).toBe('dotenv-model')
  })

  it('test_simple_model_env_aliases_configure_runtime_env: 友好别名映射到 canonical 名', () => {
    const env = loadModelRuntimeEnv({
      API_KEY: 'generic-placeholder',
      BASE_URL: 'https://generic.example.com',
      MODEL: 'generic-model',
    })

    expect(env.KODEKS_CHAT_COMPLETIONS_API_KEY).toBe('generic-placeholder')
    expect(env.KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe('https://generic.example.com')
    expect(env.KODEKS_CHAT_COMPLETIONS_MODEL).toBe('generic-model')
    expect(resolveModelClientOptions(env)).toEqual({
      provider: 'moonbridge',
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'bridge',
      reasoningEffort: 'high',
    })
  })

  it('test_canonical_model_env_overrides_aliases: canonical 名胜过别名', () => {
    const env = loadModelRuntimeEnv({
      API_KEY: 'alias-placeholder',
      KODEKS_CHAT_COMPLETIONS_API_KEY: 'canonical-placeholder',
    })

    expect(env.KODEKS_CHAT_COMPLETIONS_API_KEY).toBe('canonical-placeholder')
  })

  it('test_process_env_overrides_workspace_dotenv: 显式 env 胜过 .env', () => {
    const workspace = join(tmpRoot, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, '.env'), 'DEEPSEEK_API_KEY=dotenv-placeholder\n', 'utf-8')

    const env = loadModelRuntimeEnv({
      KODEKS_WORKSPACE_ROOT: workspace,
      API_KEY: 'process-placeholder',
    })

    expect(env.KODEKS_CHAT_COMPLETIONS_API_KEY).toBe('process-placeholder')
  })

  it('test_dotenv_values_expand_json_config_vars: .env 值可用于 JSON 配置插值', () => {
    const workspace = join(tmpRoot, 'workspace')
    const configDir = join(workspace, '.kodeks')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(workspace, '.env'), 'DEEPSEEK_BASE_URL=https://dotenv.example.com\n', 'utf-8')
    writeJson(join(configDir, 'config.json'), {
      model: {
        chatCompletions: {
          apiKey: 'json-placeholder',
          baseURL: '${DEEPSEEK_BASE_URL}',
          model: 'json-model',
        },
      },
    })

    const env = loadModelRuntimeEnv({ KODEKS_WORKSPACE_ROOT: workspace })

    expect(env.KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe('https://dotenv.example.com')
    expect(env.KODEKS_CHAT_COMPLETIONS_MODEL).toBe('json-model')
  })

  it('test_workspace_config_is_discovered_before_user_config: workspace 配置优先于用户配置', () => {
    const workspace = join(tmpRoot, 'workspace')
    const home = join(tmpRoot, 'home')
    const userConfigDir = join(home, '.kodeks')
    const workspaceConfigDir = join(workspace, '.kodeks')
    mkdirSync(userConfigDir, { recursive: true })
    mkdirSync(workspaceConfigDir, { recursive: true })
    // 复刻 Python monkeypatch Path.home → home：用 home seam 注入假 home。
    const restoreHome = setHomeResolverForTesting(() => home)
    try {
      const userConfigPath = join(userConfigDir, 'config.json')
      const workspaceConfigPath = join(workspaceConfigDir, 'config.json')
      writeJson(userConfigPath, {
        model: {
          chatCompletions: {
            apiKey: 'user-placeholder',
            baseURL: 'https://user.example.com',
            model: 'user-model',
          },
        },
      })
      writeJson(workspaceConfigPath, {
        model: {
          chatCompletions: {
            apiKey: 'workspace-placeholder',
            baseURL: 'https://workspace.example.com',
            model: 'workspace-model',
          },
        },
      })

      const autoEnv = { KODEKS_WORKSPACE_ROOT: workspace }
      expect(resolveKodeksConfigPath(autoEnv)).toBe(workspaceConfigPath)
      expect(loadModelRuntimeEnv(autoEnv).KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe(
        'https://workspace.example.com',
      )
    } finally {
      restoreHome()
    }
  })

  it('test_explicit_config_dir_overrides_workspace_config: 显式 config dir 覆盖 workspace', () => {
    const workspace = join(tmpRoot, 'workspace')
    const explicitConfigDir = join(tmpRoot, 'explicit', '.kodeks')
    const workspaceConfigDir = join(workspace, '.kodeks')
    mkdirSync(explicitConfigDir, { recursive: true })
    mkdirSync(workspaceConfigDir, { recursive: true })
    const explicitConfigPath = join(explicitConfigDir, 'config.json')
    const workspaceConfigPath = join(workspaceConfigDir, 'config.json')
    writeJson(explicitConfigPath, {
      model: {
        chatCompletions: {
          apiKey: 'explicit-placeholder',
          baseURL: 'https://explicit.example.com',
          model: 'explicit-model',
        },
      },
    })
    writeJson(workspaceConfigPath, {
      model: {
        chatCompletions: {
          apiKey: 'workspace-placeholder',
          baseURL: 'https://workspace.example.com',
          model: 'workspace-model',
        },
      },
    })

    const env = {
      KODEKS_CONFIG_DIR: explicitConfigDir,
      KODEKS_WORKSPACE_ROOT: workspace,
    }

    expect(resolveKodeksConfigPath(env)).toBe(explicitConfigPath)
    expect(loadModelRuntimeEnv(env).KODEKS_CHAT_COMPLETIONS_BASE_URL).toBe(
      'https://explicit.example.com',
    )
  })

  it('test_config_file_adapter_fields_do_not_enable_model_routing: 旧适配器字段不启用路由', () => {
    const configPath = join(tmpRoot, 'config.json')
    writeJson(configPath, {
      model: {
        provider: 'moonbridge',
        bridge: {
          enabled: true,
          baseURL: 'http://127.0.0.1:38440/v1',
          model: 'bridge',
        },
      },
    })

    const env = loadModelRuntimeEnv({ KODEKS_CONFIG_PATH: configPath })

    expect('KODEKS_MODEL_PROVIDER' in env).toBe(false)
    expect('KODEKS_BRIDGE_ENABLED' in env).toBe(false)
    expect('KODEKS_BRIDGE_BASE_URL' in env).toBe(false)
    expect(resolveModelClientOptions(env)).toBeNull()
  })

  // test_unsupported_aliases_fail_with_supported_config_guidance（4 参数化用例）。
  const unsupportedCases: ReadonlyArray<{ env: Record<string, string>; expected: string }> = [
    {
      env: { KODEKS_BRIDGE_DEEPSEEK_BASE_URL: 'https://old.test/v1' },
      expected: 'KODEKS_BRIDGE_DEEPSEEK_BASE_URL is unsupported',
    },
    {
      env: { MOONBRIDGE_DEEPSEEK_MODEL: 'old-model' },
      expected: 'MOONBRIDGE_DEEPSEEK_MODEL is unsupported',
    },
    { env: { MOONBRIDGE_API_KEY: 'moon-old' }, expected: 'MOONBRIDGE_API_KEY is unsupported' },
    {
      env: { KODEKS_MODEL_PROVIDER: 'deepseek' },
      expected: 'MoonBridge remains an internal adapter',
    },
  ]

  it.each(unsupportedCases)(
    'test_unsupported_aliases_fail_with_supported_config_guidance: %o',
    ({ env, expected }) => {
      let caught: unknown
      try {
        resolveModelClientOptions(env)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ModelConfigurationError)
      expect((caught as ModelConfigurationError).message).toContain(expected)
    },
  )

  it('test_direct_openai_provider_is_outside_product_boundary: 直连 OpenAI/Responses 在产品边界外', () => {
    let caught: unknown
    try {
      resolveModelClientOptions({ KODEKS_MODEL_PROVIDER: 'openai' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ModelConfigurationError)
    expect((caught as ModelConfigurationError).message).toContain(
      'outside the Kodeks product boundary',
    )
  })
})
