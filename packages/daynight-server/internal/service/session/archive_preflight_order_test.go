package session

import (
	"context"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archivePreflightOrder struct {
	t                                            *testing.T
	ctx                                          context.Context
	actor                                        model.Principal
	project, task, id, owner                     string
	active, callbackReturned, completionReturned bool
	calls                                        []string
}

func (o *archivePreflightOrder) inside(ctx context.Context, name string) {
	o.t.Helper()
	if ctx != o.ctx || !o.active || o.callbackReturned || o.completionReturned {
		o.t.Fatalf("%s escaped the preflight callback", name)
	}
	want := []string{"writer", "credential", "project", "metadata"}
	if len(o.calls) >= len(want) || want[len(o.calls)] != name {
		o.t.Fatalf("preflight call %s after %v", name, o.calls)
	}
	o.calls = append(o.calls, name)
}

type archivePreflightOrderDAO struct {
	store.SessionDAO
	order *archivePreflightOrder
}

func (d archivePreflightOrderDAO) ReadCredential(ctx context.Context, actor model.Principal, now time.Time) error {
	d.order.inside(ctx, "credential")
	if actor != d.order.actor || now.IsZero() {
		d.order.t.Fatalf("preflight credential %+v at %s", actor, now)
	}
	return nil
}
func (d archivePreflightOrderDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.order.inside(ctx, "project")
	if user != d.order.actor.UserID || project != d.order.project {
		d.order.t.Fatalf("preflight Project access %s/%s", user, project)
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectMemberRole}, nil
}
func (d archivePreflightOrderDAO) ArchiveMetadata(ctx context.Context, id string) (store.ArchiveMetadata, error) {
	d.order.inside(ctx, "metadata")
	if id != d.order.id {
		d.order.t.Fatalf("preflight Session %s", id)
	}
	return store.ArchiveMetadata{Owner: d.order.owner, Project: d.order.project, Task: d.order.task, Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}, nil
}

type archivePreflightOrderScope struct {
	store.SessionScope
	dao archivePreflightOrderDAO
}

func (s archivePreflightOrderScope) SessionDAO() store.SessionDAO {
	if !s.dao.order.active || s.dao.order.callbackReturned {
		s.dao.order.t.Fatal("DAO requested after preflight scope returned")
	}
	return s.dao
}

type archivePreflightOrderWriter struct{ order *archivePreflightOrder }

func (w archivePreflightOrderWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	o := w.order
	if ctx != o.ctx || len(o.calls) != 0 || o.active || o.completionReturned {
		o.t.Fatal("unexpected preflight writer call")
	}
	o.active = true
	o.calls = append(o.calls, "writer")
	defer func() {
		o.active = false
		o.completionReturned = true
		o.calls = append(o.calls, "completion returned")
	}()
	err := work(archivePreflightOrderScope{dao: archivePreflightOrderDAO{order: o}})
	o.callbackReturned = true
	o.calls = append(o.calls, "callback returned")
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type archivePreflightOrderStorage struct {
	filestorage.Storage
	order *archivePreflightOrder
}

func (s archivePreflightOrderStorage) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	o := s.order
	if ctx != o.ctx || o.active || !o.callbackReturned || !o.completionReturned {
		o.t.Fatal("residency acquired before preflight callback and completion returned")
	}
	if key != "session/archive/owner/"+o.owner || len(o.calls) != 6 {
		o.t.Fatalf("residency key %q after %v", key, o.calls)
	}
	o.calls = append(o.calls, "residency")
	return archivePreflightOrderPermit{order: o}, nil
}

type archivePreflightOrderPermit struct{ order *archivePreflightOrder }

func (p archivePreflightOrderPermit) Close() error {
	if p.order.active || len(p.order.calls) != 7 {
		p.order.t.Fatal("unexpected residency permit close")
	}
	p.order.calls = append(p.order.calls, "permit closed")
	return nil
}

func TestArchivePreflightReturnsTransactionBeforeResidency(t *testing.T) {
	// Project readers can differ from the archive owner; permit identity must
	// come from trusted metadata rather than the requesting principal.
	order := &archivePreflightOrder{t: t, ctx: t.Context(), actor: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, project: uuid.NewString(), task: uuid.NewString(), id: uuid.NewString(), owner: uuid.NewString()}
	engine := core.NewEngine(archivePreflightOrderStorage{order: order})
	service := New(archivePreflightOrderWriter{order: order}, engine)
	t.Cleanup(func() {
		if err := engine.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	operation, err := service.BeginArchive(order.ctx, order.actor, order.project, order.task, order.id, core.ArchiveV1Read)
	if err != nil {
		t.Fatal(err)
	}
	if err := operation.Close(); err != nil {
		t.Fatal(err)
	}
	want := []string{"writer", "credential", "project", "metadata", "callback returned", "completion returned", "residency", "permit closed"}
	if !reflect.DeepEqual(order.calls, want) {
		t.Fatalf("archive admission order %v want %v", order.calls, want)
	}
}
