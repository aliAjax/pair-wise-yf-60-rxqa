import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, setValue, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  STORE_KEY,
  seedState,
  createPersistentStore,
  activeBlockersOf,
  dependenciesOf,
  findCycle,
  type AuditIssue,
  type Dependency,
  type IssueStatus,
  type Severity
} from '~/lib/audit';

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

const statusLabel: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const { state, persist, flushNow, saveStatus, saveError } = createPersistentStore(STORE_KEY, seedState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [dependsOnId, setDependsOnId] = createSignal('');
  const [depError, setDepError] = createSignal<string | null>(null);
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length, state.revision],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const selectedDeps = createMemo(() => dependenciesOf(state, selected()?.id ?? ''));
  const blockers = createMemo(() => activeBlockersOf(state, selected()?.id ?? ''));
  const blocked = createMemo(() => blockers().length > 0);

  const bump = () => {
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      ...values,
      status: 'open',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date().toISOString()
    };
    persist((draft) => {
      draft.issues.unshift(issue);
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, message: '审计员创建问题并保存证据' });
    });
    setSelectedId(issue.id);
    bump();
  };

  const transition = (patch: Partial<AuditIssue>, message: string) => {
    const issue = selected();
    if (!issue) return;
    persist((draft) => {
      const target = draft.issues.find((item) => item.id === issue.id);
      if (!target) return;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, message });
    });
    bump();
  };

  const reopenIssue = () => {
    const issue = selected();
    if (!issue) return;
    persist((draft) => {
      const target = draft.issues.find((item) => item.id === issue.id);
      if (!target) return;
      target.status = 'reopened';
      target.retestNote = '焦点顺序仍不正确';
      target.updatedAt = new Date().toISOString();
      const now = new Date().toISOString();
      draft.events.unshift({ id: crypto.randomUUID(), at: now, issueId: issue.id, message: '复测失败并重新打开' });
      // 被它卡住的重复项与依赖项：回到待复测
      const affected = draft.issues.filter(
        (item) =>
          item.id !== issue.id &&
          (item.canonicalId === issue.id || draft.dependencies.some((dep) => dep.issueId === item.id && dep.dependsOnId === issue.id)) &&
          (item.status === 'closed' || item.status === 'verifying')
      );
      for (const item of affected) {
        item.status = 'verifying';
        item.updatedAt = now;
        draft.events.unshift({
          id: crypto.randomUUID(),
          at: now,
          issueId: item.id,
          message: `主问题《${issue.title}》复测失败重新打开，本问题回到待复测`
        });
      }
    });
    bump();
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    persist((draft) => {
      const dup = draft.issues.find((item) => item.id === duplicate.id);
      if (!dup) return;
      dup.canonicalId = canonical.id;
      dup.updatedAt = new Date().toISOString();
      // 重复项视为被主问题卡住：主问题未关闭前，重复项不能复测
      if (!draft.dependencies.some((dep) => dep.issueId === dup.id && dep.dependsOnId === canonical.id)) {
        draft.dependencies.push({ id: crypto.randomUUID(), issueId: dup.id, dependsOnId: canonical.id, createdAt: new Date().toISOString() });
      }
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: dup.id, message: `重复问题已合并到 《${canonical.title}》` });
    });
    setMergeInto('');
    setSelectedId(canonical.id);
    bump();
  };

  const addDependency = () => {
    const issue = selected();
    const blocker = state.issues.find((item) => item.id === dependsOnId());
    if (!issue || !blocker || issue.id === blocker.id) return;
    const cycle = findCycle(state, issue.id, blocker.id);
    if (cycle) {
      const names = [issue, ...cycle, issue].map((item) => `《${item.title}》`).join(' → ');
      setDepError(`检测到循环依赖：${names}。请先解除已有依赖，再登记新的依赖。`);
      return;
    }
    setDepError(null);
    persist((draft) => {
      draft.dependencies.push({ id: crypto.randomUUID(), issueId: issue.id, dependsOnId: blocker.id, createdAt: new Date().toISOString() });
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, message: `登记依赖：等待《${blocker.title}》修复后才能复测` });
    });
    setDependsOnId('');
  };

  const removeDependency = (dep: Dependency) => {
    const issue = selected();
    const blocker = state.issues.find((item) => item.id === dep.dependsOnId);
    persist((draft) => {
      draft.dependencyTombstones.push(dep.id);
      draft.dependencies = draft.dependencies.filter((item) => item.id !== dep.id);
      draft.events.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        issueId: dep.issueId,
        message: `解除依赖：不再等待《${blocker?.title ?? '已删除问题'}》`
      });
    });
    if (issue) setDepError(null);
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <Show when={saveStatus() === 'saving'}><p role="status" class="save-banner">正在保存…</p></Show>
        <Show when={saveStatus() === 'error'}>
          <p role="alert" class="save-banner save-error">
            保存失败：{saveError()}。其他标签页的改动没有丢失，可重试。
            <button class="secondary" style="margin-left:10px" onClick={flushNow}>重试写入</button>
          </p>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{statusLabel[issue.status]}</span>
                  <span class="badge">{issue.severity}</span>
                  <span>{issue.flow}</span><span>{issue.impactGroup}</span>
                  <Show when={activeBlockersOf(state, issue.id).length > 0}><span class="badge badge-blocked">被卡住</span></Show>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
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
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => transition({ status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => transition({ status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button
                    disabled={blocked()}
                    title={blocked() ? `等待 ${blockers().map((item) => `《${item.title}》`).join('、')} 修复后才能复测` : undefined}
                    onClick={() => transition({ status: 'verifying' }, '开发人员提交修复，进入复测')}
                  >提交复测</button>{' '}
                  <button
                    disabled={blocked()}
                    title={blocked() ? `前置问题未关闭，不能结束复测` : undefined}
                    onClick={() => transition({ status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}
                  >复测通过</button>{' '}
                  <button class="danger" onClick={reopenIssue}>复测失败</button>
                </div>
                <Show when={blocked()}>
                  <p class="error" role="status">该问题被 {blockers().map((item) => `《${item.title}》`).join('、')} 卡住，前置问题修复并关闭后才能复测。</p>
                </Show>
                <hr />
                <section aria-label="依赖关系">
                  <h4>依赖关系</h4>
                  <Show when={selectedDeps().length > 0} fallback={<p>没有已登记的依赖。</p>}>
                    <ul class="dep-list">
                      <For each={selectedDeps()}>{(dep) => {
                        const blocker = () => state.issues.find((item) => item.id === dep.dependsOnId);
                        return (
                          <li>
                            《{blocker()?.title ?? '已删除问题'}》
                            <Show when={blocker()}><span class="badge">{statusLabel[blocker()!.status]}</span></Show>
                            <button class="secondary" onClick={() => removeDependency(dep)}>解除依赖</button>
                          </li>
                        );
                      }}</For>
                    </ul>
                  </Show>
                  <label>登记依赖（等待哪个问题修复）
                    <select value={dependsOnId()} onChange={(event) => { setDependsOnId(event.currentTarget.value); setDepError(null); }}>
                      <option value="">选择问题</option>
                      <For each={state.issues.filter((item) => item.id !== issue.id && !selectedDeps().some((dep) => dep.dependsOnId === item.id))}>
                        {(item) => <option value={item.id}>{item.title}</option>}
                      </For>
                    </select>
                  </label>
                  <button disabled={!dependsOnId()} onClick={addDependency}>登记依赖</button>
                  <Show when={depError()}><p class="error" role="alert">{depError()}</p></Show>
                </section>
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
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => setValue(form, 'title', event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => setValue(form, 'flow', event.currentTarget.value)} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => setValue(form, 'steps', event.currentTarget.value)} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => setValue(form, 'impactGroup', event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => setValue(form, 'severity', event.currentTarget.value as Severity)}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
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
