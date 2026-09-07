import process from 'node:process';

const INSTRUCTION = `Diagnose this small home network from the supplied evidence.
Prefer physical managed-switch carrier and negotiated-speed evidence over reachability.
Treat Wi-Fi witness Raspberry Pis as unreliable corroborating witnesses: a missing witness is never sufficient proof of a network fault.
Distinguish the most likely root cause from downstream symptoms and coincidences.
Take account of the observer having independent Ethernet and Wi-Fi paths.
Do not assume that a router or access point is healthy merely because its management interface answers.

Default to a SHORT operational answer, normally 2–4 sentences. If one cause is strongly indicated, state the best diagnosis, confidence, and least disruptive next action; mention only the one or two observations that materially establish it. Do not recite the complete evidence chain, provide separate evidence-for/evidence-against sections, or discuss already-excluded alternatives unless the evidence is genuinely ambiguous. If the evidence is ambiguous, briefly give the leading alternatives and the single most useful discriminating check.`;

export function buildAIEvidence({ config, current, storage, problem }) {
  return {
    humanObservation: String(problem || '').trim(),
    site: {
      name: config.name,
      topology: {
        switches: config.switches,
        links: config.links,
        nodes: config.nodes,
        witnesses: config.witnesses
      }
    },
    current,
    recentEvents: storage.recentEvents(40),
    recentHumanObservations: storage.recentObservations(10)
  };
}

export function extractOpenAIText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  const text = chunks.join('\n').trim();
  if (text) return text;
  throw new Error('OpenAI response contained no text output');
}

async function diagnoseOpenAI(evidence) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  const model = process.env.OPENAI_MODEL || 'gpt-5.6';
  const effort = process.env.OPENAI_REASONING_EFFORT || 'medium';
  const url = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses';
  const request = {
    model,
    instructions: INSTRUCTION,
    input: `Network-supervisor evidence follows as JSON.\n\n${JSON.stringify(evidence)}`,
    reasoning: { effort }
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS || 60000))
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenAI API HTTP ${response.status}: ${body.slice(0, 500)}`);
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new Error('OpenAI API returned non-JSON data'); }
  return extractOpenAIText(parsed);
}

async function diagnoseGeneric(evidence) {
  const url = process.env.AI_URL;
  if (!url) throw new Error('AI_URL is not configured');
  const headers = { 'content-type': 'application/json' };
  if (process.env.AI_BEARER_TOKEN) headers.authorization = `Bearer ${process.env.AI_BEARER_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ instruction: INSTRUCTION, ...evidence }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS || 60000))
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`AI endpoint HTTP ${response.status}: ${body.slice(0, 500)}`);
  try {
    const parsed = JSON.parse(body);
    return parsed.answer ?? parsed.output ?? parsed;
  } catch {
    return body;
  }
}

export async function diagnoseWithAI(context) {
  const evidence = buildAIEvidence(context);
  const configured = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = configured || (process.env.OPENAI_API_KEY ? 'openai' : 'generic');
  if (provider === 'openai') return diagnoseOpenAI(evidence);
  if (provider === 'generic') return diagnoseGeneric(evidence);
  throw new Error(`Unknown AI_PROVIDER ${provider}; expected openai or generic`);
}
