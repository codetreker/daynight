import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';

// Keep the directory open until the connection finishes: the fd path remains
// short even when the checkout's absolute path exceeds the Unix socket limit.
export async function recoveryControl(privateDirectory: string, operation: string): Promise<Record<string, unknown>> {
  const directory = await open(privateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(`/proc/self/fd/${directory.fd}/control.sock`); let data = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Recovery control timed out.')); }, 10_000);
      socket.once('connect', () => socket.write(`${operation}\n`));
      socket.on('data', chunk => { data += chunk.toString(); if (data.length > 32768) socket.destroy(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('end', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(data) as Record<string, unknown>;
          if (result.error) reject(new Error('Recovery control refused.')); else resolve(result);
        } catch (error) { reject(error); }
      });
    });
  } finally { await directory.close(); }
}
