const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let config = null;
let customers = [];
let testId = String(Date.now());
let botFlow = null;
let selectedNodeId = null;
let flowDirty = false;
let previewState = null;
let flowZoom = 1;
let account = null;
let adminWhatsapp = '';
let cloudSettings = null;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (response.status === 401) {
    location.href = '/auth.html';
    throw new Error('يرجى تسجيل الدخول');
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(response.ok ? 'استجابة الخادم غير صالحة، أعد المحاولة' : raw || 'الخادم غير متاح مؤقتاً'); }
  if (response.status === 403 && data.code) { if (account) { account.access = { allowed:false, state:data.code, daysLeft:0 }; showLockedAccount(); } }
  if (!response.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}

async function load() {
  const session = await api('/api/auth/me');
  account = session.account;
  adminWhatsapp = session.adminWhatsapp || '';
  renderAccount();
  if (!account.access.allowed) { showLockedAccount(); return; }
  let flowResponse;
  [config, customers, flowResponse, cloudSettings] = await Promise.all([api('/api/config'), api('/api/customers'), api('/api/bot-flow'), api('/api/cloud/settings')]);
  botFlow = flowResponse.draft || createDefaultBotFlow();
  fillConfig(); fillCloudSettings(); renderSteps(); renderCustomers(); renderBotFlow(); await refreshStatus();
}

function renderAccount() {
  $('#account-name').textContent = account.fullName;
  const plan = account.access.state === 'active' ? 'حساب مفعّل' : `متبقي ${account.access.daysLeft} يوم من التجربة`;
  $('#account-plan').textContent = plan;
  $('#trial-pill').textContent = plan;
  const number = String(adminWhatsapp).replace(/\D/g,'');
  $('#contact-admin').href = number ? `https://wa.me/${number}?text=${encodeURIComponent(`مرحباً، أريد تفعيل حسابي: ${account.email}`)}` : `mailto:?subject=${encodeURIComponent('طلب تفعيل الحساب')}&body=${encodeURIComponent(`أريد تفعيل حسابي: ${account.email}`)}`;
}

function showLockedAccount() {
  document.body.classList.add('account-expired');
  $$('.page').forEach(page => page.classList.remove('active'));
  $('main>header').hidden = true;
  $('#account-locked').hidden = false;
}

async function signOut() { await fetch('/api/auth/logout', { method:'POST' }); location.href='/auth.html'; }
$('#account-logout').onclick = signOut;
$('#locked-logout').onclick = signOut;

function fillConfig() {
  $('#bot-name').value = config.botName || '';
  $('#chat-name').textContent = config.botName || 'المساعد الآلي';
  $('#enabled').checked = !!config.enabled;
  $('#welcome').value = config.welcomeText || '';
  $('#complete').value = config.completionText || '';
  $('#fallback').value = config.fallbackText || '';
  $('#bot-state').textContent = config.enabled ? 'مفعّل' : 'متوقف';
}

function fillCloudSettings() {
  if (!cloudSettings) return;
  $('#cloud-phone-id').value = cloudSettings.phoneNumberId || '';
  $('#cloud-waba-id').value = cloudSettings.businessAccountId || '';
  $('#cloud-version').value = cloudSettings.apiVersion || 'v25.0';
  $('#cloud-enabled').checked = !!cloudSettings.enabled;
  $('#cloud-token').value = '';
  $('#cloud-app-secret').value = '';
  $('#cloud-webhook').value = cloudSettings.webhookUrl || '';
  $('#cloud-verify-token').value = cloudSettings.verifyToken || '';
  const connected = cloudSettings.configured && cloudSettings.enabled && cloudSettings.verified;
  $('#cloud-state').textContent = connected ? 'متصل رسمياً' : cloudSettings.configured && cloudSettings.enabled ? 'بانتظار الاختبار' : cloudSettings.configured ? 'محفوظ — غير مفعّل' : 'غير مربوط';
  $('#cloud-state').className = `cloud-badge ${connected ? 'good' : ''}`;
  if (cloudSettings.displayPhone || cloudSettings.verifiedName) {
    $('#cloud-result').textContent = `متصل: ${cloudSettings.verifiedName || 'WhatsApp Business'} ${cloudSettings.displayPhone || ''}`;
    $('#cloud-result').className = 'cloud-result good';
  }
}

function renderSteps() {
  $('#steps').innerHTML = config.steps.map((step, index) => `
    <article class="card step-card" data-index="${index}">
      <div class="step-top"><span class="step-number">${index + 1}</span><h3>السؤال ${index + 1}</h3><div class="step-actions"><button class="icon-btn move-up" title="للأعلى">↑</button><button class="icon-btn move-down" title="للأسفل">↓</button><button class="icon-btn remove-step danger" title="حذف">×</button></div></div>
      <div class="step-grid"><label>نص السؤال<textarea class="question" rows="3">${escapeHtml(step.question)}</textarea></label><label>اسم الحقل<input class="field" value="${escapeHtml(step.field)}" /></label><label>نوع الإجابة<select class="type"><option value="text" ${step.type==='text'?'selected':''}>نص</option><option value="phone" ${step.type==='phone'?'selected':''}>رقم هاتف</option><option value="choice" ${step.type==='choice'?'selected':''}>اختيارات</option></select></label></div>
      <div class="options" ${step.type !== 'choice' ? 'hidden' : ''}><b>الاختيارات</b><div class="option-list">${(step.options || []).map(optionHtml).join('')}</div><button class="ghost add-option">＋ إضافة اختيار</button></div>
    </article>`).join('');
}

