/**
 * Install-wide provider concurrency caps (`concurrency.providers.<id>` and Pi
 * `assistants.pi.maxConcurrent` in `~/.archon/config.yaml`), read fresh at every provider
 * attempt through `readConcurrencyConfig`.
 */
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { configSchemas as piConfigSchemas } from '@archon/providers/pi/config';
import { isRegisteredProvider } from '@archon/providers';
import { ConcurrencyConfigError, readConcurrencyConfig } from './concurrency-config';

const REFUSED = 'Provider attempts';

// `.nullish()`: YAML reads an empty `concurrency:` or `providers:` key as null, which
// means no caps, not an invalid config.
//
// The single owner of the `concurrency.providers` rules. Admission reads it here and the
// settings writer validates through it in `config-validation.ts`, so a write can never
// persist a block admission would refuse.
export const providerConcurrencySchema = z.looseObject({
  concurrency: z
    .looseObject({ providers: z.record(z.string(), z.number().int().min(1)).nullish() })
    .nullish(),
});

const configSchema = providerConcurrencySchema.extend({
  assistants: z
    .looseObject({
      pi: z.looseObject({ maxConcurrent: piConfigSchemas.install.shape.maxConcurrent }).nullish(),
    })
    .nullish(),
});

/** The IDs in `ids` that Archon has no provider registration for. */
export function unknownProviderCapIds(ids: Iterable<string>): string[] {
  return [...ids].filter(id => !isRegisteredProvider(id));
}

/** Caps keyed by provider registration ID. An absent provider is unlimited. */
export async function loadProviderConcurrencyCaps(): Promise<ReadonlyMap<string, number>> {
  const config = await readConcurrencyConfig(configSchema, REFUSED);
  const caps = new Map(Object.entries(config.concurrency?.providers ?? {}));
  const piCap = config.assistants?.pi?.maxConcurrent;
  if (piCap !== undefined) caps.set('pi', Math.min(caps.get('pi') ?? piCap, piCap));
  const unknown = unknownProviderCapIds(caps.keys());
  if (unknown.length > 0) {
    throw new ConcurrencyConfigError(
      getArchonConfigPath(),
      `unknown provider registration ID(s) ${unknown.map(id => `'${id}'`).join(', ')}`,
      REFUSED
    );
  }
  return caps;
}
