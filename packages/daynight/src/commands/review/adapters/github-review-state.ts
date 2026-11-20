import type { PullRequestReviewSnapshot, RemoteReview, RemoteReviewThread } from "../model.js";
import { fullDatabaseId } from "./github-id.js";

export const pullRequestReviewSnapshotQuery = `query PullRequestReviewSnapshot($owner: String!, $name: String!, $number: Int!, $reviewCursor: String, $threadCursor: String) {
  viewer { id }
  repository(owner: $owner, name: $name) {
    fullDatabaseId
    pullRequest(number: $number) {
      number state isDraft headRefOid baseRefName
      reviews(first: 100, after: $reviewCursor) {
        totalCount
        nodes { id author { ... on Node { id } } commit { oid } body state }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100, after: $threadCursor) {
        totalCount
        nodes {
          id isResolved
          comments(first: 1) { totalCount nodes { replyTo { id } pullRequestReview { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const object = (value: unknown, subject: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${subject} must be an object.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, subject: string): string => {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/.test(value)) throw new Error(`${subject} must be nonempty text without control characters.`);
  return value;
};
const count = (value: unknown, subject: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${subject} must be a nonnegative safe integer.`);
  return value;
};
type Page<T> = { totalCount: number; nodes: T[]; cursor: string | null };
const page = <T>(value: unknown, subject: string, parse: (value: unknown) => T): Page<T> => {
  const connection = object(value, subject);
  const totalCount = count(connection.totalCount, `${subject} count`);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 100) throw new Error(`${subject} has an invalid page.`);
  const nodes = connection.nodes.map(parse);
  const info = object(connection.pageInfo, `${subject} page info`);
  if (typeof info.hasNextPage !== "boolean" || (info.endCursor !== null && typeof info.endCursor !== "string")) throw new Error(`${subject} has invalid pagination.`);
  const cursor = info.endCursor === null ? null : text(info.endCursor, `${subject} cursor`);
  if (info.hasNextPage && (cursor === null || nodes.length === 0)) throw new Error(`${subject} has an incomplete page.`);
  return { totalCount, nodes, cursor: info.hasNextPage ? cursor : null };
};
const review = (value: unknown): RemoteReview => {
  const data = object(value, "PR review");
  if (typeof data.body !== "string" || data.body.includes("\0")) throw new Error("PR review has an invalid body.");
  if (data.state !== "APPROVED" && data.state !== "COMMENTED" && data.state !== "CHANGES_REQUESTED" && data.state !== "DISMISSED" && data.state !== "PENDING") throw new Error("PR review has an invalid state.");
  return {
    id: text(data.id, "PR review ID"),
    authorId: data.author === null ? null : text(object(data.author, "PR review author").id, "PR review author ID"),
    headSha: data.commit === null ? null : text(object(data.commit, "PR review commit").oid, "PR review commit SHA"),
    body: data.body, state: data.state,
  };
};
const thread = (value: unknown): RemoteReviewThread => {
  const data = object(value, "PR review thread");
  if (typeof data.isResolved !== "boolean") throw new Error("PR review thread has an invalid resolution flag.");
  const comments = object(data.comments, "PR review thread comments");
  if (count(comments.totalCount, "PR review thread comment count") < 1 || !Array.isArray(comments.nodes) || comments.nodes.length !== 1) throw new Error("PR review thread has no complete root comment.");
  const root = object(comments.nodes[0], "PR review thread root comment");
  if (root.replyTo !== null) throw new Error("PR review thread first comment is not its root comment.");
  return {
    id: text(data.id, "PR review thread ID"), isResolved: data.isResolved,
    reviewId: root.pullRequestReview === null ? null : text(object(root.pullRequestReview, "PR thread review").id, "PR thread review ID"),
  };
};
export type ReviewSnapshotPage = Omit<PullRequestReviewSnapshot, "reviews" | "threads"> & { reviews: Page<RemoteReview>; threads: Page<RemoteReviewThread> };
export const parsePullRequestReviewSnapshot = (value: unknown, repositoryId: string, number: number): ReviewSnapshotPage => {
  const data = object(object(value, "GraphQL response").data, "GraphQL data");
  const repository = object(data.repository, "GitHub repository");
  if (fullDatabaseId(repository.fullDatabaseId) !== repositoryId) throw new Error("GitHub returned a different repository than requested.");
  const pullRequest = object(repository.pullRequest, "PR");
  if (pullRequest.number !== number) throw new Error("GitHub returned a different PR than requested.");
  if (pullRequest.state !== "OPEN" && pullRequest.state !== "CLOSED" && pullRequest.state !== "MERGED") throw new Error("PR has an invalid state.");
  if (typeof pullRequest.isDraft !== "boolean") throw new Error("PR has an invalid Draft flag.");
  return {
    state: pullRequest.state === "OPEN" ? "open" : pullRequest.state === "CLOSED" ? "closed" : "merged",
    draft: pullRequest.isDraft, headSha: text(pullRequest.headRefOid, "PR head SHA"), baseRef: text(pullRequest.baseRefName, "PR base branch"),
    viewerId: text(object(data.viewer, "GitHub viewer").id, "GitHub viewer ID"),
    reviews: page(pullRequest.reviews, "PR reviews", review), threads: page(pullRequest.reviewThreads, "PR review threads", thread),
  };
};

export const reviewSnapshotCollection = <T extends { id: string }>(subject: string) => {
  const nodes = new Map<string, T>();
  const cursors = new Set<string>();
  let totalCount: number | null = null;
  let complete = false;
  let cursor: string | null = null;
  let finalPage: string | null = null;
  return {
    observe: (page: Page<T>): void => {
      if (complete) {
        if (JSON.stringify(page) !== finalPage) throw new Error(`${subject} changed after collection.`);
        return;
      }
      if (totalCount === null) totalCount = page.totalCount;
      else if (totalCount !== page.totalCount) throw new Error(`${subject} count changed during pagination.`);
      for (const node of page.nodes) {
        if (nodes.has(node.id)) throw new Error(`${subject} repeated an ID during pagination.`);
        nodes.set(node.id, node);
      }
      if (nodes.size > totalCount) throw new Error(`${subject} returned more entries than its count.`);
      if (page.cursor === null) {
        if (nodes.size !== totalCount) throw new Error(`${subject} returned an incomplete collection.`);
        complete = true;
        finalPage = JSON.stringify(page);
      } else {
        if (nodes.size === totalCount) throw new Error(`${subject} has a cursor after its complete collection.`);
        if (cursors.has(page.cursor)) throw new Error(`${subject} repeated a cursor.`);
        cursors.add(page.cursor);
        cursor = page.cursor;
      }
    },
    complete: (): boolean => complete,
    cursor: (): string | null => cursor,
    nodes: (): T[] => [...nodes.values()],
  };
};
