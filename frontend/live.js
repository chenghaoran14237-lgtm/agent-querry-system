const $ = (selector) => document.querySelector(selector);
const state = { user: null, connection: null, sources: [], sourceId: null, selectedTable: null, sample: null, job: null, pollTimer: null, sampleRows: [], appId: null, spec: null, catalog: null, pollBusy: false, mirror: null, mirrorSupported: true, mirrorRecords: [], mirrorPage: 1, mirrorPageSize: 20, mirrorTotal: 0, mirrorPages: 1, mirrorImportTimer: null, recordMode: 'create', recordId: null, recordVersion: null, currentApp: null, includeArchived: false };
const statusSteps = ['queued','discovering','connecting','streaming','validating','completed'];

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const message = payload.detail?.message || payload.error?.message || payload.message || `请求失败（${response.status}）`; const error = new Error(message); error.status = response.status; throw error; }
  return payload;
}
function setText(selector, value) { const node = $(selector); if (node) node.textContent = value == null ? '' : String(value); }
function show(selector, visible = true) { const node = $(selector); if (node) node.classList.toggle('hidden', !visible); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => node.classList.remove('show'), 2600); }
function addMessage(role, text) { const node = document.createElement('div'); node.className = `message ${role}`; node.textContent = text; $('#messages').appendChild(node); $('#messages').scrollTop = $('#messages').scrollHeight; }
function activeBindingId() { return state.mirror?.binding_id || state.mirror?.id || state.mirror?.binding?.id || (state.mirror?.type === 'binding' ? state.mirror.id : '') || state.spec?.binding_id || state.spec?.source?.binding_id || state.currentApp?.spec?.binding_id || ''; }
function activeSourceTable() { const source = state.spec?.source || state.selectedTable || state.currentApp?.spec?.source; return source && source.schema_name && source.table_name ? source : null; }
function isLocalMode(spec = state.spec) { return Boolean(spec?.data_mode === 'local_mirror' || spec?.binding_id || activeBindingId()); }
function mirrorRowData(row) { if (!row) return {}; if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) return row.data; if (row.data_json) { try { return JSON.parse(row.data_json); } catch (_) { return {}; } } return row; }
function mirrorRowId(row) { return row?._id ?? row?.pk ?? row?._mirror_id ?? row?.source_pk ?? row?._source_pk ?? row?.id ?? mirrorRowData(row).id ?? mirrorRowData(row).bed_master_id ?? mirrorRowData(row).code ?? ''; }
function mirrorColumns() { const cols = state.spec?.columns || state.mirror?.columns || state.mirror?.binding?.columns || state.selectedTable?.columns || []; return cols.map((column) => ({ field: column.field || column.name || column.column_name, label: column.label || column.display_name || column.comment || column.field || column.name || column.column_name, type: column.type || column.data_type || 'text', nullable: column.nullable !== false })); }
function setMirrorStatus(kind, text) { const badge = $('#mirrorStatusBadge'); if (!badge) return; badge.className = `mirror-badge ${kind}`; badge.textContent = text; }
function renderMirrorStatus(data = state.mirror) {
  setText('#mirrorMetric', data ? (['ready', 'completed'].includes(String(data.status || data.state || '').toLowerCase()) ? '已就绪' : '已配置') : '未导入');
  if (!data) { setMirrorStatus('idle', '尚未导入'); setText('#mirrorStatusText', state.mirrorSupported ? '先选择数据表，再导入一个本地副本。' : '当前后端尚未启用本地副本接口。'); $('#mirrorStats').textContent = ''; $('#importMirror').disabled = !state.selectedTable || !state.mirrorSupported; return; }
  const status = String(data.status || data.state || data.import_status || 'ready').toLowerCase();
  const label = ({ready:'已就绪',completed:'已就绪',running:'导入中',queued:'排队中',failed:'导入失败',preview_sample:'样例预览',sample_only:'仅样例'})[status] || status;
  setMirrorStatus(status === 'failed' ? 'failed' : ['running','queued'].includes(status) ? 'running' : data.mode === 'preview_sample' || status === 'preview_sample' || data.capability === 'sample_only' ? 'preview' : 'ready', label);
  const source = data.schema_name && data.table_name ? `${data.schema_name}.${data.table_name}` : activeSourceTable() ? `${activeSourceTable().schema_name}.${activeSourceTable().table_name}` : '当前表';
  const mode = data.mode === 'preview_sample' || data.capability === 'sample_only' ? '本地副本（脱敏样例来源）' : '本地工作副本';
  setText('#mirrorStatusText', `${source} · ${mode}${data.updated_at ? ` · 最近更新 ${formatDate(data.updated_at)}` : ''}`);
  const stats = $('#mirrorStats'); stats.textContent = '';
  [['本地记录', data.row_count ?? data.active_row_count ?? data.total ?? data.count ?? '—'], ['副本版本', data.version || data.snapshot_version || data.snapshot_id || '—'], ['导入状态', data.sync_state || (status === 'ready' || status === 'completed' ? '已持久化' : label)]].forEach(([name, value]) => { const box = document.createElement('div'); box.className = 'mirror-stat'; box.innerHTML = `<span></span><b></b>`; box.querySelector('span').textContent = name; box.querySelector('b').textContent = value; stats.appendChild(box); });
  $('#importMirror').disabled = !state.selectedTable || !state.mirrorSupported || ['running','queued'].includes(status);
}
async function loadMirrorState() {
  try { const data = await api('/api/live/mirror'); const bindings = data.bindings || data.items || []; state.mirror = data.binding || data.mirror || data.active_binding || bindings.find((item) => Number(item.source_id) === Number(state.sourceId) && item.schema_name === state.selectedTable?.schema_name && item.table_name === state.selectedTable?.table_name) || null; state.mirrorSupported = true; renderMirrorStatus(state.mirror); return data; }
  catch (error) { state.mirrorSupported = error.status !== 404; state.mirror = null; renderMirrorStatus(null); if (error.status !== 404 && error.status !== 401) setText('#mirrorStatusText', `本地副本状态读取失败：${error.message}`); return null; }
}
async function startMirrorImport() {
  const source = activeSourceTable(); if (!source || !state.sourceId) return toast('请先选择一张远端数据表');
  const mode = $('#importMode')?.value || 'local_mirror'; const button = $('#importForm button[type="submit"]'); if (button) button.disabled = true; $('#importError').textContent = '';
  try {
    const result = await api('/api/live/mirror/import', {method:'POST', body:JSON.stringify({source_id:state.sourceId, schema_name:source.schema_name, table_name:source.table_name, mode, limit: 20})});
    if ($('#importDialog').open) $('#importDialog').close(); state.mirror = result.binding || result.mirror || result; renderMirrorStatus(state.mirror); toast(result.status === 'completed' ? '本地副本导入完成' : '本地副本导入已开始');
    const importId = result.import_id || result.id || result.run_id; if (importId && !['completed','failed'].includes(result.status)) pollMirrorImport(importId);
    await loadMirrorState();
  } catch (error) { $('#importError').textContent = error.message; toast(`导入失败：${error.message}`); }
  finally { if (button) button.disabled = false; }
}
async function pollMirrorImport(importId) {
  clearTimeout(state.mirrorImportTimer); setText('#mirrorImportProgress', `导入任务 ${importId} 运行中…`);
  try {
    const data = await api(`/api/live/mirror/imports/${encodeURIComponent(importId)}`); state.mirror = data.binding || data.mirror || data; renderMirrorStatus(state.mirror);
    const status = String(data.status || data.state || '').toLowerCase();
    if (['completed','failed','cancelled','interrupted'].includes(status)) { setText('#mirrorImportProgress', status === 'completed' ? '导入完成' : `导入${status === 'failed' ? '失败' : '已结束'}`); await loadMirrorState(); if (state.samplePanelOpen) loadMirrorRecords(); return; }
    setText('#mirrorImportProgress', data.progress != null ? `导入中 ${data.progress}%` : '导入中…'); state.mirrorImportTimer = setTimeout(() => pollMirrorImport(importId), 1200);
  } catch (error) { setText('#mirrorImportProgress', `导入任务查询失败：${error.message}`); }
}
function setPill(connected, external) { const pill = $('#externalPill'); pill.className = `pill ${connected ? (external ? 'success' : 'neutral') : 'warning'}`; pill.textContent = connected ? (external ? 'External v1 已配置' : '线上会话 API · 已连接') : '未连接'; const dot = $('#connectionDot'); dot.classList.toggle('connected', connected); dot.querySelector('span').textContent = connected ? `已登录 · ${state.user?.username || ''}` : '未登录线上服务'; }
function renderUser(status) { state.user = status.user || null; setPill(Boolean(status.connected), Boolean(status.external_configured)); show('#loginNotice', !status.connected); $('#accountButton').textContent = status.connected ? `${status.user?.username || '已登录'} · 退出` : '登录'; setText('#connectionState', status.connected ? '远端服务已连接' : '尚未连接'); setText('#sessionMetric', status.connected ? '已连接' : '未连接'); }
async function loadStatus() { try { const status = await api('/api/live/status'); renderUser(status); state.connection = status.connection || null; if (status.connected) await Promise.all([loadSources(), loadApps(), loadMirrorState()]); else renderMirrorStatus(null); } catch (error) { setPill(false, false); show('#loginNotice', true); renderMirrorStatus(null); toast(`登录态检查失败：${error.message}`); } }
function openLogin() { $('#loginError').textContent = ''; $('#password').value = ''; $('#loginDialog').showModal(); setTimeout(() => $('#password').focus(), 50); }
async function login(event) {
  event.preventDefault(); $('#loginError').textContent = '';
  const button = $('#loginForm button[type="submit"]'); button.disabled = true;
  try {
    const result = await api('/api/live/login', {method:'POST',body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value})});
    $('#password').value = ''; renderUser(result); $('#loginDialog').close();
    await Promise.all([loadSources(),loadApps(),loadMirrorState()]);
  } catch(error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
}
async function logout() {
  try {
    await api('/api/live/logout', {method:'POST',body:'{}'});
    clearTimeout(state.pollTimer); location.reload();
  } catch(error) { toast(error.message); }
}
async function loadSources() {
  const data = await api('/api/live/sources'); state.sources = data.sources || [];
  setText('#sourceMetric', state.sources.length || '0');
  setText('#sourceCount', state.sources.length + ' 个');
  $('#sources').textContent=''; $('#builderSource').textContent='';
  for(const source of state.sources) {
    const option = new Option(source.name,source.id); $('#builderSource').add(option);
    const b=document.createElement('button'); b.className='source-item'; b.textContent=source.name;
    b.dataset.id=source.id; b.onclick=()=>selectSource(source.id); $('#sources').append(b);
  }
  const preferred=state.sources.find(x=>x.id===Number(state.connection?.source_id)) || state.sources.find(x=>x.id===26)||state.sources[0];
  if(preferred) await selectSource(preferred.id);
}
async function selectSource(id) {
  if(state.job&&!['completed','failed','cancelled','interrupted'].includes(state.job.status)) return toast('当前生成完成后再切换来源');
  state.sourceId=Number(id); state.selectedTable=null; state.spec=null; state.appId=null; setText('#builderSelectedTable','尚未选择'); setText('#builderConnectionSummary','请在下方选择远端数据表');
  state.sample=null; show('#samplePanel',false); show('#tableDetail',false);
  $('#builderSource').value=id;
  document.querySelectorAll('.source-item').forEach(n=>n.classList.toggle('active',Number(n.dataset.id)===state.sourceId));
  setText('#catalogHint','source_id: '+id); await loadCatalog();
}
async function loadCatalog(cursor='') {
  if(!state.sourceId) return;
  const sourceId=state.sourceId;
  const params=new URLSearchParams({source_id:sourceId,query:$('#catalogSearch').value.trim(),limit:'30'});
  if(cursor) params.set('cursor',cursor);
  try {
    const data=await api('/api/live/catalog?'+params);
    if(sourceId!==state.sourceId) return;
    state.catalog=data; renderCatalog(data); $('#builderTable').textContent='';
    for(const item of data.table_profiles||[]) $('#builderTable').add(new Option(item.table_name+' · '+(item.table_comment||''),item.schema_name+'.'+item.table_name));
    const persisted = state.connection && Number(state.connection.source_id) === Number(sourceId) ? state.connection : null;
    const first=(data.table_profiles||[]).find(x=>persisted && x.schema_name===persisted.schema_name && x.table_name===persisted.table_name) || (data.table_profiles||[]).find(x=>x.table_name==='bed_master')||data.table_profiles?.[0];
    if(first) { $('#builderTable').value=first.schema_name+'.'+first.table_name; await loadTable(first); }
  } catch(error) { setText('#catalogTables','表画像加载失败：'+error.message); }
}
function renderCatalog(data) { const wrap = $('#catalogTables'); wrap.textContent = ''; const tables = data.table_profiles || []; if (!tables.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '没有匹配的线上表'; wrap.appendChild(empty); return; } tables.forEach((item) => { const row = document.createElement('div'); row.className = 'catalog-row'; const main = document.createElement('div'); const name = document.createElement('b'); name.textContent = `${item.schema_name}.${item.table_name}`; const comment = document.createElement('span'); comment.textContent = item.table_comment || '暂无表说明'; main.append(name, comment); const cols = document.createElement('span'); cols.textContent = `${item.column_count ?? '—'} 字段`; const rows = document.createElement('span'); rows.textContent = `${item.row_count ?? '—'} 行`; const button = document.createElement('button'); button.textContent = '查看'; button.onclick = () => loadTable(item); row.append(main, cols, rows, button); wrap.appendChild(row); });
  if(data.has_more&&data.next_cursor) { const more=document.createElement('button'); more.className='light'; more.textContent='下一页表画像'; more.onclick=()=>loadCatalog(data.next_cursor); wrap.append(more); }
}
async function loadTable(item) {
  if(state.job&&!['completed','failed','cancelled','interrupted'].includes(state.job.status)) return toast('当前生成完成后再切换表');
  const selectionId=crypto.randomUUID(); state.selectionId=selectionId;
  const sourceId=state.sourceId; state.selectedTable=null;
  state.appId=null; state.spec=null; state.sample=null; show('#specCard',false); show('#samplePanel',false);
  show('#tableDetail',true); setText('#detailName',item.schema_name+'.'+item.table_name);
  setText('#detailMeta','正在读取字段画像…'); $('#columnsTable').textContent='';
  try {
    const params=new URLSearchParams({source_id:sourceId,schema_name:item.schema_name,table_name:item.table_name});
    const data=await api('/api/live/table?'+params);
    if(sourceId!==state.sourceId||selectionId!==state.selectionId) return;
    state.selectedTable=data; state.connection={source_id:sourceId,schema_name:item.schema_name,table_name:item.table_name,profile_run_id:data.profile_run_id}; $('#builderTable').value=item.schema_name+'.'+item.table_name; setText('#builderSelectedTable', `${item.schema_name}.${item.table_name}`); setText('#builderConnectionSummary', `${item.schema_name}.${item.table_name} · ${data.columns.length} 个字段`); await api('/api/live/connection',{method:'PUT',body:JSON.stringify(state.connection)}); await loadMirrorState();
    setText('#bindingHint',data.columns.length+' 个真实字段 · 可导入本地副本'); $('#importMirror').disabled = false; renderMirrorStatus(state.mirror); $('#importFromDetail').onclick = openImportDialog;
    setText('#detailMeta','source_id '+data.source_id+' · profile '+data.profile_run_id+' · 估算 '+data.row_count+' 行 · '+(data.primary_key||'无主键信息'));
    renderColumns(data.columns||[]); $('#loadSample').onclick=()=>loadSample(data);
  } catch(error) { setText('#detailMeta',error.message); setText('#bindingHint',error.message); }
}
function renderColumns(columns) { const table = document.createElement('table'); table.className = 'data-table'; const head = document.createElement('tr'); ['字段','类型','显示名称','可空','敏感'].forEach((title) => { const cell = document.createElement('th'); cell.textContent = title; head.appendChild(cell); }); const thead = document.createElement('thead'); thead.appendChild(head); const body = document.createElement('tbody'); columns.forEach((column) => { const row = document.createElement('tr'); [column.name, column.type, column.label || '—', column.nullable ? '是' : '否', column.sensitive ? '是' : '否'].forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = value; if (index === 4 && column.sensitive) cell.className = 'column-sensitive'; row.appendChild(cell); }); body.appendChild(row); }); table.append(thead, body); $('#columnsTable').appendChild(table); }
async function loadSample(table = state.selectedTable) { if (!table || !state.sourceId) return; const params = new URLSearchParams({ source_id: state.sourceId, schema_name: table.schema_name, table_name: table.table_name, limit: '20' }); try { const data = await api(`/api/live/sample?${params}`); state.sample = data; state.sampleRows = data.rows || []; state.samplePanelOpen = true; show('#samplePanel', true); setText('#sampleTitle', `${table.schema_name}.${table.table_name}`); setText('#sampleSubtitle', '远端脱敏样例预览（未导入本地）'); setText('#systemSourceBadge', '远端样例'); setText('#systemAccessMode', '远端样例'); setText('#sampleMeta', `${state.sampleRows.length} 条已加载 · profile_run_id ${data.profile_run_id || '—'}`); setText('#systemNotice', '当前显示的是远端脱敏样例；若要进行增删改查，请先返回连接页导入本地工作副本。'); renderSample(); switchView('apps'); } catch (error) { toast(`样例加载失败：${error.message}`); } }
function renderSample() {
  const wrap=$('#sampleTable'); wrap.textContent='';
  if(!state.sample) return;
  const columns=state.spec?.columns || (state.sample.columns||[]).map(field=>({field,label:state.sample.field_semantics?.find(x=>x.column_name===field)?.display_name||field}));
  const query=$('#sampleSearch').value.trim().toLowerCase();
  const selected=[...document.querySelectorAll('#specFilters select')].map(n=>[n.dataset.field,n.value]);
  const rows=state.sampleRows.filter(row=>(!query||columns.some(c=>String(row[c.field]??'').toLowerCase().includes(query)))&&selected.every(([field,value])=>!value||String(row[field]??'')===value));
  const table=document.createElement('table'); table.className='data-table';
  const head=table.createTHead().insertRow();
  for(const col of columns) { const th=document.createElement('th'); th.textContent=col.label; th.title=col.field; head.append(th); }
  const actionHead=document.createElement('th'); actionHead.textContent='操作'; head.append(actionHead);
  const body=table.createTBody();
  for(const row of rows) { const tr=body.insertRow(); for(const col of columns) tr.insertCell().textContent=String(row[col.field]??'—'); const action=tr.insertCell(); action.className='row-actions'; ['查看','编辑','删除'].forEach((label)=>{ const button=document.createElement('button'); button.className=label==='删除'?'row-action danger':'row-action'; button.textContent=label; button.dataset.action=label; button.dataset.record=String(mirrorRowId(row)); action.append(button); }); }
  wrap.append(table);
  setText('#sampleMeta',rows.length+' / '+state.sampleRows.length+' 条已加载样例 · 画像 '+(state.sample.profile_run_id || '—')+' · 非全量实时查询');
  setText('#systemResultCount', rows.length); setText('#systemSourceName', state.selectedTable ? `${state.selectedTable.schema_name}.${state.selectedTable.table_name}` : '远端表');
  document.querySelectorAll('[data-action]').forEach((button)=>button.onclick=()=>systemAction(button.dataset.action,button.dataset.record));
  if(!rows.length) { const empty=document.createElement('p'); empty.className='table-empty'; empty.textContent='当前样例没有匹配记录'; wrap.append(empty); }
}
function systemAction(action, recordId='') {
  if (isLocalMode() && activeBindingId()) { if (action === '查看') openRecordDialog('view', recordId); else if (action === '编辑') openRecordDialog('edit', recordId); else if (action === '删除') deleteMirrorRecord(recordId); else if (action === '恢复') restoreMirrorRecord(recordId); return; }
  if(action==='查看') { toast(recordId ? `已选中记录 ${recordId}` : '请选择一条记录'); return; }
  toast(`${action}暂不可用：请先导入本地工作副本`);
}
async function loadMirrorRecords() {
  const bindingId = activeBindingId(); if (!bindingId) { setText('#systemNotice','本地工作副本尚未导入。请返回“连接数据库”选择数据表并导入。'); return false; }
  const params = new URLSearchParams({binding_id: bindingId, page: String(state.mirrorPage), page_size: String(state.mirrorPageSize), q: $('#sampleSearch').value.trim(), include_archived: state.includeArchived ? '1' : '0'});
  const filters = [...document.querySelectorAll('#specFilters select')].filter((node) => node.value).map((node) => [node.dataset.field, node.value]); filters.forEach(([field,value]) => params.set(`filter.${field}`, value));
  try {
    const data = await api(`/api/live/mirror/records?${params}`); state.mirrorRecords = data.records || data.rows || data.items || []; state.mirrorTotal = Number(data.total ?? state.mirrorRecords.length); state.mirrorPages = Math.max(1, Number(data.pages || Math.ceil(state.mirrorTotal / (data.page_size || state.mirrorPageSize))));
    state.sample = null; state.sampleRows = state.mirrorRecords; show('#samplePanel', true); setText('#sampleMeta', `${state.mirrorTotal} 条本地记录 · 第 ${state.mirrorPage}/${state.mirrorPages} 页`); setText('#systemAccessMode','本地工作副本'); setText('#systemSourceBadge','本地副本'); setText('#systemNotice','本地工作副本已启用：新增、编辑、删除和恢复都会持久化到本地库，后续可接入同步。'); setText('#systemResultCount', state.mirrorTotal); populateMirrorFilters(); renderMirrorTable(); renderMirrorPagination(); state.samplePanelOpen = true; loadMirrorSyncStatus(bindingId); return true;
  } catch (error) { if (error.status !== 404) toast(`本地记录加载失败：${error.message}`); setText('#systemNotice', error.status === 404 ? '本地副本尚未导入。请返回“连接数据库”选择数据表并导入。' : `本地记录加载失败：${error.message}`); return false; }
}
async function loadMirrorSyncStatus(bindingId = activeBindingId()) {
  if (!bindingId) return;
  try {
    const data = await api(`/api/live/mirror/sync-status?binding_id=${encodeURIComponent(bindingId)}`);
    setText('#systemNotice', `本地工作副本已启用：${data.pending_outbox || 0} 条本地变更待同步；远端写回未配置。新增、编辑、删除和恢复均已持久化。`);
  } catch (_) { /* the CRUD surface remains usable if status polling is unavailable */ }
}
function populateMirrorFilters() {
  document.querySelectorAll('#specFilters select').forEach((select) => {
    const current = select.value;
    const values = new Set([...select.options].map((option) => option.value).filter(Boolean));
    state.mirrorRecords.forEach((row) => { const data = mirrorRowData(row); if (data[select.dataset.field] != null && data[select.dataset.field] !== '') values.add(String(data[select.dataset.field])); });
    [...values].sort().forEach((value) => { if (![...select.options].some((option) => option.value === value)) select.add(new Option(value, value)); });
    select.value = current;
  });
}
function renderMirrorPagination() { const node = $('#mirrorPagination'); if (!node) return; show('#mirrorPagination', state.mirrorTotal > state.mirrorPageSize); setText('#mirrorPageInfo', `第 ${state.mirrorPage}/${state.mirrorPages} 页 · 共 ${state.mirrorTotal} 条`); $('#mirrorPrev').disabled = state.mirrorPage <= 1; $('#mirrorNext').disabled = state.mirrorPage >= state.mirrorPages; }
function renderMirrorTable() {
  const wrap = $('#sampleTable'); wrap.textContent = ''; const columns = mirrorColumns(); if (!state.mirrorRecords.length) { const empty = document.createElement('div'); empty.className = 'table-empty'; empty.textContent = '本地副本暂无记录'; wrap.append(empty); return; }
  const table = document.createElement('table'); table.className = 'data-table'; const head = table.createTHead().insertRow(); columns.forEach((column) => { const th = document.createElement('th'); th.textContent = column.label; th.title = column.field; head.append(th); }); const actionHead = document.createElement('th'); actionHead.textContent = '操作'; head.append(actionHead); const body = table.createTBody();
  state.mirrorRecords.forEach((record) => { const data = mirrorRowData(record); const tr = body.insertRow(); columns.forEach((column) => tr.insertCell().textContent = String(data[column.field] ?? '—')); const action = tr.insertCell(); action.className = 'row-actions'; const id = String(mirrorRowId(record)); const archived = Boolean(record._archived ?? record.archived ?? record.deleted ?? data._mirror_deleted_at); [['查看',''],['编辑',''],[archived ? '恢复' : '删除', 'danger']].forEach(([label, extra]) => { const button = document.createElement('button'); button.className = `row-action ${extra}`; button.textContent = label; button.onclick = () => systemAction(label, id); action.append(button); }); }); wrap.append(table); setText('#systemSourceName', activeSourceTable() ? `${activeSourceTable().schema_name}.${activeSourceTable().table_name}` : '本地副本'); const archivedToggle = $('#toggleArchived'); if (archivedToggle) archivedToggle.textContent = state.includeArchived ? '隐藏已删除' : '显示已删除'; }
