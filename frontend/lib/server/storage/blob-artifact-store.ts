// frontend/lib/server/storage/blob-artifact-store.ts
// Vercel Blob artifact 落盘后端（M6 云端）：实现与 LocalFileArtifactStore 完全相同的 ArtifactStore 接口，
// 透明替换本地文件后端。唯一差别——filePath 字段语义从「本地绝对路径」变为「blob 公网 URL」。
// 上层 compactToolResult 的内容模板 / refId / byteLength / 紧凑 JSON / message 常量一律不动，本类只换存储介质。
//
// 红线（见 M6 任务书）：
//  · write(refId, content) → put(`memory-artifacts/${refId}.md`, content, {access:'public', token, contentType:'text/markdown'})，返回 blob URL。
//  · read(filePath) → filePath 是 http(s) blob URL 时 fetch 取文本；404/失败返回 null。
//  · 接口/返回形状与 local 版逐字一致（Promise<string> / Promise<string|null>）。
// @vercel/blob v2.4.0：put(pathname, body, {access:'public'|'private', token?, contentType?}) → {url, downloadUrl, pathname, contentType}。
import { put } from '@vercel/blob'
import type { ArtifactStore } from './artifact-store'

/**
 * 判断一个 artifact filePath 是否为 http(s) blob URL（纯函数，便于单测）。
 * BlobArtifactStore.read 据此决定是 fetch 远端还是判为不可读。
 * @param filePath memory_artifacts.file_path 中存的句柄（blob URL 或本地路径）。
 * @returns 以 http:// 或 https:// 开头时为真。
 */
export function isBlobUrl(filePath: string): boolean {
  return /^https?:\/\//i.test(filePath)
}

/**
 * 由 refId 推出 blob 对象的 pathname（纯函数，便于单测）。
 * 与本地后端的 `<refId>.md` 命名对齐，置于 `memory-artifacts/` 前缀下。
 * @param refId compactToolResult 算出的 ref id（如 memref_<hash16>）。
 * @returns blob 对象路径，形如 `memory-artifacts/memref_xxxx.md`。
 */
export function blobPathnameForRef(refId: string): string {
  return `memory-artifacts/${refId}.md`
}

/**
 * Vercel Blob artifact 后端（M6 生产）：把内存 artifact 正文存进 Vercel Blob，
 * file_path 存其公网 URL；读取时 fetch 该 URL 取回文本。
 * 仅在 BLOB_READ_WRITE_TOKEN 存在时由 deps.ts 选用；本地默认仍是 LocalFileArtifactStore。
 */
export class BlobArtifactStore implements ArtifactStore {
  private readonly token: string

  /**
   * @param token Vercel Blob 读写 token（来自 BLOB_READ_WRITE_TOKEN）；put/head 鉴权用。
   *   显式传入以便与 deps.ts 的后端选择逻辑解耦，也便于（在有 token 时）独立测试。
   */
  constructor(token: string) {
    this.token = token
  }

  /**
   * 把 artifact 正文写入 Vercel Blob，返回其公网 URL 作为持久化句柄（落入 memory_artifacts.file_path）。
   * 对应本地后端写 `<refId>.md` 并返回绝对路径；此处写 `memory-artifacts/<refId>.md` 并返回 blob URL。
   * access:'public' 保证 read 阶段可直接 fetch；contentType 固定 text/markdown（正文是 .md 模板）。
   * @param refId compactToolResult 算出的 ref id。
   * @param content 逐字模板正文（上层已拼好，本类不改）。
   * @returns 写入后的 blob 公网 URL。
   */
  async write(refId: string, content: string): Promise<string> {
    const result = await put(blobPathnameForRef(refId), content, {
      access: 'public',
      token: this.token,
      contentType: 'text/markdown',
      // 句柄即 file_path：同名覆盖（同一 refId 内容哈希一致），避免随机后缀导致 URL 漂移。
      allowOverwrite: true,
    })
    return result.url
  }

  /**
   * 按句柄读回 artifact 正文；句柄不是 blob URL 或远端取不到（404/网络失败）时返回 null。
   * 对应本地后端 `if not file_path.is_file(): return None` 的语义——读不到即 null，绝不抛。
   * @param filePath memory_artifacts.file_path 中存的句柄（应为 write 返回的 blob URL）。
   * @returns 正文文本；不可读返回 null。
   */
  async read(filePath: string): Promise<string | null> {
    // 非 http(s) 句柄（理论上 blob 后端写入的恒为 URL）直接判不可读，保持 read 永不抛。
    if (!isBlobUrl(filePath)) {
      return null
    }
    try {
      const response = await fetch(filePath)
      if (!response.ok) {
        return null
      }
      return await response.text()
    } catch {
      // 网络异常/中断一律按「读不到」处理（与本地 stat 失败返回 null 对齐）。
      return null
    }
  }
}
