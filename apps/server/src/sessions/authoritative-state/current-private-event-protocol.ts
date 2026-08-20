import {
  decodeCurrentPrivateEvent,
  encodeCurrentPrivateEvent,
  type StoredPrivateEvent,
} from './private-event-codec.js'
import { createPrivateEvent, type PrivateEvent } from './private-event.js'

export interface CurrentPrivateEventProtocol<
  CurrentEventDraft,
  StoredCurrentEvent,
> {
  parseDraft(input: unknown): CurrentEventDraft
  encodeCurrent(input: CurrentEventDraft): StoredCurrentEvent
  decodeStoredCurrent(input: unknown): CurrentEventDraft
}

export const currentPrivateEventProtocol = Object.freeze({
  parseDraft: createPrivateEvent,
  encodeCurrent: encodeCurrentPrivateEvent,
  decodeStoredCurrent: (input: unknown) =>
    decodeCurrentPrivateEvent(input).payload.event,
}) satisfies CurrentPrivateEventProtocol<PrivateEvent, StoredPrivateEvent>
