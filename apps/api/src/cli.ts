/**
 * Server-side fallback for the agent console's switch.
 *
 *   fisika status
 *   fisika pause  [all|celo|bsc]     (default: all)
 *   fisika resume [all|celo|bsc]
 *
 * Writes the same control file the console and the traders use, so a change here shows in the console and takes
 * effect before the next trade. Pausing never interrupts a loop already under way; it finishes first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chainTrades, defaultControlFile, readControl, setControl, SWITCH_CHAINS, type ControlTarget } from './agent/control.ts';

const [cmd = 'status', arg = 'all'] = process.argv.slice(2);
const file = defaultControlFile();
const who = `cli:${process.env.SUDO_USER || process.env.USER || 'root'}`;
const statusFile = (c: string) => (c === 'celo' ? '/var/lib/fisika/live-status.json' : c === 'solana' ? '/var/lib/fisika/meme/meme-status.json' : `/var/lib/fisika/${c}/live-status.json`);

async function show() {
  const s = await readControl(file);
  console.log(`agent: ${s.active ? 'ACTIVE' : 'PAUSED'}${s.updatedAt ? `  (last change ${s.updatedAt} by ${s.by})` : '  (never switched on)'}`);
  for (const c of SWITCH_CHAINS) {
    let live = 'trader not running';
    const f = process.env[`LIVE_STATUS_FILE_${c.toUpperCase()}`] ?? statusFile(c);
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { updatedAt: string; inFlight?: boolean };
        const age = Math.round((Date.now() - Date.parse(j.updatedAt)) / 1000);
        live = age > 90 ? `trader silent for ${age}s` : j.inFlight ? 'trade in flight' : 'trader running';
      } catch {
        /* unreadable */
      }
    }
    console.log(`  ${(c === 'solana' ? 'meme' : c).padEnd(5)} switch ${s.chains[c] ? 'on ' : 'off'} -> ${chainTrades(s, c) ? 'trading' : 'paused'}  · ${live}`);
  }
}

if (cmd === 'status') await show();
else if (cmd === 'pause' || cmd === 'resume') {
  if (!['all', ...SWITCH_CHAINS].includes(arg)) {
    console.error(`usage: fisika ${cmd} [all|${SWITCH_CHAINS.join('|')}]   (solana = meme desk)`);
    process.exit(2);
  }
  const active = cmd === 'resume';
  // Resuming one chain while the global switch is off would do nothing; turn both on.
  if (active && arg !== 'all' && !(await readControl(file)).active) await setControl(file, 'all', true, who);
  await setControl(file, arg as ControlTarget, active, who);
  if (!active) console.log('Paused. A loop already under way finishes first; nothing new starts.');
  await show();
} else {
  console.error('usage: fisika status | pause [all|celo|bsc|solana] | resume [all|celo|bsc|solana]   (solana = meme desk)');
  process.exit(2);
}
