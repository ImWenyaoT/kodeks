"use client";

// frontend/components/workspace/FilePicker.tsx
// 工作区文件选择器（Task 4.5）。把本地 workspace 文件作为会话上下文挑选进 store。
// 交互流程：
//   1. 点击「选择文件」切换按钮 → 首次展开时懒加载 getWorkspaceFiles()，结果缓存在
//      组件 state 中（再次开合不重新请求）；
//   2. 搜索框对文件列表做不区分大小写的子串过滤，最多展示前 MAX_RESULTS 条；
//   3. 每个结果行是一个真实的原生 <input type="checkbox">，选中态由全局 store 的
//      selectedFiles.has(path) 驱动，onChange → toggleFile(path)；
//   4. 顶部摘要行展示已选数量（t.noFilesSelected / t.selectedFileCount(n)）。
//
// 无障碍（Apple HIG）：
//   - 文件行用 <label> 包裹原生 checkbox + 文件名 —— 原生 checkbox 天然带正确的
//     role 与 checked 状态，屏幕阅读器无需额外 ARIA；选中不只靠颜色（语义 checked）。
//   - 每行 <label> 高度 ≥ 44px（min-h-11）为合格触控目标；文件名 truncate 截断，
//     完整路径放入 title 便于悬停查看。
//   - 搜索框高度 h-11（44px），以 t.filePlaceholder 作为 aria-label，并保留可见焦点环。
//   - 「选择文件」切换按钮带 aria-expanded 反映开合，本身高度 h-11（44px）。

import { useCallback, useId, useState } from "react";
import { FolderSearch, Loader2 } from "lucide-react";

import { useI18n } from "@/components/providers/I18nProvider";
import { useChatStore } from "@/stores/chat-store";
import { getWorkspaceFiles } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 过滤后最多展示的结果行数（防止超大 workspace 撑爆列表 / DOM）。 */
const MAX_RESULTS = 80;

/**
 * 单个文件结果行。整行是一个 <label>，内含原生 checkbox 与文件名文本。
 * 原生 checkbox 让辅助技术免费获得正确的 role + checked 语义。
 * @param path     文件相对路径（同时作为无障碍名与 title 全量展示）。
 * @param checked  当前是否已选中（来自 store.selectedFiles）。
 * @param onToggle 切换回调（→ store.toggleFile）。
 */
function FileRow({
  path,
  checked,
  onToggle,
}: {
  path: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      title={path}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5",
        "transition-colors",
        "hover:bg-muted",
        // 键盘焦点落在内部 checkbox 上时，整行给出可见焦点环（不仅靠颜色）。
        "focus-within:ring-3 focus-within:ring-ring/50",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        // 原生 checkbox：用 accent-color 上色，保留默认对勾（选中态是语义信号，非仅颜色）。
        className="size-4 shrink-0 rounded accent-primary outline-none"
      />
      <span className="min-w-0 flex-1 truncate text-sm">{path}</span>
    </label>
  );
}

/**
 * 文件选择器主组件。
 * 自管「展开/收起」「懒加载状态（未取 / 加载中 / 已缓存 / 出错）」「搜索关键字」，
 * 并把选中态读写委托给全局 chat store。
 */
export function FilePicker() {
  const { t } = useI18n();
  // store：选中集合（订阅以反映 checked 态）与切换动作。
  const selectedFiles = useChatStore((s) => s.selectedFiles);
  const toggleFile = useChatStore((s) => s.toggleFile);

  // 展开状态：控制 picker 卡片的显隐与 aria-expanded。
  const [open, setOpen] = useState(false);
  // 懒加载缓存：null 表示尚未取过；数组（含空数组）表示已取并缓存，不再重复请求。
  const [files, setFiles] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // 搜索关键字（受控）。
  const [query, setQuery] = useState("");

  // picker 卡片的 id：供切换按钮 aria-controls 关联（增强无障碍上下文）。
  const panelId = useId();

  /**
   * 首次展开时懒加载文件列表并缓存。
   * 仅当 files 仍为 null（从未成功取过）时才发起请求；缓存命中后开合不再触发网络。
   */
  const ensureFiles = useCallback(async () => {
    if (files !== null) return;
    setLoading(true);
    setError(false);
    try {
      const list = await getWorkspaceFiles();
      setFiles(list);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [files]);

  /**
   * 切换 picker 开合。展开时触发懒加载（ensureFiles 内部自带缓存判断）。
   */
  const handleToggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) void ensureFiles();
      return next;
    });
  }, [ensureFiles]);

  // 不区分大小写的子串过滤；空关键字时返回全部。再截断到 MAX_RESULTS 条。
  const normalized = query.trim().toLowerCase();
  const filtered = (files ?? [])
    .filter((f) => normalized === "" || f.toLowerCase().includes(normalized))
    .slice(0, MAX_RESULTS);

  // 摘要文案：未选 → noFilesSelected；否则 → selectedFileCount(n)。
  const count = selectedFiles.size;
  const summary = count === 0 ? t.noFilesSelected : t.selectedFileCount(count);

  return (
    <div className="flex flex-col gap-2">
      {/* 切换按钮：可见文字已命名按钮；aria-expanded 反映开合；h-11 满足触控目标。 */}
      <Button
        type="button"
        variant="outline"
        onClick={handleToggleOpen}
        aria-expanded={open}
        aria-controls={panelId}
        className="h-11 w-full justify-start gap-2 rounded-xl"
      >
        <FolderSearch className="size-4" aria-hidden="true" />
        {t.selectFiles}
      </Button>

      {/* 摘要行：始终可见，让用户在折叠态也能看到当前已选数量。 */}
      <p className="px-1 text-xs text-muted-foreground">{summary}</p>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card/50 p-2"
        >
          {/* 搜索框：h-11（44px）触控目标；以 placeholder 文案作 aria-label；可见焦点。 */}
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.filePlaceholder}
            aria-label={t.filePlaceholder}
            className="h-11 rounded-lg"
          />

          {loading ? (
            // 加载中：图标 + 文案，非交互。
            <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t.fileDescription}
            </p>
          ) : error ? (
            // 出错：以 role="alert" 即时播报，复用 noFileMatches 作兜底文案。
            <p role="alert" className="px-1 py-2 text-sm text-destructive">
              {t.noFileMatches}
            </p>
          ) : filtered.length === 0 ? (
            // 空 / 无匹配：统一空状态文案。
            <p className="px-1 py-2 text-sm text-muted-foreground">
              {t.noFileMatches}
            </p>
          ) : (
            // 结果列表：每行一个原生 checkbox label，最多 MAX_RESULTS 条。
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {filtered.map((path) => (
                <li key={path}>
                  <FileRow
                    path={path}
                    checked={selectedFiles.has(path)}
                    onToggle={() => toggleFile(path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
