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
    .workspace-view .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .workspace-view .metric { min-height:76px; padding:12px; }
    .workspace-view .metric strong { font-size:23px; margin-top:5px; }
    .workspace-view .detail-panel { position:sticky; top:16px; width:auto; max-height:calc(100vh - 32px); }
    .workspace-view .detail-body { padding:18px; }
    .workspace-view .local-form { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .workspace-view .local-form h3, .workspace-view .local-form .status-buttons, .workspace-view .local-form .field:has(textarea), .workspace-view .local-form > button { grid-column:1 / -1; }
    .workspace-view .table-wrap { max-height:calc(100vh - 360px); }
    .workspace-view table { min-width:0; }
    .workspace-view th:nth-child(4), .workspace-view td:nth-child(4), .workspace-view th:nth-child(5), .workspace-view td:nth-child(5), .workspace-view th:nth-child(6), .workspace-view td:nth-child(6), .workspace-view th:nth-child(8), .workspace-view td:nth-child(8), .workspace-view th:nth-child(9), .workspace-view td:nth-child(9) { display:none; }
    @media(max-width:1180px) { .workspace-layout { grid-template-columns:1fr; } .workspace-view .detail-panel { position:static; max-height:none; } .workspace-view .table-wrap { max-height:360px; } }
    @media(max-width:560px) { .workspace-view { padding:14px; } .workspace-intro { align-items:flex-start; flex-direction:column; } .workspace-view .local-form { grid-template-columns:1fr; } }
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

    function activateWorkspace() {
      workspaceView.classList.remove('hidden');
      workspaceFilters.appendChild(filters);
      workspaceList.appendChild(listSection);
      workspaceEditor.appendChild(detailPanel);
      filters.classList.remove('hidden');
      tab.classList.add('active');
      if (window.lucide) window.lucide.createIcons();
    }

    function restoreList() {
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
