(() => {
  const style = document.createElement('style');
  style.textContent = `
    .workspace-view { padding: 18px 24px 28px; }
    .workspace-shell { display: grid; gap: 14px; }
    .workspace-intro { display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .workspace-intro h2 { margin:0; font-size:20px; }
    .workspace-intro p { margin:4px 0 0; color:var(--muted); font-size:13px; }
    .workspace-layout { display:grid; grid-template-columns:minmax(300px,.55fr) minmax(440px,1fr); gap:18px; align-items:start; }
    .workspace-view .filters { display:grid !important; padding:14px 0; border:0; background:transparent; }
    .workspace-view .list-layout { display:contents; }
    .workspace-view .list-layout > section { min-width:0; }
    .workspace-view .summary-grid { display:none; }
    .workspace-view .detail-panel { position:sticky; top:16px; width:auto; max-height:calc(100vh - 32px); }
    .workspace-view .detail-body { padding:18px; }
    .workspace-view .local-form { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .workspace-view .local-form h3, .workspace-view .local-form .status-buttons, .workspace-view .local-form .field:has(textarea), .workspace-view .local-form > button { grid-column:1 / -1; }
    .workspace-view .table-wrap { max-height:calc(100vh - 278px); }
    .workspace-view table { min-width:0; }
    .workspace-view th:nth-child(4), .workspace-view td:nth-child(4), .workspace-view th:nth-child(5), .workspace-view td:nth-child(5), .workspace-view th:nth-child(6), .workspace-view td:nth-child(6), .workspace-view th:nth-child(8), .workspace-view td:nth-child(8), .workspace-view th:nth-child(9), .workspace-view td:nth-child(9) { display:none; }
    .workspace-editor-tabs { display:flex; gap:8px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--line); background:#fbfcfb; }
    .workspace-editor-tab { min-height:36px; display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:0 12px; border-radius:8px; border:1px solid var(--line); background:#eef2f4; color:#334047; font-weight:800; }
    .workspace-editor-tab.active { background:var(--teal); border-color:var(--teal); color:#fff; }
    .workspace-view [data-workspace-pane].workspace-pane-hidden { display:none !important; }
    .workspace-view .detail-title { padding-bottom:12px; border-bottom:1px solid #edf0f2; }
    .workspace-view .detail-title h2 { font-size:24px; }
    .workspace-view .local-form > h3:first-child { margin-top:0; }
    .workspace-view .note-box { max-height:360px; overflow:auto; }
    @media(max-width:1180px) { .workspace-layout { grid-template-columns:1fr; } .workspace-view .detail-panel { position:static; max-height:none; } .workspace-view .table-wrap { max-height:360px; } }
    @media(max-width:560px) { .workspace-view { padding:14px; } .workspace-intro { align-items:flex-start; flex-direction:column; } .workspace-view .local-form { grid-template-columns:1fr; } .workspace-editor-tabs { display:grid; grid-template-columns:repeat(3,1fr); } .workspace-editor-tab { padding:0 6px; font-size:12px; } }
  `;
  document.head.appendChild(style);

  function init() {
    const app = document.getElementById('appShell');
    const listView = document.getElementById('listView');
    const listLayout = listView?.querySelector('.list-layout');
    const listSection = listLayout?.querySelector(':scope > section');
    const detailPanel = document.getElementById('detailPanel');
    const filters = document.getElementById('filtersBar');
    const dashboardButton = document.querySelector('[data-view="dashboard"]');
    if (!app || !listView || !listLayout || !listSection || !detailPanel || !filters || !dashboardButton) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab-button';
    tab.dataset.view = 'workspace';
    tab.innerHTML = '<i data-lucide="panel-right-open"></i>新版工作台';
    dashboardButton.insertAdjacentElement('afterend', tab);

    const workspaceView = document.createElement('main');
    workspaceView.id = 'workspaceView';
    workspaceView.className = 'workspace-view hidden';
    workspaceView.innerHTML = '<div class="workspace-shell"><div class="workspace-intro"><div><h2>新版客戶工作台</h2><p>左側查詢與選取客戶，右側集中處理分級、追蹤、開發業務、代辦業者與拜訪回報。</p></div><span class="count-pill">新版測試中</span></div><div id="workspaceFilters"></div><div class="workspace-layout"><section id="workspaceList"></section><aside id="workspaceEditor"></aside></div></div>';
    app.appendChild(workspaceView);

    const workspaceFilters = workspaceView.querySelector('#workspaceFilters');
    const workspaceList = workspaceView.querySelector('#workspaceList');
    const workspaceEditor = workspaceView.querySelector('#workspaceEditor');

    let workspaceActive = false;
    let selectedWorkspacePane = 'visit';

    function setWorkspacePane(name) {
      selectedWorkspacePane = name;
      detailPanel.querySelectorAll('.workspace-editor-tab').forEach((button) => {
        const active = button.dataset.workspaceTab === name;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      });
      detailPanel.querySelectorAll('[data-workspace-pane]').forEach((pane) => {
        pane.classList.toggle('workspace-pane-hidden', pane.dataset.workspacePane !== name && pane.dataset.workspacePane !== 'always');
      });
    }

    function enhanceDetail() {
      if (!workspaceActive || detailPanel.querySelector('.workspace-editor-tabs')) return;
      const body = detailPanel.querySelector('.detail-body');
      const head = detailPanel.querySelector('.panel-head');
      if (!body || !head) return;

      const title = body.querySelector('.detail-title');
      const info = body.querySelector('dl');
      const profile = body.querySelector('#profileEditSection');
      const localForm = body.querySelector('.local-form:not(#profileEditSection)');
      const history = [...body.querySelectorAll(':scope > section')].find((section) => section.querySelector('h3')?.textContent.includes('原始拜訪回報'));

      if (title) title.dataset.workspacePane = 'always';
      if (info) info.dataset.workspacePane = 'profile';
      if (profile) profile.dataset.workspacePane = 'profile';
      if (localForm) localForm.dataset.workspacePane = 'visit';
      if (history) history.dataset.workspacePane = 'history';

      const tabs = document.createElement('div');
      tabs.className = 'workspace-editor-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', '客戶工作分頁');
      tabs.innerHTML = [
        ['visit', 'clipboard-pen-line', '新增回報'],
        ['profile', 'building-2', '客戶資料'],
        ['history', 'history', '歷史紀錄'],
      ].map(([name, icon, label]) => `<button type="button" class="workspace-editor-tab" data-workspace-tab="${name}" role="tab"><i data-lucide="${icon}"></i>${label}</button>`).join('');
      head.insertAdjacentElement('afterend', tabs);
      tabs.querySelectorAll('[data-workspace-tab]').forEach((button) => {
        button.addEventListener('click', () => setWorkspacePane(button.dataset.workspaceTab));
      });
      setWorkspacePane(selectedWorkspacePane);
      if (window.lucide) window.lucide.createIcons();
    }

    function cleanupDetail() {
      detailPanel.querySelector('.workspace-editor-tabs')?.remove();
      detailPanel.querySelectorAll('[data-workspace-pane]').forEach((pane) => {
        delete pane.dataset.workspacePane;
        pane.classList.remove('workspace-pane-hidden');
      });
    }

    const detailObserver = new MutationObserver(() => {
      if (workspaceActive) window.queueMicrotask(enhanceDetail);
    });
    detailObserver.observe(detailPanel, { childList: true, subtree: true });

    function activateWorkspace() {
      workspaceActive = true;
      workspaceView.classList.remove('hidden');
      workspaceFilters.appendChild(filters);
      workspaceList.appendChild(listSection);
      workspaceEditor.appendChild(detailPanel);
      filters.classList.remove('hidden');
      tab.classList.add('active');
      enhanceDetail();
      if (window.lucide) window.lucide.createIcons();
    }

    function restoreList() {
      workspaceActive = false;
      cleanupDetail();
      if (!workspaceView.contains(listSection)) return;
      listLayout.prepend(listSection);
      listLayout.appendChild(detailPanel);
      listView.before(filters);
      workspaceView.classList.add('hidden');
    }

    tab.addEventListener('click', () => {
      window.setTimeout(activateWorkspace, 0);
    });

    document.querySelector('[data-view="list"]')?.addEventListener('click', () => {
      restoreList();
    });
    dashboardButton.addEventListener('click', () => {
      restoreList();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
