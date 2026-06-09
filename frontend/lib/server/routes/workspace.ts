// frontend/lib/server/routes/workspace.ts
// Workspace 路由逻辑（移植 workspace_routes.py）：列举可见文件。
// limit=500 逐字（保真红线 6）。
import { NextResponse } from 'next/server'
import { WorkspaceService } from '../workspace'

/**
 * 列出工作区可见文件（移植 workspace_files，workspace_routes.py:18-24）。
 * @returns 200 `{files: WorkspaceService(workspaceRoot).listFiles(500)}`。
 */
export function filesList(workspaceRoot: string): NextResponse {
  return NextResponse.json({
    files: new WorkspaceService(workspaceRoot).listFiles(500),
  })
}