async function fetchMirrorRecord(recordId) { const params = new URLSearchParams({binding_id: activeBindingId()}); const result = await api(`/api/live/mirror/records/${encodeURIComponent(recordId)}?${params}`); return result.record || result.item || result; }
function openImportDialog() { if (!activeSourceTable()) return toast('请先选择远端数据表'); $('#importError').textContent = ''; $('#importMode').value = 'local_mirror'; $('#importDialog').showModal(); }
function openRecordDialog(mode, recordId = '') { if (!activeBindingId()) return toast('请先导入本地工作副本'); state.recordMode = mode; state.recordId = recordId; state.recordVersion = null; const dialog = $('#recordDialog'); $('#recordError').textContent = ''; $('#recordDialogTitle').textContent = mode === 'create' ? '新增记录' : mode === 'edit' ? '编辑记录' : '查看记录'; $('#recordDialogCopy').textContent = mode === 'view' ? '这是当前本地副本中的记录。' : '记录会保存到当前本地工作副本。'; $('#saveRecord').classList.toggle('hidden', mode === 'view'); const render = (record) => { const data = mirrorRowData(record); state.recordVersion = record?.version ?? record?._version ?? null; const fields = $('#recordFields'); fields.textContent = ''; const columns = mirrorColumns(); columns.forEach((column) => { const label = document.createElement('label'); label.className = 'record-field'; label.dataset.field = column.field; const name = document.createElement('span'); name.textContent = column.label; const input = document.createElement(column.type?.includes('text') && String(data[column.field] ?? '').length > 80 ? 'textarea' : 'input'); input.name = column.field; input.value = data[column.field] == null ? '' : data[column.field]; input.disabled = mode === 'view'; input.dataset.type = column.type; input.required = !column.nullable && mode !== 'view'; label.append(name, input); fields.append(label); }); dialog.showModal(); }; if (mode === 'create') render({}); else fetchMirrorRecord(recordId).then(render).catch((error) => toast(`读取记录失败：${error.message}`)); }
async function saveMirrorRecord(event) { event.preventDefault(); if (state.recordMode === 'view') return; const data = {}; document.querySelectorAll('#recordFields [name]').forEach((input) => { if (input.value !== '') data[input.name] = input.value; }); const body = {binding_id: activeBindingId(), data}; if (state.recordVersion != null) body.version = state.recordVersion; const button = $('#saveRecord'); button.disabled = true; $('#recordError').textContent = ''; try { const path = state.recordMode === 'create' ? '/api/live/mirror/records' : `/api/live/mirror/records/${encodeURIComponent(state.recordId)}`; await api(path, {method: state.recordMode === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(body)}); $('#recordDialog').close(); toast(state.recordMode === 'create' ? '记录已新增' : '记录已更新'); await loadMirrorRecords(); await loadMirrorState(); } catch (error) { $('#recordError').textContent = error.message; } finally { button.disabled = false; } }
async function deleteMirrorRecord(recordId) { if (!recordId || !window.confirm(`确定删除记录 ${recordId} 吗？删除后仍可恢复。`)) return; try { await api(`/api/live/mirror/records/${encodeURIComponent(recordId)}`, {method:'DELETE', body: JSON.stringify({binding_id: activeBindingId()})}); toast('记录已删除，可在恢复视图中找回'); await loadMirrorRecords(); await loadMirrorState(); } catch (error) { toast(`删除失败：${error.message}`); } }
async function restoreMirrorRecord(recordId) { try { await api(`/api/live/mirror/records/${encodeURIComponent(recordId)}/restore`, {method:'POST', body: JSON.stringify({binding_id: activeBindingId()})}); toast('记录已恢复'); await loadMirrorRecords(); } catch (error) { toast(`恢复失败：${error.message}`); } }
function renderJob(job) { state.job = job; const busy=!['completed','failed','cancelled','interrupted'].includes(job.status); for(const selector of ['#builderSource','#builderTable','#newApp']) $(selector).disabled=busy; show('#jobEmpty', false); show('#jobDetails', true); const status = job.status || 'queued'; const node = $('#jobStatus'); node.className = `status ${status === 'completed' ? 'success' : status === 'failed' ? 'failed' : status === 'queued' ? 'neutral' : 'running'}`; node.textContent = ({queued:'排队中',discovering:'发现数据',connecting:'连接线上服务',streaming:'生成中',validating:'校验 AppSpec',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'重启中断'})[status] || status; $('#progressBar').style.width = `${status === 'failed' ? 100 : Math.max(5, Math.round((Math.max(statusSteps.indexOf(status), 0) + 1) / statusSteps.length * 100))}%`; setText('#jobMessage', job.error?.message || job.message_text || (status==='completed'?'已从数据库恢复完成记录':'同步中…')); const meta = $('#jobMeta'); meta.textContent = ''; [[String(job.id||'').startsWith('live-')?'应用 ID':'任务 ID',job.id],['Run ID',job.run_id || '—'],['Thread ID',job.thread_id || '—'],['事件数',job.event_count ?? '—'],['耗时',job.latency_ms ? `${job.latency_ms} ms` : '—'],['最后序号',job.last_seq ?? '—']].forEach(([label,value]) => { const box = document.createElement('div'); box.textContent = label; const b = document.createElement('b'); b.textContent = value; box.appendChild(b); meta.appendChild(box); }); if (job.spec && status === 'completed' && state.spec !== job.spec) renderSpec(job.spec); }
function renderSpec(spec) {
  state.spec=spec; show('#specCard',true);
  setText('#specName',spec.name); setText('#specDescription',spec.description);
  $('#specChips').textContent='';
  for(const c of spec.columns) { const span=document.createElement('span'); span.textContent=c.label+' · '+c.field; $('#specChips').append(span); }
  loadSpecSample(spec);
}
async function loadSpecSample(spec) {
  state.sourceId=spec.source.id; state.selectedTable={...spec.source,source_id:spec.source.id};
  if (isLocalMode(spec) && activeBindingId()) {
    setText('#sampleTitle', spec.name); setText('#sampleSubtitle', spec.description || '数据来自本地工作副本'); setText('#systemSourceBadge','本地副本'); setText('#systemAccessMode','本地工作副本'); $('#specFilters').textContent='';
    for(const field of spec.filters || []) { const label=document.createElement('label'); label.textContent=spec.columns.find(c=>c.field===field)?.label||field; const select=document.createElement('select'); select.dataset.field=field; select.add(new Option('全部','')); select.onchange=()=>{state.mirrorPage=1; loadMirrorRecords();}; label.append(select); $('#specFilters').append(label); }
    const loaded = await loadMirrorRecords(); if (loaded) { switchView('apps'); return; }
  }
  try {
    const params=new URLSearchParams({source_id:spec.source.id,schema_name:spec.source.schema_name,table_name:spec.source.table_name,limit:'20'});
    const data=await api('/api/live/sample?'+params);
    if(state.spec!==spec) return;
    const profileChanged=data.profile_run_id!==spec.source.profile_run_id;
    state.sample=data; state.sampleRows=data.rows||[];
    show('#samplePanel',true); setText('#sampleTitle',spec.name); setText('#sampleSubtitle', spec.description || '数据来自已连接的远端数据库'); setText('#systemSourceBadge', `${spec.source.schema_name}.${spec.source.table_name}`);
    setText('#bindingHint',profileChanged ? ('来源 '+spec.source.id+' / '+spec.source.schema_name+'.'+spec.source.table_name+' · 原画像 '+spec.source.profile_run_id+' · 当前样例画像 '+data.profile_run_id) : ('来源 '+spec.source.id+' / '+spec.source.schema_name+'.'+spec.source.table_name+' · profile '+spec.source.profile_run_id));
    if(profileChanged) toast('线上表画像已更新，当前显示最新脱敏样例；如需同步页面字段，请重新生成');
    $('#specFilters').textContent='';
    for(const field of spec.filters) {
      const label=document.createElement('label'); label.textContent=spec.columns.find(c=>c.field===field)?.label||field;
      const select=document.createElement('select'); select.dataset.field=field; select.add(new Option('全部',''));
      for(const value of [...new Set(state.sampleRows.map(r=>String(r[field]??'')))].filter(Boolean)) select.add(new Option(value,value));
      select.onchange=renderSample; label.append(select); $('#specFilters').append(label);
    }
    renderSample(); setText('#runtimeStatus', `${state.sampleRows.length} 条远端脱敏样例已加载；导入副本后可进行增删改查`); setText('#systemAccessMode','远端样例'); switchView('apps');
  } catch(error) { show('#samplePanel',false); toast(error.message); }
}
async function pollJob(id) {
  if(state.pollBusy) return; state.pollBusy=true;
  let again=false;
  try {
    const job=await api('/api/live/jobs/'+encodeURIComponent(id)); renderJob(job);
    if(['completed','failed','cancelled','interrupted'].includes(job.status)) {
      sessionStorage.removeItem('buildkit-job');
      if(job.status==='completed') { state.appId=job.app_id; addMessage('agent','页面生成并保存成功。字段与来源已通过校验，可在下方预览或继续描述修改。'); await loadApps(); }
      else addMessage('agent',(job.error?.message||job.status)+'；未保存新应用。');
      $('#generateForm button[type="submit"]').disabled=false; show('#cancelJob',false);
    } else again=true;
  } catch(error) { toast('任务查询失败：'+error.message); again=error.status!==401; }
  finally {
    state.pollBusy=false;
    if(again) state.pollTimer=setTimeout(()=>pollJob(id),1400);
  }
}
async function generate(event) {
  event.preventDefault(); const prompt=$('#prompt').value.trim();
  if(!state.user) return openLogin();
  if(!prompt) return toast('请输入需求');
  if(!state.selectedTable) return toast('请先选择真实线上表');
  if(state.job&&!['completed','failed','cancelled','interrupted'].includes(state.job.status)) return toast('请等待当前生成完成或取消');
  const request={prompt,source_id:state.sourceId,schema_name:state.selectedTable.schema_name,table_name:state.selectedTable.table_name,app_id:state.appId,request_id:crypto.randomUUID()};
  $('#generateForm button[type="submit"]').disabled=true; show('#specCard',false);
  try {
    const job=await api('/api/live/generate',{method:'POST',body:JSON.stringify(request)});
    addMessage('user',prompt); $('#prompt').value=''; renderJob(job); show('#cancelJob',true);
    sessionStorage.setItem('buildkit-job',job.id);
    clearTimeout(state.pollTimer); await pollJob(job.id);
  } catch(error) { toast(error.message); $('#generateForm button[type="submit"]').disabled=false; }
}
function renderAppsLoginGate() {
  const list = $('#appsList');
  if (!list) return;
  setText('#appMetric', '—');
  list.textContent = '';
  const empty = document.createElement('div'); empty.className = 'empty catalog-empty';
  const icon = document.createElement('span'); icon.className = 'empty-state-icon'; icon.textContent = '⌁';
  const title = document.createElement('b'); title.className = 'empty-state-title'; title.textContent = '登录后查看系统目录';
  const copy = document.createElement('span'); copy.className = 'empty-state-copy'; copy.textContent = '系统定义、版本和本地工作副本状态会在登录后加载。';
  const action = document.createElement('button'); action.className = 'primary empty-state-action'; action.type = 'button'; action.textContent = '登录线上服务'; action.onclick = openLogin;
  empty.append(icon, title, copy, action); list.appendChild(empty);
}
async function loadApps() {
  if (!state.user) { renderAppsLoginGate(); return; }
  try {
    const data = await api('/api/live/apps'); const list = $('#appsList'); list.textContent = '';
    const apps = data.apps || [];
    setText('#appMetric', String(apps.length));
    if (!apps.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '还没有生成的页面。点击“生成新页面”开始。'; list.appendChild(empty); return; }
    apps.forEach((app) => {
      const card = document.createElement('article'); card.className = 'app-card';
      const top = document.createElement('div'); top.className = 'app-card-top';
      const title = document.createElement('h3'); title.textContent = app.name || '未命名页面';
      const badge = document.createElement('span'); badge.className = 'app-status'; badge.textContent = app.data_mode === 'local_mirror' || app.binding_id ? '本地副本系统' : '待导入副本'; top.append(title, badge);
      const desc = document.createElement('p'); desc.className = 'app-description'; desc.textContent = app.description || '已根据线上数据生成的管理页面。';
      const meta = document.createElement('div'); meta.className = 'app-meta';
      meta.textContent = `${app.source_table || '线上数据'} · ${app.columns_count || 0} 个字段 · ${app.filters_count || 0} 个筛选条件`;
      const foot = document.createElement('div'); foot.className = 'app-card-foot';
      const time = document.createElement('span'); time.textContent = `最近保存 ${formatDate(app.updated_at)}`;
      const open = document.createElement('button'); open.className = 'primary'; open.type = 'button'; open.textContent = '打开系统'; open.onclick = (event) => { event.stopPropagation(); loadApp(app.id, true); };
      foot.append(time, open); card.append(top, desc, meta, foot);
      card.onclick = () => loadApp(app.id, false); list.appendChild(card);
    });
  } catch (error) {
    if (error.status === 401) { renderAppsLoginGate(); return; }
    toast(`应用列表加载失败：${error.message}`);
  }
}
function formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {dateStyle:'medium', timeStyle:'short'}); }
async function loadApp(id, openPreview = false) {
  try {
    const app=await api('/api/live/apps/'+encodeURIComponent(id));
    state.currentApp=app;
    state.appId=app.id; state.sourceId=app.spec.source.id; state.selectedTable={...app.spec.source};
    state.spec=app.spec;
    await loadMirrorState();
    $('#builderSource').value=state.sourceId;
    state.catalog={table_profiles:[app.spec.source]};
    $('#builderTable').textContent='';
    $('#builderTable').add(new Option(app.spec.source.schema_name+'.'+app.spec.source.table_name,app.spec.source.schema_name+'.'+app.spec.source.table_name));
    show('#appDetail',true); setText('#restoredName',app.name); setText('#restoredSummary',app.spec.description || '');
    const overview=$('#restoredOverview'); overview.textContent='';
    [['数据来源',`${app.spec.source.schema_name}.${app.spec.source.table_name}`],['字段',`${app.spec.columns.length} 个`],['筛选条件',`${app.spec.filters.length} 个`],['数据模式',isLocalMode(app.spec) ? '本地工作副本' : '待导入副本']].forEach(([label,value])=>{const item=document.createElement('div'); item.className='overview-item'; const name=document.createElement('span'); name.textContent=label; const valueNode=document.createElement('b'); valueNode.textContent=value; item.append(name,valueNode); overview.append(item);});
    $('#restoredSpec').textContent=JSON.stringify(app.spec,null,2); $('#restoredMessages').textContent=''; $('#messages').textContent='';
    for(const m of app.messages) {
      const n=document.createElement('div'); n.className='restored-message'; n.textContent=m.role+'：'+m.content; $('#restoredMessages').append(n);
      if(m.role==='user') addMessage('user',m.content);
    }
    addMessage('agent','已恢复「'+app.name+'」。继续输入需求会沿用原线上会话。');
    setText('#restoredModeBadge', isLocalMode(app.spec) ? '本地工作副本' : '待导入副本'); setText('#runtimeStatus', isLocalMode(app.spec) ? '本地工作副本已绑定，可执行增删改查' : '当前系统尚未绑定本地副本，请在连接页导入后再打开');
    renderJob({...app.last_run,status:'completed',id:app.id,spec:app.spec});
    document.querySelector('#apps').classList.toggle('system-open', Boolean(openPreview)); show('#appDetail', !openPreview);
    if (openPreview) { await loadSpecSample(app.spec); } else document.querySelector('#appDetail')?.scrollIntoView({behavior:'smooth', block:'start'});
    toast(openPreview ? '已打开生成系统' : '已打开系统详情');
  } catch(error) { toast(error.message); }
}
async function loadDiagnostics() { try { const [data, application] = await Promise.all([api('/api/live/diagnostics'), api('/api/live/application')]); const checks = data.checks || []; const ok = checks.filter((item) => item.status >= 200 && item.status < 400).length; const summary = $('#diagnosticSummary'); summary.textContent = ''; [['应用',application.name+' / '+application.version],['挂载工具',application.tools_count],['知识库',application.knowledge_count],['检查数',checks.length],['成功',ok],['需关注',checks.length-ok]].forEach(([label,value]) => { const span = document.createElement('span'); span.textContent = `${label}：${value}`; summary.appendChild(span); }); const list = $('#diagnosticsList'); list.textContent = ''; checks.forEach((check) => { const row = document.createElement('div'); row.className = 'diagnostic-row'; const path = document.createElement('b'); path.textContent = `${check.method || 'GET'} ${check.path}`; const status = document.createElement('span'); status.className = check.status >= 200 && check.status < 400 ? 'ok' : 'bad'; status.textContent = check.status || 'ERR'; const latency = document.createElement('span'); latency.textContent = check.latency_ms == null ? '—' : `${check.latency_ms} ms`; const code = document.createElement('code'); code.textContent = check.code || check.at || ''; row.append(path,status,latency,code); list.appendChild(row); }); } catch (error) { $('#diagnosticsList').textContent = `诊断失败：${error.message}`; } }
function switchView(view) { document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.id === view)); document.querySelectorAll('.workflow-step').forEach((button) => button.classList.toggle('active', button.dataset.go === view)); setText('#pageTitle', ({connection:'数据源',builder:'生成中心',apps:'系统目录'})[view]); if (view === 'apps') loadApps(); }
document.querySelectorAll('.nav-item').forEach((button) => { button.onclick = () => switchView(button.dataset.view); });
document.querySelectorAll('[data-prompt]').forEach((button) => { button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); }; });
$('#generateForm').onsubmit = generate; $('#newFromApps').onclick = () => { $('#apps').classList.remove('system-open'); show('#samplePanel',false); switchView('builder'); $('#newApp').click(); }; $('#continueEditing').onclick = () => { $('#apps').classList.remove('system-open'); switchView('builder'); }; $('#accountButton').onclick = () => state.user ? logout() : openLogin(); $('#noticeLogin').onclick = openLogin; $('#loginForm').onsubmit = login; $('#closeLogin').onclick = () => $('#loginDialog').close(); $('#cancelLogin').onclick = () => $('#loginDialog').close(); $('#catalogSearch').oninput = () => loadCatalog(); $('#sampleSearch').oninput = () => isLocalMode() && activeBindingId() ? (state.mirrorPage = 1, loadMirrorRecords()) : renderSample(); $('#refreshApps').onclick = () => { $('#apps').classList.remove('system-open'); show('#samplePanel',false); loadApps(); };

