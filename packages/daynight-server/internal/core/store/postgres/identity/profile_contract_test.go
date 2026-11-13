package identity_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestEnsureUserReturnsActualIdentityWithoutOverwritingProfile(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	name, avatar := "Original", "https://example.test/avatar"
	candidate := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Name: &name, AvatarURL: &avatar}
	var actual model.User
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		var inserted bool
		var err error
		actual, inserted, err = sc.IdentityDAO().EnsureUser(ctx, candidate, now)
		if err == nil && (!inserted || actual.ID != candidate.ID || !actual.CreatedAt.Equal(now) || !actual.UpdatedAt.Equal(now)) {
			t.Fatalf("new identity: %+v inserted=%t", actual, inserted)
		}
		return err
	})
	replacement := model.User{ID: uuid.NewString(), UniAuthID: candidate.UniAuthID}
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		got, inserted, err := sc.IdentityDAO().EnsureUser(ctx, replacement, now.Add(time.Hour))
		if err == nil && (inserted || !reflect.DeepEqual(got, actual)) {
			t.Fatalf("existing profile changed: got=%+v original=%+v inserted=%t", got, actual, inserted)
		}
		return err
	})
	stop := errors.New("initialization failed")
	rolledBackID := uuid.NewString()
	completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		_, inserted, err := sc.IdentityDAO().EnsureUser(ctx, model.User{ID: rolledBackID, UniAuthID: "github:" + uuid.NewString()}, now)
		if err != nil {
			return err
		}
		if !inserted {
			t.Fatal("new identity not inserted")
		}
		return stop
	})
	if !errors.Is(err, stop) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, rolledBackID).Scan(&count))
	if count != 0 {
		t.Fatal("rolled back candidate persisted")
	}
}

