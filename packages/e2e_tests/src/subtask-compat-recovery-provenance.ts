type Combination = {
  status?: string;
  cleanup?: { completed?: boolean };
  combination?: { server?: string; baseline?: string };
  artifacts?: { sourceRevision?: string; sourceFingerprint?: string; hashes?: { server?: string } };
  selectedArtifacts?: { server?: string };
};

export const verifyCandidateCombination = (input: {
  manifest: unknown; candidate: string; baseline: string; sha256: string; sourceFingerprint: string;
}): void => {
  const { candidate, baseline, sha256, sourceFingerprint } = input;
  if (!/^[a-f0-9]{64}$/.test(sha256) || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error('Shared candidate digest is invalid.');
  if (typeof input.manifest !== 'object' || input.manifest === null || Array.isArray(input.manifest)) throw new Error('Shared candidate combination provenance mismatch.');
  const manifest = input.manifest as Combination;
  if (manifest.status !== 'passed' || manifest.cleanup?.completed !== true || manifest.combination?.server !== 'candidate' || manifest.combination.baseline !== baseline ||
    manifest.artifacts?.sourceRevision !== candidate || manifest.artifacts.sourceFingerprint !== sourceFingerprint || manifest.artifacts.hashes?.server !== sha256 ||
    manifest.selectedArtifacts?.server !== sha256) throw new Error('Shared candidate combination provenance mismatch.');
};

export const verifyRepairArtifact = (input: {
  revision: string; expectedSHA256: string; suppliedSHA256: string; copiedSHA256: string; reproducedSHA256: string; buildInfo: string;
}): void => {
  if (!/^[a-f0-9]{40}$/.test(input.revision) || !/^[a-f0-9]{64}$/.test(input.expectedSHA256) ||
    input.suppliedSHA256 !== input.expectedSHA256 || input.copiedSHA256 !== input.expectedSHA256 || input.reproducedSHA256 !== input.expectedSHA256 ||
    !input.buildInfo.includes('\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n') ||
    !input.buildInfo.includes(`\tbuild\tvcs.revision=${input.revision}\n`) || !input.buildInfo.includes('\tbuild\tvcs.modified=false\n') ||
    !input.buildInfo.includes('\tbuild\t-trimpath=true\n') || !input.buildInfo.includes('\tbuild\tCGO_ENABLED=0\n') || !/: go1\.27\.2\n/.test(input.buildInfo) || /^\t=>/m.test(input.buildInfo)) {
    throw new Error('Repair artifact provenance or reproducible build mismatch.');
  }
};

// The registry probe runs with ordinary production build tags and toolchain.
// Reject settings that could make the handed-off binary select different code.
export const verifyCandidateBuild = (input: { revision: string; architecture: 'amd64' | 'arm64'; buildInfo: string }): void => {
  const settings = new Map<string, string>();
  for (const match of input.buildInfo.matchAll(/^\tbuild\t([^=]+)=(.*)$/gm)) {
    if (settings.has(match[1]!)) throw new Error('Candidate build settings are ambiguous.');
    settings.set(match[1]!, match[2]!);
  }
  const allowed = new Set(['-buildmode', '-compiler', '-trimpath', 'CGO_ENABLED', 'GOARCH', 'GOOS', input.architecture === 'amd64' ? 'GOAMD64' : 'GOARM64', 'vcs', 'vcs.revision', 'vcs.time', 'vcs.modified']);
  if (!/^[a-f0-9]{40}$/.test(input.revision) || !/: go1\.27\.2\n/.test(input.buildInfo) ||
    !input.buildInfo.includes('\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n') || /^\t=>/m.test(input.buildInfo) ||
    [...settings.keys()].some(key => !allowed.has(key)) || settings.get('-buildmode') !== 'exe' || settings.get('-compiler') !== 'gc' ||
    settings.get('-trimpath') !== 'true' || settings.get('CGO_ENABLED') !== '0' || settings.get('GOOS') !== 'linux' || settings.get('GOARCH') !== input.architecture ||
    settings.get(input.architecture === 'amd64' ? 'GOAMD64' : 'GOARM64') !== (input.architecture === 'amd64' ? 'v1' : 'v8.0') ||
    settings.get('vcs') !== 'git' || settings.get('vcs.revision') !== input.revision || !['true', 'false'].includes(settings.get('vcs.modified') ?? '') || !settings.get('vcs.time')) {
    throw new Error('Candidate artifact build settings do not match registry extraction.');
  }
};

export const fallbackBaseline = '12ebdd08f63c9e09f64937b096d4f9390987be7a';
export const fallbackPatchSHA256 = '9b852ff6c1a076840774c50bdd99cbdb2f633b1df87e4a6ec186d46bd6db49c4';

// A fallback is a patched baseline, not the original binary. Compare independent
// production builds and their embedded Web trees before starting either artifact.
export const verifyFallbackArtifact = (input: {
  baseline: string; patchSHA256: string; baselineLedgerSHA256: string; fallbackLedgerSHA256: string;
  webSHA256: string; reproducedWebSHA256: string; serverSHA256: string; reproducedServerSHA256: string; buildInfo: string;
}): void => {
  const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
  if (input.baseline !== fallbackBaseline || input.patchSHA256 !== fallbackPatchSHA256 ||
    !digest(input.baselineLedgerSHA256) || input.baselineLedgerSHA256 !== input.fallbackLedgerSHA256 ||
    !digest(input.webSHA256) || input.webSHA256 !== input.reproducedWebSHA256 ||
    !digest(input.serverSHA256) || input.serverSHA256 !== input.reproducedServerSHA256 ||
    !input.buildInfo.includes('\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n') ||
    !input.buildInfo.includes(`\tbuild\tvcs.revision=${fallbackBaseline}\n`) || !input.buildInfo.includes('\tbuild\tvcs.modified=true\n') ||
    !input.buildInfo.includes('\tbuild\t-trimpath=true\n') || !input.buildInfo.includes('\tbuild\tCGO_ENABLED=0\n') ||
    !/: go1\.27\.2\n/.test(input.buildInfo) || /^\t=>/m.test(input.buildInfo)) {
    throw new Error('Fallback artifact provenance or reproducible build mismatch.');
  }
};
