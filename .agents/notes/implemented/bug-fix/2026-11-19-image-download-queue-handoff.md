# Agent Note: Release the image download slot when the browser receives a download

Status: implemented

## Problem

A Session page serialized image downloads through one page-level queue whose
active job stayed active for the whole 60-second Blob URL retention period. After
the first download had already reached the browser, a second download waited up
to 60 seconds while its button reported that the download was being prepared,
and a third consecutive request could fail as busy. The same retained `download`
lease also kept the store's single foreground download slot occupied, so a
second uncached original could not start its read.

## Decision

The [browser image design](../../../../docs/design/session-image-browser.md#读取缓存容量与下载)
separates read concurrency from URL retention. `ImageDownloadQueue` in
`packages/daynight-web/src/features/task-agent-session/images/image-download.ts`
still runs one download read at a time with at most two waiting requests and a
65-second wait limit. Once a download is triggered, the job leaves the active
slot and the next queued download starts immediately.

A triggered job moves to a retained set that keeps its dedicated URL until the
60-second deadline, access loss, owner close or queue close. The set holds at
most two URLs; triggering a third revokes the oldest early. Before triggering,
the job acquires a `background` lease on the already cached original and then
releases its `download` lease, so the store moves the entry into the background
budget or, when that budget is full, drops the cache entry while the URL alone
holds the Blob.

## Alternatives

**Shorten the URL retention period.** A shorter deadline reduces the wait but
keeps coupling unrelated downloads to a timer and risks revoking a URL before a
slow browser takes over the download.

**Release the download lease without a background lease.** This frees the
foreground slot, but a cached original that fits the background budget would no
longer be charged while its URL is retained.

**Keep unbounded retained URLs.** Rapid consecutive downloads could then pin an
unbounded number of 10 MiB originals for 60 seconds each.

## Consequences

Consecutive downloads on one page start as soon as the previous one reaches the
browser, and only reads that are actually in progress can cause a busy result.
Page-held download Blobs stay bounded by two retained URLs plus the active read.
A Blob retained only by its URL after a full background budget is not charged
to the store budget for up to 60 seconds. Revoking the oldest URL early assumes
the browser has received a download that was triggered before a later one.
