package session

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type historyAuthorizationDAO struct {
	store.SessionDAO
	actor      model.Principal
	err        error
	calls      int
	oauthLocks int
	oauthReads int
	binding    store.OAuthBinding
	bindings   []store.OAuthBinding
	metadata   store.ArchiveMetadata
}

func (d *historyAuthorizationDAO) LockCredential(_ context.Context, p model.Principal, _ time.Time) error {
	d.actor = p
	d.calls++
	return d.err
}
func (d *historyAuthorizationDAO) ReadCredential(ctx context.Context, p model.Principal, now time.Time) error {
	return d.LockCredential(ctx, p, now)
}
func (d *historyAuthorizationDAO) LockOAuthCredential(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	d.oauthLocks++
	return d.oauthCredential(ctx, p, bindings, now)
}
func (d *historyAuthorizationDAO) oauthCredential(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	d.bindings = slices.Clone(bindings)
	if err := d.LockCredential(ctx, p, now); err != nil {
		return err
	}
	for _, binding := range bindings {
		if binding.Resource == d.binding.Resource && binding.Scope == d.binding.Scope && (binding.ClientID == "" || binding.ClientID == d.binding.ClientID) {
			return nil
		}
	}
	return model.ErrNotFound
}
func (d *historyAuthorizationDAO) ReadOAuthCredential(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) error {
	d.oauthReads++
	return d.oauthCredential(ctx, p, bindings, now)
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

func TestTaskReadCredentialRetainsNativeAuthorization(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			e := NewEngine(nil)
			op, err := e.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			actor := model.Principal{Kind: kind, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
			dao := &historyAuthorizationDAO{}
			scope := historyAuthorizationScope{dao}
			if err = op.LockTaskReadCredential(t.Context(), scope, actor); err != nil || dao.actor != actor || dao.calls != 1 || dao.oauthLocks != 0 {
				t.Fatalf("native admission=%v actor=%#v calls=%d OAuth locks=%d", err, dao.actor, dao.calls, dao.oauthLocks)
			}
			dao.err = fmt.Errorf("credential read: %w", model.ErrNotFound)
			err = op.LockTaskReadCredential(t.Context(), scope, actor)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" || dao.calls != 2 {
				t.Fatalf("revoked native credential admitted: calls=%d err=%v", dao.calls, err)
			}
			storageErr := errors.New("credential storage unavailable")
			dao.err = fmt.Errorf("credential read: %w", storageErr)
			if err = op.LockTaskReadCredential(t.Context(), scope, actor); !errors.Is(err, storageErr) || dao.calls != 3 {
				t.Fatalf("credential failure lost: calls=%d err=%v", dao.calls, err)
			}
		})
	}
}

func TestTaskReadCredentialRejectsInvalidActorBeforeDAO(t *testing.T) {
	valid := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	for _, actor := range []model.Principal{{}, {Kind: valid.Kind, UserID: valid.UserID}, {Kind: valid.Kind, CredentialID: valid.CredentialID}, {Kind: "unsupported", UserID: valid.UserID, CredentialID: valid.CredentialID}, {Kind: valid.Kind, UserID: "invalid", CredentialID: valid.CredentialID}, {Kind: valid.Kind, UserID: valid.UserID, CredentialID: "invalid"}} {
		t.Run(string(actor.Kind)+actor.UserID+actor.CredentialID, func(t *testing.T) {
			e := NewEngine(nil)
			op, err := e.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			dao := &historyAuthorizationDAO{}
			err = op.LockTaskReadCredential(t.Context(), historyAuthorizationScope{dao}, actor)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" || dao.calls != 0 || dao.oauthLocks != 0 {
				t.Fatalf("invalid actor reached DAO: calls=%d OAuth locks=%d err=%v", dao.calls, dao.oauthLocks, err)
			}
		})
	}
}

