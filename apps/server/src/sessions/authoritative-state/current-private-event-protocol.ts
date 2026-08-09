import type { PrivateEventVersionIdentity } from './private-event-version-registry.js'
import {
  decodeCurrentPrivateEventV2,
  encodePrivateEventV2,
  EVENT_V2_SCHEMA_VERSION,
  PRIVATE_EVENT_V2_PAYLOAD_VERSION,
  type StoredPrivateEventV2,
} from './private-event-codec-v2.js'
import {
  createPrivateEventV2,
  type PrivateEventV2,
} from './private-event-v2.js'

export interface CurrentPrivateEventProtocol<
  CurrentEventDraft,
  StoredCurrentEvent,
> {
  readonly identity: PrivateEventVersionIdentity
  parseDraft(input: unknown): CurrentEventDraft
  encodeCurrent(input: CurrentEventDraft): StoredCurrentEvent
  decodeStoredCurrent(input: unknown): CurrentEventDraft
}

export const currentPrivateEventProtocol = Object.freeze({
  identity: Object.freeze({
    rowPayloadVersion: PRIVATE_EVENT_V2_PAYLOAD_VERSION,
    envelopeSchemaVersion: EVENT_V2_SCHEMA_VERSION,
  }),
  parseDraft: createPrivateEventV2,
  encodeCurrent: encodePrivateEventV2,
  decodeStoredCurrent: (input: unknown) =>
    decodeCurrentPrivateEventV2(input).payload.event,
}) satisfies CurrentPrivateEventProtocol<PrivateEventV2, StoredPrivateEventV2>
