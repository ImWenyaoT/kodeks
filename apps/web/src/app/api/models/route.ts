import { listConfiguredModelCatalog } from '@/lib/server/kodeks-runtime';

// Next.js API routes 需要 Node runtime 来读取 repo 外的用户配置文件。
export const runtime = 'nodejs';

// 返回用户配置中的 provider/model 清单；不暴露 apiKey 等 secret。
export async function GET(): Promise<Response> {
  return Response.json(listConfiguredModelCatalog());
}
