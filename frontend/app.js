const $ = (s) => document.querySelector(s);
const state = { entity: 'bed', spec: null, appId: 'app-bed-management', editing: null };
const labels = { bed: '床位', patient: '患者' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: {'Content-Type': 'application/json', 'X-BuildKit-Actor': 'local_admin', ...(options.headers || {})}, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail?.message || '请求失败');
  return payload;
}

function addMessage(role, text) {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  $('#messages').appendChild(node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function renderSpec(spec) {
  state.spec = spec;
  $('#appName').textContent = spec.name;
  $('#specSummary').innerHTML = '';
  [['数据源', spec.data_sources?.[0]?.name || '—'], ['实体', `${spec.entities?.length || 0} 个`], ['视图', `${spec.views?.length || 0} 个`], ['写入', 'Gateway 校验 + 审计']].forEach(([k, v]) => {
    const span = document.createElement('span'); span.textContent = `${k}：${v}`; $('#specSummary').appendChild(span);
  });
}

async function loadSpec() { const data = await api(`/api/apps/${state.appId}/spec`); renderSpec(data.spec); }

function rowActions(row) {
  return row._archived ? `<button class="row-action" data-restore="${escapeHtml(row.id)}">恢复</button>` : `<button class="row-action" data-edit="${escapeHtml(row.id)}">编辑</button><button class="row-action delete" data-delete="${escapeHtml(row.id)}">删除</button>`;
}

async function loadRecords() {
  const params = new URLSearchParams({entity: state.entity, q: $('#search').value, ward: $('#ward').value});
  const data = await api(`/api/runtime/records?${params}`);
  const fields = state.entity === 'bed' ? [['id','床位'],['ward','病区'],['type','类型'],['status','状态'],['patient','当前患者']] : [['id','患者 ID'],['name','姓名'],['sex','性别'],['age','年龄'],['insurance','医保类型'],['ward','病区']];
  $('#table').innerHTML = data.records.length ? `<table class="data-table"><thead><tr>${fields.map(([, label]) => `<th>${label}</th>`).join('')}<th>操作</th></tr></thead><tbody>${data.records.map((row) => `<tr>${fields.map(([key]) => `<td>${escapeHtml(key === 'status' ? (row[key] === 'occupied' ? '使用中' : '空闲') : row[key])}</td>`).join('')}<td>${rowActions(row)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无记录</div>';
  document.querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => openForm(button.dataset.edit));
  document.querySelectorAll('[data-delete]').forEach((button) => button.onclick = () => mutate(`/api/runtime/records/${button.dataset.delete}`, 'DELETE'));
  document.querySelectorAll('[data-restore]').forEach((button) => button.onclick = () => mutate(`/api/runtime/records/restore/${button.dataset.restore}`, 'POST'));
}

async function mutate(path, method, body) { try { await api(path, {method, body: body ? JSON.stringify(body) : JSON.stringify({})}); await loadRecords(); await loadAudit(); } catch (error) { alert(error.message); } }

function openForm(id = null) {
  state.editing = id; $('#dialogTitle').textContent = `${id ? '编辑' : '新增'}${labels[state.entity]}`;
  const bed = state.entity === 'bed'; const row = id ? null : {};
  const fields = bed ? [['id','床位编号','例如 B-05-01'],['ward','所属病区',''],['type','床位类型',''],['status','状态',''],['patient','当前患者','']] : [['id','患者 ID','例如 P-000301'],['name','显示姓名','可使用脱敏名称'],['sex','性别',''],['age','年龄',''],['insurance','医保类型',''],['ward','所属病区','']];
  $('#fields').innerHTML = fields.map(([key, label, hint]) => `<div class="field"><label>${label}</label>${['ward','type','status','sex','insurance'].includes(key) ? `<select id="field-${key}">${(key === 'ward' ? ['内分泌一病区','内分泌二病区','糖尿病中心','代谢病区'] : key === 'type' ? ['单人间','双人间'] : key === 'status' ? ['available','occupied'] : key === 'sex' ? ['男','女'] : ['城镇职工医保','城乡居民医保','商业保险','自费']).map((x) => `<option value="${x}">${x === 'available' ? '空闲' : x === 'occupied' ? '使用中' : x}</option>`).join('')}</select>` : `<input id="field-${key}" placeholder="${hint}" ${key === 'id' ? 'required' : ''} />`}</div>`).join('');
  $('#recordDialog').showModal();
}

async function saveForm(event) {
  event.preventDefault();
  const values = {}; document.querySelectorAll('#fields [id^="field-"]').forEach((el) => values[el.id.slice(6)] = el.value.trim());
  try {
    if (state.editing) await mutate(`/api/runtime/records/${state.editing}`, 'PATCH', values);
    else {
      // Creation is explicit and validated by the gateway. The prototype uses a
      // client-generated ID only to demonstrate the eventual request shape.
      const data = await api('/api/runtime/records', {method: 'POST', body: JSON.stringify({entity: state.entity, record: values})});
      if (data.record) await loadRecords();
    }
    $('#recordDialog').close();
  } catch (error) { alert(error.message); }
}

async function loadAssets() { const data = await api('/api/assets'); $('#assetCards').innerHTML = data.sources.map((source) => `<article class="asset-card"><span class="eyebrow">SOURCE</span><h3>${escapeHtml(source.name)}</h3><p>${escapeHtml(source.driver)} · ${source.tables} 张表</p><code>status: ${escapeHtml(source.status)}</code></article>`).join('') + data.entities.map((entity) => `<article class="asset-card"><span class="eyebrow">ENTITY</span><h3>${escapeHtml(entity.label)}</h3><p>字段：${entity.fields.map(escapeHtml).join('、')}</p><code>actions: ${entity.actions.join(', ')}</code></article>`).join(''); }
async function loadAudit() { const data = await api('/api/audit'); $('#auditTable').innerHTML = data.events.length ? data.events.map((row) => `<div class="audit-row"><span>${escapeHtml(row.created_at)}</span><b>${escapeHtml(row.action)}</b><span>${escapeHtml(row.entity)} / ${escapeHtml(row.record_id || '')}</span><span class="muted">${escapeHtml(row.actor)} · ${escapeHtml(row.request_id)}</span></div>`).join('') : '<div class="empty">暂无审计记录</div>'; }

async function generate(prompt) { addMessage('user', prompt); try { const data = await api('/api/apps/generate', {method:'POST', body: JSON.stringify({prompt})}); state.appId = data.app.id; state.entity = /患者|病人|医保/.test(prompt) ? 'patient' : 'bed'; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.entity === state.entity)); renderSpec(data.spec); addMessage('agent', `${data.message} 已绑定 ${data.spec.entities.length} 个实体，数据写入将经过服务端 Gateway。`); await loadRecords(); } catch (error) { addMessage('agent', `生成失败：${error.message}`); } }

document.querySelectorAll('.nav').forEach((button) => button.onclick = async () => { document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('active', x === button)); document.querySelectorAll('.view').forEach((x) => x.classList.remove('active')); $(`#${button.dataset.view}`).classList.add('active'); $('#pageTitle').textContent = button.textContent.trim().replace(/^[^\u4e00-\u9fff]*/, ''); if (button.dataset.view === 'assets') await loadAssets(); if (button.dataset.view === 'audit') await loadAudit(); });
document.querySelectorAll('[data-prompt]').forEach((button) => button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); });
$('#chatForm').onsubmit = (event) => { event.preventDefault(); const prompt = $('#prompt').value.trim(); if (prompt) { $('#prompt').value = ''; generate(prompt); } };
document.querySelectorAll('.tab').forEach((button) => button.onclick = async () => { document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === button)); state.entity = button.dataset.entity; await loadRecords(); });
$('#search').oninput = loadRecords; $('#ward').onchange = loadRecords; $('#refresh').onclick = loadRecords; $('#add').onclick = () => openForm(); $('#recordForm').onsubmit = saveForm;

(async function init() { await loadSpec(); await loadRecords(); await loadAudit(); })().catch((error) => addMessage('agent', `初始化失败：${error.message}`));
