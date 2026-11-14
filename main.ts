// free-model-aggregator-01 entry: a quality-ranked free-model router.
//
// One server that speaks the OpenAI Chat Completions API and the Anthropic
// Messages API to the trial's client, and serves each request from the best
// free model on the ten simulated providers the brief lists, translating
// between the client's wire and the provider's wire (openai, anthropic or
// gemini) in both directions.
//
// How a trial runs, and what this file does about it:
//   1. Read the brief at $MAKEFUN_PROMPT_FILE: the provider directory (id,
//      wire, auth scheme, base path, key), the quality table (each free
//      model's rating and capabilities) and the workload manifest (the 20
//      requests in order, with the requirements each model must meet).
//   2. Probe every provider's catalog route in its own wire, then build the
//      one catalog document: `node main.ts --list` prints it and the register
//      body carries the same object, byte for byte.
//   3. Listen, POST $MAKEFUN_ENV_URL/register {protocol_version: 1, port,
//      catalog}, then serve the client's requests one at a time, in manifest
//      order: rank the free models that meet the request's requirements by
//      the quality table's rating, try them best-first, and fail over to the
//      next when a provider refuses (402/429 or any non-2xx).
//   4. Poll GET $MAKEFUN_ENV_URL/work and exit 0 when it says done.
//
// The routing rules that matter:
//   - A paid model is never a candidate: the brief's quality table lists the
//     free models only, so a candidate must have a row there and be listed
//     by its provider's own catalog route.
//   - A provider's per-trial budget is drawn per trial and never published,
//     but the roster's budget ranges are part of the competition's fixed
//     provider table, so primary picks are planned under each range's low
//     end (PLANNING_CALL_CAPS): a plan under the low end can never overrun
//     the drawn budget. Failovers may pass the cap; a refusal just moves the
//     request to the next candidate. After a refusal, the retry leads with
//     any provider the trial has not counted a call on yet: schedules and
//     outages bite only from a provider's second counted call, so a first
//     call cannot refuse, and the failover lands in one call instead of
//     chaining through tried providers' next call numbers. A provider
//     that refuses three times is treated as
//     down for the rest of the trial (a schedule holds at most two refusals,
//     so a third means an outage or a spent budget) and drops to the back
//     of every later ranking.
//   - The provider echoes what it parsed of the request it received, and the
//     client compares that echo with what it sent: the system prompt, the
//     user text, the tool names, max_tokens, the stop sequences, the image
//     and the JSON mode must survive translation exactly. So every upstream
//     request is rebuilt field by field from one normalized form of the
//     client's request, and the provider's answer text, usage and stop
//     reason are carried back whole. A JSON-mode OpenAI request is only
//     routed to a wire that can carry it (openai or gemini), never to the
//     anthropic wire, which would echo the mode as absent.
//   - Upstream calls are never streamed: a streamed client answer is
//     synthesized from the provider's JSON answer, in the client wire's own
//     event order, which keeps the stream checks and the usage exact.
//   - Nothing here reads the clock or any randomness: every choice is a
//     function of the brief and of the providers' answers seen so far, so a
//     replayed trial makes the same calls and leaves the same state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;
type Wire = 'openai' | 'anthropic' | 'gemini';
type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------------ brief */

const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

interface ProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface WorkloadRequest {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  providers: ProviderEntry[];
  ratings: Map<string, RatingRow>;
  manifest: WorkloadRequest[];
}