func TestEnsureUserReadsCommittedConcurrentWinner(t *testing.T) {
	for _, mode := range []string{"ensure-commit", "ensure-rollback", "native-commit", "native-rollback"} {
		commitWinner := mode == "ensure-commit" || mode == "native-commit"
		t.Run(mode, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			requireNoError(t, err)
			defer tx.Rollback(context.Background())
			now := time.Now().UTC()
			name := "Winner"
			winner := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Name: &name}
			dao := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
			var winningUser model.User
			if mode == "native-commit" || mode == "native-rollback" {
				winningUser, err = dao.UpsertUser(ctx, winner, now)
				requireNoError(t, err)
			} else {
				var inserted bool
				winningUser, inserted, err = dao.EnsureUser(ctx, winner, now)
				requireNoError(t, err)
				if !inserted {
					t.Fatal("winner not inserted")
				}
			}
			candidate := model.User{ID: uuid.NewString(), UniAuthID: winner.UniAuthID}
			var result model.User
			var resultInserted bool
			done := make(chan error, 1)
			go func() {
				_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
					var err error
					result, resultInserted, err = sc.IdentityDAO().EnsureUser(ctx, candidate, now.Add(time.Hour))
					return err
				})
				done <- err
			}()
			testutil.WaitForQueryLock(t, db.Pool, "INSERT INTO users")
			if commitWinner {
				requireNoError(t, tx.Commit(ctx))
			} else {
				requireNoError(t, tx.Rollback(ctx))
			}
			requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
			if commitWinner && (resultInserted || !reflect.DeepEqual(result, winningUser)) {
				t.Fatalf("concurrent winner lost: %+v inserted=%t", result, resultInserted)
			}
			if !commitWinner && (!resultInserted || result.ID != candidate.ID) {
				t.Fatalf("rollback did not insert candidate: %+v inserted=%t", result, resultInserted)
			}
			var count int
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE uniauth_id=$1`, winner.UniAuthID).Scan(&count))
			if count != 1 {
				t.Fatalf("identity count=%d", count)
			}
		})
	}
}

func TestPatchUserSparseConcurrentUpdatesAndRollback(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	name, avatar := "New name", "https://example.test/new"
	tx, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer tx.Rollback(context.Background())
	first, err := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
	requireNoError(t, err)
	if first.Name == nil || *first.Name != name || first.AvatarURL != nil || !first.UpdatedAt.After(user.UpdatedAt) {
		t.Fatalf("name patch=%+v", first)
	}
	var second model.User
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
			var err error
			second, err = sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{AvatarURL: model.ProfileField{Present: true, Value: &avatar}})
			return err
		})
		done <- err
	}()
	testutil.WaitForQueryLock(t, db.Pool, "UPDATE users SET")
	requireNoError(t, tx.Commit(ctx))
	requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
	if second.Name == nil || *second.Name != name || second.AvatarURL == nil || *second.AvatarURL != avatar {
		t.Fatalf("concurrent sparse update=%+v", second)
	}
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		cleared, err := sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true}, AvatarURL: model.ProfileField{Present: true}})
		if err == nil && (cleared.Name != nil || cleared.AvatarURL != nil || cleared.ID != user.ID || cleared.UniAuthID != user.UniAuthID || !cleared.CreatedAt.Equal(user.CreatedAt)) {
			t.Fatalf("clear changed immutable fields: %+v", cleared)
		}
		return err
	})
	stop := errors.New("encoding refused")
	completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		if _, err := sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}}); err != nil {
			return err
		}
		return stop
	})
	if !errors.Is(err, stop) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("patch rollback: %+v %v", completion, err)
	}
	actual, facts, err := testutil.IdentityUser(ctx, db, user.ID)
	requireNoError(t, err)
	if actual.Name != nil || actual.AvatarURL != nil || facts.ID != user.PersonalTeam.ID {
		t.Fatalf("rollback changed profile/team: %+v %+v", actual, facts)
	}
	_, err = db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		_, err := sc.IdentityDAO().PatchUser(ctx, uuid.NewString(), model.UserProfilePatch{Name: model.ProfileField{Present: true}})
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing user: %v", err)
	}
}

func TestLoginUpsertMergesNullableProfile(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	str := func(s string) *string { return &s }
	boolean := func(b bool) *bool { return &b }
	oldEmail, newEmail := "old@example.test", "new@example.test"
	oldName, oldAvatar := "Original", "https://example.test/old"
	newName, newAvatar := " 名字 ", "data:image/png;base64,aGVsbG8="
	cases := []struct {
		name              string
		input             model.User
		email             *string
		verified          *bool
		nameValue, avatar *string
	}{
		{"all null", model.User{}, &oldEmail, boolean(true), &oldName, &oldAvatar},
		{"name null", model.User{AvatarURL: &newAvatar}, &oldEmail, boolean(true), &oldName, &newAvatar},
		{"avatar null", model.User{Name: &newName}, &oldEmail, boolean(true), &newName, &oldAvatar},
		{"empty strings", model.User{Name: str(""), AvatarURL: str("")}, &oldEmail, boolean(true), str(""), str("")},
		{"null email ignores verification", model.User{EmailVerified: boolean(false)}, &oldEmail, boolean(true), &oldName, &oldAvatar},
		{"same email null", model.User{Email: &oldEmail}, &oldEmail, boolean(true), &oldName, &oldAvatar},
		{"same email true", model.User{Email: &oldEmail, EmailVerified: boolean(true)}, &oldEmail, boolean(true), &oldName, &oldAvatar},
		{"same email false", model.User{Email: &oldEmail, EmailVerified: boolean(false)}, &oldEmail, boolean(false), &oldName, &oldAvatar},
		{"new email null", model.User{Email: &newEmail}, &newEmail, nil, &oldName, &oldAvatar},
		{"new email true", model.User{Email: &newEmail, EmailVerified: boolean(true)}, &newEmail, boolean(true), &oldName, &oldAvatar},
		{"new email false all fields", model.User{Email: &newEmail, EmailVerified: boolean(false), Name: &newName, AvatarURL: &newAvatar}, &newEmail, boolean(false), &newName, &newAvatar},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			initial := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Email: &oldEmail, EmailVerified: boolean(true), Name: &oldName, AvatarURL: &oldAvatar}
			identityScopeTest(t, db, func(sc store.IdentityScope) error {
				_, err := sc.IdentityDAO().UpsertUser(ctx, initial, now)
				return err
			})
			tc.input.ID, tc.input.UniAuthID = uuid.NewString(), initial.UniAuthID
			var returned model.User
			identityScopeTest(t, db, func(sc store.IdentityScope) error {
				var err error
				returned, err = sc.IdentityDAO().UpsertUser(ctx, tc.input, now.Add(time.Minute))
				return err
			})
			actual, _, err := testutil.IdentityUser(ctx, db, initial.ID)
			requireNoError(t, err)
			if !reflect.DeepEqual(returned, actual) || returned.ID != initial.ID || returned.UniAuthID != initial.UniAuthID || !returned.CreatedAt.Equal(now) || !returned.UpdatedAt.Equal(now.Add(time.Minute)) || !reflect.DeepEqual(returned.Email, tc.email) || !reflect.DeepEqual(returned.EmailVerified, tc.verified) || !reflect.DeepEqual(returned.Name, tc.nameValue) || !reflect.DeepEqual(returned.AvatarURL, tc.avatar) {
				t.Fatalf("login merge returned=%+v persisted=%+v", returned, actual)
			}
		})
	}
}

func TestLoginUpsertSerializesWithProfilePatch(t *testing.T) {
	for _, first := range []string{"patch", "login"} {
		t.Run(first, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, _, _ := testutil.AuthRecords(t, db)
			patchName, loginAvatar := "Edited locally", "https://example.test/login"
			tx, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			defer tx.Rollback(context.Background())
			dao := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
			patch := model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &patchName}}
			login := model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID, AvatarURL: &loginAvatar}
			now := time.Now().UTC().Truncate(time.Microsecond)
			if first == "patch" {
				_, err = dao.PatchUser(ctx, user.ID, patch)
			} else {
				_, err = dao.UpsertUser(ctx, login, now)
			}
			requireNoError(t, err)
			var result model.User
			done := make(chan error, 1)
			go func() {
				_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
					var err error
					if first == "patch" {
						result, err = sc.IdentityDAO().UpsertUser(ctx, login, now.Add(time.Minute))
					} else {
						result, err = sc.IdentityDAO().PatchUser(ctx, user.ID, patch)
					}
					return err
				})
				done <- err
			}()
			query := "INSERT INTO users"
			if first == "login" {
				query = "UPDATE users SET"
			}
			testutil.WaitForQueryLock(t, db.Pool, query)
			requireNoError(t, tx.Commit(ctx))
			requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
			actual, facts, err := testutil.IdentityUser(ctx, db, user.ID)
			requireNoError(t, err)
			if !reflect.DeepEqual(result, actual) || actual.Name == nil || *actual.Name != patchName || actual.AvatarURL == nil || *actual.AvatarURL != loginAvatar || actual.ID != user.ID || !actual.CreatedAt.Equal(user.CreatedAt) || facts.ID != user.PersonalTeam.ID {
				t.Fatalf("serialized profile returned=%+v persisted=%+v team=%+v", result, actual, facts)
			}
		})
	}
}

// A real store proves that final admission rolls back the merged write while
// the earlier, independently committed pending consumption remains consumed.
func TestLoginMergedProfileAdmissionRollsBack(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	avatar := strings.Repeat("<", 174700)
	name := strings.Repeat("x", core.MaxProfileFieldBytes)
	initial := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), AvatarURL: &avatar}
	incoming := model.User{UniAuthID: initial.UniAuthID, Name: &name}
	if err := core.AdmitCompleteUser(initial, false); err != nil {
		t.Fatalf("initial profile: %v", err)
	}
	if err := core.AdmitCompleteUser(incoming, false); err != nil {
		t.Fatalf("incoming profile: %v", err)
	}
	merged := initial
	merged.Name = &name
	if err := core.AdmitCompleteUser(merged, false); err == nil {
		t.Fatal("merged profile must exceed budget")
	}
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		_, err := sc.IdentityDAO().UpsertUser(ctx, initial, now)
		return err
	})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/auth/result" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"provider": "github", "id": initial.UniAuthID, "email": nil, "email_verified": nil, "name": name, "avatar_url": nil, "origin": map[string]any{}})
	}))
	defer gateway.Close()
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "test-app", AppSecret: "test-secret", AllowLoopbackHTTP: true})
	requireNoError(t, err)
	svc := service.New(db, client, "https://daynight.example/auth/callback")
	start, err := svc.StartLogin(ctx, "github", "/projects", secret.Random(""))
	requireNoError(t, err)
	result, err := svc.CompleteLogin(ctx, url.Values{"state": {start.State}, "code": {"profile"}}, start.BrowserBinding)
	var provider *model.IdentityProviderError
	var violation *limit.Violation
	if !errors.As(err, &provider) || provider.Code != "identity_unavailable" || !errors.As(err, &violation) || violation.Field != "profile" || result.LoginID != start.ID || result.Secret != "" {
		t.Fatalf("final admission result=%+v error=%v", result, err)
	}
	actual, facts, err := testutil.IdentityUser(ctx, db, initial.ID)
	requireNoError(t, err)
	if actual.Name != nil || actual.AvatarURL == nil || *actual.AvatarURL != avatar || !actual.UpdatedAt.Equal(now) || facts.ID != "" {
		t.Fatalf("rollback changed stored profile/team: %+v %+v", actual, facts)
	}
	var logins, sessions, teams int
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions WHERE id=$1),(SELECT count(*) FROM sessions WHERE user_id=$2),(SELECT count(*) FROM teams WHERE personal_user_id=$2)`, start.ID, initial.ID).Scan(&logins, &sessions, &teams))
	if logins != 0 || sessions != 0 || teams != 0 {
		t.Fatalf("pending=%d sessions=%d teams=%d", logins, sessions, teams)
	}
	_, err = svc.CompleteLogin(ctx, url.Values{"state": {start.State}, "code": {"profile"}}, start.BrowserBinding)
	if err == nil {
		t.Fatal("consumed pending login replay succeeded")
	}
}

