import { NextResponse } from 'next/server';

import { WorkspaceService } from '@kodeks/workspace';

import { resolveWorkspaceRoot } from '@/lib/server/kodeks-runtime';

export const runtime = 'nodejs';

const MAX_WORKSPACE_FILES = 500;

// 列出当前授权 workspace 的可见文件，供前端文件选择器使用。
export async function GET(): Promise<NextResponse> {
  const workspace = new WorkspaceService(resolveWorkspaceRoot());
  const files = await workspace.listFiles({ limit: MAX_WORKSPACE_FILES });
  return NextResponse.json({ files });
}
