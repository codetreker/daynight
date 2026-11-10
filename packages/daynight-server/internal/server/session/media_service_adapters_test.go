package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type mediaAdapterWriter struct{ t *testing.T }

func (w mediaAdapterWriter) WriteSession(context.Context, func(store.SessionScope) error) (store.Completion, error) {
	w.t.Fatal("closed engine adapter entered the database scope")
	return store.Completion{}, errors.New("unexpected database scope")
}

func TestMediaServiceAdaptersKeepShutdownRefusalAndReleaseReservations(t *testing.T) {
	engine := core.NewEngine(nil)
	svc := service.New(mediaAdapterWriter{t: t}, engine)
	calls := callsFromService(svc)
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	reservation, err := svc.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal(err)
	}
	op, err := calls.BeginHistoryLedgerReserved(t.Context(), "project", "task", "session", core.ActiveHistoryWriter{}, reservation)
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "service_unavailable" || op != (*core.ArchiveOperation)(nil) {
		t.Fatal("history adapter changed shutdown refusal", op, err)
	}
	reservation, err = svc.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal("history adapter leaked preflight capacity", err)
	}
	content, err := calls.ArchiveTimelineContentReserved(t.Context(), model.Principal{}, "project", "task", "session", "file", reservation)
	if !errors.As(err, &refusal) || refusal.Code != "service_unavailable" || content.Data != nil || content.Closer != nil {
		t.Fatal("timeline adapter exposed content after shutdown", content, err)
	}
	reservation, err = svc.TryReserveArchivePreflight()
	if err != nil {
		t.Fatal("timeline adapter leaked preflight capacity", err)
	}
	if err = reservation.Close(); err != nil {
		t.Fatal(err)
	}
}
