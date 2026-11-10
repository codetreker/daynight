package session

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTaskHistoryArchiveRetainsRealFileReservation(t *testing.T) {
	f, v, data := archiveFixture(t)
	archiveTerminal(t, f)
	prepareHistoryReads(f)
	status, err := fixtureArchivePut(f, f.s, t.Context(), f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1})
	if err != nil {
		t.Fatal(err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	read := func() (HistoryArchive, error) {
		phase := fixtureArchiveIOPhase(f, t.Context(), true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.TaskArchiveContent(phase, f.p, f.project, f.task, v.SessionID)
	}
	retained, err := read()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(retained.Bytes(), data) || retained.TimelineBytes() != nil {
		t.Fatal("archive bytes changed")
	}
	if _, err = f.s.TryReserveArchivePreflight(); err == nil {
		t.Fatal("archive residency released before response")
	}
	if err = retained.Close(); err != nil {
		t.Fatal(err)
	}
	reservation, err := f.s.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal(err)
	}
	_ = reservation.Close()
	path := "projects/" + f.project + "/" + v.SessionID[:2] + "/" + v.SessionID + "/" + *status.SHA256 + ".json"
	if _, err = f.s.files.Put(t.Context(), archiveBucket, path, strings.NewReader("broken")); err != nil {
		t.Fatal(err)
	}
	if _, err = read(); err == nil {
		t.Fatal("damaged source accepted")
	}
	var failure *model.Fault
	if !errors.As(err, &failure) || failure.Code != "source_corrupt" {
		t.Fatal("damaged source not classified", err)
	}
	if err = f.s.files.Delete(t.Context(), archiveBucket, path); err != nil {
		t.Fatal(err)
	}
	if _, err = read(); err == nil {
		t.Fatal("missing source accepted")
	}
	if !errors.As(err, &failure) || failure.Code != "source_corrupt" {
		t.Fatal("missing source not classified", err)
	}
	reservation, err = f.s.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal("failed reads retained capacity", err)
	}
	_ = reservation.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = f.s.TaskArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	reservation, err = f.s.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal("cancel retained capacity", err)
	}
	_ = reservation.Close()
}
