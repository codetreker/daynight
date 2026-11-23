package session

import (
	"context"
	"encoding/json"
	"errors"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func archiveResourceInLedger(bundle store.ArchiveBundle, raw json.RawMessage) bool {
	var ledger archiveLedger
	if json.Unmarshal(bundle.Ledger, &ledger) != nil {
		return false
	}
	for _, resource := range ledger.Resources {
		if jsonEqual(raw, encode(resource)) {
			return true
		}
	}
	return false
}

func (op *ArchiveOperation) validateArchiveStreamContent(ctx context.Context, file *store.ArchiveBundleFile, row store.ArchiveStagingRecord, epoch int64, inventoryRequired bool, resource *sp.Resource, content []byte, validateOnly bool) error {
	purpose, fileID := file.Purpose, file.FileID
	var err error
	// Decode and construct the complete candidate outside the Session lock.
	var candidate archiveLedger
	var history sp.ArchiveHistoryContent
	var timeline sp.ArchiveTimeline
	var capturedImages map[string]string
	if purpose == "history" {
		history, err = sp.DecodeArchiveHistory(content)
		if err == nil {
			candidate, err = makeArchiveLedger(history, history.HistoryEpoch, number(history.SourceThrough))
		}
		if err != nil {
			return invalidArchiveFile(err)
		}
		candidate.HistoryID = fileID
		if inventoryRequired {
			capturedImages, err = stoppedCaptureImages(history.Entries)
			if err != nil {
				return err
			}
		}
	} else if purpose == "timeline" {
		timeline, err = sp.DecodeArchiveTimeline(content)
		if err != nil {
			return invalidArchiveFile(err)
		}
	}
	err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		current, e := d.ArchiveStagingRecord(ctx, op.id, row.FileID)
		if e != nil {
			return e
		}
		if current.State != "receiving" || !sameStreamRecord(current, row) {
			return archiveConflict()
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.DeleteEpoch != epoch {
			return conflict()
		}
		if purpose == "history" && bundle.HistoryID != fileID || purpose == "timeline" && (bundle.TimelineID != fileID || bundle.Revision != file.TimelineRevision) || file.UploadVersion == 2 && purpose == "resource" && (file.TimelineRevision < 1 || file.TimelineRevision > bundle.Revision || !archiveResourceInLedger(bundle, file.Resource)) {
			return archiveConflict()
		}
		if purpose == "history" {
			var identity historySourceIdentity
			if len(file.Resource) != 0 && string(file.Resource) != "null" {
				if json.Unmarshal(file.Resource, &identity) != nil || identity.SourceEpoch != sourceEpoch(r) {
					return invalidArchiveFile(archiveConflict())
				}
			} else {
				var prior archiveLedger
				if json.Unmarshal(bundle.Ledger, &prior) != nil || prior.TargetSourceEpoch != "" {
					return invalidArchiveFile(archiveConflict())
				}
			}
			through := r.SourceSeq
			if op.historyWriter != nil {
				through = number(history.SourceThrough)
				if through > r.SourceSeq {
					return invalidArchiveFile(archiveConflict())
				}
			}
			ledger := candidate
			if ledger.ContentPolicy != "" && r.Snapshot.ClaimID == "" || op.historyWriter == nil && len(ledger.OnlineImageOccurrences) != 0 {
				return invalidArchiveFile(archiveConflict())
			}
			ledger.SourceEpoch = sourceEpoch(r)
			if history.HistoryEpoch != r.Snapshot.HistoryEpoch || history.SourceThrough != decimal(through) {
				return invalidArchiveFile(archiveConflict())
			}
			var previous archiveLedger
			if json.Unmarshal(bundle.Ledger, &previous) != nil {
				return archiveConflict()
			}
			if r.HistoryContentPolicy != nil {
				want := *r.HistoryContentPolicy
				if want == "legacy" {
					want = ""
				}
				if (want != "" && want != "task_body") || ledger.ContentPolicy != want {
					return invalidArchiveFile(archiveConflict())
				}
			}
			ledger.StoppedContentPolicy = previous.StoppedContentPolicy
			ledger.WithoutActiveBundle = previous.WithoutActiveBundle
			if previous.WithoutActiveBundle && ((r.HistoryContentPolicy == nil) != (previous.StoppedContentPolicy == "") || r.HistoryContentPolicy != nil && *r.HistoryContentPolicy != previous.StoppedContentPolicy) {
				return invalidArchiveFile(archiveConflict())
			}
			if (previous.StoppedContentPolicy != "") != inventoryRequired {
				return archiveConflict()
			}
			if previous.StoppedContentPolicy != "" {
				if r.HistoryContentPolicy == nil || *r.HistoryContentPolicy != previous.StoppedContentPolicy {
					return invalidArchiveFile(archiveConflict())
				}
				if e = op.execution.verifyStoppedCaptures(ctx, tx, r, ledger, capturedImages); e != nil {
					return e
				}
			}
			if previous.HistoryID != "" {
				if previous.ContentPolicy != ledger.ContentPolicy {
					return invalidArchiveFile(archiveConflict())
				}
				if op.historyWriter != nil {
					for _, old := range previous.OnlineImageOccurrences {
						found := false
						for _, current := range ledger.OnlineImageOccurrences {
							if current.ImageID == old.ImageID {
								found = jsonEqual(encode(old), encode(current))
								break
							}
						}
						if !found {
							return invalidArchiveFile(archiveConflict())
						}
					}
				}
				if op.historyWriter != nil {
					e = verifySourceHistoryAdvance(previous, ledger)
				} else if op.historyWriter == nil && previous.FinalSourceThrough != "" {
					e = verifySourceHistoryAdvance(previous, ledger)
				} else if op.historyWriter == nil && file.TimelineRevision > 1 {
					e = verifyArchiveHistoryAdvance(previous, ledger)
				}
				if e != nil {
					return invalidArchiveFile(e)
				}
			}
			if !validateOnly && op.historyWriter == nil && previous.ContentPolicy == "task_body" {
				if e = op.execution.retireOnlineImageReferences(ctx, tx, r, previous.OnlineImageOccurrences, ledger.Resources); e != nil {
					return e
				}
			}
			if e = checkContentPublication(ctx, tx, op.id, historyContentChange{ledger}); e != nil {
				return archiveContentFailure(e)
			}
			bundle.Ledger = encode(ledger)
			if !validateOnly {
				if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
					return e
				}
			}
		} else if purpose == "resource" {
			if e = checkContentPublication(ctx, tx, op.id, resourceContentChange{*resource}); e != nil {
				return archiveContentFailure(e)
			}
			if !validateOnly {
				if e = media.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: op.id, Resource: *resource, BlobID: fileID, BlobPath: file.Path, MigrationID: fileID}); e != nil {
					return e
				}
			}
		} else {
			var ledger archiveLedger
			if json.Unmarshal(bundle.Ledger, &ledger) != nil {
				return errors.New("invalid persisted archive ledger")
			}
			if e = verifyArchiveLedger(ledger, timeline); e != nil {
				return invalidArchiveFile(e)
			}
		}
		if validateOnly {
			return nil
		}
		ok, e := d.FinishArchiveStaging(ctx, row, "complete", row.ByteLength, nil)
		if e != nil {
			return e
		}
		if !ok {
			return archiveConflict()
		}
		file.State = "complete"
		file.AcceptedOffset = row.ByteLength
		return nil
	})
	if err != nil {
		return err
	}
	return nil
}
