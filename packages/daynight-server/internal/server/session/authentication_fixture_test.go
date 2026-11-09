package session_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type routeCredential struct {
	token     string
	hash      []byte
	principal model.Principal
	err       error
}

type routeAuthentication struct {
	Authentication *authhttp.Authentication
	OnFailure      func(error)
	t              *testing.T
	mu             sync.Mutex
	credentials    []routeCredential
	calls          int
}

func newRouteAuthentication(t *testing.T, origin string) *routeAuthentication {
	t.Helper()
	fixture := &routeAuthentication{t: t}
	identity := identityservice.New(fixture, nil, origin+"/api/v1/auth/callback")
	authentication, err := authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: strings.HasPrefix(origin, "http://")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	fixture.Authentication = authentication
	return fixture
}

func (f *routeAuthentication) Credential(principal model.Principal) string {
	f.t.Helper()
	if principal.UserID == "" || principal.CredentialID == "" {
		f.t.Fatal("authentication reply needs supplied user and credential IDs")
	}
	var prefix string
	switch principal.Kind {
	case model.PATCredential:
		prefix = "dnpat_"
	case model.SessionCredential:
		prefix = "dnst_"
	default:
		f.t.Fatalf("unsupported authentication fixture credential kind %q", principal.Kind)
	}
	token := secret.Random(prefix)
	f.mu.Lock()
	f.credentials = append(f.credentials, routeCredential{token: token, hash: secret.Hash(token), principal: principal})
	f.mu.Unlock()
	return token
}

func (f *routeAuthentication) RejectCredential(token string, cause error) {
	f.t.Helper()
	if cause == nil {
		f.t.Fatal("rejected authentication reply needs an error")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for index, credential := range f.credentials {
		if credential.token == token {
			f.credentials[index].err = cause
			return
		}
	}
	f.t.Fatal("authentication rejection targeted an unconfigured credential")
}

func (f *routeAuthentication) Count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *routeAuthentication) failure(method string) error {
	cause := fmt.Errorf("unexpected authentication fixture call %s", method)
	f.t.Error(cause)
	if f.OnFailure != nil {
		f.OnFailure(cause)
	}
	return cause
}

func (f *routeAuthentication) WriteIdentity(ctx context.Context, work func(store.IdentityScope) error) (store.Completion, error) {
	if err := ctx.Err(); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	scope := &routeIdentityScope{fixture: f}
	scope.dao = &routeIdentityDAO{scope: scope}
	scope.personal = &routePersonalTeamDAO{scope: scope}
	err := work(scope)
	scope.mu.Lock()
	calls := scope.dao.calls
	scope.closed = true
	scope.mu.Unlock()
	if calls != 1 {
		err = errors.Join(err, f.failure("Authenticate count"))
	}
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type routeIdentityScope struct {
	mu       sync.Mutex
	fixture  *routeAuthentication
	dao      *routeIdentityDAO
	personal *routePersonalTeamDAO
	closed   bool
}

func (s *routeIdentityScope) IdentityDAO() store.IdentityDAO { return s.dao }
func (s *routeIdentityScope) PersonalTeamDAO() store.PersonalTeamDAO {
	_ = s.fixture.failure("PersonalTeamDAO")
	return s.personal
}

type routeIdentityDAO struct {
	scope *routeIdentityScope
	calls int
}

func (d *routeIdentityDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	d.scope.mu.Lock()
	d.calls++
	unexpected := d.scope.closed || d.calls != 1
	d.scope.mu.Unlock()
	if unexpected {
		return model.Principal{}, d.scope.fixture.failure("Authenticate")
	}
	if err := ctx.Err(); err != nil {
		return model.Principal{}, err
	}
	if now.IsZero() || len(hash) != 32 {
		return model.Principal{}, d.scope.fixture.failure("Authenticate arguments")
	}
	fixture := d.scope.fixture
	fixture.mu.Lock()
	fixture.calls++
	for _, credential := range fixture.credentials {
		if credential.principal.Kind == kind && bytes.Equal(credential.hash, hash) {
			principal, cause := credential.principal, credential.err
			fixture.mu.Unlock()
			return principal, cause
		}
	}
	fixture.mu.Unlock()
	return model.Principal{}, fixture.failure("Authenticate credentials")
}

func (d *routeIdentityDAO) unexpected(method string) error { return d.scope.fixture.failure(method) }

type routePersonalTeamDAO struct{ scope *routeIdentityScope }

func (d *routePersonalTeamDAO) InsertPersonalTeam(context.Context, string, string, time.Time) (bool, error) {
	return false, d.scope.fixture.failure("InsertPersonalTeam")
}
func (d *routePersonalTeamDAO) InsertPersonalOwner(context.Context, string, string, time.Time) error {
	return d.scope.fixture.failure("InsertPersonalOwner")
}
func (d *routePersonalTeamDAO) PersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	return store.PersonalTeamFacts{}, d.scope.fixture.failure("PersonalTeam")
}