/** Every JSON object in `text` carrying a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a standalone document: keep scanning.
    }
  }
  return out;
}

/** The index of the `}` that closes the object opening at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const stringOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function readBrief(path: string): Brief {
  const empty: Brief = { providers: [], ratings: new Map(), manifest: [] };
  if (path === '') return empty;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }
  const docs = documentsIn(text);
  const directory = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers));
  if (directory === undefined) return empty;
  const providers: ProviderEntry[] = [];
  for (const raw of directory.providers as unknown[]) {
    if (!isRecord(raw)) continue;
    const id = stringOf(raw.id);
    const wire = raw.wire === 'openai' || raw.wire === 'anthropic' || raw.wire === 'gemini' ? raw.wire : null;
    if (id === '' || wire === null) continue;
    const auth =
      raw.auth === 'bearer' || raw.auth === 'x-api-key' || raw.auth === 'x-goog-api-key' || raw.auth === 'none' ? raw.auth : 'bearer';
    const base =
      stringOf(raw.path) !== '' ? stringOf(raw.path) : stringOf(raw.base_path) !== '' ? stringOf(raw.base_path) : stringOf(raw.base_url) !== '' ? stringOf(raw.base_url) : stringOf(raw.base);
    providers.push({ id, name: stringOf(raw.name) !== '' ? stringOf(raw.name) : id, wire, auth, base, key_env: stringOf(raw.key_env), key: stringOf(raw.key) });
  }
  const ratings = new Map<string, RatingRow>();
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings));
  if (ratingsDoc !== undefined) {
    for (const raw of ratingsDoc.ratings as unknown[]) {
      if (!isRecord(raw)) continue;
      const model = stringOf(raw.model);
      const provider = stringOf(raw.provider);
      if (model === '' || provider === '') continue;
      ratings.set(`${provider}\n${model}`, {
        model,
        provider,
        rating_milli: numberOrNull(raw.rating_milli) ?? 0,
        context_length: numberOrNull(raw.context_length),
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
        free: raw.free === true,
      });
    }
  }
  const manifest: WorkloadRequest[] = [];
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest));
  if (workloadDoc !== undefined) {
    for (const raw of workloadDoc.manifest as unknown[]) {
      if (!isRecord(raw) || stringOf(raw.id) === '') continue;
      const requires = isRecord(raw.requires) ? raw.requires : {};
      manifest.push({
        id: stringOf(raw.id),
        api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
        stream: raw.stream === true,
        weight: raw.weight === 2 ? 2 : 1,
        requires: {
          tools: requires.tools === true,
          vision: requires.vision === true,
          json: requires.json === true,
          ...(numberOrNull(requires.min_context) !== null ? { min_context: numberOrNull(requires.min_context) as number } : {}),
        },
      });
    }
  }
  return { providers, ratings, manifest };
}

/* ------------------------------------------------------------------ probe */

interface ProbedModel {
  id: string;
  display_name: string;
  free: boolean | null;
  context_length: number | null;
}

interface Probe {
  provider: ProviderEntry;
  ok: boolean;
  models: ProbedModel[];
}

/** The provider's own base path joined to the env's origin; an absolute base is used as it stands. */
function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The headers a provider's auth scheme wants, from the brief's key. */
function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '' || auth === 'none') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** A listing's price field: true when every price it names is zero, null when it says nothing. */
function zeroPriced(v: Json): boolean | null {
  const pricing = isRecord(v.pricing) ? v.pricing : null;
  if (pricing === null) return null;
  const values = Object.values(pricing).flatMap((x) => {
    if (typeof x === 'number') return [x];
    if (typeof x === 'string' && x.trim() !== '') return [Number(x)];
    return [];
  });
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? stringOf(v.name).replace(/^models\//, '') : stringOf(v.id);
  if (id === '') return null;
  return {
    id,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : stringOf(v.displayName) !== '' ? stringOf(v.displayName) : id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context_length: numberOrNull(v.context_length) ?? numberOrNull(v.context_window) ?? numberOrNull(v.inputTokenLimit),
  };
}

/** Probe one provider's catalog route, in its own wire. */
async function probeProvider(envUrl: string, provider: ProviderEntry): Promise<Probe> {
  const base = joinBase(envUrl, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { provider, ok: false, models: [] };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { provider, ok: false, models: [] };
    const list = provider.wire === 'gemini' ? body.models : body.data;
    if (!Array.isArray(list)) return { provider, ok: false, models: [] };
    const models = list.flatMap((v) => {
      const m = modelIn(provider.wire, v);
      return m === null ? [] : [m];
    });
    return { provider, ok: true, models };
  } catch {
    return { provider, ok: false, models: [] };
  }
}

/* ---------------------------------------------------------------- catalog */

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface Catalog {
  providers: { id: string; base_url: string; key_env: string; wire: Wire; models: CatalogModel[] }[];
}

const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a listed model is free: the quality table's row where it has one, else the listing's word. */
function freeOf(brief: Brief, providerId: string, model: ProbedModel): boolean {
  const row = brief.ratings.get(`${providerId}\n${model.id}`);
  if (row !== undefined) return row.free;
  return model.free ?? false;
}

function buildCatalog(brief: Brief, probes: Probe[]): Catalog {
  const providers: Catalog['providers'] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const seen = new Set<string>();
    const models: CatalogModel[] = [];
    for (const model of [...probe.models].sort((a, b) => byIdAsc(a.id, b.id))) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const row = brief.ratings.get(`${probe.provider.id}\n${model.id}`);
      models.push({ id: model.id, free: freeOf(brief, probe.provider.id, model), context_length: row?.context_length ?? model.context_length ?? null });
    }
    providers.push({ id: probe.provider.id, base_url: probe.provider.base, key_env: probe.provider.key_env, wire: probe.provider.wire, models });
  }
  return { providers };
}