$('#backToSystems').onclick = () => { $('#apps').classList.remove('system-open'); show('#samplePanel',false); loadApps(); };
$('#systemRefresh').onclick = () => { if (isLocalMode() && activeBindingId()) { state.mirrorPage = 1; loadMirrorRecords(); loadMirrorState(); } else if(state.spec) loadSpecSample(state.spec); else if(state.selectedTable) loadSample(state.selectedTable); else toast('尚未连接远端数据表'); };
$('#systemAdd').onclick = () => isLocalMode() && activeBindingId() ? openRecordDialog('create') : openImportDialog();
$('#systemImport').onclick = openImportDialog;
const archivedToggle = document.createElement('button'); archivedToggle.id = 'toggleArchived'; archivedToggle.className = 'light'; archivedToggle.textContent = '显示已删除'; archivedToggle.onclick = () => { state.includeArchived = !state.includeArchived; state.mirrorPage = 1; loadMirrorRecords(); }; $('.crud-actions')?.insertBefore(archivedToggle, $('#systemAdd'));
$('#importMirror').onclick = openImportDialog; $('#importFromDetail').onclick = openImportDialog; $('#refreshMirror').onclick = loadMirrorState;
$('#importForm').onsubmit = (event) => { event.preventDefault(); startMirrorImport(); }; $('#closeImport').onclick = () => $('#importDialog').close(); $('#cancelImport').onclick = () => $('#importDialog').close();
$('#recordForm').onsubmit = saveMirrorRecord; $('#closeRecord').onclick = () => $('#recordDialog').close(); $('#cancelRecord').onclick = () => $('#recordDialog').close();
$('#mirrorPrev').onclick = () => { if (state.mirrorPage > 1) { state.mirrorPage -= 1; loadMirrorRecords(); } }; $('#mirrorNext').onclick = () => { if (state.mirrorPage < state.mirrorPages) { state.mirrorPage += 1; loadMirrorRecords(); } };

