package session

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
	"time"
)

type historyAuthorizationDAO struct {
	store.SessionDAO
	actor    model.Principal
	err      error
	calls    int
	metadata store.ArchiveMetadata
}

func (d *historyAuthorizationDAO) LockCredential(_ context.Context, p model.Principal, _ time.Time) error {
	d.actor = p
	d.calls++
	return d.err
}
func (d *historyAuthorizationDAO) ReadCredential(_ context.Context, p model.Principal, _ time.Time) error {
	d.actor = p
	d.calls++
	return d.err
}
func (d *historyAuthorizationDAO) ProjectAccess(context.Context, string, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, nil
}
func (d *historyAuthorizationDAO) ArchiveMetadata(context.Context, string) (store.ArchiveMetadata, error) {
	return d.metadata, nil
}

type historyAuthorizationScope struct{ dao *historyAuthorizationDAO }

func (s historyAuthorizationScope) SessionDAO() store.SessionDAO { return s.dao }
func (s historyAuthorizationScope) BotDAO() store.BotWriteDAO    { return nil }
func TestTaskHistoryOAuthPurposePreservesActorAndRevocation(t *testing.T) {
	e := NewEngine(nil)
	op, err := e.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	actor := model.Principal{Kind: model.OAuthCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	dao := &historyAuthorizationDAO{}
	scope := historyAuthorizationScope{dao}
	if err = op.LockTaskReadCredential(t.Context(), scope, actor); err != nil || dao.actor != actor || dao.calls != 1 {
		t.Fatalf("actor changed %#v %v", dao.actor, err)
	}
	dao.err = model.ErrNotFound
	if err = op.LockTaskReadCredential(t.Context(), scope, actor); err == nil {
		t.Fatal("revoked OAuth accepted")
	}
	if err = op.LockCredential(t.Context(), scope, actor); err == nil {
		t.Fatal("purpose expanded ordinary credential admission")
	}
	if dao.calls != 2 {
		t.Fatal("ordinary OAuth reached DAO")
	}
	dao.err = errors.New("database failure")
	if !errors.Is(op.LockTaskReadCredential(t.Context(), scope, actor), dao.err) {
		t.Fatal("dependency error lost")
	}
}
func TestTaskArchiveOAuthAdmitsOnlyTaskRead(t *testing.T) {
	e := NewEngine(nil)
	op, _ := e.BeginOperation()
	defer op.Close()
	actor := model.Principal{Kind: model.OAuthCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	dao := &historyAuthorizationDAO{metadata: store.ArchiveMetadata{Owner: "owner", Project: "p", Task: "t", Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}}
	scope := historyAuthorizationScope{dao}
	owner, err := op.ArchivePreflight(t.Context(), scope, actor, "p", "t", "s", ArchiveV1Read)
	if err != nil || owner != "owner" || dao.actor != actor {
		t.Fatalf("Task read refused %s %v", owner, err)
	}
	for _, mode := range []ArchiveMode{ArchiveV1Upload, ArchiveV2Read, ArchiveV2Upload} {
		if _, err = op.ArchivePreflight(t.Context(), scope, actor, "p", "t", "s", mode); err == nil {
			t.Fatalf("purpose expanded to %d", mode)
		}
	}
	if _, err = op.ArchivePreflight(t.Context(), scope, actor, "", "", "s", ArchiveV1Read); err == nil {
		t.Fatal("independent Session accepted OAuth")
	}
	dao.err = model.ErrNotFound
	if _, err = op.ArchivePreflight(t.Context(), scope, actor, "p", "t", "s", ArchiveV1Read); err == nil {
		t.Fatal("revoked archive actor accepted")
	}
}
