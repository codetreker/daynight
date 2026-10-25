const app = document.querySelector('#app');
const dialogRoot = document.querySelector('#dialog-root');
const scenarioSelect = document.querySelector('#scenario');
const roleSelect = document.querySelector('#demo-role');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9m-3-3 3-3m-6 0 3-3"/>',
  repo: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 3H20v19H6.5A2.5 2.5 0 0 1 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  link: '<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1"/>',
  logout: '<path d="M9 3H4v18h5m5-14 5 5-5 5m-6-5h11"/>',
};
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const providerMark = (provider) => provider === 'microsoft' ? '<span class="ms-squares"><i></i><i></i><i></i><i></i></span>' : provider === 'google' ? '<b>G</b>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.1.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.1-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.99 1.03-2.69-.1-.26-.45-1.28.1-2.66 0 0 .84-.27 2.75 1.03a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.66.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.73c0 .27.18.59.69.49A10 10 0 0 0 12 2Z"/></svg>';
const button = (label, action, style = '', extra = '') => `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
const roleBadge = (role) => `<span class="badge ${role === 'admin' ? 'admin' : ''}">${role === 'admin' ? '管理员' : '成员'}</span>`;
const initialProjects = [
  { name: 'Daynight', repo: 'github.com/oc-engteam/day-night', role: 'admin', members: 3, tasks: 48, date: '今天 14:32' },
  { name: 'Syntrix', repo: 'github.com/oc-engteam/syntrix', role: 'member', members: 5, tasks: 126, date: '昨天 18:06' },
  { name: 'UniAuth', repo: 'github.com/oc-engteam/uniauth', role: 'admin', members: 2, tasks: 32, date: '10 月 20 日' },
];
const scenarios = [
  ['projects', '项目 · 已登录', 'projects'], ['login', '登录 · 正常', 'login'],
  ['login-loading', '登录 · 跳转中', 'login'], ['login-error', '登录 · 失败', 'login'],
  ['providers-unavailable', '登录 · 无可用方式', 'login'], ['session-expired', '登录 · 会话已过期', 'login'],
  ['projects-loading', '项目 · 加载中', 'projects'], ['projects-empty', '项目 · 空列表', 'projects'],
  ['projects-error', '项目 · 加载失败', 'projects'], ['project-long', '项目 · 长名称', 'projects'],
  ['project', '项目 · 任务视图', 'project'], ['members-admin', '成员 · 管理员', 'members'],
  ['members-member', '成员 · 普通成员', 'members'], ['members-last-admin', '成员 · 最后一名管理员', 'members'],
  ['members-error', '成员 · 操作失败', 'members'], ['invitations-empty', '成员 · 无有效邀请', 'members'],
  ['tokens', '令牌 · 列表', 'tokens'], ['tokens-empty', '令牌 · 空列表', 'tokens'],
  ['token-created', '令牌 · 创建成功', 'tokens'], ['tokens-error', '令牌 · 操作失败', 'tokens'],
  ['invite', '邀请 · 接受邀请', 'invite'], ['invite-signed-out', '邀请 · 尚未登录', 'invite'],
  ['invite-expired', '邀请 · 已过期', 'invite'], ['invite-revoked', '邀请 · 已撤销', 'invite'],
  ['invite-used', '邀请 · 已使用', 'invite'], ['invite-member', '邀请 · 已经是成员', 'invite'],
  ['access-revoked', '项目 · 已失去访问权限', 'denied'],
  ['preview-html', '预览 · HTML 与相对资源', 'project'],
  ['preview-loading', '预览 · 加载中', 'project'], ['preview-error', '预览 · 加载失败', 'project'],
];
const state = {};
let toastTimer;
let transitionTimer;
let dialogOpener;
let dialogSubmit;
let dialogCancel;
const sampleToken = 'dn_example_7pN4sK2mQ9xT6vR3hW8cA5yB1zF0';
const inviteUrl = 'https://daynight.example.com/invitations#example-7Kp3m9';

const resetState = (id) => {
  const item = scenarios.find(([candidate]) => candidate === id) || scenarios[0];
  Object.assign(state, { scenario: item[0], view: item[2], role: item[0] === 'members-member' ? 'member' : 'admin', loginForInvite: false, loginProvider: 'github', name: 'Daynight', repository: 'github.com/oc-engteam/day-night', taskCount: 48, error: '', projects: structuredClone(initialProjects), tokens: [
    { id: 'cli', name: 'MacBook · 日常开发', created: '2026 年 10 月 20 日创建', expiry: '2027 年 1 月 20 日到期', status: 'active' },
    { id: 'agent', name: '构建服务器 · 发布自动化', created: '2026 年 10 月 21 日创建', expiry: '2026 年 11 月 21 日到期', status: 'active' },
    { id: 'old', name: '旧开发环境', created: '2026 年 9 月 18 日创建', expiry: '2026 年 10 月 18 日已过期', status: 'expired' },
  ], members: [
    { id: 'self', initials: 'JJ', name: 'Jianjun', email: 'jianjun@example.com', role: 'admin', color: '', self: true },
    { id: 'alice', initials: 'AL', name: 'Alice Chen', email: 'alice.chen@example.com', role: 'admin', color: 'green' },
    { id: 'bob', initials: 'BW', name: 'Bob Wang', email: 'bob.wang@example.com', role: 'member', color: 'amber' },
  ], invites: [{ id: 'current', label: '邀请新成员', expiry: '10 月 29 日 14:32 到期', created: 'Jianjun · 今天 14:32' }] });
  if (state.scenario === 'projects-empty') state.projects = [];
  if (state.scenario === 'tokens-empty') state.tokens = [];
  if (state.scenario === 'invitations-empty') state.invites = [];
  if (state.scenario === 'project-long') state.projects[0].name = '跨团队协作与自动化研发基础设施 · 国际化平台迁移及可观测性建设';
  if (state.scenario === 'members-last-admin') state.members[1].role = 'member';
  if (state.role === 'member') { state.members[0].role = 'member'; state.members[1].role = 'admin'; }
  if (state.scenario === 'members-error') state.error = '成员信息保存失败。请重试。';
  if (state.scenario === 'tokens-error') state.error = '访问令牌列表暂时无法更新。请重试。';
};
const notify = (message) => {
  clearTimeout(toastTimer);
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
};
const headingFocus = () => document.querySelector('#main h1')?.focus();
const navigate = (view) => { closeDialog(); state.view = view; state.error = ''; state.scenario = view === 'projects' ? 'projects' : view; render(); headingFocus(); };
const setScenario = (id) => {
  clearTimeout(transitionTimer);
  closeDialog();
  resetState(id);
  history.replaceState(null, '', `?scenario=${encodeURIComponent(state.scenario)}`);
  render();
  if (state.scenario === 'token-created') tokenCreated();
  if (state.scenario.startsWith('preview-')) openPreview(state.scenario);
};
const avatar = (member) => `<span class="avatar ${member.color || ''}" aria-hidden="true">${escapeHtml(member.initials)}</span>`;
const brand = '<div class="brand"><span class="brand-mark" aria-hidden="true"></span>daynight</div>';
const errorNotice = () => state.error ? `<div class="notice error" role="alert">${escapeHtml(state.error)} <span class="small">请求编号：rq_example_27f9</span> ${button('重试', 'retry')}</div>` : '';
const shell = (body, crumb) => `<div class="shell"><aside class="sidebar"><div class="sidebar-main">${brand}<div class="nav-label">工作空间</div><nav aria-label="主导航"><button class="nav-button ${['projects', 'project', 'members', 'denied'].includes(state.view) ? 'active' : ''}" data-action="projects">${icon('grid')}<span>项目</span></button></nav></div><div class="sidebar-bottom"><button class="nav-button ${['account', 'tokens'].includes(state.view) ? 'active' : ''}" data-action="account">${icon('user')}<span>账户设置</span></button><div class="sidebar-workspace">已连接 Daynight<small>私人项目 · 团队协作</small></div></div></aside><div class="workspace"><header class="topbar"><div class="crumb"><button data-action="projects">Daynight</button><span>/</span><span class="crumb-current">${crumb}</span></div><button class="account-button" data-action="account" aria-label="Jianjun 的账户设置"><span class="avatar" aria-hidden="true">JJ</span><span class="account-name">Jianjun</span>${icon('user', 14)}</button></header><main id="main" class="content" tabindex="-1">${body}</main></div></div>`;
const stateBox = (title, description, action = '', type = 'grid') => `<div class="state-box"><span class="state-icon">${icon(type, 26)}</span><h2>${title}</h2><p>${description}</p>${action}</div>`;
const loginPage = () => {
  const busy = state.scenario === 'login-loading';
  const unavailable = state.scenario === 'providers-unavailable';
  const message = state.scenario === 'login-error' ? '<div class="notice error" role="alert"><p>登录未完成。身份服务暂时无法确认你的身份，请重新登录。</p><p class="small">请求编号：rq_example_91b2</p></div>' : state.scenario === 'session-expired' ? '<div class="notice warning" role="status"><p>登录状态已过期。重新登录后可继续访问项目。</p></div>' : unavailable ? '<div class="notice error" role="alert"><p>当前没有可用的登录方式。请联系部署管理员。</p></div>' : '';
  return `<div class="auth-page"><aside class="auth-aside">${brand}<div class="auth-copy"><h2>让任务有序推进，<br>让协作持续发生。</h2><p>在项目中整理任务、连接依赖、共享成果。与团队一起，把计划推进到完成。</p><div class="auth-visual" aria-hidden="true"><span>明确目标</span><span>连接工作</span><span>交付成果</span></div></div><p class="auth-caption">专注于你的项目，与团队共同前进。</p></aside><main id="main" class="auth-main"><section class="auth-card"><div class="eyebrow">欢迎使用 DAYNIGHT</div><h1 tabindex="-1">登录你的工作空间</h1><p class="subtitle">${state.loginForInvite ? '通过 UniAuth 登录后，继续确认项目邀请。' : '通过 UniAuth 登录，访问你的项目与任务。'}</p>${message}<div class="provider-list">${[['microsoft', 'Microsoft'], ['google', 'Google'], ['github', 'GitHub']].map(([id, label]) => `<button class="provider-button" data-action="login" data-provider="${id}" ${busy || unavailable ? 'disabled' : ''}>${busy && id === state.loginProvider ? '<span class="spinner" aria-hidden="true"></span>' : `<span class="provider-icon" aria-hidden="true">${providerMark(id)}</span>`}<span>${busy && id === state.loginProvider ? '正在前往 UniAuth…' : `使用 ${label} 登录`}</span></button>`).join('')}</div><p class="auth-note">登录后可以创建私有项目，或接受团队的项目邀请。<br>你的身份由 UniAuth 验证。</p>${busy ? '<p class="invite-status" role="status">正在安全跳转，请稍候。</p>' : ''}</section></main></div>`;
};
const projectsPage = () => {
  const header = `<div class="page-heading"><div><div class="eyebrow">工作空间</div><h1 tabindex="-1">我的项目</h1><p class="subtitle">你创建或加入的项目，集中在这里。</p></div>${button(`${icon('plus')}创建项目`, 'create-project', 'primary')}</div>`;
  if (state.scenario === 'projects-loading') return header + '<div class="state-box" role="status"><span class="spinner"></span><p>正在加载你的项目…</p></div>';
  if (state.scenario === 'projects-error') return header + stateBox('项目暂时无法加载', '请检查网络连接后重试。请求编号：rq_example_48e7', button('重新加载', 'retry', 'primary'), 'warning');
  if (!state.projects.length) return header + stateBox('从一个项目开始', '创建私有项目来整理工作，或使用管理员发给你的邀请链接加入团队。', button(`${icon('plus')}创建项目`, 'create-project', 'primary'));
  return header + `<ul class="project-grid">${state.projects.map((project, index) => `<li><button class="project-card" data-action="open-project" data-index="${index}"><span class="project-icon">${icon('grid', 23)}</span><span class="project-name">${escapeHtml(project.name)}</span><span class="repo">${icon('repo', 12)}<span>${escapeHtml(project.repo)}</span></span><span class="project-footer"><span>${roleBadge(project.role)} <span class="small">${project.members} 位成员</span></span><span class="project-open">${project.tasks} 个任务 ${icon('arrow', 13)}</span></span><span class="project-footer" style="padding-top:13px">最近更新 ${escapeHtml(project.date)}</span></button></li>`).join('')}</ul><p class="list-footer">共 ${state.projects.length} 个项目 · 仅你和项目成员可访问</p>`;
};
const projectPage = () => {
  if (state.taskCount === 0) return `<button class="button quiet back-link" data-action="projects">${icon('back', 14)}返回项目列表</button><div class="page-heading project-heading"><div><div class="eyebrow">项目工作空间</div><h1 tabindex="-1">${escapeHtml(state.name)}</h1><p class="subtitle break">${escapeHtml(state.repository)} · 1 位成员</p></div><div class="project-title-actions">${roleBadge('admin')}${button(`${icon('users')}项目成员`, 'members')}</div></div><div style="margin-top:26px">${stateBox('项目已就绪', '在 CLI 中创建任务后，可以在这里查看任务与依赖关系。你也可以邀请协作者加入。', button(`${icon('users')}邀请协作者`, 'members'))}</div>`;
  return `<button class="button quiet back-link" data-action="projects">${icon('back', 14)}返回项目列表</button><div class="page-heading project-heading"><div><div class="eyebrow">项目工作空间</div><h1 tabindex="-1">${escapeHtml(state.name)}</h1><p class="subtitle break">${escapeHtml(state.repository)}</p></div><div class="project-title-actions">${roleBadge(state.role)}${button(`${icon('users')}项目成员`, 'members')}</div></div><div class="stats">${[['全部任务', '48', ''], ['已完成', '31', 'green'], ['进行中', '9', 'blue'], ['待处理', '8', 'amber']].map(([label, value, color]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-number ${color}">${value}</div></div>`).join('')}</div><div class="section-heading"><h2>任务链</h2><span class="muted small">最近创建优先</span></div><div class="root-row"><div><div class="root-title">⌄　项目鉴权与团队协作</div><div class="root-meta">ROOT-024 · 6 个任务 · 最近更新于今天 14:32</div></div><div class="root-progress">3 / 6 已完成<div class="progress"><i style="width:50%"></i></div></div></div><div class="graph-preview" aria-label="任务依赖关系示意"><div class="graph-node"><small>TASK-105</small><h3>接入 UniAuth 身份登录</h3><span class="badge success">已完成</span></div><span class="graph-arrow" aria-hidden="true">→</span><div class="graph-node"><small>TASK-106</small><h3>项目成员与访问权限</h3><span class="badge admin">进行中</span></div><span class="graph-arrow" aria-hidden="true">→</span><button class="graph-node" data-action="open-preview" aria-label="查看任务：团队邀请与账户管理"><small>TASK-107</small><h3>团队邀请与账户管理</h3><span class="badge">待处理</span></button></div><div class="root-row" style="margin-top:12px"><div><div class="root-title">›　附件预览与成果共享</div><div class="root-meta">ROOT-022 · 8 个任务</div></div><div class="root-progress">8 / 8 已完成<div class="progress"><i style="width:100%"></i></div></div></div>`;
};
const membersPage = () => {
  const isAdmin = state.role === 'admin';
  const adminCount = state.members.filter((member) => member.role === 'admin').length;
  return `<button class="button quiet back-link" data-action="project">${icon('back', 14)}返回 ${escapeHtml(state.name)}</button><div class="page-heading"><div><div class="eyebrow">项目设置</div><h1 tabindex="-1">项目成员</h1><p class="subtitle">${escapeHtml(state.name)} · 管理协作成员与加入邀请</p></div>${isAdmin ? button(`${icon('plus')}邀请成员`, 'create-invite', 'primary') : roleBadge('member')}</div>${errorNotice()}${!isAdmin ? '<div class="notice">你可以读写项目中的任务和附件。成员与邀请由项目管理员管理。</div>' : ''}<section class="panel" aria-labelledby="members-title"><div class="panel-heading"><div><h2 id="members-title">成员 <span class="badge">${state.members.length}</span></h2><p>所有成员都可以读写项目资源。</p></div></div><div class="row head" aria-hidden="true"><span>成员</span><span>项目角色</span><span style="text-align:right">操作</span></div>${state.members.map((member) => {
    const lastAdmin = member.role === 'admin' && adminCount === 1;
    return `<div class="row"><div class="person">${avatar(member)}<div><div class="person-name">${escapeHtml(member.name)} ${member.self ? '<span class="muted small">（你）</span>' : ''}</div><div class="person-meta">${escapeHtml(member.email)}</div></div></div><div>${isAdmin ? `<select class="role-select" data-action="member-role" data-id="${member.id}" aria-label="${escapeHtml(member.name)} 的项目角色" ${lastAdmin ? 'disabled aria-describedby="last-admin-note"' : ''}><option value="member" ${member.role === 'member' ? 'selected' : ''}>成员</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>管理员</option></select>` : roleBadge(member.role)}</div><div class="actions">${isAdmin ? button('移除', 'remove-member', 'quiet', `data-id="${member.id}" ${lastAdmin ? 'disabled title="项目必须至少保留一名管理员"' : ''}`) : '<span class="muted small">—</span>'}</div></div>`;
  }).join('')}</section><p class="muted small" id="last-admin-note">项目必须至少保留一名管理员。最后一名管理员需要先将另一位成员设为管理员，才能移除自己或变更自己的角色。</p>${isAdmin ? `<section class="panel" style="margin-top:24px" aria-labelledby="invites-title"><div class="panel-heading"><div><h2 id="invites-title">有效邀请</h2><p>每个邀请链接只能使用一次，接受邀请后以成员身份加入。链接只在创建时显示。</p></div></div>${state.invites.length ? state.invites.map((invite) => `<div class="row"><div><div class="person-name">${escapeHtml(invite.label)}</div><div class="person-meta">${escapeHtml(invite.created)}</div></div><div class="row-detail">${escapeHtml(invite.expiry)}</div><div class="actions">${button('撤销', 'revoke-invite', 'quiet', `data-id="${invite.id}"`)}</div></div>`).join('') : '<div class="empty-inline">还没有有效邀请。创建邀请链接，邀请团队成员加入。</div>'}</section>` : ''}<div class="role-legend"><div><h3>管理员</h3><p>读写项目、任务和附件，并管理项目成员及邀请。</p></div><div><h3>成员</h3><p>读写项目、任务和附件，与团队共同推进工作。</p></div></div>`;
};
const settingsNav = () => `<nav class="settings-nav" aria-label="账户设置"><button class="${state.view === 'account' ? 'active' : ''}" data-action="account">个人资料</button><button class="${state.view === 'tokens' ? 'active' : ''}" data-action="tokens">访问令牌</button></nav>`;
const accountPage = () => `<div class="page-heading"><div><div class="eyebrow">你的账户</div><h1 tabindex="-1">账户设置</h1><p class="subtitle">管理个人资料和 CLI、Agent 的访问凭据。</p></div></div><div class="settings-grid">${settingsNav()}<div class="settings-main"><section class="panel"><div class="panel-body"><div class="profile-info"><span class="avatar">JJ</span><div><h2>Jianjun</h2><p class="muted small">jianjun@example.com</p></div></div><dl class="info-list"><dt>登录方式</dt><dd>GitHub · 通过 UniAuth</dd><dt>资料来源</dt><dd>姓名、邮箱和头像由登录身份提供。</dd></dl></div></section><section class="panel"><div class="panel-heading"><div><h2>当前会话</h2><p>退出当前浏览器的登录状态。</p></div>${button(`${icon('logout', 14)}退出登录`, 'logout')}</div></section></div></div>`;
const tokensPage = () => `<div class="page-heading"><div><div class="eyebrow">你的账户</div><h1 tabindex="-1">账户设置</h1><p class="subtitle">管理个人资料和 CLI、Agent 的访问凭据。</p></div></div><div class="settings-grid">${settingsNav()}<div class="settings-main">${errorNotice()}<section class="panel" aria-labelledby="tokens-title"><div class="panel-heading"><div><h2 id="tokens-title">个人访问令牌</h2><p>让 CLI 和 Agent 以你的身份访问 Daynight。</p></div>${button(`${icon('plus', 14)}创建令牌`, 'create-token', 'primary')}</div>${state.tokens.length ? state.tokens.map((token) => `<div class="row token-row ${token.status !== 'active' ? 'revoked' : ''}"><div class="person"><span class="token-symbol">${icon('key', 17)}</span><div><div class="person-name">${escapeHtml(token.name)}</div><div class="person-meta">${escapeHtml(token.created)} ${token.status === 'expired' ? '<span class="badge warning">已过期</span>' : token.status === 'revoked' ? '<span class="badge">已撤销</span>' : ''}</div></div></div><div class="row-detail"><strong>${escapeHtml(token.expiry)}</strong></div><div class="actions">${token.status === 'active' ? button('撤销', 'revoke-token', 'quiet', `data-id="${token.id}"`) : '<span class="muted small">不可使用</span>'}</div></div>`).join('') : '<div class="empty-inline">还没有访问令牌。创建后可用于 CLI 或 Agent。</div>'}</section><div class="notice">令牌代表你当前的项目权限。项目成员关系变化会立即影响后续访问；请只将令牌交给你信任的客户端。</div><p class="muted small">令牌明文只在创建成功时显示一次。丢失后请撤销并创建新令牌。</p></div></div>`;
const invitePage = () => {
  const unavailable = ['invite-expired', 'invite-revoked', 'invite-used'].includes(state.scenario);
  const existing = state.scenario === 'invite-member';
  const signedOut = state.scenario === 'invite-signed-out';
  const titles = { 'invite-expired': ['邀请已过期', '请联系项目管理员，获取新的邀请链接。'], 'invite-revoked': ['邀请已撤销', '这个邀请链接已被项目管理员撤销。请联系管理员获取新链接。'], 'invite-used': ['邀请已被使用', '每个邀请链接只能使用一次。请联系项目管理员获取新的邀请。'] };
  const title = unavailable ? titles[state.scenario][0] : existing ? '你已加入这个项目' : '一起推进项目';
  return `<div class="invite-page">${brand}<main id="main" class="invite-card"><div class="project-icon">${icon(unavailable ? 'warning' : 'users', 28)}</div><h1 tabindex="-1">${title}</h1><p class="subtitle">${unavailable ? titles[state.scenario][1] : existing ? '你已经是 Daynight 的项目成员。' : 'Jianjun 邀请你加入一个私有项目。'}</p>${!unavailable ? `<div class="invited-project"><h2>Daynight</h2><span class="badge">以成员身份加入</span><ul class="permission-list"><li>查看项目任务与依赖关系</li><li>创建和更新任务，共享附件</li><li>与团队共同推进项目工作</li></ul></div>` : ''}<div class="invite-footer">${signedOut ? `<p class="muted small">先登录，再确认是否加入这个项目。登录不会自动接受邀请。</p>${button('通过 UniAuth 登录', 'invite-login', 'primary')}` : unavailable ? button('前往我的项目', 'projects', 'primary') : `<div class="invite-account"><div class="person"><span class="avatar">JJ</span><div><div class="person-name">Jianjun</div><div class="person-meta">jianjun@example.com</div></div></div><button class="inline-link" data-action="switch-account">切换账户</button></div>${button(existing ? '打开项目' : '接受邀请并加入', existing ? 'project' : 'accept-invite', 'primary')}`}</div>${!unavailable && !existing ? '<p class="invite-status">此邀请在 10 月 29 日 14:32 到期</p>' : ''}</main></div>`;
};
const render = () => {
  scenarioSelect.value = scenarios.some(([id]) => id === state.scenario) ? state.scenario : state.view === 'members' ? `members-${state.role}` : state.view;
  roleSelect.value = state.role;
  const pages = { projects: projectsPage, project: projectPage, members: membersPage, account: accountPage, tokens: tokensPage, denied: () => `<div class="page-heading"><div><div class="eyebrow">项目访问</div><h1 tabindex="-1">无法访问这个项目</h1></div></div>${stateBox('项目不存在或你没有访问权限', '如果你认为应该可以访问，请联系项目管理员获取邀请。', button('返回我的项目', 'projects', 'primary'), 'lock')}` };
  app.innerHTML = state.view === 'login' ? loginPage() : state.view === 'invite' ? invitePage() : shell(pages[state.view](), state.view === 'projects' ? '我的项目' : state.view === 'members' ? `${escapeHtml(state.name)} / 项目成员` : ['account', 'tokens'].includes(state.view) ? '账户设置' : escapeHtml(state.name));
  document.title = `Daynight · ${state.view === 'login' ? '登录' : state.view === 'invite' ? '项目邀请' : state.view === 'members' ? '项目成员' : state.view === 'tokens' ? '访问令牌' : '项目协作'}`;
};

const closeDialog = () => {
  clearTimeout(transitionTimer);
  const dialog = dialogRoot.querySelector('dialog');
  if (dialog) dialog.close();
};
const openDialog = ({ title, body, confirm = '确认', danger = false, submit, cancel = () => {} }) => {
  closeDialog();
  dialogOpener = document.activeElement;
  dialogSubmit = submit;
  dialogCancel = cancel;
  dialogRoot.innerHTML = `<dialog aria-labelledby="dialog-title"><form id="dialog-form"><header class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="close-button" type="button" data-action="cancel-dialog" aria-label="关闭对话框">${icon('close', 18)}</button></header><div class="dialog-body">${body}</div><footer class="dialog-footer">${button('取消', 'cancel-dialog', '', 'type="button"')}<button class="button ${danger ? 'danger' : 'primary'}" type="submit">${confirm}</button></footer></form></dialog>`;
  const dialog = dialogRoot.querySelector('dialog');
  dialog.addEventListener('cancel', () => dialogCancel());
  dialog.addEventListener('close', () => {
    if (dialogRoot.firstElementChild !== dialog) return;
    dialogRoot.innerHTML = '';
    if (dialogOpener?.isConnected) dialogOpener.focus();
    else headingFocus();
  }, { once: true });
  dialog.showModal();
};
const infoDialog = (title, body, confirm = '完成') => openDialog({ title, body, confirm, submit: () => closeDialog() });
const openPreview = (status) => {
  closeDialog();
  dialogOpener = document.activeElement;
  const content = status === 'preview-html' ? '<iframe id="attachment-frame" class="attachment-frame" src="preview-assets/index.html" title="HTML 预览：site/index.html" tabindex="0"></iframe>' : status === 'preview-loading' ? `<div class="preview-state" role="status"><span class="spinner"></span><p>正在加载预览…</p></div>` : `<div class="preview-state" role="alert"><span class="state-icon">${icon('warning', 24)}</span><h3>无法加载文件预览</h3><p>请重试，或稍后再打开这个文件。</p>${button('重试预览', 'retry-preview')}</div>`;
  dialogRoot.innerHTML = `<dialog class="task-detail-dialog" aria-labelledby="task-detail-title"><header class="task-detail-header"><h2 id="task-detail-title">任务详情</h2><button class="button task-detail-close" data-action="close-preview" aria-label="关闭任务详情">${icon('close', 15)}</button></header><div class="task-detail-body"><div class="task-detail-heading"><p class="task-detail-id">TASK-107</p><h3 class="task-detail-title">团队邀请与账户管理</h3><div class="task-detail-badges"><span class="badge admin">进行中</span><span class="badge">Daynight</span></div></div><div class="task-detail-columns"><div class="task-detail-main"><section class="task-detail-section"><h4>描述</h4><p class="task-detail-description">让协作者安全加入项目，为 CLI 和 Agent 管理访问凭据。</p></section><section class="task-detail-section"><h4>附件</h4><div class="attachment-file-selected">${icon('repo', 14)}<span>site/index.html</span><span class="muted small">2.4 KB</span></div><div class="attachment-preview"><header class="attachment-preview-header"><div><h5>site/index.html</h5><p>HTML · 项目附件</p></div><span class="badge">预览</span></header>${content}</div></section></div><aside class="task-detail-aside" aria-label="任务元数据"><section class="task-detail-section"><h4>任务信息</h4><div class="task-detail-metadata"><div><span>创建时间</span><span>2026 年 10 月 22 日 13:10</span></div><div><span>最近更新</span><span>今天 14:32</span></div></div></section></aside></div></div><footer class="task-detail-footer">按 Esc 关闭 · 使用 Tab 在预览与任务操作之间切换</footer></dialog>`;
  const dialog = dialogRoot.querySelector('dialog');
  dialog.addEventListener('close', () => {
    if (dialogRoot.firstElementChild !== dialog) return;
    dialogRoot.innerHTML = '';
    if (dialogOpener?.isConnected) dialogOpener.focus();
    else headingFocus();
  }, { once: true });
  dialog.showModal();
  const frame = dialog.querySelector('#attachment-frame');
  frame?.addEventListener('load', () => {
    const content = frame.contentDocument;
    content.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
      if (event.key !== 'Tab') return;
      const focusable = [...content.querySelectorAll('button, a[href]')];
      const boundary = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
      if (content.activeElement === boundary) { event.preventDefault(); dialog.querySelector('.task-detail-close').focus(); }
    });
  }, { once: true });
};
const copy = async (value, label) => {
  try {
    await navigator.clipboard.writeText(value);
    notify(`${label}已复制`);
  } catch {
    infoDialog(`复制${label}`, `<p>浏览器未允许自动复制。请选中下面的内容并复制。</p><div class="credential"><code tabindex="0">${escapeHtml(value)}</code></div>`);
  }
};
const tokenCreated = () => openDialog({ title: '访问令牌已创建', body: `<p>把令牌保存在安全的位置，然后配置到 CLI 或 Agent。</p><div class="credential"><code id="new-token">${sampleToken}</code>${button('复制', 'copy-token', '', 'type="button"')}</div><div class="one-time">令牌明文只显示这一次。关闭后无法再次查看；如果丢失，请撤销并重新创建。</div>`, confirm: '我已保存，关闭', submit: () => closeDialog() });
const createToken = () => openDialog({ title: '创建个人访问令牌', body: `<div class="field"><label for="token-name">令牌名称 <span class="required">*</span></label><input id="token-name" name="name" maxlength="100" placeholder="例如：MacBook · 日常开发" required autocomplete="off"><p class="hint">用名称区分设备或自动化用途。</p></div><div class="field"><label for="token-expiry">有效期</label><input id="token-expiry" name="expiry" type="number" min="1" max="365" value="30" required><p class="hint">按天设置有效期，范围为 1–365 天。</p></div><div class="notice" style="margin-top:20px">令牌以你的身份访问项目。请勿将令牌放入代码仓库或公开日志。</div>`, confirm: '创建令牌', submit: (form) => {
  const data = new FormData(form);
  state.tokens.unshift({ id: `token-${state.tokens.length}`, name: String(data.get('name')).trim(), created: '刚刚创建', expiry: `${data.get('expiry')} 天后到期`, status: 'active' });
  closeDialog(); render(); tokenCreated();
} });
const createInvite = () => openDialog({ title: '邀请项目成员', body: `<p>创建一个单次使用的邀请链接，分享给你希望加入项目的人。对方登录并确认后，以成员身份加入。</p><div class="notice" style="margin-top:20px">7 天后到期 · 单次使用 · 加入角色：成员</div>`, confirm: '创建邀请链接', submit: () => {
  const expiry = '7';
  state.invites.unshift({ id: `invite-${state.invites.length}`, label: '邀请新成员', created: 'Jianjun · 刚刚', expiry: `${expiry} 天后到期` });
  closeDialog(); render();
  openDialog({ title: '邀请链接已创建', body: `<p>将链接分享给一位协作者。对方需要登录并确认加入。</p><div class="credential"><code>${inviteUrl}</code>${button('复制链接', 'copy-invite', '', 'type="button"')}</div><div class="notice" style="margin-top:18px">${expiry} 天后到期 · 单次使用 · 加入角色：成员</div><div class="one-time">邀请链接只在创建时显示。关闭后无法再次复制；需要新链接时，请撤销此邀请并重新创建。</div>`, confirm: '完成', submit: () => closeDialog() });
} });
const confirmation = (title, body, confirm, submit) => openDialog({ title, body: `<p>${body}</p>`, confirm, danger: true, submit: () => { submit(); closeDialog(); render(); } });
const startLogin = (invite = false, provider = 'github') => {
  state.view = 'login'; state.scenario = 'login-loading'; state.loginProvider = provider; render(); headingFocus();
  transitionTimer = setTimeout(() => { state.scenario = invite ? 'invite' : 'projects'; state.view = invite ? 'invite' : 'projects'; render(); headingFocus(); }, 1000);
};
const handleAction = (element) => {
  const action = element.dataset.action;
  const id = element.dataset.id;
  if (['projects', 'project', 'members', 'account', 'tokens'].includes(action)) return navigate(action);
  if (action === 'cancel-dialog') { dialogCancel(); closeDialog(); return; }
  if (action === 'close-preview') { closeDialog(); return; }
  if (action === 'login') return startLogin(state.loginForInvite === true, element.dataset.provider);
  if (action === 'invite-login' || action === 'switch-account') { state.loginForInvite = true; state.view = 'login'; state.scenario = 'login'; render(); headingFocus(); return; }
  if (action === 'logout') { state.loginForInvite = false; state.view = 'login'; state.scenario = 'login'; render(); headingFocus(); return; }
  if (action === 'open-project') { const project = state.projects[Number(element.dataset.index)]; state.name = project.name; state.repository = project.repo; state.role = project.role; state.taskCount = project.tasks; state.members[0].role = project.role; if (project.members === 1) { state.members = [state.members[0]]; state.invites = []; } else if (state.members.length === 1) { state.members.push({ id: 'alice', initials: 'AL', name: 'Alice Chen', email: 'alice.chen@example.com', role: 'admin', color: 'green' }, { id: 'bob', initials: 'BW', name: 'Bob Wang', email: 'bob.wang@example.com', role: 'member', color: 'amber' }); } return navigate('project'); }
  if (action === 'retry') { state.error = ''; if (state.scenario === 'projects-error') state.scenario = 'projects'; render(); notify('已重新加载'); return; }
  if (action === 'copy-token') return copy(sampleToken, '令牌');
  if (action === 'copy-invite') return copy(inviteUrl, '邀请链接');
  if (action === 'create-token') return createToken();
  if (action === 'open-preview') return openPreview('preview-html');
  if (action === 'retry-preview') return openPreview('preview-html');
  if (action === 'create-invite') return createInvite();
  if (action === 'revoke-token') {
    const token = state.tokens.find((item) => item.id === id);
    return confirmation('撤销访问令牌？', `“${escapeHtml(token.name)}”将立即无法发起新的请求。使用它的 CLI 或 Agent 需要配置新的令牌。`, '撤销令牌', () => { token.status = 'revoked'; token.expiry = '刚刚撤销'; notify('访问令牌已撤销'); });
  }
  if (action === 'revoke-invite') return confirmation('撤销这个邀请？', '撤销后，尚未加入的协作者将无法再使用这个链接。已经加入的成员不受影响。', '撤销邀请', () => { state.invites = state.invites.filter((invite) => invite.id !== id); notify('邀请已撤销'); });
  if (action === 'remove-member') {
    const member = state.members.find((item) => item.id === id);
    return confirmation(`移除 ${escapeHtml(member.name)}？`, member.self ? '移除后，你将无法继续访问这个项目。重新加入需要管理员邀请。' : '移除后，对方的浏览器和访问令牌将无法继续访问这个项目。', '移除成员', () => {
      if (member.self) { state.projects = state.projects.filter((project) => project.name !== state.name); state.view = 'projects'; state.scenario = 'projects'; }
      else state.members = state.members.filter((item) => item.id !== id);
      notify(member.self ? '已移除你的项目成员身份' : '成员已移除');
    });
  }
  if (action === 'accept-invite') { state.scenario = 'invite-member'; render(); notify('已加入 Daynight'); headingFocus(); return; }
  if (action === 'create-project') return openDialog({ title: '创建私有项目', body: `<div class="field"><label for="project-name">项目名称 <span class="required">*</span></label><input id="project-name" name="name" required maxlength="160" placeholder="例如：团队开发平台" autocomplete="off"></div><div class="field"><label for="project-repo">代码仓库 <span class="required">*</span></label><input id="project-repo" name="repo" placeholder="https://github.com/organization/repository" type="text" required autocomplete="off"><p class="hint">填写 HTTPS 或 SSH Git 地址，例如 git@github.com:organization/repository.git。</p></div><div class="notice" style="margin-top:20px">你将成为项目管理员。项目仅对你和你邀请的成员可见。</div>`, confirm: '创建项目', submit: (form) => {
    const data = new FormData(form); const name = String(data.get('name')).trim();
    state.projects.unshift({ name, repo: String(data.get('repo')), role: 'admin', members: 1, tasks: 0, date: '刚刚' });
    closeDialog(); state.name = name; state.repository = String(data.get('repo')); state.role = 'admin'; state.taskCount = 0; state.members = [{ ...state.members[0], role: 'admin' }]; state.invites = []; state.view = 'project'; state.scenario = 'project'; render(); headingFocus(); notify('私有项目已创建');
  } });
};
document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled || element.tagName === 'SELECT') return;
  handleAction(element);
});
document.addEventListener('change', (event) => {
  const element = event.target;
  if (element.dataset.action !== 'member-role') return;
  const member = state.members.find((item) => item.id === element.dataset.id);
  const role = element.value;
  if (role === member.role) return;
  openDialog({ title: `变更 ${escapeHtml(member.name)} 的角色？`, body: `<p>${role === 'admin' ? '管理员可以管理项目成员和邀请，并保留全部项目读写权限。' : '成员可以继续读写项目资源，成员和邀请由管理员管理。'}${member.self && role === 'member' ? '变更后，你将失去成员管理权限。' : ''}</p>`, confirm: '保存角色', cancel: () => { element.value = member.role; }, submit: () => {
    member.role = role;
    if (member.self) state.role = role;
    closeDialog(); render(); notify('项目角色已更新');
  } });
});
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'dialog-form') return;
  event.preventDefault();
  const emptyRequired = [...event.target.querySelectorAll('input[required]')].find((input) => !input.value.trim());
  if (emptyRequired) { emptyRequired.setCustomValidity('请填写此字段。'); emptyRequired.reportValidity(); emptyRequired.addEventListener('input', () => emptyRequired.setCustomValidity(''), { once: true }); return; }
  dialogSubmit(event.target);
});
scenarioSelect.innerHTML = scenarios.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
scenarioSelect.addEventListener('change', () => setScenario(scenarioSelect.value));
roleSelect.addEventListener('change', () => {
  setScenario(`members-${roleSelect.value}`);
});
setScenario(new URLSearchParams(location.search).get('scenario') || 'projects');
