package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestUserAPIIssuerComposition(t *testing.T) {
	writer := &apiIssuerWriter{t: t}
	ensure := func(context.Context, model.User) (model.User, error) {
		t.Fatal("construction called EnsureUser")
		return model.User{}, nil
	}
	for _, tc := range []struct {
		writer store.CredentialFamilyWriter
		ensure func(context.Context, model.User) (model.User, error)
		origin string
	}{
		{nil, ensure, "https://example.test"},
		{writer, nil, "https://example.test"},
		{writer, ensure, "https://example.test/path"},
	} {
		if result, err := NewUserAPIIssuer(tc.writer, tc.ensure, tc.origin); result != nil || !errors.Is(err, core.ErrInvalidAuthorization) {
			t.Fatalf("invalid composition: %v %v", result, err)
		}
	}
	result, err := NewUserAPIIssuer(writer, ensure, "https://example.test")
	if err != nil || result.ensureUser == nil || result.issue == nil {
		t.Fatalf("composition: %v %v", result, err)
	}
}

func TestUserAPIIssuerRequiresCompletedAccountBeforeFamily(t *testing.T) {
	identityFailure := errors.New("identity operation failed")
	familyFailure := errors.New("family operation failed")
	for _, tc := range []struct {
		name                string
		ensureErr, issueErr error
	}{
		{name: "success"}, {name: "identity rejected", ensureErr: identityFailure},
		{name: "identity unknown", ensureErr: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: identityFailure}},
		{name: "family rejected", issueErr: familyFailure},
		{name: "family unknown", issueErr: errors.Join(core.ErrAuthorizationUnknown, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: familyFailure})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := model.User{UniAuthID: "msft:object@tenant"}
			user := model.User{ID: uuid.NewString()}
			candidate := core.IssuedFamily{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: user.ID}, AccessToken: "confirmed access", RefreshToken: "confirmed refresh"}
			var steps []string
			issuer := &UserAPIIssuer{
				ensureUser: func(ctx context.Context, got model.User) (model.User, error) {
					if ctx != t.Context() || !reflect.DeepEqual(got, input) {
						t.Fatal("identity context or input changed")
					}
					steps = append(steps, "identity completed")
					return user, tc.ensureErr
				},
				issue: func(ctx context.Context, id string) (core.IssuedFamily, error) {
					if ctx != t.Context() || id != user.ID || !reflect.DeepEqual(steps, []string{"identity completed"}) {
						t.Fatal("family preceded complete actual account")
					}
					steps = append(steps, "family")
					if tc.issueErr != nil {
						return core.IssuedFamily{}, tc.issueErr
					}
					return candidate, nil
				},
			}
			got, err := issuer.Issue(t.Context(), input)
			wantErr := tc.ensureErr
			if wantErr == nil {
				wantErr = tc.issueErr
			}
			if !errors.Is(err, wantErr) {
				t.Fatalf("error cause lost: %v", err)
			}
			if wantErr != nil {
				if !reflect.DeepEqual(got, core.IssuedFamily{}) {
					t.Fatal("failed issuance returned token material")
				}
			} else if !reflect.DeepEqual(got, candidate) {
				t.Fatal("actual family changed")
			}
			wantSteps := []string{"identity completed"}
			if tc.ensureErr == nil {
				wantSteps = append(wantSteps, "family")
			}
			if !reflect.DeepEqual(steps, wantSteps) {
				t.Fatalf("steps=%v", steps)
			}
		})
	}
}

type unavailableFamilyWriter struct {
	calls   int
	failure error
}

func (w *unavailableFamilyWriter) WriteCredentialFamily(context.Context, func(store.CredentialFamilyScope) error) (store.Completion, error) {
	w.calls++
	return store.Completion{Outcome: store.TransactionNotCommitted}, w.failure
}

func TestUserAPIIssuerRetainsCommittedAccountAfterFamilyFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	identity := identityservice.New(database, nil, "https://application.example/api/v1/auth/callback")
	familyFailure := errors.New("family storage unavailable")
	writer := &unavailableFamilyWriter{failure: familyFailure}
	issuer, err := NewUserAPIIssuer(writer, identity.EnsureUser, "https://application.example")
	if err != nil {
		t.Fatal(err)
	}
	input := model.User{UniAuthID: "s2s-account-" + uuid.NewString()}
	result, err := issuer.Issue(ctx, input)
	if !errors.Is(err, familyFailure) || !reflect.DeepEqual(result, core.IssuedFamily{}) || writer.calls != 1 {
		t.Fatalf("familyfailure=%v result=%+v calls=%d", err, result, writer.calls)
	}
	var userID, teamID, role string
	err = database.Pool.QueryRow(ctx, `SELECT u.id::text,t.id::text,m.role FROM users u JOIN teams t ON t.personal_user_id=u.id JOIN team_members m ON m.team_id=t.id AND m.user_id=u.id WHERE u.uniauth_id=$1`, input.UniAuthID).Scan(&userID, &teamID, &role)
	if err != nil || userID == "" || teamID == "" || role != "admin" {
		t.Fatalf("complete account not retained: %q %q %q %v", userID, teamID, role, err)
	}
	if _, err := issuer.Issue(ctx, input); !errors.Is(err, familyFailure) {
		t.Fatalf("second failure=%v", err)
	}
	var users, teams, members int
	err = database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users WHERE uniauth_id=$1),(SELECT count(*) FROM teams WHERE personal_user_id=$2),(SELECT count(*) FROM team_members WHERE team_id=$3)`, input.UniAuthID, userID, teamID).Scan(&users, &teams, &members)
	if err != nil || users != 1 || teams != 1 || members != 1 || writer.calls != 2 {
		t.Fatalf("account convergence users=%d teams=%d members=%d calls=%d err=%v", users, teams, members, writer.calls, err)
	}
}
