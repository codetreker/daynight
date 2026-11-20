package github

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type adminRecheckDAO struct {
	adminServiceDAO
	current                 model.CredentialAuthorization
	currentErr              error
	members, adds, consumes int
}

func (d *adminRecheckDAO) CurrentAdminAuthorization(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	return d.current, d.currentErr
}
func (d *adminRecheckDAO) Membership(_ context.Context, app, user string) (githubpr.AdminMembership, error) {
	d.members++
	return githubpr.AdminMembership{AppID: app, UserID: user, Version: 1}, nil
}
func (d *adminRecheckDAO) AddAdmin(context.Context, string, string) (githubpr.AdminMembership, error) {
	d.adds++
	return githubpr.AdminMembership{}, nil
}
func (d *adminRecheckDAO) ConsumeInvitation(context.Context, string, string, string, time.Time) error {
	d.consumes++
	return nil
}

func TestAcceptAdminRechecksScopeAfterLookupBeforeExistingReceipt(t *testing.T) {
	initial := adminPolicy(t, "github:manage", "github:read")
	current := adminPolicy(t, "github:read")
	dao := &adminRecheckDAO{current: initial}
	entered, release := make(chan struct{}), make(chan struct{})
	storeFixture := adminStoreTest{
		read: func(_ context.Context, f func(store.GitHubAppAdminReader) error) error { return f(dao) },
		write: func(ctx context.Context, _ string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return store.Completion{}, ctx.Err()
			}
			if err := f(dao); err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		},
	}
	result := make(chan error, 1)
	go func() {
		_, err := NewAdminManager(storeFixture).AcceptAdminInvitationAuthorized(t.Context(), initial, secretutil.Random("dn_gai_"), initial.Principal.UserID)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("final transaction did not start")
	}
	dao.current = current
	close(release)
	select {
	case err := <-result:
		scopeFault(t, err, "insufficient_scope")
	case <-time.After(5 * time.Second):
		t.Fatal("accept did not finish")
	}
	if dao.members != 0 || dao.adds != 0 || dao.consumes != 0 {
		t.Fatalf("membership=%d adds=%d consumes=%d", dao.members, dao.adds, dao.consumes)
	}
}

func TestAcceptAdminRequiresTransactionRecheckCapability(t *testing.T) {
	initial := adminPolicy(t, "github:manage", "github:read")
	type missingRecheck struct {
		store.GitHubAppAdminWriter
		store.GitHubAppAdminVisibilityDAO
	}
	original := adminServiceDAO{}
	dao := missingRecheck{GitHubAppAdminWriter: original, GitHubAppAdminVisibilityDAO: original}
	s := adminStoreTest{
		read: func(_ context.Context, f func(store.GitHubAppAdminReader) error) error { return f(dao) },
		write: func(_ context.Context, _ string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
			err := f(dao)
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		},
	}
	if _, err := NewAdminManager(s).AcceptAdminInvitationAuthorized(t.Context(), initial, secretutil.Random("dn_gai_"), initial.Principal.UserID); err == nil {
		t.Fatal("missing recheck accepted")
	}
}

func TestAcceptAdminCurrentCredentialFailurePrecedesMissingScope(t *testing.T) {
	auth := adminPolicy(t, "github:read")
	dao := &adminRecheckDAO{currentErr: model.Unauthenticated(nil)}
	s := adminStoreTest{
		read: func(_ context.Context, f func(store.GitHubAppAdminReader) error) error { return f(dao) },
		write: func(_ context.Context, _ string, f func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
			err := f(dao)
			return store.Completion{Outcome: store.TransactionCommitted}, err
		},
	}
	_, err := NewAdminManager(s).AcceptAdminInvitationAuthorized(t.Context(), auth, secretutil.Random("dn_gai_"), auth.Principal.UserID)
	scopeFault(t, err, "unauthenticated")
	if dao.members != 0 || dao.adds != 0 || dao.consumes != 0 {
		t.Fatal("business operation proceeded")
	}
}
