const commands = await import(new URL("../../../e2e_tests/src/command.ts", import.meta.url).href) as {
  assertCommandQuiescence(): void;
};
const ownership = await import(new URL("../../../e2e_tests/src/fixture-owner.ts", import.meta.url).href) as {
  initializeRunOwnership(repository: string, runDirectory: string): Promise<void>;
  recoverRunOwnership(options: { repository: string; runDirectory: string; mode: "owner" }): Promise<void>;
};
const recovery = await import(new URL("../../../e2e_tests/src/recovery.ts", import.meta.url).href) as {
  markBuildComplete(runDirectory: string): Promise<void>;
  markEnvironmentComplete(runDirectory: string): Promise<void>;
  completeFailedBuild(runDirectory: string, cancelled: boolean): Promise<boolean>;
  completeFailedEnvironmentSetup(runDirectory: string, browserStopped: boolean, cancelled: boolean): Promise<boolean>;
};

/** Boundaries belong to this runner; independent recovery must wait for its exit. */
export class ExternalImageStages {
  private initialized = false;
  private buildComplete = false;
  private environmentStarted = false;
  private environmentComplete = false;
  private readonly repository: string;
  private readonly runDirectory: string;

  constructor(repository: string, runDirectory: string) {
    this.repository = repository;
    this.runDirectory = runDirectory;
  }

  async initialize(): Promise<void> {
    await ownership.initializeRunOwnership(this.repository, this.runDirectory);
    this.initialized = true;
  }

  async finishBuild(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    commands.assertCommandQuiescence();
    await recovery.markBuildComplete(this.runDirectory);
    this.buildComplete = true;
  }

  beginEnvironment(): void {
    if (!this.buildComplete) throw new Error("Build completion must precede environment setup.");
    this.environmentStarted = true;
  }

  async finishEnvironment(signal: AbortSignal): Promise<void> {
    if (!this.environmentStarted) throw new Error("Environment setup has not started.");
    signal.throwIfAborted();
    commands.assertCommandQuiescence();
    await recovery.markEnvironmentComplete(this.runDirectory);
    this.environmentComplete = true;
  }

  async settleFailure(cancelled: boolean): Promise<void> {
    if (!this.initialized) return;
    if (!this.buildComplete) this.buildComplete = await recovery.completeFailedBuild(this.runDirectory, cancelled);
    if (this.environmentStarted && !this.environmentComplete) {
      // This harness uses joined curl commands, not a Playwright browser.
      this.environmentComplete = await recovery.completeFailedEnvironmentSetup(this.runDirectory, true, cancelled);
    }
  }

  async verifyOwner(): Promise<void> {
    if (!this.initialized || !this.buildComplete) throw new Error("Build process stop is unverified; original resources and evidence are retained.");
    if (this.environmentStarted && !this.environmentComplete) throw new Error("Environment setup process stop is unverified; original resources and evidence are retained.");
    commands.assertCommandQuiescence();
    await ownership.recoverRunOwnership({ repository: this.repository, runDirectory: this.runDirectory, mode: "owner" });
  }
}