const optionHtml = (option = {label:'',aliases:[]}) => `<div class="option-row"><label>النتيجة<input class="option-label" value="${escapeHtml(option.label)}" placeholder="بغداد" /></label><label>الكلمات المقبولة<input class="option-aliases" value="${escapeHtml((option.aliases || []).join('، '))}" placeholder="1، بغداد" /></label><button class="icon-btn remove-option" title="حذف">×</button></div>`;

function collectSteps() {
  return $$('.step-card').map((card, index) => {
    const type = $('.type', card).value;
    return {
      id: `step-${Date.now()}-${index}`,
      type,
      question: $('.question', card).value.trim(),
      field: $('.field', card).value.trim() || `الحقل ${index + 1}`,
      ...(type === 'choice' ? { options: $$('.option-row', card).map(row => ({ label: $('.option-label', row).value.trim(), aliases: $('.option-aliases', row).value.split(/[،,]/).map(x => x.trim()).filter(Boolean) })).filter(x => x.label) } : {})
    };
  });
}

function renderCustomers() {
  $('#customer-count').textContent = customers.length;
  const fixed = ['name','whatsapp','createdAt','id'];
  const fields = [...new Set(customers.flatMap(Object.keys).filter(key => !fixed.includes(key)))];
  $('#customer-head').innerHTML = `<tr><th>الاسم</th><th>واتساب</th>${fields.map(f=>`<th>${escapeHtml(f)}</th>`).join('')}<th>التاريخ</th></tr>`;
  $('#customer-body').innerHTML = customers.map(c => `<tr><td>${escapeHtml(c.name || '—')}</td><td dir="ltr">${escapeHtml(String(c.whatsapp).split('@')[0])}</td>${fields.map(f=>`<td>${escapeHtml(c[f] || '—')}</td>`).join('')}<td>${new Date(c.createdAt).toLocaleString('ar-IQ')}</td></tr>`).join('');
  $('#empty-customers').style.display = customers.length ? 'none' : 'block';
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    const labels = { connected: status.provider === 'cloud' ? 'Cloud API متصل' : 'متصل', qr:'امسح رمز QR', connecting:'جاري الاتصال', disconnected:'غير متصل', demo:'وضع تجريبي', error:'خطأ بالاتصال' };
    $('#connection-text').textContent = labels[status.state] || status.state;
    $('#phone-text').textContent = status.phone || (status.mode === 'demo' ? 'غيّر MODE إلى whatsapp عند النشر' : status.lastMessageAt ? `آخر رسالة: ${new Date(status.lastMessageAt).toLocaleTimeString('ar-IQ')}` : 'بانتظار أول رسالة');
    $('#top-status').textContent = labels[status.state] || status.state;
    $('#top-status').className = `status-pill ${status.state === 'connected' ? 'good' : status.state === 'error' ? 'bad' : ''}`;
    $('#qr-box').innerHTML = status.qr ? `<img src="${status.qr}" alt="رمز ربط واتساب"><p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>` : `<div class="qr-placeholder">${status.state === 'connected' ? '✓' : status.state === 'demo' ? 'DEMO' : 'QR'}</div><p>${status.error || (status.provider === 'cloud' ? 'الاتصال الرسمي من Meta مفعّل' : status.state === 'connected' ? 'تم ربط واتساب بنجاح' : status.state === 'demo' ? 'الوضع التجريبي مفعّل' : 'بانتظار رمز الربط…')}</p>`;
  } catch (error) { console.error(error); }
}

$$('.nav').forEach(button => button.onclick = () => {
  $$('.nav').forEach(x => x.classList.remove('active')); button.classList.add('active');
  $$('.page').forEach(x => x.classList.remove('active')); $(`#${button.dataset.page}`).classList.add('active');
  $('#page-title').textContent = $('span', button).textContent; $('.sidebar').classList.remove('open');
  document.body.classList.toggle('bot-focus', button.dataset.page === 'bot');
  document.body.classList.remove('bot-nav-open');
  if (button.dataset.page === 'customers') api('/api/customers').then(x => { customers=x; renderCustomers(); });
  if (button.dataset.page === 'cloud') api('/api/cloud/settings').then(x => { cloudSettings=x; fillCloudSettings(); });
  if (button.dataset.page === 'bot') renderBotFlow();
});
$('#menu').onclick = () => document.body.classList.contains('bot-focus') ? document.body.classList.toggle('bot-nav-open') : $('.sidebar').classList.toggle('open');
$('#bot-menu-toggle').onclick = () => document.body.classList.toggle('bot-nav-open');

