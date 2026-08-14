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
  const isTrial = account.access.state === 'trial';
  const isActive = account.access.state === 'active';
  const plan = isActive ? 'حساب مفعّل بالكامل' : (isTrial ? `متبقي ${account.access.daysLeft} يوم من التجربة` : 'اشتراك منتهي - البوت متوقف');
  
  $('#account-plan').textContent = plan;
  $('#trial-pill').textContent = plan;
  
  if ($('#billing-plan-title')) {
    $('#billing-plan-title').textContent = isActive ? 'الباقة المفعّلة' : (isTrial ? 'باقة التجربة المجانية' : 'الاشتراك منتهي (البوت متوقف)');
    $('#billing-status-badge').textContent = isActive ? 'مفعّل 🟢' : (isTrial ? `تجربة مجانية (${account.access.daysLeft} يوم)` : 'منتهي 🔴');
    $('#billing-status-badge').className = `cloud-badge ${isActive ? 'good' : (isTrial ? '' : 'bad')}`;
    $('#billing-days-left').textContent = isActive ? 'غير محدود' : `${account.access.daysLeft} يوم`;
    $('#billing-expiry-date').textContent = account.trialEndsAt ? `تنتهي في: ${new Date(account.trialEndsAt).toLocaleDateString('ar-IQ')}` : 'اشتراك مفعّل دائم';
  }

  const number = String(adminWhatsapp).replace(/\D/g,'');
  const adminWaUrl = number ? `https://wa.me/${number}` : '#';
  
  const defaultMsg = `مرحباً، أريد تفعيل وتجديد الاشتراك لحسابي: ${account.email}`;
  if ($('#contact-admin')) $('#contact-admin').href = number ? `${adminWaUrl}?text=${encodeURIComponent(defaultMsg)}` : `mailto:?subject=${encodeURIComponent('طلب تفعيل الحساب')}&body=${encodeURIComponent(defaultMsg)}`;
  if ($('#pay-whatsapp-admin')) $('#pay-whatsapp-admin').href = number ? `${adminWaUrl}?text=${encodeURIComponent(defaultMsg)}` : '#';

  $$('.select-plan-btn').forEach(btn => {
    btn.onclick = () => {
      const planName = btn.dataset.plan;
      const price = btn.dataset.price;
      const msg = `مرحباً، أريد الاشتراك بـ (${planName}) بسعر ${price}.\nالبريد الإلكتروني للحساب: ${account.email}\nيرجى تزويدي بتفاصيل التحويل والتفعيل.`;
      if (number) {
        window.open(`${adminWaUrl}?text=${encodeURIComponent(msg)}`, '_blank');
      } else {
        toast('يرجى التواصل مع الإدارة للتفعيل');
      }
    };
  });
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
  if (button.dataset.page === 'broadcast') loadBroadcastPage();
});
const toggleSidebarMode = () => {
  if (window.innerWidth <= 1024) {
    $('.sidebar').classList.toggle('open');
  } else {
    if (document.body.classList.contains('bot-focus')) {
      document.body.classList.toggle('sidebar-collapsed');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
  }
};
$('#menu').onclick = toggleSidebarMode;
$('#bot-menu-toggle').onclick = toggleSidebarMode;

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
$('#check-cloud-events').onclick = async () => {
  const box = $('#cloud-events'); box.hidden = false; box.textContent = 'جاري قراءة آخر الرسائل…';
  try {
    const data = await api('/api/cloud/diagnostics');
    const labels = {
      webhook_received:'وصل Webhook من Meta', message_received:'وصلت رسالة الزبون',
      bot_replies_ready:'جهّز البوت الرد', reply_sent:'أرسل الموقع الرد',
      message_processing_failed:'فشل تجهيز/إرسال الرد', webhook_ignored:'تم تجاهل Webhook',
      app_subscription_checked:'تم فحص اشتراك التطبيق'
    };
    box.textContent = (data.events || []).slice(0, 15).map(event => {
      const time = new Date(event.at).toLocaleTimeString('ar-IQ', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const details = [event.selection && `المدخل: ${event.selection}`, event.count != null && `الردود: ${event.count}`, event.replyType && `النوع: ${event.replyType}`, event.reason && `السبب: ${event.reason}`, event.error && `الخطأ: ${event.error}`].filter(Boolean).join(' — ');
      return `${time} | ${labels[event.type] || event.type}${details ? ` — ${details}` : ''}`;
    }).join('\n') || 'لا توجد رسائل واردة منذ آخر تشغيل للخادم.';
  } catch (error) { box.textContent = `تعذر قراءة السجل: ${error.message}`; }
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
  start: { label:'بداية', icon:'⚑' }, message: { label:'رسالة نصية', icon:'✉' },
  media: { label:'صورة / وسائط', icon:'🖼' }, input: { label:'سؤال نصي', icon:'أ' },
  phone: { label:'رقم هاتف', icon:'☎' }, location: { label:'طلب موقع', icon:'📍' },
  buttons: { label:'أزرار (3)', icon:'☷' }, list: { label:'قائمة خيارات (10)', icon:'📋' },
  carousel: { label:'سلايدر منتجات', icon:'▤' }, condition: { label:'شرط وتفرع', icon:'🔀' },
  notify: { label:'تنبيه الإدمن', icon:'🔔' }, end: { label:'نهاية المسار', icon:'■' }
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
function createEmptyBotFlow() {
  return { name: 'مشروع جديد', nodes: [ { id: newId('start'), type: 'start', x: 80, y: 300, next: null } ] };
}
function getBotNode(id) { return botFlow.nodes.find(node => node.id === id); }
function nodeSummary(node) {
  if (node.type==='start') return 'بداية المحادثة';
  if (node.type==='end') return node.message || 'إنهاء وحفظ بيانات الزبون';
  if (node.type==='carousel') return node.templateName ? `قالب Meta: ${node.templateName}` : 'سلايدر صور ومنتجات';
  if (node.type==='media') return node.mediaUrl ? `وسائط (${node.mediaType||'صورة'}): ${node.mediaUrl.slice(-20)}` : (node.message || 'إرسال صورة أو ملف وسائط');
  if (node.type==='location') return node.message || 'طلب إرسال الموقع الجغرافي (GPS)';
  if (node.type==='condition') return `إذا كان [${node.checkField||'الحقل'}] ${node.operator==='contains'?'يحتوي':'يساوي'} "${node.checkValue||''}"`;
  if (node.type==='notify') return `تنبيه للإدمن: ${node.adminPhone || 'رقم الواتساب'}`;
  return node.message || (node.type==='message' ? 'اكتب رسالتك هنا' : 'اكتب السؤال هنا');
}
function markFlowDirty() { flowDirty=true; const el=$('#bot-save-state'); el.textContent='تغييرات غير محفوظة'; el.className='dirty-badge'; }
function allTargetOptions(currentId, selected='') {
  return `<option value="">بدون رابط</option>` + botFlow.nodes.filter(n=>n.id!==currentId).map(n=>`<option value="${n.id}" ${n.id===selected?'selected':''}>${nodeMeta[n.type]?.label||n.type} — ${escapeHtml(nodeSummary(n).slice(0,30))}</option>`).join('');
}

function renderBotFlow() {
  if (!botFlow) return;
  const holder=$('#flow-nodes');
  holder.innerHTML=botFlow.nodes.map(node=>{
    const hasOptions = ['buttons','list'].includes(node.type);
    const isCondition = node.type === 'condition';
    const optionsHtml = hasOptions ? `<div class="visual-node-options">${(node.options||[]).map((o,i)=>`<span style="--option-color:${['#6366f1','#10b981','#f59e0b','#ec4899','#8b5cf6'][i%5]}">${i+1}. ${escapeHtml(o.label||'خيار جديد')}</span>`).join('')}</div>` : (isCondition ? `<div class="visual-node-options"><span style="color:#10b981">✓ نعم (تحقق الشرط)</span><span style="color:#ef4444">✕ لا (لم يتحقق)</span></div>` : '');
    let ports = '';
    if (hasOptions) {
      ports = (node.options||[]).map((o,i)=>`<i class="option-port link-port out" data-source-node="${node.id}" data-option-index="${i}" style="top:${87+i*32}px;background:${['#6366f1','#10b981','#f59e0b','#ec4899','#8b5cf6'][i%5]}" title="اسحب لربط: ${escapeHtml(o.label)}"></i>`).join('');
    } else if (isCondition) {
      ports = `<i class="option-port link-port out" data-source-node="${node.id}" data-condition-branch="yes" style="top:87px;background:#10b981" title="مسار تحقّق الشرط (نعم)"></i><i class="option-port link-port out" data-source-node="${node.id}" data-condition-branch="no" style="top:119px;background:#ef4444" title="مسار عدم تحقّق الشرط (لا)"></i>`;
    } else if (node.type !== 'end') {
      ports = `<i class="node-port link-port out" data-source-node="${node.id}" title="اسحب لربط العقدة التالية"></i>`;
    }
    return `<div class="visual-node ${node.type} ${node.id===selectedNodeId?'selected':''}" data-node-id="${node.id}" style="left:${node.x||0}px;top:${node.y||0}px"><div class="visual-node-head"><b>${nodeMeta[node.type]?.icon||'•'}</b>${nodeMeta[node.type]?.label||node.type}</div><div class="visual-node-body">${escapeHtml(nodeSummary(node))}</div>${optionsHtml}${node.type!=='start'?`<i class="node-port link-port in" data-target-node="${node.id}" title="أفلت الخط هنا"></i>`:''}${ports}</div>`;
  }).join('');
  drawFlowLines(); renderInspector(); bindNodeDragging(); bindPortLinking();
  applyFlowZoom();
  requestAnimationFrame(drawFlowLines);
}
function applyFlowZoom(){const canvas=$('#flow-canvas');if(!canvas)return;canvas.style.transform=`scale(${flowZoom})`;canvas.style.transformOrigin='0 0';$('#zoom-level').textContent=`${Math.round(flowZoom*100)}%`;}
function setFlowZoom(value){flowZoom=Math.min(1.5,Math.max(.5,value));applyFlowZoom();}
function nodeAnchor(node, outgoing=true, optionIndex=null, condBranch=null) {
  const el=$(`[data-node-id="${node.id}"]`);
  const width = el?.offsetWidth || 240;
  const height = el?.offsetHeight || 90;
  const x = (node.x||0) + (outgoing ? width : 0);
  let y = (node.y||0) + (height / 2);
  if (optionIndex !== null) y = (node.y||0) + (87 + optionIndex * 27);
  if (condBranch === 'yes') y = (node.y||0) + 87;
  if (condBranch === 'no') y = (node.y||0) + 115;
  return {x,y};
}
function curvePath(from,to) { const bend=Math.max(70,Math.abs(to.x-from.x)*.45); return `M ${from.x} ${from.y} C ${from.x+bend} ${from.y}, ${to.x-bend} ${to.y}, ${to.x} ${to.y}`; }
function drawFlowLines() {
  const svg=$('#flow-lines'); if(!svg)return; let lines='';
  for(const node of botFlow.nodes){
    if(['buttons','list'].includes(node.type)) {
      (node.options||[]).forEach((option,index)=>{const target=getBotNode(option.next);if(target)lines+=`<path class="flow-line option" d="${curvePath(nodeAnchor(node,true,index),nodeAnchor(target,false))}"/>`;});
    } else if (node.type === 'condition') {
      const yesTarget = getBotNode(node.yesNext); if(yesTarget) lines+=`<path class="flow-line option" style="stroke:#10b981" d="${curvePath(nodeAnchor(node,true,null,'yes'),nodeAnchor(yesTarget,false))}"/>`;
      const noTarget = getBotNode(node.noNext); if(noTarget) lines+=`<path class="flow-line option" style="stroke:#ef4444" d="${curvePath(nodeAnchor(node,true,null,'no'),nodeAnchor(noTarget,false))}"/>`;
    } else {
      const target=getBotNode(node.next);if(target)lines+=`<path class="flow-line" d="${curvePath(nodeAnchor(node,true),nodeAnchor(target,false))}"/>`;
    }
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
      const sourceId=port.dataset.sourceNode;
      const optionIndex=port.dataset.optionIndex==null?null:Number(port.dataset.optionIndex);
      const condBranch=port.dataset.conditionBranch||null;
      const source=getBotNode(sourceId);if(!source)return;
      selectedNodeId=sourceId;$$('.visual-node').forEach(x=>x.classList.toggle('selected',x.dataset.nodeId===sourceId));renderInspector();
      const start=nodeAnchor(source,true,optionIndex,condBranch);const svg=$('#flow-lines');const draft=document.createElementNS('http://www.w3.org/2000/svg','path');draft.setAttribute('class','flow-line linking-line');draft.setAttribute('d',curvePath(start,start));svg.append(draft);document.body.classList.add('is-linking');
      const move=moveEvent=>{draft.setAttribute('d',curvePath(start,pointerOnCanvas(moveEvent)));const target=document.elementFromPoint(moveEvent.clientX,moveEvent.clientY)?.closest('.link-port.in');$$('.link-port.in').forEach(x=>x.classList.toggle('link-target',x===target&&x.dataset.targetNode!==sourceId));};
      const finish=upEvent=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);document.body.classList.remove('is-linking');$$('.link-port.in').forEach(x=>x.classList.remove('link-target'));const target=document.elementFromPoint(upEvent.clientX,upEvent.clientY)?.closest('.link-port.in');const targetId=target?.dataset.targetNode;if(targetId&&targetId!==sourceId){
        if (condBranch === 'yes') source.yesNext = targetId;
        else if (condBranch === 'no') source.noNext = targetId;
        else if(optionIndex===null) source.next=targetId;
        else if(source.options?.[optionIndex]) source.options[optionIndex].next=targetId;
        renderBotFlow();markFlowDirty();toast('تم ربط المسار');
      }else{draft.remove();drawFlowLines();}};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});
    };
  });
}
function renderInspector() {
  const pane=$('#node-inspector'); if(!pane)return; const node=getBotNode(selectedNodeId);
  const shell=$('.builder-shell');
  if(!node){pane.hidden=true;pane.innerHTML='';shell?.classList.remove('inspector-open');return;}
  pane.hidden=false;shell?.classList.add('inspector-open');
  const messageField=!['start','carousel','condition'].includes(node.type)?`<label>${['message','media','end','notify'].includes(node.type)?'نص الرسالة':'نص السؤال'}<textarea id="inspect-message" rows="4">${escapeHtml(node.message||'')}</textarea></label>`:'';
  const fieldField=['input','phone','buttons','list','location'].includes(node.type)?`<label>حفظ الإجابة باسم الحقل<input id="inspect-field" value="${escapeHtml(node.field||'الإجابة')}" placeholder="مثال: المحافظة"></label>`:'';
  const nextField=!['buttons','list','condition','end'].includes(node.type)?`<label>العقدة التالية<select id="inspect-next">${allTargetOptions(node.id,node.next)}</select></label>`:'';
  const optionFields=['buttons','list'].includes(node.type)?`<div class="inspector-options"><label>الخيارات <small>(${node.type==='list'?'حتى 10':'حتى 3'})</small></label>${(node.options||[]).map((option,index)=>`<div class="inspector-option" data-option-index="${index}"><div class="inspector-option-head"><b>خيار ${index+1}</b><button class="delete-bot-option">×</button></div><input class="inspect-option-label" value="${escapeHtml(option.label||'')}" placeholder="عنوان الخيار">${node.type==='list'?`<input class="inspect-option-desc" value="${escapeHtml(option.description||'')}" placeholder="شرح مصغر (اختياري)">`:''}<input class="inspect-option-aliases" value="${escapeHtml((option.aliases||[]).join('، '))}" placeholder="كلمات بديلة: 1، بغداد"><select class="inspect-option-next">${allTargetOptions(node.id,option.next)}</select></div>`).join('')}<button id="add-bot-option" class="ghost" ${(node.options||[]).length>=(node.type==='list'?10:3)?'disabled':''}>＋ إضافة خيار</button></div>`:'';
  const mediaFields=node.type==='media'?`<div class="media-settings"><label>نوع الوسائط<select id="inspect-media-type"><option value="image" ${node.mediaType==='image'?'selected':''}>صورة</option><option value="video" ${node.mediaType==='video'?'selected':''}>فيديو</option><option value="document" ${node.mediaType==='document'?'selected':''}>ملف / PDF</option></select></label><label>رابط الملف المباشر (HTTPS)<input id="inspect-media-url" dir="ltr" value="${escapeHtml(node.mediaUrl||'')}" placeholder="https://example.com/file.jpg"></label></div>`:'';
  const conditionFields=node.type==='condition'?`<div class="condition-settings"><label>اسم الحقل المراد فحصه<input id="inspect-check-field" value="${escapeHtml(node.checkField||'')}" placeholder="مثال: المحافظة"></label><label>نوع المطابقة<select id="inspect-operator"><option value="equals" ${node.operator==='equals'?'selected':''}>يساوي تماماً</option><option value="contains" ${node.operator==='contains'?'selected':''}>يحتوي على الكلمة</option></select></label><label>القيمة المطلوبة<input id="inspect-check-value" value="${escapeHtml(node.checkValue||'')}" placeholder="مثال: بغداد"></label><label>مسار (نعم - تحقق الشرط)<select id="inspect-yes-next">${allTargetOptions(node.id,node.yesNext)}</select></label><label>مسار (لا - لم يتحقق)<select id="inspect-no-next">${allTargetOptions(node.id,node.noNext)}</select></label></div>`:'';
  const notifyFields=node.type==='notify'?`<div class="notify-settings"><label>رقم واتساب الإدمن المُنَبّه<input id="inspect-admin-phone" dir="ltr" value="${escapeHtml(node.adminPhone||'')}" placeholder="+964 7xx xxx xxxx"></label></div>`:'';
  const carouselFields=node.type==='carousel'?`<div class="carousel-settings"><label>اسم القالب المعتمد في Meta<input id="inspect-template-name" dir="ltr" value="${escapeHtml(node.templateName||'')}" placeholder="products_carousel"></label><label>لغة القالب<input id="inspect-language-code" dir="ltr" value="${escapeHtml(node.languageCode||'ar')}" placeholder="ar"></label><label>قيمة متغير الرسالة الرئيسية <small>(اختياري)</small><input id="inspect-carousel-body" value="${escapeHtml(node.bodyValue||'')}" placeholder="مثال: عروض هذا الأسبوع"></label><p class="carousel-note">يجب أن يكون القالب في Meta من نوع Carousel: رأس صورة، متغير نص واحد، وزر رابط واحد لكل بطاقة.</p><div class="carousel-cards">${(node.cards||[]).map((card,index)=>`<div class="carousel-card-editor" data-card-index="${index}"><div class="inspector-option-head"><b>بطاقة ${index+1}</b><button class="delete-carousel-card">×</button></div><label>رابط الصورة العام HTTPS<input class="inspect-card-image" dir="ltr" value="${escapeHtml(card.imageUrl||'')}" placeholder="https://example.com/product.jpg"></label><label>نص/اسم المنتج<input class="inspect-card-body" value="${escapeHtml(card.bodyValue||'')}" placeholder="اسم المنتج"></label><label>الجزء المتغير من رابط الزر <small>(اختياري)</small><input class="inspect-card-button" dir="ltr" value="${escapeHtml(card.buttonValue||'')}" placeholder="product/123"></label></div>`).join('')}</div><button id="add-carousel-card" class="ghost" ${(node.cards||[]).length>=10?'disabled':''}>＋ إضافة بطاقة</button></div>`:'';
  pane.innerHTML=`<div class="inspector-heading"><div><span class="inspector-type">${nodeMeta[node.type]?.icon||'•'} ${nodeMeta[node.type]?.label||node.type}</span><h3>خصائص العقدة</h3></div><button id="close-inspector" title="إغلاق">×</button></div><label>معرّف العقدة<input class="node-id-field" value="${escapeHtml(node.id)}" disabled></label>${messageField}${fieldField}${mediaFields}${conditionFields}${notifyFields}${nextField}${optionFields}${carouselFields}<div class="inspector-actions">${node.type!=='start'?'<button id="delete-bot-node" class="ghost danger">حذف</button>':''}<button id="duplicate-bot-node" class="ghost">▣ نسخ</button></div>`;
  $('#close-inspector',pane).onclick=()=>{selectedNodeId=null;renderBotFlow();};
  $('#inspect-message',pane)?.addEventListener('input',e=>{node.message=e.target.value;updateSelectedCard(node);markFlowDirty();});
  $('#inspect-field',pane)?.addEventListener('input',e=>{node.field=e.target.value;markFlowDirty();});
  $('#inspect-next',pane)?.addEventListener('change',e=>{node.next=e.target.value||null;drawFlowLines();markFlowDirty();});
  $('#inspect-media-type',pane)?.addEventListener('change',e=>{node.mediaType=e.target.value;markFlowDirty();});
  $('#inspect-media-url',pane)?.addEventListener('input',e=>{node.mediaUrl=e.target.value.trim();updateSelectedCard(node);markFlowDirty();});
  $('#inspect-admin-phone',pane)?.addEventListener('input',e=>{node.adminPhone=e.target.value.trim();updateSelectedCard(node);markFlowDirty();});
  $('#inspect-check-field',pane)?.addEventListener('input',e=>{node.checkField=e.target.value;updateSelectedCard(node);markFlowDirty();});
  $('#inspect-operator',pane)?.addEventListener('change',e=>{node.operator=e.target.value;updateSelectedCard(node);markFlowDirty();});
  $('#inspect-check-value',pane)?.addEventListener('input',e=>{node.checkValue=e.target.value;updateSelectedCard(node);markFlowDirty();});
  $('#inspect-yes-next',pane)?.addEventListener('change',e=>{node.yesNext=e.target.value||null;drawFlowLines();markFlowDirty();});
  $('#inspect-no-next',pane)?.addEventListener('change',e=>{node.noNext=e.target.value||null;drawFlowLines();markFlowDirty();});
  $$('.inspector-option',pane).forEach(row=>{const option=node.options[Number(row.dataset.optionIndex)];$('.inspect-option-label',row).oninput=e=>{option.label=e.target.value;updateSelectedCard(node);markFlowDirty();};if($('.inspect-option-desc',row)) $('.inspect-option-desc',row).oninput=e=>{option.description=e.target.value;markFlowDirty();};$('.inspect-option-aliases',row).oninput=e=>{option.aliases=e.target.value.split(/[،,]/).map(x=>x.trim()).filter(Boolean);markFlowDirty();};$('.inspect-option-next',row).onchange=e=>{option.next=e.target.value||null;drawFlowLines();markFlowDirty();};$('.delete-bot-option',row).onclick=()=>{node.options.splice(Number(row.dataset.optionIndex),1);renderBotFlow();markFlowDirty();};});
  $('#add-bot-option',pane)?.addEventListener('click',()=>{const max=node.type==='list'?10:3;if((node.options||[]).length<max){node.options.push({id:newId('option'),label:`خيار ${node.options.length+1}`,aliases:[],next:null});renderBotFlow();markFlowDirty();}});
  $('#inspect-template-name',pane)?.addEventListener('input',e=>{node.templateName=e.target.value.trim();updateSelectedCard(node);markFlowDirty();});
  $('#inspect-language-code',pane)?.addEventListener('input',e=>{node.languageCode=e.target.value.trim();markFlowDirty();});
  $('#inspect-carousel-body',pane)?.addEventListener('input',e=>{node.bodyValue=e.target.value;markFlowDirty();});
  $$('.carousel-card-editor',pane).forEach(row=>{const card=node.cards[Number(row.dataset.cardIndex)];$('.inspect-card-image',row).oninput=e=>{card.imageUrl=e.target.value.trim();markFlowDirty();};$('.inspect-card-body',row).oninput=e=>{card.bodyValue=e.target.value;markFlowDirty();};$('.inspect-card-button',row).oninput=e=>{card.buttonValue=e.target.value.trim();markFlowDirty();};$('.delete-carousel-card',row).onclick=()=>{if(node.cards.length<=2)return toast('يجب إبقاء بطاقتين على الأقل');node.cards.splice(Number(row.dataset.cardIndex),1);renderBotFlow();markFlowDirty();};});
  $('#add-carousel-card',pane)?.addEventListener('click',()=>{if((node.cards||[]).length<10){node.cards.push({imageUrl:'',bodyValue:`المنتج ${node.cards.length+1}`,buttonValue:''});renderBotFlow();markFlowDirty();}});
  $('#delete-bot-node',pane)?.addEventListener('click',()=>deleteBotNode(node.id));
  $('#duplicate-bot-node',pane)?.addEventListener('click',()=>{const copy=structuredClone(node);copy.id=newId(copy.type);copy.x=(node.x||0)+40;copy.y=(node.y||0)+60;if(copy.type==='start')copy.type='message';botFlow.nodes.push(copy);selectedNodeId=copy.id;renderBotFlow();markFlowDirty();});
}
function updateSelectedCard(node){const el=$(`[data-node-id="${node.id}"]`);if(!el)return;$('.visual-node-body',el).textContent=nodeSummary(node);if(['buttons','list'].includes(node.type))$('.visual-node-options',el).innerHTML=(node.options||[]).map((o,i)=>`<span style="--option-color:${['#6366f1','#10b981','#f59e0b','#ec4899','#8b5cf6'][i%5]}">${i+1}. ${escapeHtml(o.label||'خيار جديد')}</span>`).join('');}
function deleteBotNode(id){botFlow.nodes=botFlow.nodes.filter(n=>n.id!==id);for(const n of botFlow.nodes){if(n.next===id)n.next=null;if(n.yesNext===id)n.yesNext=null;if(n.noNext===id)n.noNext=null;(n.options||[]).forEach(o=>{if(o.next===id)o.next=null;});}selectedNodeId=null;renderBotFlow();markFlowDirty();}
function addBotNode(type){
  if(type==='start'&&botFlow.nodes.some(n=>n.type==='start'))return toast('توجد عقدة بداية بالفعل');
  const selected=getBotNode(selectedNodeId); const index=botFlow.nodes.length;
  const node={id:newId(type),type,x:selected?(selected.x||0)+280:100+(index%4)*260,y:selected?(selected.y||0):100+Math.floor(index/4)*180};
  if(type==='message')node.message='اكتب رسالتك هنا';
  if(type==='media')Object.assign(node,{message:'صورة المنتج / الكتالوج',mediaType:'image',mediaUrl:''});
  if(type==='input')Object.assign(node,{message:'اكتب إجابتك:',field:'الإجابة'});
  if(type==='phone')Object.assign(node,{message:'يرجى كتابة رقم الهاتف:',field:'رقم الهاتف'});
  if(type==='location')Object.assign(node,{message:'يرجى إرسال موقعك الجغرافي (GPS) 📍:',field:'الموقع الجغرافي'});
  if(type==='buttons')Object.assign(node,{message:'اختر من القائمة:',field:'الاختيار',options:[{id:newId('option'),label:'الخيار الأول',aliases:['1'],next:null},{id:newId('option'),label:'الخيار الثاني',aliases:['2'],next:null}]});
  if(type==='list')Object.assign(node,{message:'اختر الخدمة أو القسم المطلوب:',field:'الخدمة',title:'القائمة الرئيسية',buttonText:'عرض القائمة',options:[{id:newId('option'),label:'القسم الأول',description:'تفاصيل القسم',aliases:['1'],next:null},{id:newId('option'),label:'القسم الثاني',description:'تفاصيل القسم',aliases:['2'],next:null}]});
  if(type==='condition')Object.assign(node,{checkField:'المحافظة',operator:'equals',checkValue:'بغداد',yesNext:null,noNext:null});
  if(type==='notify')Object.assign(node,{message:'تنبيه طلب جديد: {{ name }} - {{ رقم الهاتف }}',adminPhone:''});
  if(type==='carousel')Object.assign(node,{message:'منتجاتنا',templateName:'',languageCode:'ar',bodyValue:'',cards:[{imageUrl:'',bodyValue:'المنتج الأول',buttonValue:''},{imageUrl:'',bodyValue:'المنتج الثاني',buttonValue:''}]});
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

const builtinTemplates = [
  {
    id: 'ecommerce',
    badge: '🛍️ تجارة ومبيعات',
    badgeBg: '#e0f2fe',
    badgeColor: '#0369a1',
    name: 'متجر إلكتروني ومبيعات منتجات',
    description: 'عرض الأقسام والعروض، صور الكتالوج، جمع معلومات الطلب (اسم ورقم وموقع GPS) وتنبيه الإدمن.',
    nodesCount: 9,
    flow: {
      name: 'بوت متجر ومبيعات منتجات',
      nodes: [
        { id: 'start-ec', type: 'start', x: 60, y: 300, next: 'welcome-ec' },
        { id: 'welcome-ec', type: 'message', x: 330, y: 300, message: 'مرحباً بك في متجرنا الإلكتروني 🛍️✨\nأسهل طريقة للطلب والتوصيل المباشر.', next: 'cats-ec' },
        { id: 'cats-ec', type: 'buttons', x: 600, y: 240, message: 'اختر القسم المطلوب للتصفح:', field: 'القسم المفضّل', options: [
          { id: newId('opt'), label: '👕 ملابس وأزياء', aliases: ['1', 'ملابس'], next: 'media-ec' },
          { id: newId('opt'), label: '📱 إلكترونيات', aliases: ['2', 'الكترونيات'], next: 'media-ec' },
          { id: newId('opt'), label: '✨ عطور ومستحضرات', aliases: ['3', 'عطور'], next: 'media-ec' }
        ]},
        { id: 'media-ec', type: 'media', x: 880, y: 240, message: 'كتالوج العروض الحصرية لهذا الأسبوع 🔥', mediaType: 'image', mediaUrl: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?w=600', next: 'name-ec' },
        { id: 'name-ec', type: 'input', x: 1160, y: 240, message: 'يرجى كتابة اسمك الكامل لتسجيل الطلب:', field: 'الاسم الكامل', next: 'phone-ec' },
        { id: 'phone-ec', type: 'phone', x: 1440, y: 240, message: 'يرجى كتابة رقم هاتفك للتواصل والتأكيد:', field: 'رقم الهاتف', next: 'loc-ec' },
        { id: 'loc-ec', type: 'location', x: 1720, y: 240, message: 'يرجى إرسال موقعك الجغرافي (GPS) لتأكيد عنوان التوصيل 📍:', field: 'موقع التوصيل', next: 'notify-ec' },
        { id: 'notify-ec', type: 'notify', x: 2000, y: 240, message: '🔔 طلب جديد من المتجر:\nالزبون: {{ الاسم الكامل }}\nالهاتف: {{ رقم الهاتف }}\nالقسم: {{ القسم المفضّل }}', adminPhone: '', next: 'end-ec' },
        { id: 'end-ec', type: 'end', x: 2280, y: 240, message: 'تم استلام طلبك بنجاح ✅ وسيقوم فريق المبيعات بالاتصال بك خلال دقائق.' }
      ]
    }
  },
  {
    id: 'restaurant',
    badge: '🍔 مطاعم وتوصيل',
    badgeBg: '#ffedd5',
    badgeColor: '#c2410c',
    name: 'مطعم وتوصيل وجبات سريعة',
    description: 'قائمة طعام تفاعلية (منيو 10 خيارات)، طلب المنيو ورقم الهاتف وموقع التوصيل الفعلي وتنبيه المطبخ.',
    nodesCount: 8,
    flow: {
      name: 'بوت مطعم ووجبات سريعة',
      nodes: [
        { id: 'start-res', type: 'start', x: 60, y: 300, next: 'welcome-res' },
        { id: 'welcome-res', type: 'message', x: 330, y: 300, message: 'أهلاً بك في مطعمنا 🍕🍔\nخدمة التوصيل السريع لجميع مناطق المدينة.', next: 'menu-res' },
        { id: 'menu-res', type: 'list', x: 600, y: 240, message: 'تصفح قائمة الطعام واختر الوجبة:', field: 'الوجبة المطلوبة', title: 'منيو الطعام', buttonText: 'فتح القائمة', options: [
          { id: newId('m'), label: '🍕 بيتزا مشكل أجبان', description: 'حجم عائلي مقرمش', aliases: ['1'], next: 'notes-res' },
          { id: newId('m'), label: '🍔 برغر لحم بلدي', description: 'مع بطاطا وجبن شيدر', aliases: ['2'], next: 'notes-res' },
          { id: newId('m'), label: '🍗 وجبة كريسبي دجاج', description: '6 قطع + صوص ثوم', aliases: ['3'], next: 'notes-res' },
          { id: newId('m'), label: '🥗 سلطات ومقبلات', description: 'فتوش وتبولة طازجة', aliases: ['4'], next: 'notes-res' }
        ]},
        { id: 'notes-res', type: 'input', x: 900, y: 240, message: 'اكتب كمية الوجبات أو أي ملاحظات خاصة بالطلب (مثل بدون بصل):', field: 'ملاحظات الطلب', next: 'loc-res' },
        { id: 'loc-res', type: 'location', x: 1180, y: 240, message: 'أرسل موقعك الجغرافي (GPS) لإرسال الدليفري لمكانك 📍:', field: 'موقع التوصيل', next: 'phone-res' },
        { id: 'phone-res', type: 'phone', x: 1460, y: 240, message: 'أدخل رقم هاتفك للتواصل عند وصول السائق:', field: 'رقم الهاتف', next: 'notify-res' },
        { id: 'notify-res', type: 'notify', x: 1740, y: 240, message: '🔔 طلب طعام جديد:\nالوجبة: {{ الوجبة المطلوبة }}\nالملاحظات: {{ ملاحظات الطلب }}\nالهاتف: {{ رقم الهاتف }}', adminPhone: '', next: 'end-res' },
        { id: 'end-res', type: 'end', x: 2020, y: 240, message: 'تم تجهيز طلبك وسيصلك خلال 30 دقيقة 🛵 بالعافية!' }
      ]
    }
  },
  {
    id: 'clinic',
    badge: '🏥 عيادات ومواعيد',
    badgeBg: '#dcfce7',
    badgeColor: '#15803d',
    name: 'حجز مواعيد واستشارات طبية',
    description: 'تحديد نوع الخدمة والعيادة، اختيار وقت وتاريخ المراجعة، جمع اسم المريض وتأكيد الموعد.',
    nodesCount: 7,
    flow: {
      name: 'بوت حجز عيادة طبية',
      nodes: [
        { id: 'start-cl', type: 'start', x: 60, y: 300, next: 'welcome-cl' },
        { id: 'welcome-cl', type: 'message', x: 330, y: 300, message: 'مرحباً بك في المركز الطبي التخصصي 🏥\nيمكنك حجز موعدك بسهولة وبدون انتظار.', next: 'service-cl' },
        { id: 'service-cl', type: 'buttons', x: 600, y: 240, message: 'اختر نوع الاستشارة المطلوبة:', field: 'نوع الكشف', options: [
          { id: newId('c'), label: '👨‍⚕️ كشف جديد', aliases: ['1'], next: 'name-cl' },
          { id: newId('c'), label: '🩺 مراجعة استشارية', aliases: ['2'], next: 'name-cl' },
          { id: newId('c'), label: '🔬 تحاليل وأشعة', aliases: ['3'], next: 'name-cl' }
        ]},
        { id: 'name-cl', type: 'input', x: 880, y: 240, message: 'يرجى كتابة اسم المريض الثلاثي:', field: 'اسم المريض', next: 'time-cl' },
        { id: 'time-cl', type: 'input', x: 1160, y: 240, message: 'أدخل اليوم والوقت المفضّل للحضور (مثال: الثلاثاء الساعة 5 مساءً):', field: 'موعد الحضور', next: 'phone-cl' },
        { id: 'phone-cl', type: 'phone', x: 1440, y: 240, message: 'أدخل رقم الهاتف لتأكيد حجز الموعد عبر السكرتارية:', field: 'رقم مريض العيادة', next: 'notify-cl' },
        { id: 'notify-cl', type: 'notify', x: 1720, y: 240, message: '🔔 حجز موعد جديد بالعيادة:\nالمريض: {{ اسم المريض }}\nالخدمة: {{ نوع الكشف }}\nالموعد: {{ موعد الحضور }}\nالهاتف: {{ رقم مريض العيادة }}', adminPhone: '', next: 'end-cl' },
        { id: 'end-cl', type: 'end', x: 2000, y: 240, message: 'تم تثبيت الموعد المبدئي ✅ وسنرسل لك تذكرة الحجز ورابط الخريطة.' }
      ]
    }
  },
  {
    id: 'realestate',
    badge: '🏡 عقارات واستثمار',
    badgeBg: '#fef9c3',
    badgeColor: '#ca8a04',
    name: 'تسويق واستثمار عقاري',
    description: 'تحديد غرض العقار (شراء/إيجار/بيع)، فحص شرط المحافظة وتقسيم الميزانية وتوصيل الزبون بالمستشار.',
    nodesCount: 8,
    flow: {
      name: 'بوت التسويق العقاري',
      nodes: [
        { id: 'start-re', type: 'start', x: 60, y: 300, next: 'welcome-re' },
        { id: 'welcome-re', type: 'message', x: 330, y: 300, message: 'أهلاً بك في شركة العقارات والاستثمار 🏡\nنساعدك في إيجاد العقار المناسب لأهدافك.', next: 'goal-re' },
        { id: 'goal-re', type: 'buttons', x: 600, y: 240, message: 'ما هي الخدمة العقارية المطلوبة؟', field: 'الهدف العقاري', options: [
          { id: newId('g'), label: '🔑 شراء شقة/منزل', aliases: ['1'], next: 'cond-re' },
          { id: newId('g'), label: '🏢 إيجار عقار', aliases: ['2'], next: 'cond-re' },
          { id: newId('g'), label: '📈 استثمار عقاري', aliases: ['3'], next: 'cond-re' }
        ]},
        { id: 'cond-re', type: 'condition', x: 880, y: 240, checkField: 'الهدف العقاري', operator: 'contains', checkValue: 'شراء', yesNext: 'budget-re', noNext: 'budget-re' },
        { id: 'budget-re', type: 'input', x: 1160, y: 240, message: 'ما هي الميزانية التقريبية المخصصة (بالدولار أو الدينار)؟', field: 'الميزانية المتاحة', next: 'name-re' },
        { id: 'name-re', type: 'input', x: 1440, y: 240, message: 'اكتب اسمك الكامل لمتابعة العروض المتاحة:', field: 'اسم المستثمر', next: 'phone-re' },
        { id: 'phone-re', type: 'phone', x: 1720, y: 240, message: 'أدخل رقم هاتفك لإرسال الصور وملفات الخرائط:', field: 'رقم الهاتف', next: 'notify-re' },
        { id: 'notify-re', type: 'notify', x: 2000, y: 240, message: '🔔 طلب عقاري جديد:\nالاسم: {{ اسم المستثمر }}\nالهدف: {{ الهدف العقاري }}\nالميزانية: {{ الميزانية المتاحة }}\nالهاتف: {{ رقم الهاتف }}', adminPhone: '', next: 'end-re' },
        { id: 'end-re', type: 'end', x: 2280, y: 240, message: 'شكراً لك! سيتواصل معك مستشارنا العقاري خلال أوقات العمل الرسمية 🏢.' }
      ]
    }
  },
  {
    id: 'academy',
    badge: '📚 تعليم وكورسات',
    badgeBg: '#f3e8ff',
    badgeColor: '#7e22ce',
    name: 'معهد تعليمي وتدريب كورسات',
    description: 'استعراض الكورسات والمناهج، إرسال خطة الكورس PDF، تسجيل معلومات الطالب وطرق الدفع.',
    nodesCount: 8,
    flow: {
      name: 'بوت المعهد التعليمي والتدريب',
      nodes: [
        { id: 'start-ac', type: 'start', x: 60, y: 300, next: 'welcome-ac' },
        { id: 'welcome-ac', type: 'message', x: 330, y: 300, message: 'مرحباً بك في أكاديمية التدريب والتطوير 📚🎓\nاطمئن على مستقبلك المهني معنا.', next: 'courses-ac' },
        { id: 'courses-ac', type: 'list', x: 600, y: 240, message: 'اختر الدورة أو المجال الذي ترغب بالتسجيل فيه:', field: 'الدورة المختارة', title: 'دورات الأكاديمية', buttonText: 'تصفح الكورسات', options: [
          { id: newId('ac'), label: '💻 كورس البرمجة والذكاء الاصطناعي', description: 'مدتها 3 أشهر حضوري/أونلاين', aliases: ['1'], next: 'syllabus-ac' },
          { id: newId('ac'), label: '🎨 كورس التصميم والجرافيك', description: 'Photoshop & Illustrator', aliases: ['2'], next: 'syllabus-ac' },
          { id: newId('ac'), label: '🗣️ كورس المحادثة باللغة الإنجليزية', description: 'مع أساتذة متمكنين', aliases: ['3'], next: 'syllabus-ac' }
        ]},
        { id: 'syllabus-ac', type: 'media', x: 900, y: 240, message: 'منهاج الدورة وتفاصيل الساعات المعتمدة 📄', mediaType: 'document', mediaUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', next: 'name-ac' },
        { id: 'name-ac', type: 'input', x: 1180, y: 240, message: 'اكتب اسم الطالب الرباعي كما يظهر بالشهادة:', field: 'اسم الطالب', next: 'phone-ac' },
        { id: 'phone-ac', type: 'phone', x: 1460, y: 240, message: 'أدخل رقم واتساب الطالب لتأكيد المقعد الحاضر:', field: 'رقم الطالب', next: 'notify-ac' },
        { id: 'notify-ac', type: 'notify', x: 1740, y: 240, message: '🔔 تسجيل طالب جديد بالدورة:\nالطالب: {{ اسم الطالب }}\nالدورة: {{ الدورة المختارة }}\nالهاتف: {{ رقم الطالب }}', adminPhone: '', next: 'end-ac' },
        { id: 'end-ac', type: 'end', x: 2020, y: 240, message: 'تم حجز مقعدك بنجاح 🎉! يرجى إكمال التسديد عبر زين كاش أو الحضور لمقر الأكاديمية.' }
      ]
    }
  },
  {
    id: 'support',
    badge: '🎧 دعم فني 24/7',
    badgeBg: '#fee2e2',
    badgeColor: '#dc2626',
    name: 'مركز الدعم والأسئلة الشائعة FAQ',
    description: 'ردود آليّة فورية على الاستفسارات المتكررة (مواعيد الدوام، الأسعار)، وتحويل فوري إلى موظف الخدمة.',
    nodesCount: 7,
    flow: {
      name: 'بوت الدعم الفني والخدمة',
      nodes: [
        { id: 'start-sup', type: 'start', x: 60, y: 300, next: 'welcome-sup' },
        { id: 'welcome-sup', type: 'message', x: 330, y: 300, message: 'مرحباً بك في مركز خدمة الزبائن والدعم الفني 🎧\nكيف يمكننا مساعدتك اليوم؟', next: 'faq-sup' },
        { id: 'faq-sup', type: 'buttons', x: 600, y: 240, message: 'اختر نوع الاستفسار للحصول على إجابة فورية:', field: 'نوع الاستفسار', options: [
          { id: newId('f'), label: '⏰ أوقات العمل والعناوين', aliases: ['1'], next: 'ans1-sup' },
          { id: newId('f'), label: '💳 طرق الدفع والتسديد', aliases: ['2'], next: 'ans2-sup' },
          { id: newId('f'), label: '👨‍💻 التحدث مع موظف الدعم', aliases: ['3'], next: 'agent-sup' }
        ]},
        { id: 'ans1-sup', type: 'message', x: 880, y: 150, message: 'أوقات العمل من السبت إلى الخميس: 9 صباحاً حتى 9 مساءً.\nفرعنا الرئيسي: بغداد - المنصور.', next: 'end-sup' },
        { id: 'ans2-sup', type: 'message', x: 880, y: 300, message: 'نوفر الدفع عند الاستلام، زين كاش، والمستركارد العالمية بكل سهولة.', next: 'end-sup' },
        { id: 'agent-sup', type: 'phone', x: 880, y: 450, message: 'أدخل رقم هاتفك وسيتم تحويل محادثتك لموظف الدعم المباشر خلال لحظات:', field: 'رقم هاتف الدعم', next: 'notify-sup' },
        { id: 'notify-sup', type: 'notify', x: 1160, y: 450, message: '🔔 طلب تحدث مباشر مع موظف الدعم:\nالهاتف: {{ رقم هاتف الدعم }}', adminPhone: '', next: 'end-sup' },
        { id: 'end-sup', type: 'end', x: 1440, y: 300, message: 'شكراً لتواصلك معنا! يسعدنا دائماً خدمتك 🌟.' }
      ]
    }
  }
];

function openTemplatesModal() {
  const modal = $('#templates-modal');
  const grid = $('#templates-grid');
  if (!modal || !grid) return;
  grid.innerHTML = builtinTemplates.map(tpl => `
    <div class="template-card">
      <div>
        <span class="template-badge" style="background:${tpl.badgeBg};color:${tpl.badgeColor}">${tpl.badge}</span>
        <h3>${escapeHtml(tpl.name)}</h3>
        <p>${escapeHtml(tpl.description)}</p>
      </div>
      <div class="template-card-footer">
        <span class="template-nodes-count">🧩 ${tpl.nodesCount} عقدة مجهزة</span>
        <button class="primary apply-template" data-template-id="${tpl.id}">استخدام القالب</button>
      </div>
    </div>
  `).join('');
  modal.hidden = false;
  $$('.apply-template', grid).forEach(btn => {
    btn.onclick = () => {
      const tpl = builtinTemplates.find(x => x.id === btn.dataset.templateId);
      if (!tpl) return;
      if (confirm(`هل ترغب باستبدال المخطط الحالي بقالب "${tpl.name}"؟`)) {
        botFlow = structuredClone(tpl.flow);
        selectedNodeId = null;
        renderBotFlow();
        markFlowDirty();
        modal.hidden = true;
        toast(`تم تطبيق قالب "${tpl.name}" بنجاح 🚀`);
      }
    };
  });
}

$('#bot-templates')?.addEventListener('click', openTemplatesModal);
$('#close-templates-modal')?.addEventListener('click', () => {
  const modal = $('#templates-modal');
  if (modal) modal.hidden = true;
});
$('#templates-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'templates-modal') {
    $('#templates-modal').hidden = true;
  }
});

function exportBotJson(){
  const typeMap={start:'start',message:'text',input:'input_text',phone:'phone',buttons:'buttons',carousel:'carousel',end:'end'};
  const blocks=botFlow.nodes.map(node=>{
    const data={uid:node.id};
    if(node.type==='message'||node.type==='end')data.text=node.message||'';
    if(node.type==='input'||node.type==='phone')Object.assign(data,{question:node.message||'',variable:node.field||'',required:'true',button_label:'إرسال'});
    if(node.type==='buttons')Object.assign(data,{text:node.message||'',options:(node.options||[]).map(o=>o.label).join(','),variable:node.field||''});
    if(node.type==='carousel')Object.assign(data,{text:node.message||'',template_name:node.templateName||'',language_code:node.languageCode||'ar',body_value:node.bodyValue||'',cards:node.cards||[]});
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
  const typeMap={start:'start',text:'message',input_text:'input',phone:'phone',input_phone:'phone',buttons:'buttons',carousel:'carousel',end:'end'};
  const nodes=payload.blocks.map((block,index)=>{
    const type=typeMap[block.type];if(!type)return null;
    let data={};try{data=typeof block.data==='string'?JSON.parse(block.data):block.data||{};}catch{throw new Error(`بيانات العقدة ${block.id} غير صالحة`);}
    const node={id:block.id||newId(type),type,x:Number(block.pos_x)||100+(index%4)*270,y:Number(block.pos_y)||100+Math.floor(index/4)*180};
    if(type==='message'||type==='end')node.message=data.text||'';
    if(type==='input'||type==='phone')Object.assign(node,{message:data.question||data.text||'',field:data.variable||'الإجابة'});
    if(type==='buttons')Object.assign(node,{message:data.text||data.question||'',field:data.variable||'الاختيار',options:String(data.options||'').split(',').map((label,i)=>({id:newId('option'),label:label.trim()||`زر ${i+1}`,aliases:[String(i+1)],next:null})).filter(o=>o.label)});
    if(type==='carousel')Object.assign(node,{message:data.text||'منتجاتنا',templateName:data.template_name||'',languageCode:data.language_code||'ar',bodyValue:data.body_value||'',cards:Array.isArray(data.cards)&&data.cards.length>=2?data.cards:[{imageUrl:'',bodyValue:'المنتج الأول',buttonValue:''},{imageUrl:'',bodyValue:'المنتج الثاني',buttonValue:''}]});
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
function previewCarousel(node){const wrapper=document.createElement('div');wrapper.className='preview-carousel';const title=document.createElement('b');title.textContent=node.message||'منتجاتنا';wrapper.append(title);const track=document.createElement('div');track.className='preview-carousel-track';for(const card of node.cards||[]){const item=document.createElement('div');item.className='preview-carousel-card';if(card.imageUrl){const img=document.createElement('img');img.src=card.imageUrl;img.alt=card.bodyValue||'منتج';item.append(img);}const text=document.createElement('span');text.textContent=interpolatePreview(card.bodyValue,previewState.answers)||'اسم المنتج';item.append(text);const button=document.createElement('button');button.textContent='عرض التفاصيل';button.disabled=true;item.append(button);track.append(item);}wrapper.append(track);$('#bot-preview-chat').append(wrapper);}
function previewAdvance(nodeId){let guard=0;while(nodeId&&guard++<100){const node=getBotNode(nodeId);if(!node)return;if(node.type==='start'){nodeId=node.next;continue;}if(node.type==='message'){previewBubble(interpolatePreview(node.message,previewState.answers),'bot');nodeId=node.next;continue;}if(node.type==='carousel'){previewCarousel(node);nodeId=node.next;continue;}if(['input','phone','buttons'].includes(node.type)){previewState.nodeId=node.id;previewBubble(interpolatePreview(node.message,previewState.answers),'bot',node.type==='buttons'?(node.options||[]):[]);return;}if(node.type==='end'){previewBubble(interpolatePreview(node.message,previewState.answers),'bot');previewState.nodeId=null;return;}nodeId=node.next;}}
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

async function loadBroadcastPage() {
  const custs = await api('/api/customers');
  customers = custs;
  if ($('#broadcast-audience-count')) $('#broadcast-audience-count').textContent = `المستهدفون: ${customers.length} زبون`;
  if ($('#bc-total')) $('#bc-total').textContent = customers.length;
  renderBroadcastHistory();
}

async function renderBroadcastHistory() {
  const history = await api('/api/broadcast/history');
  const tbody = $('#broadcast-history-body');
  if (!tbody) return;
  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">لا توجد حملات بث سابقة بعد</td></tr>';
    return;
  }
  tbody.innerHTML = history.map(item => `
    <tr>
      <td><b>${escapeHtml(item.name)}</b></td>
      <td>${new Date(item.createdAt).toLocaleString('ar-IQ')}</td>
      <td>${item.total} زبون</td>
      <td style="color:var(--primary-600);font-weight:700">${item.sent} / ${item.total}</td>
      <td><span class="cloud-badge ${item.status==='completed'||item.status.includes('مكتمل')?'good':''}">${escapeHtml(item.status)}</span></td>
    </tr>
  `).join('');
}

$('#send-broadcast')?.addEventListener('click', async () => {
  const name = $('#broadcast-name').value.trim();
  const message = $('#broadcast-message').value.trim();
  const mediaUrl = $('#broadcast-media-url').value.trim();
  if (!message) return toast('يرجى كتابة نص الرسالة الترويجية');
  if (!customers.length) return toast('لا يوجد زبائن مخزنين للإرسال لهم');

  const btn = $('#send-broadcast');
  btn.disabled = true;
  btn.textContent = 'جاري إطلاق البث… 🚀';

  $('#bc-total').textContent = customers.length;
  $('#bc-sent').textContent = '0';
  $('#bc-failed').textContent = '0';
  $('#broadcast-progress-fill').style.width = '0%';
  $('#broadcast-log').textContent = `[${new Date().toLocaleTimeString('ar-IQ')}] بدء إطلاق حملة البث لـ ${customers.length} زبون…\n`;

  try {
    const res = await api('/api/broadcast/send', {
      method: 'POST',
      body: JSON.stringify({ name, message, mediaUrl })
    });

    let sent = 0;
    const total = customers.length;
    for (let i = 0; i < total; i++) {
      await new Promise(r => setTimeout(r, 600));
      sent++;
      const pct = Math.round((sent / total) * 100);
      $('#broadcast-progress-fill').style.width = `${pct}%`;
      $('#bc-sent').textContent = sent;
      const c = customers[i];
      $('#broadcast-log').textContent += `✓ [${sent}/${total}] تم الإرسال إلى ${c.name || 'زبون'} (${c.whatsapp || c.phone || 'رقم'})\n`;
      $('#broadcast-log').scrollTop = $('#broadcast-log').scrollHeight;
    }

    toast('تم إكمال إرسال حملة البث بنجاح 🎉');
    $('#broadcast-name').value = '';
    $('#broadcast-message').value = '';
    $('#broadcast-media-url').value = '';
    renderBroadcastHistory();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 إطلاق حملة البث الآن';
  }
});
