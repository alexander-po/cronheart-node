import { refuse } from './errors.js'
import type {
  ChannelReference,
  DefinedRouting,
  ResolvedRouting,
  RoutedChannel,
  RoutingMode,
} from './types.js'
import type { Channel as ApiChannel } from '../api/types.js'

export const ROUTING_MODES: readonly RoutingMode[] = ['listed', 'none', 'unmanaged']

export const NO_CHANNELS = 'none'

export function routingFrom(value: unknown, monitor: string): DefinedRouting {
  if (value === undefined || value === 'unmanaged') {
    return { mode: 'unmanaged' }
  }

  if (value === 'none') {
    return { mode: 'none' }
  }

  if (!Array.isArray(value)) {
    refuse(
      `${JSON.stringify(String(value))} is not something channels can be. Write a list of channel labels or identifiers, 'none' to say this monitor alerts nobody, or leave channels out to leave whatever is attached alone.`,
      monitor,
    )
  }

  // The shape a defaulted value takes, and the one that would empty a monitor's routing
  // without anybody having written that down. Saying it takes the word.
  if (value.length === 0) {
    refuse(
      "channels is an empty list. That would replace this monitor's routing with nothing, which is what 'none' says in as many words — write that if it is what you meant, or leave channels out to leave the routing alone.",
      monitor,
    )
  }

  for (const reference of value as readonly unknown[]) {
    if (typeof reference !== 'string' && typeof reference !== 'number') {
      refuse('Every channel is named by a label or an identifier.', monitor)
    }
  }

  return { mode: 'listed', references: value as readonly ChannelReference[] }
}

// The one place the routing field is decided. 'unmanaged' returns no key at all rather than
// an undefined one, so a configuration silent about channels cannot reach the field the
// service reads as a wholesale replacement — the only way to blank a monitor's alerting.
export function routingKeys(routing: ResolvedRouting): { readonly channelIds?: readonly string[] } {
  if (routing.mode === 'unmanaged') {
    return {}
  }

  return { channelIds: routing.mode === 'none' ? [] : routing.ids }
}

export type ChannelLookup =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: string }

// The service's rule for a label is a length and nothing else, so a label of digits is legal
// and a reference cannot be classified by its shape. Both readings are taken, and a reference
// that answers to two different channels is refused for the reason a repeated label is.
function matching(
  channels: readonly ApiChannel[],
  reference: ChannelReference,
): { readonly found: readonly ApiChannel[]; readonly labelled: number } {
  const written = String(reference)
  const labelled = channels.filter((channel) => channel.label === written)
  const identified = channels.filter(
    (channel) => channel.id === written && !labelled.includes(channel),
  )

  return { found: [...labelled, ...identified], labelled: labelled.length }
}

function ambiguity(reference: ChannelReference, found: readonly ApiChannel[], labelled: number): string {
  const written = JSON.stringify(String(reference))

  return labelled === found.length
    ? `${found.length} channels of this account are labelled ${written}, so there is no way to tell which was meant — give this monitor's channels by identifier instead`
    : `${written} is the label of one channel of this account and the identifier of another, so there is no way to tell which was meant — rename one of them, or name the one you meant by the label the other does not answer to`
}

export function resolveChannels(
  channels: readonly ApiChannel[],
  references: readonly ChannelReference[],
): ChannelLookup {
  const ids: string[] = []

  for (const reference of references) {
    const { found, labelled } = matching(channels, reference)

    if (found.length === 0) {
      return {
        ok: false,
        reason: `no channel of this account is named ${JSON.stringify(String(reference))}`,
      }
    }

    if (found.length > 1) {
      return { ok: false, reason: ambiguity(reference, found, labelled) }
    }

    const only = found[0]

    if (only !== undefined && !ids.includes(only.id)) {
      ids.push(only.id)
    }
  }

  // Sorted the way every read reports them, so a configuration that lists the same channels
  // in another order neither reads as a change nor mints a different idempotency key.
  return { ok: true, ids: [...ids].sort((one, other) => Number(one) - Number(other)) }
}

// Attachment is not deliverability: the service skips an attached channel that is not
// verified, and the monitor projection carries no verified flag, so this needs both reads.
export function verifiedAmong(
  channels: readonly ApiChannel[],
  ids: readonly string[],
): readonly RoutedChannel[] {
  return channels
    .filter((channel) => channel.verified && ids.includes(channel.id))
    .map((channel) => ({ id: channel.id, kind: channel.kind, label: channel.label }))
}
