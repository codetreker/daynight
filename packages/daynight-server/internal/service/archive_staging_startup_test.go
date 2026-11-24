package service

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

type refusingArchiveStorage struct {
	filestorage.Storage
	failure         error
	enabled, closed bool
}

func (s *refusingArchiveStorage) EnableArchiveStaging(_ context.Context, verified bool) error {
	s.enabled = verified
	return s.failure
}
func (s *refusingArchiveStorage) Close() error { s.closed = true; return nil }

func TestArchiveStagingProbeFailureStopsStartupAndClosesStorage(t *testing.T) {
	c := appTestConfig(t)
	c.Storage.ArchiveStagingTopologyVerified = true
	c.Storage.ArchiveUploadV2Enabled = true
	sentinel := errors.New("volume rejected")
	files := &refusingArchiveStorage{failure: sentinel}
	databaseCalled := false
	open := appOpeners{files: func(string) (appStorage, error) { return files, nil }, database: func(context.Context, string) (persistenceBackend, error) {
		databaseCalled = true
		return nil, nil
	}}
	app, err := openApp(context.Background(), c, nil, open)
	if app != nil || !errors.Is(err, sentinel) || !files.enabled || !files.closed || databaseCalled {
		t.Fatalf("startup %v enabled=%v closed=%v database=%v", err, files.enabled, files.closed, databaseCalled)
	}
}
