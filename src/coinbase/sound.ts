/**
 * Coinbase Bot Audio Notification Utility
 * ─────────────────────────────────────────
 * Triggers audio chimes and terminal bells for every transaction,
 * win, loss, and stop-loss event on Linux / system terminals.
 */

import { exec } from 'child_process';

export type SoundEvent = 'buy' | 'sell' | 'win' | 'loss' | 'trailing' | 'alert';

/**
 * Play transaction sound asynchronously without blocking the event loop
 */
export function playTransactionSound(event: SoundEvent) {
  // 1. ASCII Terminal Bell (triggers internal terminal audio chime)
  try {
    process.stdout.write('\x07');
  } catch {}

  // 2. Linux / GNOME / Desktop Audio via canberra-gtk-play
  let soundId = 'bell';
  switch (event) {
    case 'buy':
      soundId = 'message-new-instant'; // crisp entry ding
      break;
    case 'win':
      soundId = 'complete'; // triumphant take-profit chime
      break;
    case 'loss':
      soundId = 'dialog-warning'; // stop-loss warning
      break;
    case 'sell':
      soundId = 'service-logout'; // exit tone
      break;
    case 'trailing':
      soundId = 'window-attention'; // breakeven ratchet sound
      break;
    default:
      soundId = 'bell';
  }

  // Non-blocking background execution with paplay / aplay fallback
  const cmd = `canberra-gtk-play -i ${soundId} 2>/dev/null || (aplay /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null) &`;
  try {
    exec(cmd, () => {});
  } catch {}
}
