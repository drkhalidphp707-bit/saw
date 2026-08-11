import { getConfig, getCustomers, getSessions, saveCustomers, saveSessions } from './store.js';

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[أإآ]/g, 'ا');

function validate(step, input) {
  const clean = String(input || '').trim();
  if (step.type === 'choice') {
    const normalized = normalize(clean);
    const option = step.options?.find((item) =>
      [item.label, ...(item.aliases || [])].some((alias) => normalize(alias) === normalized)
    );
    return option ? { ok: true, value: option.label } : { ok: false };
  }
  if (step.type === 'phone') {
    const digits = clean.replace(/[^0-9٠-٩]/g, '');
    return digits.length >= 8 && digits.length <= 15
      ? { ok: true, value: clean }
      : { ok: false };
  }
  return clean ? { ok: true, value: clean } : { ok: false };
}

export async function processMessage(sender, text, displayName = '') {
  const config = await getConfig();
  if (!config.enabled || !config.steps?.length) return [];

  const sessions = await getSessions();
  let session = sessions[sender];
  const restart = ['ابدأ', 'ابدا', 'start', 'القائمة', 'القائمه', '0'].includes(normalize(text));

  if (!session || restart) {
    sessions[sender] = { step: 0, answers: {}, displayName, startedAt: new Date().toISOString() };
    await saveSessions(sessions);
    return [config.welcomeText, config.steps[0].question].filter(Boolean);
  }

  const step = config.steps[session.step];
  if (!step) {
    delete sessions[sender];
    await saveSessions(sessions);
    return [config.welcomeText, config.steps[0].question].filter(Boolean);
  }

  const result = validate(step, text);
  if (!result.ok) return [config.fallbackText, step.question].filter(Boolean);

  session.answers[step.field || step.id] = result.value;
  session.step += 1;

  if (session.step < config.steps.length) {
    sessions[sender] = session;
    await saveSessions(sessions);
    return [config.steps[session.step].question];
  }

  const customers = await getCustomers();
  customers.unshift({
    id: crypto.randomUUID(),
    whatsapp: sender,
    name: session.displayName || '',
    ...session.answers,
    createdAt: new Date().toISOString()
  });
  await saveCustomers(customers);
  delete sessions[sender];
  await saveSessions(sessions);
  return [config.completionText];
}
