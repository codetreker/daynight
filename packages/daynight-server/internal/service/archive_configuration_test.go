package service

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
)

func TestArchiveConfigurationReachesSharedEngine(t *testing.T) {
	c := config.DefaultConfig()
	c.Session.MaxConcurrent = 3
	c.Session.MaxConcurrentPerOwner = 2
	app := NewModules(c, compositionOnlyStore{}, nil, nil, nil)
	if app.ScopeError != nil {
		t.Fatal(app.ScopeError)
	}
	execution := sessioncore.NewExecution(app.Engine, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	reservations := make([]*sessioncore.ArchivePreflightReservation, 0, 3)
	for range 3 {
		reservation, err := execution.TryReserveArchivePreflight()
		if err != nil {
			t.Fatal(err)
		}
		reservations = append(reservations, reservation)
	}
	if reservation, err := execution.TryReserveArchivePreflight(); err == nil {
		reservation.Close()
		t.Fatal("preflight exceeded configured instance capacity")
	}
	for _, reservation := range reservations {
		if err := reservation.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveConfigurationRejectsInvalidAssembly(t *testing.T) {
	c := config.DefaultConfig()
	c.Session.MaxConcurrentPerOwner = 0
	if app := NewModules(c, compositionOnlyStore{}, nil, nil, nil); app.ScopeError == nil || app.Application != nil {
		t.Fatal("invalid owner capacity reached application assembly")
	}
}
