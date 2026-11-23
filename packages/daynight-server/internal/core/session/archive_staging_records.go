package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func archiveStagingDAO(dao store.SessionArchiveDAO) (store.SessionArchiveStagingDAO, error) {
	d, ok := dao.(store.SessionArchiveStagingDAO)
	if !ok {
		return nil, errors.New("archive staging registration unavailable")
	}
	return d, nil
}

func stagingBundleFile(v store.ArchiveStagingRecord) store.ArchiveBundleFile {
	return store.ArchiveBundleFile{SessionID: v.SessionID, FileID: v.FileID, Purpose: v.Purpose, SHA256: v.SHA256, State: v.State, Path: v.Path, ByteLength: v.ByteLength, AcceptedOffset: v.TerminalOffset, TimelineRevision: v.TimelineRevision, StagingReleased: v.StagingReleased, Resource: v.Resource, UploadVersion: 2, SuccessorFileID: v.SuccessorFileID, TerminalError: v.TerminalError}
}

// archiveFileAny reads both formats while keeping all legacy mutation methods
// fenced to v1. The caller must not treat a v2 terminal offset as progress.
func archiveFileAny(ctx context.Context, dao store.SessionArchiveDAO, sessionID, fileID string) (store.ArchiveBundleFile, error) {
	if d, ok := dao.(store.SessionArchiveStagingDAO); ok {
		row, err := d.ArchiveStagingRecord(ctx, sessionID, fileID)
		if err == nil {
			return stagingBundleFile(row), nil
		}
		if !errors.Is(err, model.ErrNotFound) {
			return store.ArchiveBundleFile{}, err
		}
	}
	return dao.SessionArchiveFile(ctx, sessionID, fileID)
}

func archiveFilesAny(ctx context.Context, dao store.SessionArchiveDAO, sessionID string) ([]store.ArchiveBundleFile, error) {
	files, err := dao.SessionArchiveFiles(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if d, ok := dao.(store.SessionArchiveStagingDAO); ok {
		rows, e := d.ArchiveStagingRecords(ctx, sessionID)
		if e != nil {
			return nil, e
		}
		for _, row := range rows {
			files = append(files, stagingBundleFile(row))
		}
	}
	return files, nil
}
