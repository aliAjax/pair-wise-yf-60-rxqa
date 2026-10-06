import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  STORAGE_KEY,
  collectReopenedDuplicates,
  findDependencyCycle,
  loadState,
  mergeStates,
  parseWorkbench,
  persistState,
  sameContent
} from '../lib/audit-store';
import type { AuditIssue, Severity, WorkbenchState } from '../lib/audit-store';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [depTarget, setDepTarget] = createSignal('');
  const [depError, setDepError] = createSignal('');
  const [saveError, setSaveError] = createSignal('');
  const [lastSavedAt, setLastSavedAt] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const issueById = (id: string) => state.issues.find((issue) => issue.id === id);
  const openBlockers = (issue: AuditIssue) =>
    issue.blockedBy.map((id) => issueById(id)).filter((blocker): blocker is AuditIssue => Boolean(blocker) && blocker!.status !== 'closed');
  const dependentsOf = (id: string) => state.issues.filter((issue) => issue.blockedBy.includes(id));
  const duplicatesOf = (id: string) => state.issues.filter((issue) => issue.canonicalId === id);

  const adoptState = (next: WorkbenchState) => {
    setState('issues', next.issues);
    setState('events', next.events);
  };

  // 合并已存记录后落盘，避免另一个标签页先到的改动被盖掉；失败时保留错误供重试。
  const persistNow = () => {
    const snapshot = JSON.parse(JSON.stringify(state)) as WorkbenchState;
    const result = persistState(snapshot);
    if (result.ok) {
      setSaveError('');
      setLastSavedAt(new Date().toLocaleTimeString());
      if (!sameContent(result.state, snapshot)) adoptState(result.state);
    } else {
      setSaveError(result.error);
    }
  };

  createEffect(() => persistNow());

  const addEvent = (issueId: string, message: string) => setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message }, ...events]);
  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    if (patch.status === 'reopened') {
      const reopened = issueById(id);
      for (const duplicate of collectReopenedDuplicates(state.issues, id)) {
        setState('issues', (issue) => issue.id === duplicate.id, produce((issue) => {
          issue.status = 'verifying';
          issue.updatedAt = new Date().toISOString();
        }));
        addEvent(duplicate.id, `主问题「${reopened?.title ?? id}」重新打开，重复项回到待复测`);
      }
    }
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = { id: crypto.randomUUID(), ...values, status: 'open', blockedBy: [], fixNote: '', retestNote: '', updatedAt: new Date().toISOString() };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  const registerDependency = () => {
    const issue = selected();
    const blocker = issueById(depTarget());
    if (!issue || !blocker) return;
    const cycle = findDependencyCycle(state.issues, issue.id, blocker.id);
    if (cycle) {
      const names = cycle.map((id) => issueById(id)?.title ?? id);
      setDepError(`检测到循环依赖，已拦截：${names.join(' → ')}`);
      return;
    }
    setDepError('');
    updateIssue(issue.id, { blockedBy: [...issue.blockedBy, blocker.id] }, `登记依赖：「${issue.title}」被「${blocker.title}」阻塞，待其关闭后再复测`);
    setDepTarget('');
  };

  const removeDependency = (blockerId: string) => {
    const issue = selected();
    if (!issue) return;
    const blocker = issueById(blockerId);
    updateIssue(issue.id, { blockedBy: issue.blockedBy.filter((id) => id !== blockerId) }, `解除「${issue.title}」对「${blocker?.title ?? blockerId}」的依赖`);
  };

  // 切换选中问题时，清掉上一个问题残留的依赖登记选择
  createEffect(() => {
    selectedId();
    setDepTarget('');
    setDepError('');
  });

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    // 另一个标签页写入后，把对方改动合并进当前记录
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const remote = parseWorkbench(event.newValue);
      if (!remote) return;
      const snapshot = JSON.parse(JSON.stringify(state)) as WorkbenchState;
      const merged = mergeStates(remote, snapshot);
      if (!sameContent(merged, snapshot)) adoptState(merged);
    };
    window.addEventListener('keydown', shortcut);
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener('storage', onStorage);
    });
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <div class="save-area">
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
            <p role="status" class="save-status">
              {saveError() ? `保存失败：${saveError()}` : `记录已自动保存${lastSavedAt() ? ` · 上次 ${lastSavedAt()}` : ''}`}
            </p>
            <Show when={saveError()}>
              <button class="danger" onClick={persistNow}>重试保存</button>
            </Show>
          </div>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>被阻塞</span><strong>{state.issues.filter((issue) => openBlockers(issue).length > 0).length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta"><span class="badge">{issue.status}</span><span class="badge">{issue.severity}</span><span>{issue.flow}</span><span>{issue.impactGroup}</span><Show when={issue.canonicalId}><span class="badge">重复项</span></Show><Show when={openBlockers(issue).length > 0}><span class="badge blocked">被阻塞</span></Show></div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <Show when={issue.canonicalId}>
                  <p>本问题是重复项，主问题：<button class="secondary" onClick={() => setSelectedId(issue.canonicalId!)}>{issueById(issue.canonicalId!)?.title ?? issue.canonicalId}</button></p>
                </Show>
                <Show when={duplicatesOf(issue.id).length > 0}>
                  <p><strong>重复项（{duplicatesOf(issue.id).length}）：</strong></p>
                  <ul>
                    <For each={duplicatesOf(issue.id)}>{(duplicate) => (
                      <li><button class="secondary" onClick={() => setSelectedId(duplicate.id)}>{duplicate.title}</button> <span class="badge">{duplicate.status}</span></li>
                    )}</For>
                  </ul>
                </Show>
                <Show when={openBlockers(issue).length > 0}>
                  <p class="error" role="alert">该问题仍被 {openBlockers(issue).length} 个问题阻塞（{openBlockers(issue).map((blocker) => blocker.title).join('、')}），建议阻塞问题关闭后再提交复测。</p>
                </Show>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => updateIssue(issue.id, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>
                </div>
                <hr />
                <h4>依赖关系</h4>
                <Show when={issue.blockedBy.length > 0} fallback={<p>暂无依赖。若本问题被其他问题卡住，可在下方登记。</p>}>
                  <ul>
                    <For each={issue.blockedBy}>{(blockerId) => (
                      <li style="margin-bottom:8px">
                        <button class="secondary" onClick={() => setSelectedId(blockerId)}>{issueById(blockerId)?.title ?? '未知问题'}</button>{' '}
                        <span class="badge">{issueById(blockerId)?.status ?? '已删除'}</span>{' '}
                        <button class="secondary" onClick={() => removeDependency(blockerId)}>解除依赖</button>
                      </li>
                    )}</For>
                  </ul>
                </Show>
                <Show when={dependentsOf(issue.id).length > 0}>
                  <p>以下问题被本问题阻塞：{dependentsOf(issue.id).map((dependent) => dependent.title).join('、')}</p>
                </Show>
                <label>登记依赖
                  <select value={depTarget()} onChange={(event) => setDepTarget(event.currentTarget.value)}>
                    <option value="">选择阻塞本问题的问题</option>
                    <For each={state.issues.filter((item) => item.id !== issue.id && !issue.blockedBy.includes(item.id))}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                  </select>
                </label>
                <div><button disabled={!depTarget()} onClick={registerDependency}>登记依赖</button></div>
                <Show when={depError()}><p class="error" role="alert">{depError()}</p></Show>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => field.value = event.currentTarget.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => field.value = event.currentTarget.value as Severity}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