/* ------------------------------------------------------- request normal form */

/** One content part of a conversation turn, in wire-neutral form. */
type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'image_url'; url: string };

interface ToolCall {
  id: string;
  name: string;
  input: Json;
}

type Turn =
  | { role: 'user'; parts: Part[] }
  | { role: 'assistant'; text: string; tool_calls: ToolCall[] }
  | { role: 'tool'; id: string; name: string; text: string };

interface ToolDef {
  name: string;
  description: string;
  parameters: Json;
}

type ToolChoice = { kind: 'auto' } | { kind: 'any' } | { kind: 'none' } | { kind: 'tool'; name: string } | null;

/** A client request rewritten once, in a form every provider wire is built from. */
interface NormRequest {
  system_text: string;
  turns: Turn[];
  tools: ToolDef[];
  tool_choice: ToolChoice;
  max_tokens: number | null;
  stops: string[];
  temperature: number | null;
  top_p: number | null;
  json_mode: boolean;
  json_format: Json | null;
  stream: boolean;
}

/** The text of a string or of a block array's text blocks, joined with newlines, as both client wires read it. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function jsonObjectOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty object.
    }
  }
  return {};
}

function imagePart(url: string): Part {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (data !== null && data[2] === ';base64') return { type: 'image', media_type: data[1] ?? 'image/png', data: data[3] };
  return { type: 'image_url', url };
}

/** An OpenAI Chat Completions body in normal form. */
function normalizeOpenAI(body: Json): NormRequest {
  const systemParts: string[] = [];
  const turns: Turn[] = [];
  const callNames = new Map<string, string>();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const text = blocksText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (raw.role === 'user') {
      const parts: Part[] = [];
      if (typeof raw.content === 'string') {
        if (raw.content !== '') parts.push({ type: 'text', text: raw.content });
      } else if (Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
          else if (block.type === 'image_url' && isRecord(block.image_url) && typeof block.image_url.url === 'string') parts.push(imagePart(block.image_url.url));
        }
      }
      turns.push({ role: 'user', parts });
      continue;
    }
    if (raw.role === 'assistant') {
      const toolCalls: ToolCall[] = [];
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const name = stringOf(call.function.name);
        const id = stringOf(call.id);
        if (id !== '') callNames.set(id, name);
        toolCalls.push({ id, name, input: jsonObjectOf(call.function.arguments) });
      }
      turns.push({ role: 'assistant', text: blocksText(raw.content), tool_calls: toolCalls });
      continue;
    }
    if (raw.role === 'tool') {
      const id = stringOf(raw.tool_call_id);
      turns.push({ role: 'tool', id, name: callNames.get(id) ?? '', text: blocksText(raw.content) || (typeof raw.content === 'string' ? raw.content : '') });
      continue;
    }
  }
  const tools: ToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') continue;
      tools.push({
        name: raw.function.name,
        description: stringOf(raw.function.description),
        parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      });
    }
  }
  let toolChoice: ToolChoice = null;
  const choice = body.tool_choice;
  if (choice === 'auto') toolChoice = { kind: 'auto' };
  else if (choice === 'required') toolChoice = { kind: 'any' };
  else if (choice === 'none') toolChoice = { kind: 'none' };
  else if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') toolChoice = { kind: 'tool', name: choice.function.name };
  const format = isRecord(body.response_format) ? body.response_format : null;
  return {
    system_text: systemParts.join('\n'),
    turns,
    tools,
    tool_choice: toolChoice,
    max_tokens: numberOrNull(body.max_tokens) ?? numberOrNull(body.max_completion_tokens),
    stops: stringList(body.stop),
    temperature: numberOrNull(body.temperature),
    top_p: numberOrNull(body.top_p),
    json_mode: format !== null && (format.type === 'json_object' || format.type === 'json_schema'),
    json_format: format,
    stream: body.stream === true,
  };
}

