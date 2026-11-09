import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { ContractError } from '@t1/contracts';

export class ModelConfig {
  readonly #apiKey: string;
  constructor(readonly provider: string, readonly baseUrl: string, readonly modelId: string, apiKey: string) { this.#apiKey = apiKey; }
  apiKey(): string { return this.#apiKey; }
  publicInfo() { return { provider: this.provider, endpoint: this.baseUrl, model_id: this.modelId, api_key_present: Boolean(this.#apiKey) }; }
}
export function parseModelConfig(fileText: string, environment: Record<string, string | undefined> = {}): ModelConfig {
  const values = parse(fileText);
  const get = (key: string) => (environment[key] ?? values[key] ?? '').trim();
  const provider = get('T1_MODEL_PROVIDER');
  const endpoint = get('T1_MODEL_BASE_URL');
  const model = get('T1_MODEL_ID');
  const key = get('T1_MODEL_API_KEY');
  if (!provider || !endpoint || !model || !key) throw new ContractError('model_configuration_incomplete');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ContractError('invalid_model_endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ContractError('model_endpoint_requires_https_without_credentials_or_query');
  if (!/^[a-zA-Z0-9_.-]+$/.test(provider) || !/^[a-zA-Z0-9_./:@+-]+$/.test(model)) throw new ContractError('invalid_provider_or_model_identifier');
  return new ModelConfig(provider, endpoint.replace(/\/+$/, ''), model, key);
}
export function loadModelConfig(path = '.env', environment = process.env): ModelConfig {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ContractError('model_configuration_unreadable');
  }
  return parseModelConfig(text, environment);
}
export function safeError(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const names = ['ContractError', 'AbortError', 'TimeoutError', 'APIError', 'Error'];
  const type = typeof value.name === 'string' && names.includes(value.name) ? value.name : 'UnknownError';
  const status = typeof value.status === 'number' && value.status >= 100 && value.status < 600 ? value.status : undefined;
  const code = error instanceof ContractError ? error.code : undefined;
  const requestId = typeof value.request_id === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value.request_id) ? value.request_id : undefined;
  return { type, status, code, request_id: requestId };
}
