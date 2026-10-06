import { createSignal, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';

// 审计工作台的领域模型与持久化：
// - 问题（issue）可登记依赖（A 未修复则 B 不能复测）
// - 重复关系通过 canonicalId 保留，旧数据升级后仍可看出主问题与重复项
// - 依赖、问题、操作事件全部持久化到 localStorage，跨标签页按 revision 三方合并
// - 写入失败保留错误状态，界面可重试

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}

/** 依赖关系：issueId（被卡住的问题）等待 dependsOnId（前置问题）修复 */
export interface Dependency {
  id: string;
  issueId: string;
  dependsOnId: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

export interface WorkbenchState {
  version: number;
  revision: number;
  issues: AuditIssue[];
  dependencies: Dependency[];
  /** 已解除依赖的墓碑 id，合并时用于过滤两个标签页各自的删除 */
  dependencyTombstones: string[];
  events: AuditEvent[];
}

export const STORE_KEY = 'a11y-audit-v1';

/** 深拷贝 store 快照（JSON 往返，避免在响应式 Proxy 上使用 structuredClone） */
function clone(state: WorkbenchState): WorkbenchState {
  return JSON.parse(JSON.stringify(state)) as WorkbenchState;
}

export function seedState(): WorkbenchState {
  return {
    version: 2,
    revision: 1,
    issues: [
      { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
    ],
    dependencies: [],
    dependencyTombstones: [],
    events: [
      { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ]
  };
}

/** 旧数据（v1）只有 issues/events 与 canonicalId；升级时把重复关系补成依赖，原主问题与重复项仍然可辨 */
function synthesizeDependencies(issues: AuditIssue[]): Dependency[] {
  const ids = new Set(issues.map((issue) => issue.id));
  const deps: Dependency[] = [];
  for (const issue of issues) {
    if (issue.canonicalId && ids.has(issue.canonicalId)) {
      deps.push({ id: `dep-migrated-${issue.id}`, issueId: issue.id, dependsOnId: issue.canonicalId, createdAt: issue.updatedAt });
    }
  }
  return deps;
}

export function migrate(raw: unknown): WorkbenchState {
  if (!raw || typeof raw !== 'object') return clone(seedState());
  const parsed = raw as Partial<WorkbenchState>;
  const issues = Array.isArray(parsed.issues) ? (parsed.issues as AuditIssue[]) : [];
  if (parsed.version === 2) {
    return {
      version: 2,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
      issues,
      dependencies: Array.isArray(parsed.dependencies) ? (parsed.dependencies as Dependency[]) : [],
      dependencyTombstones: Array.isArray(parsed.dependencyTombstones) ? (parsed.dependencyTombstones as string[]) : [],
      events: Array.isArray(parsed.events) ? (parsed.events as AuditEvent[]) : []
    };
  }
  // v1：仅重复关系，升级后保留 canonicalId，并据此补出依赖
  return {
    version: 2,
    revision: 1,
    issues,
    dependencies: synthesizeDependencies(issues),
    dependencyTombstones: [],
    events: Array.isArray(parsed.events) ? (parsed.events as AuditEvent[]) : []
  };
}

/** 跨标签页三方合并：问题按 updatedAt 逐题最后写入获胜，依赖按 id 并集（墓碑过滤），事件按 id 并集 */
export function mergeState(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): WorkbenchState {
  const issueMap = new Map<string, AuditIssue>();
  for (const issue of [...local.issues, ...remote.issues]) {
    const prev = issueMap.get(issue.id);
    if (!prev || issue.updatedAt > prev.updatedAt) issueMap.set(issue.id, issue);
  }

  const tombstones = new Set([...local.dependencyTombstones, ...remote.dependencyTombstones]);
  const depMap = new Map<string, Dependency>();
  for (const dep of [...local.dependencies, ...remote.dependencies]) {
    if (!tombstones.has(dep.id)) depMap.set(dep.id, dep);
  }

  const eventMap = new Map<string, AuditEvent>();
  for (const ev of [...local.events, ...remote.events]) eventMap.set(ev.id, ev);

  return {
    version: 2,
    revision: Math.max(local.revision, remote.revision),
    issues: [...issueMap.values()],
    dependencies: [...depMap.values()],
    dependencyTombstones: [...tombstones],
    events: [...eventMap.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
  };
}

/** 直接前置：还没关闭的依赖问题（卡住 B 使其不能复测） */
export function activeBlockersOf(state: WorkbenchState, issueId: string): AuditIssue[] {
  return state.dependencies
    .filter((dep) => dep.issueId === issueId)
    .map((dep) => state.issues.find((issue) => issue.id === dep.dependsOnId))
    .filter((issue): issue is AuditIssue => !!issue && issue.status !== 'closed');
}

/** 全部前置（含已关闭），用于展示与解除 */
export function dependenciesOf(state: WorkbenchState, issueId: string): Dependency[] {
  return state.dependencies.filter((dep) => dep.issueId === issueId);
}

/** 被 issueId 卡住的问题（含重复项） */
export function dependentsOf(state: WorkbenchState, issueId: string): AuditIssue[] {
  const ids = new Set<string>();
  for (const issue of state.issues) {
    if (issue.canonicalId === issueId) ids.add(issue.id);
  }
  for (const dep of state.dependencies) {
    if (dep.dependsOnId === issueId) ids.add(dep.issueId);
  }
  return state.issues.filter((issue) => ids.has(issue.id));
}

/**
 * 登记依赖 issueId -> dependsOnId 前的成环检查：
 * 从 dependsOnId 沿前置关系能走回 issueId 即成环，返回环上的问题序列（不含起点 issueId）。
 */
export function findCycle(state: WorkbenchState, issueId: string, dependsOnId: string): AuditIssue[] | null {
  const visited = new Set<string>();
  const path: AuditIssue[] = [];
  const walk = (currentId: string): boolean => {
    if (currentId === issueId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const current = state.issues.find((issue) => issue.id === currentId);
    if (current) path.push(current);
    const nextIds = state.dependencies.filter((dep) => dep.issueId === currentId).map((dep) => dep.dependsOnId);
    for (const nextId of nextIds) {
      if (walk(nextId)) return true;
    }
    path.pop();
    return false;
  };
  return walk(dependsOnId) ? path : null;
}

export interface PersistentStore {
  state: WorkbenchState;
  /** 乐观更新本地并排队写入；写入失败时保留错误，可重试 */
  persist: (mutator: (draft: WorkbenchState) => void) => void;
  flushNow: () => void;
  saveStatus: () => 'idle' | 'saving' | 'error';
  saveError: () => string | null;
}

export function createPersistentStore(key: string, seed: WorkbenchState): PersistentStore {
  const storageAvailable = typeof window !== 'undefined' && typeof localStorage !== 'undefined';
  const [state, setState] = createStore<WorkbenchState>(storageAvailable ? loadInitial() : clone(seed));
  const [saveStatus, setSaveStatus] = createSignal<'idle' | 'saving' | 'error'>('idle');
  const [saveError, setSaveError] = createSignal<string | null>(null);

  let base: WorkbenchState = clone(state);
  let queue: Promise<void> = Promise.resolve();

  function loadInitial(): WorkbenchState {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return migrate(JSON.parse(raw));
    } catch { /* 数据损坏时回退到种子 */ }
    return clone(seed);
  }

  function readRemote(): WorkbenchState | null {
    if (!storageAvailable) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return null;
      return migrate(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function flush() {
    queue = queue.then(async () => {
      setSaveStatus('saving');
      setSaveError(null);
      try {
        const remote = readRemote();
        const localNow = clone(state);
        // 写入前以远端为基线合并，避免两个标签页互相覆盖
        const rebased = remote ? mergeState(base, localNow, remote) : localNow;
        const next: WorkbenchState = { ...rebased, version: 2, revision: (remote?.revision ?? base.revision) + 1 };
        if (storageAvailable) localStorage.setItem(key, JSON.stringify(next));
        base = next;
        setState(next);
        setSaveStatus('idle');
      } catch (error) {
        setSaveStatus('error');
        setSaveError(error instanceof Error ? error.message : String(error));
      }
    });
  }

  function persist(mutator: (draft: WorkbenchState) => void) {
    // 先乐观更新本地界面，再排队落盘
    setState(produce((draft) => { mutator(draft as WorkbenchState); }));
    flush();
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== key) return;
    const remote = readRemote();
    if (!remote) return;
    const merged = mergeState(base, clone(state), remote);
    base = remote;
    setState(merged);
  }

  if (storageAvailable) window.addEventListener('storage', onStorage);
  onCleanup(() => {
    if (storageAvailable) window.removeEventListener('storage', onStorage);
  });

  return { state, persist, flushNow: flush, saveStatus, saveError };
}
