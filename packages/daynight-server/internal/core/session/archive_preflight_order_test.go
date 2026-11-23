package session

import (
	"context"
	"io"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

type archivePreflightAdmission struct {
	t                *testing.T
	ctx              context.Context
	owner, session   string
	active, returned bool
	calls            []string
}

type archivePreflightAdmissionStorage struct {
	filestorage.Storage
	admission *archivePreflightAdmission
}

func (s archivePreflightAdmissionStorage) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	a := s.admission
	if ctx != a.ctx || a.active || !a.returned {
		a.t.Fatal("residency acquired before the preflight callback returned")
	}
	if owner != a.owner || session != a.session || limit != 1 || cleanup || len(a.calls) != 2 {
		a.t.Fatalf("archive gate owner %q session %q limit %d cleanup %t after %v", owner, session, limit, cleanup, a.calls)
	}
	a.calls = append(a.calls, "residency")
	return archivePreflightAdmissionPermit{admission: a}, nil
}

type archivePreflightAdmissionPermit struct{ admission *archivePreflightAdmission }

func (p archivePreflightAdmissionPermit) Close() error {
	if p.admission.active || len(p.admission.calls) != 3 {
		p.admission.t.Fatal("unexpected archive permit close")
	}
	p.admission.calls = append(p.admission.calls, "permit closed")
	return nil
}

func TestArchivePreflightReturnsBeforeResidencyAcquisition(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	project, task, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	// Project readers can differ from the archive owner; the gate must use the
	// trusted preflight result rather than the requesting principal.
	admission := &archivePreflightAdmission{t: t, ctx: t.Context(), owner: uuid.NewString(), session: id}
	engine := NewEngine(archivePreflightAdmissionStorage{admission: admission})
	execution := &Execution{Engine: engine}
	execution.SetArchivePreflight(func(ctx context.Context, p model.Principal, actualProject, actualTask, actualID string, mode ArchiveMode) (string, error) {
		if ctx != admission.ctx || p != actor || actualProject != project || actualTask != task || actualID != id || mode != ArchiveV1Read || len(admission.calls) != 0 {
			t.Fatal("unexpected archive preflight call")
		}
		admission.active = true
		admission.calls = append(admission.calls, "preflight")
		defer func() {
			admission.active = false
			admission.returned = true
			admission.calls = append(admission.calls, "preflight returned")
		}()
		return admission.owner, nil
	})
	t.Cleanup(func() {
		if err := engine.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	operation, err := execution.BeginArchive(admission.ctx, actor, project, task, id, ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := operation.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := operation.Close(); err != nil {
		t.Fatal(err)
	}
	want := []string{"preflight", "preflight returned", "residency", "permit closed"}
	if !reflect.DeepEqual(admission.calls, want) {
		t.Fatalf("archive admission order %v want %v", admission.calls, want)
	}
}
