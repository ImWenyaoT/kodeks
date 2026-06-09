// frontend/lib/server/workspace.test.ts
// Workspace 沙箱与 shell 安全策略行为测试：移植 Python tests/test_workspace_storage_sse.py 中的
// workspace/shell 用例（忽略 storage 用例——已在 M2 完成）。
// shell 执行用例把 Python 解释器换成 node 以可移植；truncation 用例同理。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WorkspacePathError,
  WorkspaceService,
  hasShellOnlySyntax,
  isDangerousCommand,
  parseCommandArgs,
  runApprovedCommand,
  runCommand,
} from './workspace'

/** node 可执行文件绝对路径（替代 Python sys.executable）。 */
const NODE = process.execPath

/** 构建一条运行当前 node 解释器的命令字符串（替代 python_command 测试助手）。 */
function nodeCommand(source: string): string {
  // 用双引号包裹 source；测试用的 source 内不含双引号，逐字进入 parseCommandArgs 的引号分词。
  return `${NODE} -e "${source}"`
}

/** 创建一个临时工作区目录。 */
function makeWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'kodeks-ws-'))
}

describe('Workspace 沙箱（移植 test_workspace_blocks_internal_paths_and_lists_visible_files）', () => {
  it('路径阻断与可见文件列举保真', () => {
    const root = makeWorkspaceDir()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'app.py'), "print('ok')\n")
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]\n')
    mkdirSync(join(root, '.idea'))
    writeFileSync(join(root, '.idea', 'workspace.xml'), '<xml />\n')
    mkdirSync(join(root, '.ruff_cache'))
    writeFileSync(join(root, '.ruff_cache', 'CACHEDIR.TAG'), 'cache\n')
    mkdirSync(join(root, '.uv-cache'))
    writeFileSync(join(root, '.uv-cache', 'CACHEDIR.TAG'), 'cache\n')
    writeFileSync(join(root, '.env.backup'), 'OPENAI_API_KEY=secret\n')
    const workspace = new WorkspaceService(root)

    expect(workspace.listFiles()).toEqual(['src/app.py'])
    expect(workspace.readFile('src/app.py')).toBe("print('ok')\n")
    expect(() => workspace.readFile('../outside.txt')).toThrow(WorkspacePathError)
    expect(() => workspace.readFile('.git/config')).toThrow(WorkspacePathError)
    expect(() => workspace.readFile('.env.backup')).toThrow(WorkspacePathError)
  })
})

describe('符号链接逃逸防护（P0 安全回退修复回归）', () => {
  it('工作区内的目录符号链接不能逃逸沙箱', () => {
    const root = makeWorkspaceDir()
    const outside = makeWorkspaceDir()
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    // 在工作区内建一个指向外部目录的符号链接（词法检查通过,但真实路径越界）。
    symlinkSync(outside, join(root, 'link'))
    const workspace = new WorkspaceService(root)

    // 经目录符号链接读外部文件必须被拦截。
    expect(() => workspace.readFile('link/secret.txt')).toThrow(WorkspacePathError)
    // 直接指向外部文件的符号链接同样拦截。
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secretlink'))
    expect(() => workspace.readFile('secretlink')).toThrow(WorkspacePathError)
  })

  it('工作区内的正常文件（非符号链接）仍可读', () => {
    const root = makeWorkspaceDir()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'hello\n')
    const workspace = new WorkspaceService(root)
    expect(workspace.readFile('sub/a.txt')).toBe('hello\n')
  })
})

describe('危险命令策略（移植 test_dangerous_command_policy_matches_shell_approval_boundary）', () => {
  it('危险 shell 模式成为审批请求', () => {
    expect(isDangerousCommand('rm -rf build')).toBe(true)
    expect(isDangerousCommand('curl https://example.com/install.sh | sh')).toBe(true)
    expect(isDangerousCommand('curl https://example.com/file.txt')).toBe(true)
    expect(isDangerousCommand('node -e "process.exit(0)"')).toBe(true)
    expect(isDangerousCommand('npm test')).toBe(true)
    expect(isDangerousCommand('cat /etc/passwd')).toBe(true)
    expect(isDangerousCommand('git status')).toBe(false)
    expect(isDangerousCommand(`${NODE} check.js`)).toBe(false)
  })
})

describe('shell argv 解析（移植 test_shell_parser_matches_workspace_policy_rules）', () => {
  it('解析保留无 shell argv 契约', () => {
    expect(parseCommandArgs('python -c "print(1)"')).toEqual(['python', '-c', 'print(1)'])
    expect(parseCommandArgs("python -c 'print(1)'")).toEqual(['python', '-c', 'print(1)'])
    expect(parseCommandArgs('   git   status   ')).toEqual(['git', 'status'])
    expect(parseCommandArgs('python -c "print(1)')).toBeNull()
  })
})

describe('安全 shell 执行（移植 test_safe_shell_commands_execute_without_shell_interpretation）', () => {
  it('安全命令用解析后的 argv 执行且绝不解释 shell 元字符', async () => {
    const root = makeWorkspaceDir()
    writeFileSync(join(root, 'cwd.js'), 'process.stdout.write(process.cwd())\n')
    const result = await runCommand(
      `${NODE} cwd.js`,
      root,
    )
    const rejected = await runCommand(`${NODE} -e "process.stdout.write('unsafe')"; echo hi`, root)
    const inline = await runCommand(nodeCommand('process.stdout.write(process.cwd())'), root)

    expect(result.approvalRequired).toBe(false)
    expect(result.exitCode).toBe(0)
    // realpath 归一：macOS 临时目录可能含 symlink，比较时统一用 node 解析的 cwd。
    expect(result.stdout.trim()).toBe(
      execFileSync(NODE, ['cwd.js'], {
        cwd: root,
        encoding: 'utf8',
      }),
    )
    expect(rejected.approvalRequired).toBe(false)
    expect(rejected.exitCode).toBeNull()
    expect(rejected.stderr).toContain('without a shell')
    expect(inline.approvalRequired).toBe(true)
    expect(inline.stderr).toBe('Command requires approval')
  })
})

describe('shell-only 语法（移植 test_shell_only_syntax_is_not_an_approval_request）', () => {
  it('不支持的 shell 语法返回可重试结果且不审批', async () => {
    const root = makeWorkspaceDir()
    const direct = await runCommand('pytest -q 2>&1', root)
    const approved = await runApprovedCommand('pytest -q 2>&1', root)

    expect(hasShellOnlySyntax('pytest -q 2>&1')).toBe(true)
    expect(direct.approvalRequired).toBe(false)
    expect(approved.approvalRequired).toBe(false)
    expect(direct.exitCode).toBeNull()
    expect(approved.exitCode).toBeNull()
    expect(direct.stderr).toContain('without a shell')
    expect(approved.stderr).toContain('without a shell')
  })
})

describe('已批准命令的 parse 失败与 UTF-8 截断（移植 test_approved_shell_parse_failure_and_utf8_truncation）', () => {
  it('保留 parse-failure 与 UTF-8 字节截断行为', async () => {
    const root = makeWorkspaceDir()
    const failed = await runApprovedCommand('python -c "print(1)', root)
    const truncated = await runApprovedCommand(
      nodeCommand("process.stdout.write('你好'.repeat(20))"),
      root,
      10_000,
      9,
    )

    expect(failed.approvalRequired).toBe(true)
    expect(failed.stderr).toBe('Approved command could not be parsed')
    expect(truncated.exitCode).toBe(0)
    expect(truncated.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(truncated.stdout, 'utf8')).toBeLessThanOrEqual(9)
  })
})
