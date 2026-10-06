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
  blockedBy: string[];
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}

export interface AuditEvent { id: string; at: string; issueId: string; message: string }
export interface WorkbenchState { version: 2; issues: AuditIssue[]; events: AuditEvent[] }

export const STORAGE_KEY = 'a11y-audit-v2';
export const LEGACY_STORAGE_KEY = 'a11y-audit-v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const seed: WorkbenchState = {
  version: 2,
  issues: [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', blockedBy: [], fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', blockedBy: [], fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ]
};

const defaultStorage = (): StorageLike | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;

/** 把任意历史版本数据规范化为 v2：旧数据只有 canonicalId 重复关系，升级后保留并补上 blockedBy。 */
export function migrateState(raw: unknown): WorkbenchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { issues?: unknown; events?: unknown };
  if (!Array.isArray(candidate.issues) || !Array.isArray(candidate.events)) return null;
  const issues: AuditIssue[] = candidate.issues.map((issue) => {
    const legacy = issue as Partial<AuditIssue> & { id: string };
    return {
      ...(legacy as AuditIssue),
      blockedBy: Array.isArray(legacy.blockedBy) ? legacy.blockedBy : [],
      fixNote: legacy.fixNote ?? '',
      retestNote: legacy.retestNote ?? ''
    };
  });
  return { version: 2, issues, events: candidate.events as AuditEvent[] };
}

export function parseWorkbench(raw: string): WorkbenchState | null {
  try { return migrateState(JSON.parse(raw)); } catch { return null; }
}

/** 读取可续作记录：优先 v2，其次把 v1 旧数据升级，最后退回种子数据。 */
export function loadState(storage: StorageLike | undefined = defaultStorage()): WorkbenchState {
  if (!storage) return seed;
  try {
    const current = storage.getItem(STORAGE_KEY);
    if (current) return parseWorkbench(current) ?? seed;
    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) return parseWorkbench(legacy) ?? seed;
    return seed;
  } catch {
    return seed;
  }
}

/**
 * 合并两个标签页各自保存的状态：问题按 id 以 updatedAt 较新者为准，
 * 时间线按 id 求并集，输出排序确定，保证两个标签页收敛到同一份记录。
 */
export function mergeStates(a: WorkbenchState, b: WorkbenchState): WorkbenchState {
  const issues = new Map<string, AuditIssue>();
  for (const issue of [...a.issues, ...b.issues]) {
    const existing = issues.get(issue.id);
    if (!existing || issue.updatedAt >= existing.updatedAt) issues.set(issue.id, issue);
  }
  const events = new Map<string, AuditEvent>();
  for (const event of [...a.events, ...b.events]) {
    if (!events.has(event.id)) events.set(event.id, event);
  }
  return {
    version: 2,
    issues: [...issues.values()].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt) || x.id.localeCompare(y.id)),
    events: [...events.values()].sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id))
  };
}

/** 忽略顺序地比较两份记录内容是否一致，用于决定是否需要落盘或刷新界面。 */
export function sameContent(a: WorkbenchState, b: WorkbenchState): boolean {
  if (a.issues.length !== b.issues.length || a.events.length !== b.events.length) return false;
  const issueMap = new Map(a.issues.map((issue) => [issue.id, JSON.stringify(issue)]));
  if (!b.issues.every((issue) => issueMap.get(issue.id) === JSON.stringify(issue))) return false;
  const eventIds = new Set(a.events.map((event) => event.id));
  return b.events.every((event) => eventIds.has(event.id));
}

export type PersistResult =
  | { ok: true; state: WorkbenchState; changed: boolean }
  | { ok: false; state: WorkbenchState; error: string };

/** 先读出已存记录合并后再写入，避免后到的标签页盖掉先到的改动；失败时返回错误供重试。 */
export function persistState(state: WorkbenchState, storage: StorageLike | undefined = defaultStorage()): PersistResult {
  if (!storage) return { ok: false, state, error: '当前环境不支持本地存储' };
  try {
    const storedRaw = storage.getItem(STORAGE_KEY);
    const stored = storedRaw ? parseWorkbench(storedRaw) : null;
    const merged = stored ? mergeStates(stored, state) : state;
    if (stored && sameContent(merged, stored)) return { ok: true, state: stored, changed: false };
    storage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return { ok: true, state: merged, changed: true };
  } catch (error) {
    return { ok: false, state, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 检测“fromId 依赖 toId”是否会成环：沿现有 blockedBy 从 toId 出发，
 * 若能回到 fromId 则返回成环的问题 id 路径（首尾相同），否则返回 null。
 */
export function findDependencyCycle(issues: AuditIssue[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId, toId];
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const visited = new Set<string>([toId]);
  const stack: string[][] = [[toId]];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const current = path[path.length - 1];
    if (current === fromId) return [fromId, ...path];
    for (const next of byId.get(current)?.blockedBy ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push([...path, next]);
      }
    }
  }
  return null;
}

/** 主问题重新打开时，被它卡住且已关闭的重复项需要回到待复测。 */
export function collectReopenedDuplicates(issues: AuditIssue[], canonicalId: string): AuditIssue[] {
  return issues.filter((issue) => issue.canonicalId === canonicalId && issue.status === 'closed');
}