/** An Anthropic Messages body in normal form. */
function normalizeAnthropic(body: Json): NormRequest {
  const turns: Turn[] = [];
  const callNames = new Map<string, string>();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'assistant') {
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (!isRecord(block) || block.type !== 'tool_use') continue;
          const id = stringOf(block.id);
          const name = stringOf(block.name);
          if (id !== '') callNames.set(id, name);
          toolCalls.push({ id, name, input: isRecord(block.input) ? block.input : {} });
        }
      }
      turns.push({ role: 'assistant', text: blocksText(raw.content), tool_calls: toolCalls });
      continue;
    }
    // A user turn: its text and image blocks, then one tool turn per tool_result block.
    const parts: Part[] = [];
    const results: Turn[] = [];
    if (typeof raw.content === 'string') {
      if (raw.content !== '') parts.push({ type: 'text', text: raw.content });
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
        else if (block.type === 'image' && isRecord(block.source)) {
          const source = block.source;
          if (source.type === 'base64' && typeof source.data === 'string') {
            parts.push({ type: 'image', media_type: typeof source.media_type === 'string' ? source.media_type : 'image/png', data: source.data });
          } else if (source.type === 'url' && typeof source.url === 'string') parts.push({ type: 'image_url', url: source.url });
        } else if (block.type === 'tool_result') {
          const id = stringOf(block.tool_use_id);
          const content = block.content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? blocksText(content) || JSON.stringify(content) : content === undefined ? '' : JSON.stringify(content);
          results.push({ role: 'tool', id, name: callNames.get(id) ?? '', text });
        }
      }
    }
    if (parts.length > 0) turns.push({ role: 'user', parts });
    turns.push(...results);
    if (parts.length === 0 && results.length === 0) turns.push({ role: 'user', parts: [] });
  }
  const tools: ToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      tools.push({
        name: raw.name,
        description: stringOf(raw.description),
        parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
      });
    }
  }
  let toolChoice: ToolChoice = null;
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') toolChoice = { kind: 'auto' };
    else if (choice.type === 'any') toolChoice = { kind: 'any' };
    else if (choice.type === 'none') toolChoice = { kind: 'none' };
    else if (choice.type === 'tool' && typeof choice.name === 'string') toolChoice = { kind: 'tool', name: choice.name };
  }
  return {
    system_text: blocksText(body.system),
    turns,
    tools,
    tool_choice: toolChoice,
    max_tokens: numberOrNull(body.max_tokens),
    stops: stringList(body.stop_sequences),
    temperature: numberOrNull(body.temperature),
    top_p: numberOrNull(body.top_p),
    json_mode: false,
    json_format: null,
    stream: body.stream === true,
  };
}

/* --------------------------------------------------------- upstream builders */

function partForOpenAI(part: Part): Json {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') return { type: 'image_url', image_url: { url: `data:${part.media_type};base64,${part.data}` } };
  return { type: 'image_url', image_url: { url: part.url } };
}

function partForAnthropic(part: Part): Json {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') return { type: 'image', source: { type: 'base64', media_type: part.media_type, data: part.data } };
  return { type: 'image', source: { type: 'url', url: part.url } };
}

function partForGemini(part: Part): Json {
  if (part.type === 'text') return { text: part.text };
  if (part.type === 'image') return { inlineData: { mimeType: part.media_type, data: part.data } };
  return { fileData: { fileUri: part.url } };
}

