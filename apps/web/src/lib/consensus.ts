/**
 * Idempotency keys for the writes that MAY NOT be queued.
 *
 * ###########################################################################
 * THE QUEUE IS THE DEFAULT. THIS IS FOR THE OPERATIONS THE SERVER FORBIDS
 * OFFLINE -- AND IT EXISTS SO THOSE STILL DO NOT MINT A KEY IN A TAP HANDLER.
 *
 * `src/modules/offline/sync.ts` names the line and does not leave it to taste:
 *
 *   OFFLINE_ALLOWED   session.open, order.line.add, order.line.edit_prefire,
 *                     order.line.remove_prefire, kot.fire
 *   OFFLINE_FORBIDDEN bill.generate, payment.tender, payment.tender.void,
 *                     payment.refund, order.void, order.comp, order.discount
 *
 * A batch containing anything from the forbidden set is quarantined ENTIRE with
 * reason `forbidden_operation`. So a client that queues a comp is not being
 * resilient, it is composing a batch the server has already promised to refuse
 * whole -- taking the waiter's unrelated queued lines down with it. Those seven
 * wait for the server, exactly as `Bill.tsx` explains for tender.
 *
 * Waiting for the server does NOT excuse minting the key in `onClick`. A second
 * tap during a stalled request is the same failure the queue exists to prevent,
 * and `crypto.randomUUID()` inside a handler is a new key on that second tap.
 * So a key is minted once per composed INTENT and reused for every attempt at
 * that same intent; change the composition and it is a different intent with a
 * different key, which is what `idempotency_key_reused` is there to catch.
 *
 * DELIBERATELY IN MEMORY, NOT PERSISTED. The key's lifetime is the intent's, and
 * the intent -- a selection of lines, a typed percentage -- is not persisted
 * either. A key that outlived its intent across a reload would be reused for a
 * DIFFERENT composition, which is the one thing the header must never do.
 * ###########################################################################
 */
export function createConsensusKeys() {
  const minted = new Map<string, string>();

  return {
    /**
     * The key for this intent. Same signature, same key, however many taps.
     *
     * The signature must be derived from everything the server will see in the
     * body. A signature that ignores a field is a key reused for two different
     * requests.
     */
    for(signature: string): string {
      let key = minted.get(signature);
      if (key === undefined) {
        key = crypto.randomUUID();
        minted.set(signature, key);
      }
      return key;
    },

    /** Called on ACKNOWLEDGED success only. A refusal keeps the key: the next
     * attempt at the same intent is the same request. */
    retire(signature: string): void {
      minted.delete(signature);
    },
  };
}

export type ConsensusKeys = ReturnType<typeof createConsensusKeys>;