document.querySelectorAll('[data-go]').forEach((button) => { button.onclick = () => switchView(button.dataset.go); });

$('#builderSource').onchange=()=>selectSource($('#builderSource').value);
$('#builderTable').onchange=()=>{ const t=state.catalog?.table_profiles.find(t=>t.schema_name+'.'+t.table_name===$('#builderTable').value); if(t) loadTable(t); };
$('#newApp').onclick=()=>{ state.appId=null; state.spec=null; state.currentApp=null; state.selectedTable=null; show('#specCard',false); show('#samplePanel',false); setText('#builderSelectedTable','尚未选择'); setText('#builderConnectionSummary','请在下方选择远端数据表'); $('#messages').textContent=''; addMessage('agent','已清除当前选择。请重新选择远端数据表，再描述需求。'); renderMirrorStatus(state.mirror); };
$('#cancelJob').onclick=async()=>{ if(state.job) { try { await api('/api/live/jobs/'+state.job.id+'/cancel',{method:'POST',body:'{}'}); toast('已请求取消；等待服务确认'); } catch(e) { toast(e.message); } } };
let searchTimer; $('#catalogSearch').oninput=()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>loadCatalog(),350); };
(async function init() {
  await loadStatus();
  if(state.user) { const id=sessionStorage.getItem('buildkit-job'); if(id) { show('#cancelJob',true); pollJob(id); } }
})();