function buildOpenAIBody(req: NormRequest, model: string): Json {
  const messages: Json[] = [];
  if (req.system_text !== '') messages.push({ role: 'system', content: req.system_text });
  for (const turn of req.turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.parts.map(partForOpenAI) });
    } else if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text !== '' ? turn.text : null,
        ...(turn.tool_calls.length > 0
          ? {
              tool_calls: turn.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
            }
          : {}),
      });
    } else {
      messages.push({ role: 'tool', tool_call_id: turn.id, content: turn.text });
    }
  }
  const out: Json = { model, messages, stream: false };
  if (req.max_tokens !== null) out.max_tokens = req.max_tokens;
  if (req.temperature !== null) out.temperature = req.temperature;
  if (req.top_p !== null) out.top_p = req.top_p;
  if (req.stops.length > 0) out.stop = req.stops;
  if (req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (req.tool_choice !== null) {
    if (req.tool_choice.kind === 'auto') out.tool_choice = 'auto';
    else if (req.tool_choice.kind === 'any') out.tool_choice = 'required';
    else if (req.tool_choice.kind === 'none') out.tool_choice = 'none';
    else out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
  }
  if (req.json_mode && req.json_format !== null) out.response_format = req.json_format;
  return out;
}

function buildAnthropicBody(req: NormRequest, model: string): Json {
  const messages: Json[] = [];
  for (const turn of req.turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.parts.map(partForAnthropic) });
    } else if (turn.role === 'assistant') {
      const blocks: Json[] = [];
      if (turn.text !== '') blocks.push({ type: 'text', text: turn.text });
      for (const c of turn.tool_calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content: blocks });
    } else {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.id, content: turn.text }] });
    }
  }
  const out: Json = { model, messages, stream: false };
  if (req.system_text !== '') out.system = req.system_text;
  if (req.max_tokens !== null) out.max_tokens = req.max_tokens;
  if (req.temperature !== null) out.temperature = req.temperature;
  if (req.top_p !== null) out.top_p = req.top_p;
  if (req.stops.length > 0) out.stop_sequences = req.stops;
  if (req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (req.tool_choice !== null) {
    if (req.tool_choice.kind === 'auto') out.tool_choice = { type: 'auto' };
    else if (req.tool_choice.kind === 'any') out.tool_choice = { type: 'any' };
    else if (req.tool_choice.kind === 'none') out.tool_choice = { type: 'none' };
    else out.tool_choice = { type: 'tool', name: req.tool_choice.name };
  }
  return out;
}

function buildGeminiBody(req: NormRequest): Json {
  const contents: Json[] = [];
  for (const turn of req.turns) {
    if (turn.role === 'user') {
      contents.push({ role: 'user', parts: turn.parts.length > 0 ? turn.parts.map(partForGemini) : [{ text: '' }] });
    } else if (turn.role === 'assistant') {
      const parts: Json[] = [];
      if (turn.text !== '') parts.push({ text: turn.text });
      for (const c of turn.tool_calls) parts.push({ functionCall: { name: c.name, args: c.input } });
      contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    } else {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: turn.name !== '' ? turn.name : 'tool', response: { result: turn.text } } }] });
    }
  }
  const out: Json = { contents };
  if (req.system_text !== '') out.systemInstruction = { parts: [{ text: req.system_text }] };
  if (req.tools.length > 0) {
    out.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const config: Json = {};
  if (req.max_tokens !== null) config.maxOutputTokens = req.max_tokens;
  if (req.stops.length > 0) config.stopSequences = req.stops;
  if (req.temperature !== null) config.temperature = req.temperature;
  if (req.top_p !== null) config.topP = req.top_p;
  if (req.json_mode) config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

/* ------------------------------------------------------------ provider calls */

interface Answer {
  text: string;
  input_tokens: number;
  output_tokens: number;
  stop: string | null;
  raw_text: string;
}

interface Candidate {
  provider: ProviderEntry;
  model: string;
  row: RatingRow;
}

const CALL_TIMEOUT_MS = 15000;

function parseAnswer(wire: Wire, body: Json): Answer | null {
  if (wire === 'openai') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null || !isRecord(choice.message)) return null;
    const content = choice.message.content;
    const text = typeof content === 'string' ? content : blocksText(content);
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text,
      input_tokens: numberOrNull(usage.prompt_tokens) ?? 0,
      output_tokens: numberOrNull(usage.completion_tokens) ?? 0,
      stop: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      raw_text: '',
    };
  }
  if (wire === 'anthropic') {
    if (!Array.isArray(body.content)) return null;
    const text = body.content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text,
      input_tokens: numberOrNull(usage.input_tokens) ?? 0,
      output_tokens: numberOrNull(usage.output_tokens) ?? 0,
      stop: typeof body.stop_reason === 'string' ? body.stop_reason : null,
      raw_text: '',
    };
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate === null || !isRecord(candidate.content)) return null;
  const parts = Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join('');
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    text,
    input_tokens: numberOrNull(usage.promptTokenCount) ?? 0,
    output_tokens: numberOrNull(usage.candidatesTokenCount) ?? 0,
    stop: typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
    raw_text: '',
  };
}