func (d *routeIdentityDAO) CleanupCredentials(context.Context, time.Time) error {
	return d.unexpected("CleanupCredentials")
}

func (d *routeIdentityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	return d.unexpected("CleanupLoginCredentials")
}

func (d *routeIdentityDAO) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	return time.Time{}, "", d.unexpected("AdmitLogin")
}

func (d *routeIdentityDAO) InsertLogin(context.Context, model.LoginTransaction) error {
	return d.unexpected("InsertLogin")
}

func (d *routeIdentityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	return model.LoginTransaction{}, d.unexpected("ConsumeLogin")
}

func (d *routeIdentityDAO) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	return model.User{}, d.unexpected("UpsertUser")
}

func (d *routeIdentityDAO) InsertSession(context.Context, model.Session) error {
	return d.unexpected("InsertSession")
}

func (d *routeIdentityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	return model.User{}, store.PersonalTeamFacts{}, d.unexpected("IdentityUser")
}

func (d *routeIdentityDAO) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	return store.PersonalTeamFacts{}, d.unexpected("IdentityPersonalTeam")
}

func (d *routeIdentityDAO) DeleteSession(context.Context, model.Principal) error {
	return d.unexpected("DeleteSession")
}

func (d *routeIdentityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	return d.unexpected("LockSession")
}

func (d *routeIdentityDAO) InsertPAT(context.Context, model.PersonalAccessToken) error {
	return d.unexpected("InsertPAT")
}

func (d *routeIdentityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	return nil, d.unexpected("ListPATs")
}

func (d *routeIdentityDAO) DeletePAT(context.Context, string, string) error {
	return d.unexpected("DeletePAT")
}

func (d *routeIdentityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	return model.PersonalAccessToken{}, d.unexpected("LockActivePAT")
}

func (d *routeIdentityDAO) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	return model.PersonalAccessToken{}, d.unexpected("SetPATExpiry")
}

func (d *routeIdentityDAO) PruneDeviceRates(context.Context, time.Time) error {
	return d.unexpected("PruneDeviceRates")
}

func (d *routeIdentityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	return 0, d.unexpected("IncrementDeviceRate")
}

func (d *routeIdentityDAO) PruneDevices(context.Context, time.Time) error {
	return d.unexpected("PruneDevices")
}

func (d *routeIdentityDAO) InsertDevice(context.Context, model.DeviceAuthorization) error {
	return d.unexpected("InsertDevice")
}

func (d *routeIdentityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	return model.DeviceAuthorization{}, d.unexpected("DeviceByUserCode")
}

func (d *routeIdentityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	return model.DeviceAuthorization{}, d.unexpected("LockDeviceByHash")
}

func (d *routeIdentityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	return d.unexpected("SetDeviceDecision")
}

func (d *routeIdentityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	return d.unexpected("DelayDevicePoll")
}

func (d *routeIdentityDAO) ConsumeDevice(context.Context, string) error {
	return d.unexpected("ConsumeDevice")
}
