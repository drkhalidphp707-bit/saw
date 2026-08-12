const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let config = null;
let customers = [];
let testId = String(Date.now());
const passwordKey = 'bot-admin-password';
let password = localStorage.getItem(passwordKey) || '';

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'x-admin-password': password, ...(options.headers || {}) } });
  if (response.status === 401) {
    const entered = prompt('أدخل كلمة مرور الإدارة:');
    if (entered === null) throw new Error('يجب إدخال كلمة المرور');
    password = entered;
    localStorage.setItem(passwordKey, password);
    return api(url, options);
  }
  const data = await response.json();
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
  [config, customers] = await Promise.all([api('/api/config'), api('/api/customers')]);
  fillConfig(); renderSteps(); renderCustomers(); await refreshStatus();
}

function fillConfig() {
  $('#bot-name').value = config.botName || '';
  $('#chat-name').textContent = config.botName || 'المساعد الآلي';
  $('#enabled').checked = !!config.enabled;
  $('#welcome').value = config.welcomeText || '';
  $('#complete').value = config.completionText || '';
  $('#fallback').value = config.fallbackText || '';
  $('#bot-state').textContent = config.enabled ? 'مفعّل' : 'متوقف';
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
    const labels = { connected:'متصل', qr:'امسح رمز QR', connecting:'جاري الاتصال', disconnected:'غير متصل', demo:'وضع تجريبي', error:'خطأ بالاتصال' };
    $('#connection-text').textContent = labels[status.state] || status.state;
    $('#phone-text').textContent = status.phone || (status.mode === 'demo' ? 'غيّر MODE إلى whatsapp عند النشر' : status.lastMessageAt ? `آخر رسالة: ${new Date(status.lastMessageAt).toLocaleTimeString('ar-IQ')}` : 'بانتظار أول رسالة');
    $('#top-status').textContent = labels[status.state] || status.state;
    $('#top-status').className = `status-pill ${status.state === 'connected' ? 'good' : status.state === 'error' ? 'bad' : ''}`;
    $('#qr-box').innerHTML = status.qr ? `<img src="${status.qr}" alt="رمز ربط واتساب"><p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>` : `<div class="qr-placeholder">${status.state === 'connected' ? '✓' : status.state === 'demo' ? 'DEMO' : 'QR'}</div><p>${status.error || (status.state === 'connected' ? 'تم ربط واتساب بنجاح' : status.state === 'demo' ? 'الوضع التجريبي مفعّل' : 'بانتظار رمز الربط…')}</p>`;
  } catch (error) { console.error(error); }
}

$$('.nav').forEach(button => button.onclick = () => {
  $$('.nav').forEach(x => x.classList.remove('active')); button.classList.add('active');
  $$('.page').forEach(x => x.classList.remove('active')); $(`#${button.dataset.page}`).classList.add('active');
  $('#page-title').textContent = $('span', button).textContent; $('.sidebar').classList.remove('open');
  if (button.dataset.page === 'customers') api('/api/customers').then(x => { customers=x; renderCustomers(); });
});
$('#menu').onclick = () => $('.sidebar').classList.toggle('open');

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

function bubble(text, who) { const div=document.createElement('div'); div.className=`bubble ${who}`; div.innerHTML=`${escapeHtml(text)}<time>${new Date().toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})}</time>`; $('#chat').append(div); $('#chat').scrollTop=$('#chat').scrollHeight; }
async function sendTest(text) { bubble(text,'user'); const data=await api('/api/simulate',{method:'POST',body:JSON.stringify({sender:testId,text})}); for (const reply of data.replies) { await new Promise(r=>setTimeout(r,300)); bubble(reply,'bot'); } }
$('#chat-form').onsubmit = async event => { event.preventDefault(); const input=$('#chat-input'); const text=input.value.trim(); if(!text)return; input.value=''; await sendTest(text); };
$('#restart-test').onclick = async () => { testId=String(Date.now()); $('#chat').innerHTML=''; await sendTest('ابدأ'); };

$('#export').onclick = () => {
  if (!customers.length) return toast('لا توجد بيانات للتصدير');
  const keys=[...new Set(customers.flatMap(Object.keys))].filter(x=>x!=='id');
  const csv='\ufeff'+[keys,...customers.map(c=>keys.map(k=>c[k]??''))].map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
  const link=document.createElement('a'); link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); link.download='customers.csv'; link.click(); URL.revokeObjectURL(link.href);
};

load().then(() => $('#restart-test').click()).catch(error => toast(error.message));
setInterval(refreshStatus, 4000);