/** One inference call to one provider. Null when the provider refused or the answer was unusable. */
async function callProvider(envUrl: string, candidate: Candidate, req: NormRequest): Promise<Answer | null> {
  const provider = candidate.provider;
  const base = joinBase(envUrl, provider.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider.auth, provider.key) };
  let url: string;
  let payload: Json;
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    payload = buildOpenAIBody(req, candidate.model);
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    payload = buildAnthropicBody(req, candidate.model);
  } else {
    url = `${base}/v1beta/models/${encodeURIComponent(candidate.model)}:generateContent`;
    payload = buildGeminiBody(req);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) {
    // A refusal (402/429) or any other non-2xx: this candidate did not serve.
    try {
      await res.text();
    } catch {
      // Nothing to drain.
    }
    return null;
  }
  const rawText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const answer = parseAnswer(provider.wire, body);
  if (answer === null) return null;
  answer.raw_text = rawText;
  return answer;
}

/* ------------------------------------------------------------ client answers */

const FIXED_CREATED = 1767225600;
const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';

/** The stop-reason family: 0 turn ended, 1 length, 2 tool use, 3 refusal. */
function stopFamily(reason: string | null): number {
  switch (reason) {
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 1;
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 2;
    case 'content_filter':
    case 'refusal':
    case 'SAFETY':
      return 3;
    default:
      return 0;
  }
}

const stopForOpenAI = (reason: string | null): string => ['stop', 'length', 'tool_calls', 'content_filter'][stopFamily(reason)];
const stopForAnthropic = (reason: string | null): string => ['end_turn', 'max_tokens', 'tool_use', 'refusal'][stopFamily(reason)];

function openAIJsonAnswer(answer: Answer, model: string): Json {
  return {
    id: 'chatcmpl-agg',
    object: 'chat.completion',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: stopForOpenAI(answer.stop), logprobs: null }],
    usage: { prompt_tokens: answer.input_tokens, completion_tokens: answer.output_tokens, total_tokens: answer.input_tokens + answer.output_tokens },
  };
}

function anthropicJsonAnswer(answer: Answer, model: string): Json {
  return {
    id: 'msg_agg',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: stopForAnthropic(answer.stop),
    stop_sequence: null,
    usage: { input_tokens: answer.input_tokens, output_tokens: answer.output_tokens },
  };
}

function sseFrame(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Split an answer text the way the providers do: fixed 13-character pieces. */
function splitPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += 13) pieces.push(text.slice(at, at + 13));
  return pieces;
}

function openAIStreamAnswer(answer: Answer, model: string): string {
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-agg',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames: string[] = [sseFrame(null, chunk({ role: 'assistant', content: '' }, null))];
  for (const piece of splitPieces(answer.text)) frames.push(sseFrame(null, chunk({ content: piece }, null)));
  frames.push(sseFrame(null, chunk({}, stopForOpenAI(answer.stop))));
  frames.push(
    sseFrame(null, {
      id: 'chatcmpl-agg',
      object: 'chat.completion.chunk',
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: { prompt_tokens: answer.input_tokens, completion_tokens: answer.output_tokens, total_tokens: answer.input_tokens + answer.output_tokens },
    }),
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

function anthropicStreamAnswer(answer: Answer, model: string): string {
  const frames: string[] = [
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_agg',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.input_tokens, output_tokens: 0 },
      },
    }),
    sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (const piece of splitPieces(answer.text)) {
    frames.push(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
  }
  frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
  frames.push(
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopForAnthropic(answer.stop), stop_sequence: null },
      usage: { output_tokens: answer.output_tokens },
    }),
  );
  frames.push(sseFrame('message_stop', { type: 'message_stop' }));
  return frames.join('');
}

function openAIError(message: string, type: string): Json {
  return { error: { message, type, param: null, code: null } };
}

