'use client';

import React, { useEffect, useMemo, useState } from 'react';

import { MaterialIcon } from '@/components/material-icon';
import type { UiCopy } from '@/lib/ui-copy';

type WorkspacePanelProps = {
  collapsed: boolean;
  copy: UiCopy['tools'];
  currentSessionId: string;
  selectedFiles: string[];
  onCollapseToggle: () => void;
  onNewSession: () => void;
  onSelectedFilesChange: (files: string[]) => void;
  onSessionSelect: (sessionId: string) => void;
};

type WorkspaceFilesResponse = {
  files?: unknown;
};

type SessionSummary = {
  id: string;
  title: string;
  mode: 'act' | 'plan';
  updatedAt: string;
  activePlan?: { title?: string } | null;
};

type SessionsResponse = {
  sessions?: unknown;
};

// 读取 workspace 文件列表，供本地文件选择器按需展示。
async function fetchWorkspaceFiles(): Promise<string[]> {
  const response = await fetch('/api/workspace/files');
  if (!response.ok) {
    throw new Error(`Workspace file request failed with ${response.status}`);
  }
  const body = (await response.json()) as WorkspaceFilesResponse;
  return Array.isArray(body.files)
    ? body.files.filter((file): file is string => typeof file === 'string')
    : [];
}

// 读取本地 sessions 列表，并过滤掉不完整的后端响应项。
async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch('/api/sessions');
  if (!response.ok) {
    throw new Error(`Session list request failed with ${response.status}`);
  }
  const body = (await response.json()) as SessionsResponse;
  if (!Array.isArray(body.sessions)) {
    return [];
  }
  return body.sessions
    .filter((session): session is Record<string, unknown> => {
      return (
        session !== null &&
        typeof session === 'object' &&
        typeof session.id === 'string' &&
        typeof session.title === 'string' &&
        typeof session.updatedAt === 'string'
      );
    })
    .map((session) => ({
      id: session.id as string,
      title: session.title as string,
      mode: session.mode === 'plan' ? 'plan' : 'act',
      updatedAt: session.updatedAt as string,
      activePlan:
        session.activePlan !== null &&
        typeof session.activePlan === 'object' &&
        typeof (session.activePlan as { title?: unknown }).title === 'string'
          ? { title: (session.activePlan as { title: string }).title }
          : null
    }));
}