func TestLoginAndPatchSameFieldFollowLockOrder(t *testing.T) {
	for _, first := range []string{"patch", "login"} {
		t.Run(first, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, _, _ := testutil.AuthRecords(t, db)
			patchName, loginName, patchAvatar := "Edited locally", "Provider name", "https://example.test/edited"
			patch := model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &patchName}, AvatarURL: model.ProfileField{Present: true, Value: &patchAvatar}}
			login := model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID, Name: &loginName}
			tx, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			defer tx.Rollback(context.Background())
			dao := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
			now := time.Now().UTC().Truncate(time.Microsecond)
			if first == "patch" {
				_, err = dao.PatchUser(ctx, user.ID, patch)
			} else {
				_, err = dao.UpsertUser(ctx, login, now)
			}
			requireNoError(t, err)
			var result model.User
			done := make(chan error, 1)
			go func() {
				_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
					var err error
					if first == "patch" {
						result, err = sc.IdentityDAO().UpsertUser(ctx, login, now.Add(time.Minute))
					} else {
						result, err = sc.IdentityDAO().PatchUser(ctx, user.ID, patch)
					}
					return err
				})
				done <- err
			}()
			query := "INSERT INTO users"
			if first == "login" {
				query = "UPDATE users SET"
			}
			testutil.WaitForQueryLock(t, db.Pool, query)
			requireNoError(t, tx.Commit(ctx))
			requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
			actual, facts, err := testutil.IdentityUser(ctx, db, user.ID)
			requireNoError(t, err)
			wantName := loginName
			if first == "login" {
				wantName = patchName
			}
			if !reflect.DeepEqual(result, actual) || actual.Name == nil || *actual.Name != wantName || actual.AvatarURL == nil || *actual.AvatarURL != patchAvatar || actual.ID != user.ID || !actual.CreatedAt.Equal(user.CreatedAt) || facts.ID != user.PersonalTeam.ID {
				t.Fatalf("serialized profile returned=%+v persisted=%+v team=%+v", result, actual, facts)
			}
		})
	}
}