$('#steps').onclick = (event) => {
  const card = event.target.closest('.step-card'); if (!card) return;
  const index = Number(card.dataset.index);
  if (event.target.closest('.remove-step')) { if (config.steps.length > 1) { config.steps.splice(index,1); renderSteps(); } else toast('يجب إبقاء سؤال واحد على الأقل'); }
  if (event.target.closest('.move-up') && index > 0) { config.steps = collectSteps(); [config.steps[index-1],config.steps[index]]=[config.steps[index],config.steps[index-1]]; renderSteps(); }
  if (event.target.closest('.move-down') && index < config.steps.length-1) { config.steps = collectSteps(); [config.steps[index+1],config.steps[index]]=[config.steps[index],config.steps[index+1]]; renderSteps(); }
  if (event.target.closest('.add-option')) $('.option-list', card).insertAdjacentHTML('beforeend', optionHtml());
  if (event.target.closest('.remove-option')) event.target.closest('.option-row').remove();
};
$('#steps').onchange = (event) => { if (event.target.matches('.type')) $('.options', event.target.closest('.step-card')).hidden = event.target.value !== 'choice'; };
$('#add-step').onclick = () => { config.steps = collectSteps(); config.steps.push({id:`step-${Date.now()}`,type:'text',question:'اكتب سؤالك هنا:',field:'الإجابة'}); renderSteps(); };

async function saveConfig() {
  config = { ...config, botName: $('#bot-name').value.trim(), enabled: $('#enabled').checked, welcomeText: $('#welcome').value, completionText: $('#complete').value, fallbackText: $('#fallback').value, steps: collectSteps() };
  await api('/api/config', {method:'PUT',body:JSON.stringify(config)}); fillConfig(); toast('تم الحفظ بنجاح');
}
$('#save-quick').onclick = saveConfig;
$('#save-flow').onclick = saveConfig;
$('#logout').onclick = async () => { if (confirm('هل تريد فصل رقم واتساب؟ ستحتاج لمسح QR مرة أخرى.')) { await api('/api/logout',{method:'POST'}); toast('تم فصل الرقم'); setTimeout(refreshStatus,700); } };

$('#save-cloud').onclick = async () => {
  try {
    cloudSettings = await api('/api/cloud/settings', { method:'PUT', body:JSON.stringify({
      phoneNumberId: $('#cloud-phone-id').value.trim(), businessAccountId: $('#cloud-waba-id').value.trim(),
      accessToken: $('#cloud-token').value.trim(), appSecret: $('#cloud-app-secret').value.trim(),
      apiVersion: $('#cloud-version').value.trim(), enabled: $('#cloud-enabled').checked
    }) });
    fillCloudSettings(); await refreshStatus(); toast('تم حفظ اتصال Meta بشكل مشفّر');
  } catch (error) { $('#cloud-result').textContent = error.message; $('#cloud-result').className='cloud-result bad'; }
};
$('#test-cloud').onclick = async () => {
  $('#cloud-result').textContent='جاري الاتصال بـ Meta…'; $('#cloud-result').className='cloud-result';
  try {
    cloudSettings = await api('/api/cloud/test', { method:'POST' }); fillCloudSettings();
    $('#cloud-result').textContent=`نجح الاتصال والاشتراك بالرسائل ✅ ${cloudSettings.verifiedName || ''} ${cloudSettings.displayPhone || ''}`;
    $('#cloud-result').className='cloud-result good'; await refreshStatus();
  } catch (error) { $('#cloud-result').textContent=`فشل الاتصال: ${error.message}`; $('#cloud-result').className='cloud-result bad'; }
};
$$('[data-copy]').forEach(button => button.onclick = async () => {
  const value = $(`#${button.dataset.copy}`).value; if (!value) return toast('احفظ الاتصال أولاً');
  await navigator.clipboard.writeText(value); toast('تم النسخ');
});

function bubble(reply, who) { const text=typeof reply==='string'?reply:reply?.text||'';const div=document.createElement('div');div.className=`bubble ${who}`;div.append(document.createTextNode(text));if(reply?.buttons?.length){for(const option of reply.buttons){const button=document.createElement('button');button.className='preview-choice';button.textContent=option.label;button.onclick=()=>sendTest(option.id||option.label);div.append(button);}}const time=document.createElement('time');time.textContent=new Date().toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'});div.append(time);$('#chat').append(div);$('#chat').scrollTop=$('#chat').scrollHeight;}
async function sendTest(text) { bubble(text,'user'); const data=await api('/api/simulate',{method:'POST',body:JSON.stringify({sender:testId,text})}); for (const reply of data.replies) { await new Promise(r=>setTimeout(r,300)); bubble(reply,'bot'); } }
$('#chat-form').onsubmit = async event => { event.preventDefault(); const input=$('#chat-input'); const text=input.value.trim(); if(!text)return; input.value=''; await sendTest(text); };
$('#restart-test').onclick = async () => { testId=String(Date.now()); $('#chat').innerHTML=''; await sendTest('ابدأ'); };

$('#export').onclick = () => {
  if (!customers.length) return toast('لا توجد بيانات للتصدير');
  const keys=[...new Set(customers.flatMap(Object.keys))].filter(x=>x!=='id');
  const csv='\ufeff'+[keys,...customers.map(c=>keys.map(k=>c[k]??''))].map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
  const link=document.createElement('a'); link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); link.download='customers.csv'; link.click(); URL.revokeObjectURL(link.href);
};

