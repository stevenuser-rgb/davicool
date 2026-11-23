document.addEventListener('DOMContentLoaded', () => {
  const byId = id => document.getElementById(id);
  const entry = byId('importCustomersBtn');
  const menu = entry.closest('details');
  const dialog = byId('customerImportDialog');
  const form = byId('customerImportForm');
  const select = byId('importRegion');
  const newRegion = byId('newImportRegion');
  const fileInput = byId('importFile');
  const message = byId('customerImportMessage');
  const previewSection = byId('customerImportPreview');
  const previewButton = byId('previewCustomerImport');
  const commitButton = byId('commitCustomerImport');
  const closeButton = byId('closeCustomerImport');
  const history = byId('customerImportHistory');
  const receipts = byId('customerImportReceipts');
  const statusLabels = { add: '可新增', existing: '已存在', review: '需確認', invalid: '格式錯誤' };
  const newRegionValue = '__new_region__';
  let draft = null;
  let busy = false;
  let sessionVersion = 0;

  document.addEventListener('crm-session-change', async () => {
    const version = ++sessionVersion;
    entry.classList.add('hidden');
    if (document.getElementById('appShell').classList.contains('hidden') || state.currentUser?.role !== 'admin') {
      if (dialog.open) dialog.close();
      return;
    }
    try {
      const status = await api('/api/customer-import/status');
      if (sessionVersion === version) entry.classList.toggle('hidden', !status.enabled);
    } catch {}
  });

  entry.addEventListener('click', () => {
    form.reset();
    const regions = [...new Set(state.records.map(record => record.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    select.replaceChildren(new Option('選擇區域', ''), ...regions.map(region => new Option(region, region)), new Option('＋ 新增區域', newRegionValue));
    select.value = regions.includes(el.regionFilter.value) ? el.regionFilter.value : '';
    history.open = false;
    updateRegionField();
    resetPreview();
    menu.open = false;
    dialog.showModal();
    refreshIcons();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    resetPreview();
    form.reset();
    if (!entry.classList.contains('hidden')) menu.querySelector('summary').focus();
  });
  select.addEventListener('change', updateRegionField);
  form.addEventListener('input', resetPreview);
  fileInput.addEventListener('change', resetPreview);
  byId('importTemplate').addEventListener('click', () => {
    const csv = '\ufeff所屬區域,工廠登記編號,公司名稱,工廠地址,負責人姓名,電話\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '特登名單匯入範本.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const file = fileInput.files[0];
    if (!file || file.size > 512 * 1024) return announce('請選擇 512 KB 以下的名單檔案。', true);
    const createRegion = select.value === newRegionValue;
    const region = createRegion ? newRegion.value.trim() : select.value;
    resetPreview();
    setBusy(true);
    announce('正在核對名單…');
    try {
      const content = await readFile(file);
      draft = await api('/api/customer-import/preview', {
        method: 'POST', body: JSON.stringify({ name: file.name, content, region, createRegion })
      });
      if (dialog.open) renderPreview(draft);
    } catch (reason) { announce(reason.message, true); }
    finally { setBusy(false); }
  });

  commitButton.addEventListener('click', async () => {
    if (busy || !draft?.counts.add) return;
    const batchId = draft.batchId;
    setBusy(true);
    announce('正在匯入總表與區域分頁…');
    try {
      const result = await api('/api/customer-import/commit', {
        method: 'POST', body: JSON.stringify({ batchId })
      });
      resetPreview();
      fileInput.value = '';
      announce(`已新增 ${result.added} 筆至總表與「${result.regionSheet}」；批次 ${result.batchId}。`);
      if (history.open) void loadHistory();
      await loadData();
      if (select.value === newRegionValue && !Array.from(select.options).some(option => option.value === result.region)) {
        select.add(new Option(result.region, result.region), select.options.length - 1);
        select.value = result.region;
        updateRegionField();
      }
    } catch (reason) { announce(reason.message, true); }
    finally { setBusy(false); }
  });
  history.addEventListener('toggle', () => { if (history.open) void loadHistory(); });

  function announce(text, failure = false) {
    message.textContent = text;
    message.dataset.error = String(failure);
  }
  function resetPreview() {
    draft = null;
    previewSection.classList.add('hidden');
    commitButton.disabled = true;
    announce('');
  }
  function updateRegionField() {
    const creates = select.value === newRegionValue;
    byId('newImportRegionField').classList.toggle('hidden', !creates);
    newRegion.required = creates;
    newRegion.disabled = !creates || busy;
  }
  function setBusy(value) {
    busy = value;
    [select, fileInput, previewButton, closeButton].forEach(control => { control.disabled = value; });
    commitButton.disabled = value || !draft?.counts.add;
    updateRegionField();
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('無法讀取檔案。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  }
  function renderPreview(result) {
    announce(result.counts.add ? '' : '沒有可新增的資料。');
    byId('customerImportTarget').textContent = `客戶總表 ＋ ${result.regionSheet}${result.createsRegion ? '（新分頁）' : ''}`;
    byId('commitCustomerImportLabel').textContent = `確認新增 ${result.counts.add} 筆`;
    byId('customerImportCounts').innerHTML = Object.entries(statusLabels).map(([key, label]) =>
      `<div><dt>${label}</dt><dd>${Number(result.counts[key])}</dd></div>`).join('');
    byId('customerImportRows').innerHTML = result.rows.map(row =>
      `<tr data-result="${escapeHtml(row.status)}"><td>${Number(row.line)}</td><td>${escapeHtml(row.factoryId)}</td>
      <td>${escapeHtml(row.company)}</td><td>${statusLabels[row.status] || ''}</td><td>${escapeHtml(row.message)}</td></tr>`).join('');
    previewSection.classList.remove('hidden');
  }
  async function loadHistory() {
    receipts.textContent = '正在載入…';
    try {
      const result = await api('/api/customer-import/history');
      if (!result.receipts.length) { receipts.textContent = '尚無匯入紀錄。'; return; }
      receipts.innerHTML = `<ul class="import-receipts">${result.receipts.map(row =>
        `<li>${escapeHtml(new Date(row.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }))}｜${escapeHtml(row.region)}｜新增 ${Number(row.added)} 筆
        （跳過 ${Number(row.counts.existing + row.counts.review + row.counts.invalid)} 筆）｜${escapeHtml(row.operator)}｜${escapeHtml(row.batchId)}</li>`).join('')}</ul>`;
    } catch (reason) { receipts.textContent = reason.message; }
  }
});