function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/* ------------------------------------------------------------------- server */

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Planning caps for primary picks: the low end of each provider's free-tier
 * budget range in the competition's fixed provider table. A trial's drawn
 * budget never falls below its range's low end, so a primary plan under the
 * caps can never overrun a budget; failovers may pass a cap, and a refusal
 * just moves the request on. Providers the table does not name get the
 * conservative default.
 */
const PLANNING_CALL_CAPS: Record<string, number> = {
  groq: 9,
  cerebras: 5,
  gemini: 6,
  zai: 4,
  openrouter: 10,
  sambanova: 4,
  pollinations: 10,
  cloudflare: 7,
  ovh: 5,
  kilol: 12,
};
const DEFAULT_CALL_CAP = 4;
/**
 * Refusals after which a provider is treated as down for the rest of the
 * trial. A provider's failure schedule holds at most two calls, so a third
 * refusal means an outage or a spent budget, never another scheduled blip:
 * demoting at two would throw away a healthy provider's remaining calls.
 */
const DOWN_AFTER_REFUSALS = 3;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

interface State {
  brief: Brief;
  probes: Probe[];
  catalog: Catalog;
  attempts: Map<string, number>;
  refusals: Map<string, number>;
  manifest_index: number;
}

function meetsRequirements(requires: Requirement, row: RatingRow): boolean {
  if (requires.tools === true && !row.tools) return false;
  if (requires.vision === true && !row.vision) return false;
  if (requires.json === true && !row.json) return false;
  if (requires.min_context !== undefined && (row.context_length === null || row.context_length < requires.min_context)) return false;
  return true;
}

/**
 * The candidates for one request, best first. On the first attempt the order
 * is: providers not down and under their planning cap before the rest, then
 * the quality table's rating, then the planning capacity left, then ids.
 * On a retry (retry = true, after a refusal in this same request) an
 * untouched provider leads outright, whatever its rating: failure
 * schedules and outages only bite from a provider's second counted call
 * on, and every budget holds at least four, so a provider's first counted
 * call of the trial cannot refuse. A guaranteed answer ends the failover
 * in one call; chaining through tried providers instead — each with its
 * own few-in-a-range chance that its next call number is a scheduled
 * refusal — cost up to four calls a request in practice, for rating
 * differences of a few tens of milli-points that the quality column's
 * rounding never showed. Tried providers return to the ranking, in the
 * usual order, only once no untouched provider can serve the request.
 * Every key is a function of the brief and the answers seen so far, so
 * the order is replay-stable.
 */
function candidatesFor(state: State, requires: Requirement, jsonMode: boolean, retry: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of state.probes) {
    if (!probe.ok) continue;
    // The anthropic wire cannot carry an OpenAI JSON mode: its echo would
    // report the mode absent and lose the request.
    if (jsonMode && probe.provider.wire === 'anthropic') continue;
    for (const model of probe.models) {
      const row = state.brief.ratings.get(`${probe.provider.id}\n${model.id}`);
      if (row === undefined || !row.free) continue;
      if (!meetsRequirements(requires, row)) continue;
      out.push({ provider: probe.provider, model: model.id, row });
    }
  }
  const key = (c: Candidate): [number, number, number, number, number, string, string] => {
    const attempts = state.attempts.get(c.provider.id) ?? 0;
    const cap = PLANNING_CALL_CAPS[c.provider.id] ?? DEFAULT_CALL_CAP;
    return [
      retry && attempts > 0 ? 1 : 0,
      (state.refusals.get(c.provider.id) ?? 0) >= DOWN_AFTER_REFUSALS ? 1 : 0,
      attempts >= cap ? 1 : 0,
      -c.row.rating_milli,
      attempts - cap,
      c.provider.id,
      c.model,
    ];
  };
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return out;
}