// Visual Bot Builder
const nodeMeta = {
  start: { label:'بداية', icon:'⚑' }, message: { label:'رسالة', icon:'✉' },
  input: { label:'سؤال نصي', icon:'أ' }, phone: { label:'رقم هاتف', icon:'☎' },
  buttons: { label:'أزرار', icon:'☷' }, end: { label:'نهاية', icon:'■' }
};

function newId(prefix='node') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`; }
function createDefaultBotFlow() {
  const start='start-default', welcome='welcome-default', province='province-default', phone='phone-default', end='end-default';
  return { name:'البوت الرئيسي', nodes:[
    {id:start,type:'start',x:60,y:300,next:welcome},
    {id:welcome,type:'message',x:330,y:300,message:config?.welcomeText || 'أهلاً وسهلاً بك 🌟',next:province},
    {id:province,type:'buttons',x:600,y:240,message:'من أي محافظة؟',field:'المحافظة',options:[
      {id:newId('option'),label:'بغداد',aliases:['1','بغداد'],next:phone},
      {id:newId('option'),label:'الأنبار',aliases:['2','الانبار','الأنبار'],next:phone}
    ]},
    {id:phone,type:'phone',x:900,y:300,message:'يرجى كتابة رقم الهاتف:',field:'رقم الهاتف',next:end},
    {id:end,type:'end',x:1190,y:300,message:config?.completionText || 'تم تسجيل معلوماتك بنجاح ✅'}
  ]};
}
function getBotNode(id) { return botFlow.nodes.find(node => node.id === id); }
function nodeSummary(node) {
  if (node.type==='start') return 'بداية المحادثة';
  if (node.type==='end') return node.message || 'إنهاء وحفظ بيانات الزبون';
  return node.message || (node.type==='message' ? 'اكتب رسالتك هنا' : 'اكتب السؤال هنا');
}
function markFlowDirty() { flowDirty=true; const el=$('#bot-save-state'); el.textContent='تغييرات غير محفوظة'; el.className='dirty-badge'; }
function allTargetOptions(currentId, selected='') {
  return `<option value="">بدون رابط</option>` + botFlow.nodes.filter(n=>n.id!==currentId).map(n=>`<option value="${n.id}" ${n.id===selected?'selected':''}>${nodeMeta[n.type].label} — ${escapeHtml(nodeSummary(n).slice(0,30))}</option>`).join('');
}

function renderBotFlow() {
  if (!botFlow) return;
  const holder=$('#flow-nodes');
  holder.innerHTML=botFlow.nodes.map(node=>{
    const options=node.type==='buttons' ? `<div class="visual-node-options">${(node.options||[]).map((o,i)=>`<span style="--option-color:${['#6366f1','#10b981','#f59e0b'][i%3]}">${i+1}. ${escapeHtml(o.label||'زر جديد')}</span>`).join('')}</div>`:'';
    const ports=node.type==='buttons' ? (node.options||[]).map((o,i)=>`<i class="option-port link-port out" data-source-node="${node.id}" data-option-index="${i}" style="top:${87+i*32}px;background:${['#6366f1','#10b981','#f59e0b'][i%3]}" title="اسحب لربط: ${escapeHtml(o.label)}"></i>`).join('') : (node.type!=='end'?`<i class="node-port link-port out" data-source-node="${node.id}" title="اسحب لربط العقدة التالية"></i>`:'');
    return `<div class="visual-node ${node.type} ${node.id===selectedNodeId?'selected':''}" data-node-id="${node.id}" style="left:${node.x||0}px;top:${node.y||0}px"><div class="visual-node-head"><b>${nodeMeta[node.type].icon}</b>${nodeMeta[node.type].label}</div><div class="visual-node-body">${escapeHtml(nodeSummary(node))}</div>${options}${node.type!=='start'?`<i class="node-port link-port in" data-target-node="${node.id}" title="أفلت الخط هنا"></i>`:''}${ports}</div>`;
  }).join('');
  drawFlowLines(); renderInspector(); bindNodeDragging(); bindPortLinking();
  applyFlowZoom();
}
function applyFlowZoom(){const canvas=$('#flow-canvas');if(!canvas)return;canvas.style.transform=`scale(${flowZoom})`;canvas.style.transformOrigin='0 0';$('#zoom-level').textContent=`${Math.round(flowZoom*100)}%`;}
function setFlowZoom(value){flowZoom=Math.min(1.5,Math.max(.5,value));applyFlowZoom();}
function nodeAnchor(node, outgoing=true, optionIndex=null) {
  const el=$(`[data-node-id="${node.id}"]`); if(!el)return {x:0,y:0};
  const x=(node.x||0)+(outgoing?el.offsetWidth:0);
  const y=(node.y||0)+(optionIndex===null?el.offsetHeight-7:87+optionIndex*32);
  return {x,y};
}
function curvePath(from,to) { const bend=Math.max(70,Math.abs(to.x-from.x)*.45); return `M ${from.x} ${from.y} C ${from.x+bend} ${from.y}, ${to.x-bend} ${to.y}, ${to.x} ${to.y}`; }
function drawFlowLines() {
  const svg=$('#flow-lines'); if(!svg)return; let lines='';
  for(const node of botFlow.nodes){
    if(node.type==='buttons') (node.options||[]).forEach((option,index)=>{const target=getBotNode(option.next);if(target)lines+=`<path class="flow-line option" d="${curvePath(nodeAnchor(node,true,index),nodeAnchor(target,false))}"/>`;});
    else {const target=getBotNode(node.next);if(target)lines+=`<path class="flow-line" d="${curvePath(nodeAnchor(node,true),nodeAnchor(target,false))}"/>`;}
  }
  svg.innerHTML=lines;
}
function bindNodeDragging() {
  $$('.visual-node').forEach(el=>{
    el.onpointerdown=(event)=>{
      if(event.button!==0 || event.target.closest('.link-port'))return; const node=getBotNode(el.dataset.nodeId); selectedNodeId=node.id; renderInspector(); $$('.visual-node').forEach(x=>x.classList.toggle('selected',x===el));
      const startX=event.clientX,startY=event.clientY,originX=node.x||0,originY=node.y||0; let moved=false; el.setPointerCapture(event.pointerId);
      el.onpointermove=(move)=>{if(Math.abs(move.clientX-startX)+Math.abs(move.clientY-startY)>3)moved=true;node.x=Math.max(10,originX+(move.clientX-startX)/flowZoom);node.y=Math.max(10,originY+(move.clientY-startY)/flowZoom);el.style.left=`${node.x}px`;el.style.top=`${node.y}px`;drawFlowLines();};
      el.onpointerup=()=>{el.onpointermove=null;if(moved)markFlowDirty();};
    };
  });
}
function pointerOnCanvas(event){const rect=$('#flow-canvas').getBoundingClientRect();return{x:(event.clientX-rect.left)/flowZoom,y:(event.clientY-rect.top)/flowZoom};}
function bindPortLinking(){
  $$('.link-port.out').forEach(port=>{
    port.onpointerdown=event=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();
      const sourceId=port.dataset.sourceNode;const optionIndex=port.dataset.optionIndex==null?null:Number(port.dataset.optionIndex);const source=getBotNode(sourceId);if(!source)return;
      selectedNodeId=sourceId;$$('.visual-node').forEach(x=>x.classList.toggle('selected',x.dataset.nodeId===sourceId));renderInspector();
      const start=nodeAnchor(source,true,optionIndex);const svg=$('#flow-lines');const draft=document.createElementNS('http://www.w3.org/2000/svg','path');draft.setAttribute('class','flow-line linking-line');draft.setAttribute('d',curvePath(start,start));svg.append(draft);document.body.classList.add('is-linking');
      const move=moveEvent=>{draft.setAttribute('d',curvePath(start,pointerOnCanvas(moveEvent)));const target=document.elementFromPoint(moveEvent.clientX,moveEvent.clientY)?.closest('.link-port.in');$$('.link-port.in').forEach(x=>x.classList.toggle('link-target',x===target&&x.dataset.targetNode!==sourceId));};
      const finish=upEvent=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);document.body.classList.remove('is-linking');$$('.link-port.in').forEach(x=>x.classList.remove('link-target'));const target=document.elementFromPoint(upEvent.clientX,upEvent.clientY)?.closest('.link-port.in');const targetId=target?.dataset.targetNode;if(targetId&&targetId!==sourceId){if(optionIndex===null)source.next=targetId;else if(source.options?.[optionIndex])source.options[optionIndex].next=targetId;renderBotFlow();markFlowDirty();toast('تم ربط المسار');}else{draft.remove();drawFlowLines();}};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});
    };
  });
}
function renderInspector() {
  const pane=$('#node-inspector'); if(!pane)return; const node=getBotNode(selectedNodeId);
  const shell=$('.builder-shell');
  if(!node){pane.hidden=true;pane.innerHTML='';shell?.classList.remove('inspector-open');return;}
  pane.hidden=false;shell?.classList.add('inspector-open');
  const messageField=!['start'].includes(node.type)?`<label>${node.type==='message'||node.type==='end'?'نص الرسالة':'نص السؤال'}<textarea id="inspect-message" rows="4">${escapeHtml(node.message||'')}</textarea></label>`:'';
  const fieldField=['input','phone','buttons'].includes(node.type)?`<label>حفظ الإجابة باسم<input id="inspect-field" value="${escapeHtml(node.field||'الإجابة')}" placeholder="مثال: المحافظة"></label>`:'';
  const nextField=!['buttons','end'].includes(node.type)?`<label>العقدة التالية<select id="inspect-next">${allTargetOptions(node.id,node.next)}</select></label>`:'';
  const optionFields=node.type==='buttons'?`<div class="inspector-options"><label>الأزرار <small>(حتى 3)</small></label>${(node.options||[]).map((option,index)=>`<div class="inspector-option" data-option-index="${index}"><div class="inspector-option-head"><b>زر ${index+1}</b><button class="delete-bot-option">×</button></div><input class="inspect-option-label" value="${escapeHtml(option.label||'')}" placeholder="عنوان الزر"><input class="inspect-option-aliases" value="${escapeHtml((option.aliases||[]).join('، '))}" placeholder="كلمات بديلة: 1، بغداد"><select class="inspect-option-next">${allTargetOptions(node.id,option.next)}</select></div>`).join('')}<button id="add-bot-option" class="ghost" ${(node.options||[]).length>=3?'disabled':''}>＋ إضافة زر</button></div>`:'';
  pane.innerHTML=`<div class="inspector-heading"><div><span class="inspector-type">${nodeMeta[node.type].icon} ${nodeMeta[node.type].label}</span><h3>خصائص العقدة</h3></div><button id="close-inspector" title="إغلاق">×</button></div><label>معرّف العقدة<input class="node-id-field" value="${escapeHtml(node.id)}" disabled></label>${messageField}${fieldField}${nextField}${optionFields}<div class="inspector-actions">${node.type!=='start'?'<button id="delete-bot-node" class="ghost danger">حذف</button>':''}<button id="duplicate-bot-node" class="ghost">▣ نسخ</button></div>`;
  $('#close-inspector',pane).onclick=()=>{selectedNodeId=null;renderBotFlow();};
  $('#inspect-message',pane)?.addEventListener('input',e=>{node.message=e.target.value;updateSelectedCard(node);markFlowDirty();});
  $('#inspect-field',pane)?.addEventListener('input',e=>{node.field=e.target.value;markFlowDirty();});
  $('#inspect-next',pane)?.addEventListener('change',e=>{node.next=e.target.value||null;drawFlowLines();markFlowDirty();});
  $$('.inspector-option',pane).forEach(row=>{const option=node.options[Number(row.dataset.optionIndex)];$('.inspect-option-label',row).oninput=e=>{option.label=e.target.value;updateSelectedCard(node);markFlowDirty();};$('.inspect-option-aliases',row).oninput=e=>{option.aliases=e.target.value.split(/[،,]/).map(x=>x.trim()).filter(Boolean);markFlowDirty();};$('.inspect-option-next',row).onchange=e=>{option.next=e.target.value||null;drawFlowLines();markFlowDirty();};$('.delete-bot-option',row).onclick=()=>{node.options.splice(Number(row.dataset.optionIndex),1);renderBotFlow();markFlowDirty();};});
  $('#add-bot-option',pane)?.addEventListener('click',()=>{if((node.options||[]).length<3){node.options.push({id:newId('option'),label:`زر ${node.options.length+1}`,aliases:[],next:null});renderBotFlow();markFlowDirty();}});
  $('#delete-bot-node',pane)?.addEventListener('click',()=>deleteBotNode(node.id));
  $('#duplicate-bot-node',pane)?.addEventListener('click',()=>{const copy=structuredClone(node);copy.id=newId(copy.type);copy.x=(node.x||0)+40;copy.y=(node.y||0)+60;if(copy.type==='start')copy.type='message';botFlow.nodes.push(copy);selectedNodeId=copy.id;renderBotFlow();markFlowDirty();});
}
function updateSelectedCard(node){const el=$(`[data-node-id="${node.id}"]`);if(!el)return;$('.visual-node-body',el).textContent=nodeSummary(node);if(node.type==='buttons')$('.visual-node-options',el).innerHTML=(node.options||[]).map((o,i)=>`<span style="--option-color:${['#6366f1','#10b981','#f59e0b'][i%3]}">${i+1}. ${escapeHtml(o.label||'زر جديد')}</span>`).join('');}
function deleteBotNode(id){botFlow.nodes=botFlow.nodes.filter(n=>n.id!==id);for(const n of botFlow.nodes){if(n.next===id)n.next=null;(n.options||[]).forEach(o=>{if(o.next===id)o.next=null;});}selectedNodeId=null;renderBotFlow();markFlowDirty();}
function addBotNode(type){
  if(type==='start'&&botFlow.nodes.some(n=>n.type==='start'))return toast('توجد عقدة بداية بالفعل');
  const selected=getBotNode(selectedNodeId); const index=botFlow.nodes.length;
  const node={id:newId(type),type,x:selected?(selected.x||0)+280:100+(index%4)*260,y:selected?(selected.y||0):100+Math.floor(index/4)*180};
  if(type==='message')node.message='اكتب رسالتك هنا';
  if(type==='input')Object.assign(node,{message:'اكتب إجابتك:',field:'الإجابة'});
  if(type==='phone')Object.assign(node,{message:'يرجى كتابة رقم الهاتف:',field:'رقم الهاتف'});
  if(type==='buttons')Object.assign(node,{message:'اختر من القائمة:',field:'الاختيار',options:[{id:newId('option'),label:'الخيار الأول',aliases:['1'],next:null},{id:newId('option'),label:'الخيار الثاني',aliases:['2'],next:null}]});
  if(type==='end')node.message='تم تسجيل معلوماتك بنجاح ✅';
  botFlow.nodes.push(node); selectedNodeId=node.id;renderBotFlow();markFlowDirty();
}
$$('[data-add-node]').forEach(button=>button.onclick=()=>addBotNode(button.dataset.addNode));
$('#block-search').oninput=event=>{const query=event.target.value.trim().toLowerCase();$$('[data-add-node]').forEach(button=>{button.hidden=query&&!button.textContent.toLowerCase().includes(query);});};
$('#fit-flow').onclick=()=>{let x=70,y=100;const visited=new Set();let node=botFlow.nodes.find(n=>n.type==='start');while(node&&!visited.has(node.id)){visited.add(node.id);node.x=x;node.y=y;x+=280;node=getBotNode(node.next||(node.options?.[0]?.next));}botFlow.nodes.filter(n=>!visited.has(n.id)).forEach((n,i)=>{n.x=70+(i%4)*280;n.y=340+Math.floor(i/4)*190;});renderBotFlow();markFlowDirty();};
$('#zoom-out').onclick=()=>setFlowZoom(flowZoom-.1);
$('#zoom-in').onclick=()=>setFlowZoom(flowZoom+.1);
$('#center-flow').onclick=()=>{const wrap=$('.flow-canvas-wrap');const nodes=botFlow.nodes;if(!nodes.length)return;const minX=Math.min(...nodes.map(n=>n.x||0));const minY=Math.min(...nodes.map(n=>n.y||0));const maxX=Math.max(...nodes.map(n=>(n.x||0)+($(`[data-node-id="${n.id}"]`)?.offsetWidth||220)));const maxY=Math.max(...nodes.map(n=>(n.y||0)+($(`[data-node-id="${n.id}"]`)?.offsetHeight||120)));wrap.scrollTo({left:Math.max(0,((minX+maxX)/2)*flowZoom-wrap.clientWidth/2),top:Math.max(0,((minY+maxY)/2)*flowZoom-wrap.clientHeight/2),behavior:'smooth'});};
$('.flow-canvas-wrap').onpointerdown=event=>{if(event.button!==0||event.target.closest('.visual-node,.canvas-controls'))return;const wrap=event.currentTarget;const sx=event.clientX,sy=event.clientY,sl=wrap.scrollLeft,st=wrap.scrollTop;wrap.classList.add('panning');wrap.setPointerCapture(event.pointerId);wrap.onpointermove=move=>{wrap.scrollLeft=sl-(move.clientX-sx);wrap.scrollTop=st-(move.clientY-sy);};wrap.onpointerup=()=>{wrap.onpointermove=null;wrap.classList.remove('panning');};};

async function saveBotFlow(publish=false){
  const url=publish?'/api/bot-flow/publish':'/api/bot-flow'; const method=publish?'POST':'PUT';
  const result=await api(url,{method,body:JSON.stringify(botFlow)}); botFlow=result.flow;flowDirty=false;$('#bot-save-state').textContent=publish?'منشور على واتساب':'تم حفظ المسودة';$('#bot-save-state').className=publish?'published-badge':'';toast(publish?'تم نشر البوت على واتساب':'تم حفظ المسودة');
}
$('#bot-save').onclick=()=>saveBotFlow(false).catch(e=>toast(e.message));
$('#bot-publish').onclick=()=>saveBotFlow(true).catch(e=>toast(e.message));

function exportBotJson(){
  const typeMap={start:'start',message:'text',input:'input_text',phone:'phone',buttons:'buttons',end:'end'};
  const blocks=botFlow.nodes.map(node=>{
    const data={uid:node.id};
    if(node.type==='message'||node.type==='end')data.text=node.message||'';
    if(node.type==='input'||node.type==='phone')Object.assign(data,{question:node.message||'',variable:node.field||'',required:'true',button_label:'إرسال'});
    if(node.type==='buttons')Object.assign(data,{text:node.message||'',options:(node.options||[]).map(o=>o.label).join(','),variable:node.field||''});
    return {id:node.id,bot_id:'local',type:typeMap[node.type],data:JSON.stringify(data),pos_x:String(Math.round(node.x||0)),pos_y:String(Math.round(node.y||0)),created_at:new Date().toISOString()};
  });
  const edges=[];
  for(const node of botFlow.nodes){
    if(node.type==='buttons'){
      for(const option of node.options||[]){if(option.next)edges.push({id:newId('edge'),bot_id:'local',from_block_id:node.id,to_block_id:option.next,condition_type:'button',condition_value:option.label});}
    }else if(node.next)edges.push({id:newId('edge'),bot_id:'local',from_block_id:node.id,to_block_id:node.next,condition_type:null,condition_value:'default'});
  }
  return {meta:{name:botFlow.name||'WhatsApp Bot',description:'Visual WhatsApp bot flow',keywords:'',version:'3.0',exported_at:new Date().toISOString()},blocks,edges};
}
function importBotJson(payload){
  if(!payload||!Array.isArray(payload.blocks)||!Array.isArray(payload.edges))throw new Error('ملف JSON لا يحتوي blocks و edges');
  const typeMap={start:'start',text:'message',input_text:'input',phone:'phone',input_phone:'phone',buttons:'buttons',end:'end'};
  const nodes=payload.blocks.map((block,index)=>{
    const type=typeMap[block.type];if(!type)return null;
    let data={};try{data=typeof block.data==='string'?JSON.parse(block.data):block.data||{};}catch{throw new Error(`بيانات العقدة ${block.id} غير صالحة`);}
    const node={id:block.id||newId(type),type,x:Number(block.pos_x)||100+(index%4)*270,y:Number(block.pos_y)||100+Math.floor(index/4)*180};
    if(type==='message'||type==='end')node.message=data.text||'';
    if(type==='input'||type==='phone')Object.assign(node,{message:data.question||data.text||'',field:data.variable||'الإجابة'});
    if(type==='buttons')Object.assign(node,{message:data.text||data.question||'',field:data.variable||'الاختيار',options:String(data.options||'').split(',').map((label,i)=>({id:newId('option'),label:label.trim()||`زر ${i+1}`,aliases:[String(i+1)],next:null})).filter(o=>o.label)});
    return node;
  }).filter(Boolean);
  const byId=new Map(nodes.map(node=>[node.id,node]));
  for(const edge of payload.edges){const source=byId.get(edge.from_block_id);if(!source||!byId.has(edge.to_block_id))continue;if(source.type==='buttons'){if(edge.condition_value==='default'){for(const option of source.options||[])option.next=edge.to_block_id;}else{const option=(source.options||[]).find(o=>o.label===edge.condition_value);if(option)option.next=edge.to_block_id;}}else source.next=edge.to_block_id;}
  if(!nodes.some(n=>n.type==='start'))throw new Error('الملف لا يحتوي عقدة بداية');
  botFlow={name:payload.meta?.name||'بوت مستورد',nodes};selectedNodeId=null;renderBotFlow();markFlowDirty();toast('تم استيراد المخطط، راجعه ثم احفظه');
}
$('#bot-export').onclick=()=>{const blob=new Blob([JSON.stringify(exportBotJson(),null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${(botFlow.name||'bot').replace(/[^\p{L}\p{N}_-]+/gu,'-')}.json`;link.click();URL.revokeObjectURL(link.href);};
$('#bot-import').onclick=()=>$('#bot-import-file').click();
$('#bot-import-file').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{importBotJson(JSON.parse(await file.text()));}catch(error){toast(error.message);}event.target.value='';};

