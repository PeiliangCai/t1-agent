import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContractError } from '@t1/contracts';
import { developmentProfile, type ModelConfig, type ResponseModelAliasPolicy } from '@t1/agent';

/** Existing supplier identity evidence only; this neither selects a formal application model nor authorizes a request. */
export function workbenchModelPolicy(config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'modelId'>) {
  const profile = developmentProfile(config.modelId);
  if (config.provider !== 'agicto' || config.baseUrl !== 'https://api.agicto.cn/v1' || config.modelId !== 'gpt-6-luna') return { profile };
  const source = 'docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json';
  const bytes = readFileSync(fileURLToPath(new URL('../../../' + source, import.meta.url)));
  if (createHash('sha256').update(bytes).digest('hex') !== '54289c509f5c5ce7327459e84af26763e45423b91bcd31aa271ca0c87d2490a1') throw new ContractError('confirmed_model_alias_evidence_changed');
  const value = JSON.parse(bytes.toString());
  const expected = [{ requested_model: 'gpt-6-luna', response_model: 'igpt-6-luna' }, { requested_model: 'igpt-6-luna', response_model: 'gpt-6-luna' }];
  if (value.requested_model !== config.modelId || value.reasoning_effort !== profile.reasoning_effort || value.wildcard_or_prefix_stripping_allowed !== false || JSON.stringify(value.exact_pairs) !== JSON.stringify(expected)) throw new ContractError('confirmed_model_alias_evidence_invalid');
  const responseModelAliasPolicy: ResponseModelAliasPolicy = { policy_id: value.confirmation_id, source: 'code/' + source, recorded_at: value.recorded_at, exact_pairs: expected };
  return { profile, responseModelAliasPolicy };
}
