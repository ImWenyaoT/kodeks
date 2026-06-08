// frontend/lib/server/storage/artifact-store.ts
// 内存 artifact 落盘后端抽象。M2 仅实现本地文件后端（LocalFileArtifactStore），
// 逐字节复刻 Python memory.py 的 `<workspaceRoot>/.kodeks/memory-artifacts/<refId>.md` 落盘。
// Vercel Blob 后端是 M6 —— 此处只为它留好接口（write 返回 filePath/key，read 按 filePath 取回）。
//
// 保真红线（见 40-storage.md §6、开放问题 1）：
//  · 本地后端写 `<workspaceRoot>/.kodeks/memory-artifacts/<refId>.md`，filePath 为绝对路径字符串。
//  · read 在文件不存在时返回 null（对应 Python `if not file_path.is_file(): return None`）。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * artifact 存储后端接口。M6 的 Vercel Blob 后端实现同一接口即可替换：
 *  · write(refId, content) → 返回持久化句柄（本地为绝对路径，Blob 为 URL/key），写入 memory_artifacts.file_path。
 *  · read(filePath) → 按句柄取回内容；不存在时返回 null。
 */
export interface ArtifactStore {
  /** 写入一个 artifact 内容，返回其持久化句柄（落入 memory_artifacts.file_path）。 */
  write(refId: string, content: string): Promise<string>
  /** 按持久化句柄读回内容；不存在返回 null。 */
  read(filePath: string): Promise<string | null>
}

/**
 * 本地文件 artifact 后端（M2 默认）。
 * 写入 `<workspaceRoot>/.kodeks/memory-artifacts/<refId>.md`，返回绝对路径字符串。
 * 与 Python memory.py:138-161 的落盘目录/文件名/路径语义一致。
 */
export class LocalFileArtifactStore implements ArtifactStore {
  private readonly workspaceRoot: string

  /** @param workspaceRoot 工作区根目录（artifact 落盘相对此目录）。 */
  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  /**
   * 写入 `<workspaceRoot>/.kodeks/memory-artifacts/<refId>.md` 并返回绝对路径。
   * 先确保目录存在（对应 Python `artifact_dir.mkdir(parents=True, exist_ok=True)`）。
   */
  async write(refId: string, content: string): Promise<string> {
    const artifactDir = join(this.workspaceRoot, '.kodeks', 'memory-artifacts')
    await mkdir(artifactDir, { recursive: true })
    const filePath = join(artifactDir, `${refId}.md`)
    await writeFile(filePath, content, 'utf8')
    return filePath
  }

  /**
   * 按绝对路径读回内容；路径不是文件时返回 null。
   * 对应 Python `read_artifact_content` 的 `if not file_path.is_file(): return None` + `file_path.read_text()`。
   */
  async read(filePath: string): Promise<string | null> {
    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) {
        return null
      }
    } catch {
      return null
    }
    return readFile(filePath, 'utf8')
  }
}
