/* Pure quiet-timer arithmetic — no I/O, fully unit-tested. The single source of
   truth for "how long a WhatsApp chat must sit silent before we summarize it."
   A tracked chat that receives a message recomputes its deadline from now; only
   a full 15 minutes of silence lets the timer fire. */

export const WHATSAPP_QUIET_MS = 15 * 60 * 1000;

/** The absolute time a chat's quiet timer should fire, given the moment its
    latest message arrived. Every inbound message recomputes this from "now",
    which is exactly the reset-on-activity behaviour. */
export function quietDeadline(now: number): number {
  return now + WHATSAPP_QUIET_MS;
}