// 将 session 更新时间压缩成人类可扫读的短日期。
function formatSessionTime(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return updatedAt;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

// 渲染 starter-style 文件选择器，把显式选择的 workspace 文件传给上层会话。
function WorkspaceFilePicker({
  copy,
  selectedFiles,
  onSelectedFilesChange
}: {
  copy: UiCopy['tools'];
  selectedFiles: string[];
  onSelectedFilesChange: (files: string[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || files.length > 0 || !isLoading) {
      return;
    }
    let isCancelled = false;
    fetchWorkspaceFiles()
      .then((nextFiles) => {
        if (!isCancelled) {
          setFiles(nextFiles);
        }
      })
      .catch((fetchError: unknown) => {
        if (!isCancelled) {
          setError(fetchError instanceof Error ? fetchError.message : 'failed');
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      isCancelled = true;
    };
  }, [files.length, isLoading, isOpen]);

  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sourceFiles =
      normalizedQuery.length === 0
        ? files
        : files.filter((file) => file.toLowerCase().includes(normalizedQuery));
    return sourceFiles.slice(0, 80);
  }, [files, query]);

  // 切换一个文件的选择状态，并保持选择顺序稳定。
  function toggleSelectedFile(path: string) {
    if (selectedSet.has(path)) {
      onSelectedFilesChange(selectedFiles.filter((file) => file !== path));
      return;
    }
    onSelectedFilesChange([...selectedFiles, path]);
  }

  // 打开文件选择器前先进入 loading 状态，让 effect 只负责外部同步。
  function toggleFilePicker() {
    setIsOpen((current) => {
      const nextOpen = !current;
      if (nextOpen && files.length === 0) {
        setIsLoading(true);
        setError(null);
      }
      return nextOpen;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        className="kodeks-control-text inline-flex h-9 w-full items-center justify-center gap-2 rounded-full bg-slate-950 px-3 text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
        onClick={toggleFilePicker}
        type="button"
      >
        <MaterialIcon name="folder" size={16} />
        {copy.selectFiles}
      </button>
      <div className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
        {selectedFiles.length > 0
          ? copy.selectedFileCount(selectedFiles.length)
          : copy.noFilesSelected}
      </div>

      {selectedFiles.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedFiles.map((path) => (
            <button
              className="kodeks-ui-caption max-w-full truncate rounded-full bg-slate-100 px-2 py-1 text-left text-slate-600 transition hover:bg-slate-200 dark:bg-[#2b3035] dark:text-slate-300 dark:hover:bg-[#30353b]"
              key={path}
              onClick={() => toggleSelectedFile(path)}
              title={path}
              type="button"
            >
              {path}
            </button>
          ))}
        </div>
      ) : null}

      {isOpen ? (
        <div className="rounded-[14px] border border-slate-200 bg-white p-3 shadow-sm dark:border-[#343a40] dark:bg-[#24282d] dark:shadow-none">
          <input
            className="kodeks-ui-body mb-3 w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-400 dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.fileSearchPlaceholder}
            type="search"
            value={query}
          />
          {isLoading ? (
            <div className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
              {copy.fileSearchLoading}
            </div>
          ) : error !== null ? (
            <div className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
              {copy.fileSearchError}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="kodeks-ui-caption text-slate-500 dark:text-slate-400">
              {copy.noFileMatches}
            </div>
          ) : (
            <div className="kodeks-scrollbar flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
              {filteredFiles.map((path) => {
                const isSelected = selectedSet.has(path);
                return (
                  <button
                    aria-pressed={isSelected}
                    className={`kodeks-ui-body flex min-h-8 items-center gap-2 rounded-[10px] px-2 py-1.5 text-left transition ${
                      isSelected
                        ? 'bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#2b3035]'
                    }`}
                    key={path}
                    onClick={() => toggleSelectedFile(path)}
                    title={path}
                    type="button"
                  >
                    <span
                      className={`size-3 shrink-0 rounded-sm border ${
                        isSelected
                          ? 'border-white bg-white dark:border-slate-950 dark:bg-slate-950'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    />
                    <span className="min-w-0 truncate">{path}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// 渲染 NotebookLM-style 的折叠窄栏，只保留展开和新会话入口。
function CollapsedWorkspaceRail({
  copy,
  onCollapseToggle,
  onNewSession
}: {
  copy: UiCopy['tools'];
  onCollapseToggle: () => void;
  onNewSession: () => void;
}) {
  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col items-center overflow-hidden rounded-[16px] border border-slate-200 bg-white py-3 text-slate-800 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-100 dark:shadow-none"
      data-testid="workspace-panel"
      data-state="collapsed"
    >
      <button
        aria-label={copy.expandSidebar}
        className="mb-4 inline-flex size-9 items-center justify-center rounded-[10px] text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-[#2b3035] dark:hover:text-white"
        data-testid="workspace-expand-button"
        onClick={onCollapseToggle}
        type="button"
      >
        <MaterialIcon name="dock_to_right" size={18} />
      </button>
      <button
        aria-label={copy.newSession}
        className="inline-flex size-9 items-center justify-center rounded-[10px] text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-[#2b3035] dark:hover:text-white"
        onClick={onNewSession}
        type="button"
      >
        <MaterialIcon name="add" size={20} />
      </button>
      <div className="mt-4 h-px w-8 bg-slate-200 dark:bg-[#343a40]" />
      <div className="mt-auto flex size-8 items-center justify-center rounded-full border border-slate-200 bg-slate-950 text-[11px] font-semibold text-white dark:border-[#343a40] dark:bg-slate-100 dark:text-slate-950">
        K
      </div>
    </aside>
  );
}

// 渲染左侧 workspace 面板，集中放新会话、历史会话和文件上下文。
export default function WorkspacePanel({
  collapsed,
  copy,
  currentSessionId,
  selectedFiles,
  onCollapseToggle,
  onNewSession,
  onSelectedFilesChange,
  onSessionSelect
}: WorkspacePanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    fetchSessions()
      .then((nextSessions) => {
        if (!isCancelled) {
          setSessions(nextSessions);
          setSessionError(null);
        }
      })
      .catch((error: unknown) => {
        if (!isCancelled) {
          setSessionError(error instanceof Error ? error.message : 'failed');
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingSessions(false);
        }
      });
    return () => {
      isCancelled = true;
    };
  }, [currentSessionId]);

  if (collapsed) {
    return (
      <CollapsedWorkspaceRail
        copy={copy}
        onCollapseToggle={onCollapseToggle}
        onNewSession={onNewSession}
      />
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[16px] border border-slate-200 bg-white text-slate-950 shadow-sm dark:border-[#343a40] dark:bg-[#202428] dark:text-slate-100 dark:shadow-none"
      data-testid="workspace-panel"
      data-state="expanded"
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <div className="kodeks-ui-title">Kodeks</div>
        <button
          aria-label={copy.collapseSidebar}
          className="inline-flex size-8 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-[#2b3035] dark:hover:text-white"
          data-testid="workspace-collapse-button"
          onClick={onCollapseToggle}
          type="button"
        >
          <MaterialIcon name="dock_to_left" size={17} />
        </button>
      </div>
      <div className="kodeks-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
        <button
          className="kodeks-ui-label flex h-9 items-center gap-2 rounded-full bg-slate-950 px-3 text-left text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
          onClick={onNewSession}
          type="button"
        >
          <MaterialIcon name="add" size={18} />
          {copy.newSession}
        </button>

        <section className="space-y-2">
          <h2 className="kodeks-ui-caption px-1 uppercase text-slate-500 dark:text-slate-400">
            {copy.sessionHistory}
          </h2>
          {isLoadingSessions && sessions.length === 0 ? (
            <div className="kodeks-ui-caption px-2 text-slate-500 dark:text-slate-400">
              {copy.loadingSessions}
            </div>
          ) : sessionError !== null ? (
            <div className="kodeks-ui-caption px-2 text-slate-500 dark:text-slate-400">
              {copy.sessionLoadError}
            </div>
          ) : sessions.length === 0 ? (
            <div className="kodeks-ui-caption px-2 text-slate-500 dark:text-slate-400">
              {copy.noSessions}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {sessions.slice(0, 20).map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <button
                    aria-pressed={isCurrent}
                    className={`group flex min-h-12 items-start gap-2 rounded-[10px] px-2.5 py-2 text-left transition ${
                      isCurrent
                        ? 'bg-slate-100 text-slate-950 dark:bg-[#30353b] dark:text-slate-100'
                        : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-[#24282d]'
                    }`}
                    key={session.id}
                    onClick={() => onSessionSelect(session.id)}
                    type="button"
                  >
                    <MaterialIcon
                      name={session.mode === 'plan' ? 'account_tree' : 'terminal'}
                      size={15}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="kodeks-ui-body block truncate">
                        {session.title || copy.autoSession}
                      </span>
                      <span className="kodeks-ui-caption block truncate text-slate-400 dark:text-slate-500">
                        {session.activePlan?.title ?? formatSessionTime(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="kodeks-ui-caption px-1 uppercase text-slate-500 dark:text-slate-400">
            {copy.fileSearch}
          </h2>
          <p className="kodeks-ui-caption px-1 text-slate-500 dark:text-slate-400">
            {copy.fileSearchDescription}
          </p>
          <WorkspaceFilePicker
            copy={copy}
            onSelectedFilesChange={onSelectedFilesChange}
            selectedFiles={selectedFiles}
          />
        </section>
      </div>
    </aside>
  );
}
