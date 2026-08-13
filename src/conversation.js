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

const interpolate = (text, answers) => String(text || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key) => answers[key] ?? '');

function graphValidation(node, input) {
  const clean = String(input || '').trim();
  if (node.type === 'buttons') {
    const normalized = normalize(clean);
    const option = (node.options || []).find((item, index) =>
      [item.label, String(index + 1), ...(item.aliases || [])].some((alias) => normalize(alias) === normalized)
    );
    return option ? { ok: true, value: option.label, next: option.next || node.next } : { ok: false };
  }
  if (node.type === 'phone') {
    const digits = clean.replace(/[^0-9٠-٩]/g, '');
    return digits.length >= 8 && digits.length <= 15 ? { ok: true, value: clean, next: node.next } : { ok: false };
  }
  return clean ? { ok: true, value: clean, next: node.next } : { ok: false };
}

function graphPrompt(node, answers) {
  const message = interpolate(node.message || node.question, answers);
  if (node.type !== 'buttons') return message;
  return {
    type: 'buttons', text: message,
    buttons: (node.options || []).map((option, index) => ({ id: option.label, label: option.label, number: index + 1 }))
  };
}

function carouselReply(node, answers) {
  return {
    type: 'carousel',
    text: interpolate(node.message || 'سلايدر منتجات', answers),
    templateName: String(node.templateName || '').trim(),
    languageCode: String(node.languageCode || 'ar').trim(),
    bodyValue: interpolate(node.bodyValue || '', answers),
    cards: (node.cards || []).map((card) => ({
      imageUrl: interpolate(card.imageUrl || '', answers),
      bodyValue: interpolate(card.bodyValue || '', answers),
      buttonValue: interpolate(card.buttonValue || '', answers)
    }))
  };
}

function stepPrompt(step) {
  if (step?.type !== 'choice') return step?.question;
  const text = String(step.question || '').split('\n').filter((line) => !/^\s*[0-9٠-٩]+\s*[-.)ـ]\s*/.test(line)).join('\n').trim();
  return { type: 'buttons', text, buttons: (step.options || []).map((option, index) => ({ id: option.label, label: option.label, number: index + 1 })) };
}

async function advanceGraph(accountId, config, sessions, sender, session, firstNodeId) {
  const nodes = new Map(config.botFlow.nodes.map((node) => [node.id, node]));
  const replies = [];
  let nodeId = firstNodeId;
  let guard = 0;

  while (nodeId && guard++ < 100) {
    const node = nodes.get(nodeId);
    if (!node) break;
    if (node.type === 'start') { nodeId = node.next; continue; }
    if (node.type === 'message') {
      const message = interpolate(node.message, session.answers);
      if (message) replies.push(message);
      nodeId = node.next;
      continue;
    }
    if (node.type === 'carousel') {
      replies.push(carouselReply(node, session.answers));
      nodeId = node.next;
      continue;
    }
    if (['input', 'phone', 'buttons'].includes(node.type)) {
      session.nodeId = node.id;
      sessions[sender] = session;
      await saveSessions(accountId, sessions);
      const prompt = graphPrompt(node, session.answers);
      if (prompt) replies.push(prompt);
      return replies;
    }
    if (node.type === 'end') {
      const message = interpolate(node.message || config.completionText, session.answers);
      if (message) replies.push(message);
      const customers = await getCustomers(accountId);
      customers.unshift({
        id: crypto.randomUUID(), whatsapp: sender, name: session.displayName || '',
        ...session.answers, createdAt: new Date().toISOString()
      });
      await saveCustomers(accountId, customers);
      delete sessions[sender];
      await saveSessions(accountId, sessions);
      return replies;
    }
    nodeId = node.next;
  }
  delete sessions[sender];
  await saveSessions(accountId, sessions);
  return replies.length ? replies : [config.fallbackText];
}

async function processGraphMessage(accountId, config, sender, text, displayName) {
  const sessions = await getSessions(accountId);
  let session = sessions[sender];
  const restart = ['ابدأ', 'ابدا', 'start', 'القائمة', 'القائمه', '0'].includes(normalize(text));
  const start = config.botFlow.nodes.find((node) => node.type === 'start');
  if (!session || session.engine !== 'graph' || restart) {
    session = { engine: 'graph', nodeId: null, answers: {}, displayName, startedAt: new Date().toISOString() };
    sessions[sender] = session;
    await saveSessions(accountId, sessions);
    return advanceGraph(accountId, config, sessions, sender, session, start?.id);
  }
  const node = config.botFlow.nodes.find((item) => item.id === session.nodeId);
  if (!node) return advanceGraph(accountId, config, sessions, sender, session, start?.id);
  const result = graphValidation(node, text);
  if (!result.ok) return [config.fallbackText, graphPrompt(node, session.answers)].filter(Boolean);
  session.answers[node.field || node.label || node.id] = result.value;
  return advanceGraph(accountId, config, sessions, sender, session, result.next);
}

export async function processMessage(accountId, sender, text, displayName = '') {
  const config = await getConfig(accountId);
  if (!config.enabled) return [];
  if (config.botFlow?.nodes?.length) return processGraphMessage(accountId, config, sender, text, displayName);
  if (!config.steps?.length) return [];

  const sessions = await getSessions(accountId);
  let session = sessions[sender];
  const restart = ['ابدأ', 'ابدا', 'start', 'القائمة', 'القائمه', '0'].includes(normalize(text));

  if (!session || restart) {
    sessions[sender] = { step: 0, answers: {}, displayName, startedAt: new Date().toISOString() };
    await saveSessions(accountId, sessions);
    return [config.welcomeText, stepPrompt(config.steps[0])].filter(Boolean);
  }

  const step = config.steps[session.step];
  if (!step) {
    delete sessions[sender];
    await saveSessions(accountId, sessions);
    return [config.welcomeText, stepPrompt(config.steps[0])].filter(Boolean);
  }

  const result = validate(step, text);
  if (!result.ok) return [config.fallbackText, stepPrompt(step)].filter(Boolean);

  session.answers[step.field || step.id] = result.value;
  session.step += 1;

  if (session.step < config.steps.length) {
    sessions[sender] = session;
    await saveSessions(accountId, sessions);
    return [stepPrompt(config.steps[session.step])];
  }

  const customers = await getCustomers(accountId);
  customers.unshift({
    id: crypto.randomUUID(),
    whatsapp: sender,
    name: session.displayName || '',
    ...session.answers,
    createdAt: new Date().toISOString()
  });
  await saveCustomers(accountId, customers);
  delete sessions[sender];
  await saveSessions(accountId, sessions);
  return [config.completionText];
}
