import { readConfigurationSource } from "../../config/files.js";
import { parseConfiguration, remoteIdentity } from "./config.js";
import { readReviewListingSnapshot } from "./store.js";
import type { ReviewConfiguration } from "./config.js";
import type { ReviewPaths } from "./paths.js";
import type { PullRequestState, RepositoryIdentity, RepositoryState, ReviewListingSnapshot, ReviewState, ReviewStatus } from "./model.js";

const reviewNames: Record<ReviewStatus, string> = {
  preparing: "Preparing",
  running: "Running",
  retry_wait: "Retry waiting",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  superseded: "Pending",
};
const activeStatuses = new Set<ReviewStatus>(["preparing", "running", "retry_wait", "interrupted"]);
const repositoryKey = ({ host, githubId }: RepositoryIdentity): string => JSON.stringify([host.toLowerCase(), githubId]);
const pullRequestKey = (pullRequest: RepositoryIdentity & { number: number }): string =>
  JSON.stringify([pullRequest.host.toLowerCase(), pullRequest.githubId, pullRequest.number]);
const terminalSafe = (text: string): string => text.replace(
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
const timestamp = (value: number): string => new Date(value).toISOString();

type ListingRow = { columns: string[]; details: string[] };

const reviewDetails = (review: ReviewState, prefix = ""): string[] => {
  const lines: string[] = [];
  if (review.retryAt !== null) lines.push(`${prefix}Retry at: ${timestamp(review.retryAt)}`);
  if (review.lastError !== null) lines.push(`${prefix}Error: ${terminalSafe(review.lastError)}`);
  return lines;
};

const rowFor = (pullRequest: PullRequestState, reviews: readonly ReviewState[]): ListingRow => {
  const ordered = [...reviews].sort((first, second) =>
    first.createdAt - second.createdAt || first.updatedAt - second.updatedAt || first.id.localeCompare(second.id));
  const isCurrent = (review: ReviewState): boolean => review.revision === pullRequest.desiredRevision &&
    review.headSha === pullRequest.headSha && review.baseRef === pullRequest.baseRef;
  const current = ordered.filter(isCurrent).at(-1);
  const previousActive = ordered.filter((review) => !isCurrent(review) && activeStatuses.has(review.status));
  let status = current === undefined ? "Pending" : reviewNames[current.status];
  if (pullRequest.draft) status = "Paused";
  else if (current === undefined && pullRequest.cleanupPending) status = "Pending (cleanup blocked)";
  else if (current === undefined && previousActive.length > 0) {
    status = `Pending (previous revision ${reviewNames[previousActive.at(-1)!.status].toLowerCase()})`;
  }
  const details = current === undefined ? [] : reviewDetails(current);
  if (pullRequest.draft && current !== undefined) details.unshift(`Recorded review: ${reviewNames[current.status]}`);
  if (pullRequest.cleanupPending) {
    details.push("Worktree cleanup: Pending");
    if (pullRequest.cleanupError !== null) details.push(`Cleanup error: ${terminalSafe(pullRequest.cleanupError)}`);
  }
  for (const previous of previousActive) {
    details.push(`Previous revision ${previous.revision}: ${reviewNames[previous.status]}; attempts: ${previous.attemptCount}/${previous.maxAttempts}`);
    details.push(...reviewDetails(previous, "Previous revision "));
  }
  return {
    columns: [`#${pullRequest.number}`, pullRequest.draft ? "Draft" : "Open", status, current === undefined ? "-" : String(current.attemptCount)],
    details,
  };
};

const renderRows = (rows: readonly ListingRow[]): string[] => {
  const headings = ["PR", "PR STATE", "REVIEW", "ATTEMPTS"];
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map(({ columns }) => columns[index]!.length)));
  const line = (columns: readonly string[]): string => columns.map((value, index) =>
    index === columns.length - 1 ? value : value.padEnd(widths[index]!)).join("   ");
  return [line(headings), ...rows.flatMap((row) => [line(row.columns), ...row.details.map((detail) => `  ${detail}`)])];
};

export const formatReviewListing = (
  configuration: ReviewConfiguration,
  snapshot: ReviewListingSnapshot | null,
): string => {
  const configuredCoordinates = new Set(configuration.repositories.map(({ coordinate }) => coordinate));
  const storedByCoordinate = new Map<string, RepositoryState>();
  for (const repository of snapshot?.repositories ?? []) {
    const { coordinate } = remoteIdentity(repository.remote, "Stored repository remote");
    if (!configuredCoordinates.has(coordinate)) continue;
    const previous = storedByCoordinate.get(coordinate);
    if (previous !== undefined && repositoryKey(previous) !== repositoryKey(repository)) {
      throw new Error(`Ambiguous persisted repository identity for ${coordinate}; multiple GitHub repository IDs match the configured remote.`);
    }
    storedByCoordinate.set(coordinate, repository);
  }
  const reviewsByPullRequest = new Map<string, ReviewState[]>();
  for (const review of snapshot?.reviews ?? []) {
    const key = pullRequestKey(review);
    const reviews = reviewsByPullRequest.get(key);
    if (reviews === undefined) reviewsByPullRequest.set(key, [review]);
    else reviews.push(review);
  }
  const groups = configuration.repositories.map(({ coordinate }) => {
    const repository = storedByCoordinate.get(coordinate);
    const lines = [coordinate, `Last observed: ${repository?.lastPollAt === null || repository === undefined ? "never" : timestamp(repository.lastPollAt)}`];
    if (repository?.lastPollError !== null && repository?.lastPollError !== undefined) {
      lines.push(`Last poll error: ${terminalSafe(repository.lastPollError)}`);
    }
    if (repository === undefined || repository.startPrNumber === null || repository.initializedAt === null) {
      lines.push("Not initialized.");
      return lines.join("\n");
    }
    const pullRequests = (snapshot?.pullRequests ?? []).filter((pullRequest) =>
      repositoryKey(pullRequest) === repositoryKey(repository) && pullRequest.state === "open" && pullRequest.number > repository.startPrNumber!)
      .sort((first, second) => first.number - second.number);
    if (pullRequests.length === 0) lines.push("No tracked ongoing PRs.");
    else lines.push("", ...renderRows(pullRequests.map((pullRequest) => rowFor(pullRequest, reviewsByPullRequest.get(pullRequestKey(pullRequest)) ?? []))));
    return lines.join("\n");
  });
  return `Local persisted snapshot (Running means recorded state, not proof of process liveness).\n\n${groups.join("\n\n")}\n`;
};

export const listReviews = async (paths: ReviewPaths): Promise<string> => {
  const source = await readConfigurationSource(paths);
  let configuration: ReviewConfiguration;
  try {
    configuration = parseConfiguration(source, paths);
  } catch (cause) {
    throw new Error(`Invalid configuration file ${paths.configFile}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return formatReviewListing(configuration, readReviewListingSnapshot(paths));
};
