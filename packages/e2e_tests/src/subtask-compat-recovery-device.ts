export type DeviceInstructions = { uri: string; code: string };

// The CLI writes device instructions to stderr. Keep each stream independently
// so chunk boundaries and unrelated messages cannot join two partial lines.
export const deviceInstructionReader = (publish: (instructions: DeviceInstructions) => void) => {
  const streams = { stdout: '', stderr: '' };
  let published = false;
  return (channel: 'stdout' | 'stderr', chunk: string): void => {
    if (published) return;
    streams[channel] = (streams[channel] + chunk).slice(-262144);
    const text = streams[channel];
    const uri = text.match(/^Open (\S+)\r?\n/m)?.[1];
    const code = text.match(/^Enter code: (\S+)\r?\n/m)?.[1];
    if (uri && code) { published = true; publish({ uri, code }); }
  };
};