func TestOAuthPurposeChecksFixedFamilyAndPreservesActor(t *testing.T) {
	api := store.OAuthBinding{Resource: "https://daynight.test/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}
	mcp := store.OAuthBinding{Resource: "https://daynight.test/mcp", Scope: oauth.Scope, ClientID: "recorded-mcp-client"}
	for _, binding := range []store.OAuthBinding{api, mcp, {Resource: api.Resource, Scope: api.Scope, ClientID: "other"}, {Resource: mcp.Resource, Scope: api.Scope, ClientID: api.ClientID}} {
		for _, purpose := range []BrowserPurpose{BrowserAccess, TaskMessageAccess, TaskReceiptAccess} {
			t.Run(binding.Resource+binding.Scope+binding.ClientID+string(rune('0'+purpose)), func(t *testing.T) {
				e := NewEngine(nil)
				e.Origin = "https://daynight.test"
				op, err := e.BeginOperation()
				if err != nil {
					t.Fatal(err)
				}
				defer op.Close()
				actor := model.Principal{Kind: model.OAuthCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
				dao := &historyAuthorizationDAO{binding: binding}
				scope := historyAuthorizationScope{dao}
				err = op.LockPurposeCredential(t.Context(), scope, actor, purpose)
				allowed := binding == api || binding == mcp && purpose != BrowserAccess
				if (err == nil) != allowed || dao.actor != actor || dao.calls != 1 {
					t.Fatalf("admission=%v actor=%#v calls=%d", err, dao.actor, dao.calls)
				}
				if dao.bindings[0] != api || len(dao.bindings) != map[bool]int{true: 2, false: 1}[purpose != BrowserAccess] {
					t.Fatalf("bindings=%+v", dao.bindings)
				}
				dao.err = model.ErrNotFound
				if err = op.LockPurposeCredential(t.Context(), scope, actor, purpose); err == nil {
					t.Fatal("revoked actor admitted")
				}
				dao.err = errors.New("database failure")
				if !errors.Is(op.LockPurposeCredential(t.Context(), scope, actor, purpose), dao.err) {
					t.Fatal("dependency error lost")
				}
				dao.err = nil
				err = op.LockTaskReadCredential(t.Context(), scope, actor)
				if (err == nil) != (binding == api || binding == mcp) {
					t.Fatalf("Task read admission=%v", err)
				}
			})
		}
	}
}

func TestArchiveOAuthReadPurposesRetainOwnerAndProducerRestrictions(t *testing.T) {
	for _, profile := range []string{"api", "mcp"} {
		for _, independent := range []bool{false, true} {
			for _, mode := range []ArchiveMode{ArchiveV1Read, ArchiveV2Read, ArchiveV1Upload, ArchiveV2Upload} {
				t.Run(profile+string(rune('0'+mode))+map[bool]string{true: "independent", false: "task"}[independent], func(t *testing.T) {
					e := NewEngine(nil)
					op, _ := e.BeginOperation()
					defer op.Close()
					actor := model.Principal{Kind: model.OAuthCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
					dao := &historyAuthorizationDAO{binding: store.OAuthBinding{Resource: "/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}, metadata: store.ArchiveMetadata{Owner: actor.UserID, Project: "p", Task: "t", Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}}
					if profile == "mcp" {
						dao.binding = store.OAuthBinding{Resource: "/mcp", Scope: oauth.Scope}
					}
					project, task := "p", "t"
					if independent {
						project, task = "", ""
						dao.metadata.Project, dao.metadata.Task, dao.metadata.Test = "", "", true
					}
					if mode == ArchiveV2Read || mode == ArchiveV2Upload {
						dao.metadata.Backend = "herdr"
					}
					scope := historyAuthorizationScope{dao}
					owner, err := op.ArchivePreflight(t.Context(), scope, actor, project, task, "s", mode)
					allowed := (mode == ArchiveV1Read || mode == ArchiveV2Read) && (profile == "api" || !independent && mode == ArchiveV1Read)
					if (err == nil) != allowed || err == nil && owner != actor.UserID {
						t.Fatalf("owner=%s admission=%v", owner, err)
					}
					if dao.oauthLocks != 0 {
						t.Fatal("archive preflight locked OAuth family")
					}
					if !allowed {
						return
					}
					if dao.oauthReads != 1 {
						t.Fatalf("OAuth reads=%d", dao.oauthReads)
					}
					dao.err = model.ErrNotFound
					if _, err = op.ArchivePreflight(t.Context(), scope, actor, project, task, "s", mode); err == nil {
						t.Fatal("revoked archive actor admitted")
					}
					dao.err = nil
					if independent {
						actor.UserID = "other"
						if _, err = op.ArchivePreflight(t.Context(), scope, actor, project, task, "s", mode); err == nil {
							t.Fatal("non-owner admitted")
						}
					}
				})
			}
		}
	}
}