/** The free model ids this entry serves, deduplicated: what GET /v1/models lists on both wires. */
function servedModelList(state: State): { id: string; provider: string; display_name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; provider: string; display_name: string }[] = [];
  for (const probe of state.probes) {
    if (!probe.ok) continue;
    for (const model of probe.models) {
      if (seen.has(model.id)) continue;
      const row = state.brief.ratings.get(`${probe.provider.id}\n${model.id}`);
      const free = row !== undefined ? row.free : (model.free ?? false);
      if (!free) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendText(res, status, 'application/json', JSON.stringify(body));
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(clientApi: 'openai' | 'anthropic', req: NormRequest): Requirement {
  const vision = req.turns.some((t) => t.role === 'user' && t.parts.some((p) => p.type === 'image' || p.type === 'image_url'));
  return { tools: req.tools.length > 0, vision, json: req.json_mode };
}

/** Serve one client inference request: try the ranked candidates until one answers. */
async function serve(state: State, clientApi: 'openai' | 'anthropic', body: Json, res: ServerResponse): Promise<void> {
  const req = clientApi === 'openai' ? normalizeOpenAI(body) : normalizeAnthropic(body);
  const entry = state.brief.manifest[state.manifest_index];
  state.manifest_index += 1;
  const requires = entry !== undefined ? entry.requires : requirementsFromBody(clientApi, req);
  const tried = new Set<string>();
  let failures = 0;
  for (;;) {
    // Re-ranked per attempt: after a refusal the retry order leads with any
    // provider this trial has not counted a call on yet (see candidatesFor).
    const candidate = candidatesFor(state, requires, req.json_mode, failures > 0).find((c) => !tried.has(c.provider.id));
    if (candidate === undefined) break;
    tried.add(candidate.provider.id);
    state.attempts.set(candidate.provider.id, (state.attempts.get(candidate.provider.id) ?? 0) + 1);
    const answer = await callProvider(ENV_URL, candidate, req);
    if (answer === null) {
      state.refusals.set(candidate.provider.id, (state.refusals.get(candidate.provider.id) ?? 0) + 1);
      failures += 1;
      continue;
    }
    // This candidate served the request: answer in the client's wire.
    if (req.stream) {
      const text = clientApi === 'openai' ? openAIStreamAnswer(answer, candidate.model) : anthropicStreamAnswer(answer, candidate.model);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(text);
      return;
    }
    if (candidate.provider.wire === clientApi) {
      // Same wire in and out: the provider's own document is the answer.
      sendText(res, 200, 'application/json', answer.raw_text);
      return;
    }
    sendJson(res, 200, clientApi === 'openai' ? openAIJsonAnswer(answer, candidate.model) : anthropicJsonAnswer(answer, candidate.model));
    return;
  }
  if (clientApi === 'openai') sendJson(res, 502, openAIError('no free model on the directory could serve this request', 'api_error'));
  else sendJson(res, 502, anthropicError('api_error', 'no free model on the directory could serve this request'));
}

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const list = servedModelList(state);
    if (typeof req.headers['x-api-key'] === 'string') {
      sendJson(res, 200, { data: list.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_CREATED_AT })), has_more: false });
    } else {
      sendJson(res, 200, { object: 'list', data: list.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })) });
    }
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const clientApi = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    const body = await readJsonBody(req);
    if (body === null) {
      if (clientApi === 'anthropic') sendJson(res, 400, anthropicError('invalid_request_error', 'the request body is not one JSON object'));
      else sendJson(res, 400, openAIError('the request body is not one JSON object', 'invalid_request_error'));
      return;
    }
    await serve(state, clientApi, body, res);
    return;
  }
  if (url.pathname === '/v1/messages') sendJson(res, 404, anthropicError('not_found_error', `no route ${req.method ?? ''} ${url.pathname}`));
  else sendJson(res, 404, openAIError(`no route ${req.method ?? ''} ${url.pathname}`, 'not_found_error'));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number, catalog: Catalog): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work; exit 0 the moment the env says the workload is done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  const brief = readBrief(PROMPT_FILE);
  const probes = await Promise.all(brief.providers.map((provider) => probeProvider(ENV_URL, provider)));
  const catalog = buildCatalog(brief, probes);
  if (process.argv.includes('--list')) {
    // The one catalog document, byte for byte as the register body carries it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const state: State = { brief, probes, catalog, attempts: new Map(), refusals: new Map(), manifest_index: 0 };
  const server = createServer((req, res) => {
    void handle(state, req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        if (req.url?.startsWith('/v1/messages') === true) sendJson(res, 500, anthropicError('api_error', 'the server failed to answer'));
        else sendJson(res, 500, openAIError('the server failed to answer', 'api_error'));
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  if (address.port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${address.port} with ${catalog.providers.length} answered providers`);
  await register(address.port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
