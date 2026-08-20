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

const CHANNEL_ID = /^[0-9]+$/

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

function matching(channels: readonly ApiChannel[], reference: ChannelReference): readonly ApiChannel[] {
  const written = String(reference)

  return CHANNEL_ID.test(written)
    ? channels.filter((channel) => channel.id === written)
    : channels.filter((channel) => channel.label === written)
}

// Identifiers are compared as the decimal strings every read reports; anything else is read
// as a label, because a number is the one thing a label cannot be confused with.
export function resolveChannels(
  channels: readonly ApiChannel[],
  references: readonly ChannelReference[],
): ChannelLookup {
  const ids: string[] = []

  for (const reference of references) {
    const found = matching(channels, reference)

    if (found.length === 0) {
      return {
        ok: false,
        reason: `no channel of this account is named ${JSON.stringify(String(reference))}`,
      }
    }

    if (found.length > 1) {
      return {
        ok: false,
        reason: `${found.length} channels of this account are named ${JSON.stringify(String(reference))}, so there is no way to tell which was meant — name it by identifier instead`,
      }
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
