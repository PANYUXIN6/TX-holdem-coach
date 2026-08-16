import {
  decodeCurrentPrivateEvent,
  encodeCurrentPrivateEvent,
  PRIVATE_EVENT_PAYLOAD_VERSION,
  type StoredPrivateEvent,
} from './private-event-codec.js'
import { createPrivateEvent, type PrivateEvent } from './private-event.js'

export interface CurrentPrivateEventProtocol<
  CurrentEventDraft,
  StoredCurrentEvent,
> {
  readonly rowPayloadVersion: number
  parseDraft(input: unknown): CurrentEventDraft
  encodeCurrent(input: CurrentEventDraft): StoredCurrentEvent
  decodeStoredCurrent(input: unknown): CurrentEventDraft
}

export const currentPrivateEventProtocol = Object.freeze({
  rowPayloadVersion: PRIVATE_EVENT_PAYLOAD_VERSION,
  parseDraft: createPrivateEvent,
  encodeCurrent: encodeCurrentPrivateEvent,
  decodeStoredCurrent: (input: unknown) =>
    decodeCurrentPrivateEvent(input).payload.event,
}) satisfies CurrentPrivateEventProtocol<PrivateEvent, StoredPrivateEvent>