function interpolatePreview(text,answers){return String(text||'').replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_m,k)=>answers[k]??'');}
function previewBubble(text,who,options=[]){const div=document.createElement('div');div.className=`bubble ${who}`;div.append(document.createTextNode(text));for(const option of options){const button=document.createElement('button');button.className='preview-choice';button.textContent=option.label;button.onclick=()=>previewSubmit(option.label);div.append(button);}$('#bot-preview-chat').append(div);$('#bot-preview-chat').scrollTop=$('#bot-preview-chat').scrollHeight;}
function previewAdvance(nodeId){let guard=0;while(nodeId&&guard++<100){const node=getBotNode(nodeId);if(!node)return;if(node.type==='start'){nodeId=node.next;continue;}if(node.type==='message'){previewBubble(interpolatePreview(node.message,previewState.answers),'bot');nodeId=node.next;continue;}if(['input','phone','buttons'].includes(node.type)){previewState.nodeId=node.id;previewBubble(interpolatePreview(node.message,previewState.answers),'bot',node.type==='buttons'?(node.options||[]):[]);return;}if(node.type==='end'){previewBubble(interpolatePreview(node.message,previewState.answers),'bot');previewState.nodeId=null;return;}nodeId=node.next;}}
function startBotPreview(){$('#bot-preview-chat').innerHTML='';previewState={answers:{},nodeId:null};previewAdvance(botFlow.nodes.find(n=>n.type==='start')?.id);}
function previewSubmit(text){if(!text||!previewState)return;previewBubble(text,'user');const node=getBotNode(previewState.nodeId);if(!node)return;let next=node.next,value=text;if(node.type==='buttons'){const normalized=text.trim().toLowerCase();const option=(node.options||[]).find((o,i)=>[o.label,String(i+1),...(o.aliases||[])].some(a=>String(a).trim().toLowerCase()===normalized));if(!option){previewBubble('الاختيار غير صحيح، حاول مرة أخرى.','bot',node.options||[]);return;}value=option.label;next=option.next||node.next;}if(node.type==='phone'&&text.replace(/\D/g,'').length<8){previewBubble('يرجى إدخال رقم هاتف صحيح.','bot');return;}previewState.answers[node.field||node.id]=value;previewAdvance(next);}
$('#bot-preview').onclick=()=>{$('#bot-preview-modal').hidden=false;startBotPreview();};
$('#close-bot-preview').onclick=()=>{$('#bot-preview-modal').hidden=true;};
$('#restart-bot-preview').onclick=startBotPreview;
$('#bot-preview-form').onsubmit=e=>{e.preventDefault();const input=$('#bot-preview-input');const text=input.value.trim();input.value='';previewSubmit(text);};

async function boot(attempt=0) {
  try { await load(); if (account?.access?.allowed) $('#restart-test').click(); }
  catch (error) {
    toast(error.message);
    if (attempt < 3) setTimeout(() => boot(attempt + 1), 1500 * (attempt + 1));
  }
}
boot();
setInterval(() => { if (account?.access?.allowed) refreshStatus(); }, 4000);
