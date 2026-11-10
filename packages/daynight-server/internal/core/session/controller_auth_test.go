package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestControllerUpgradeAuthenticationDoesNotConsumeGrant(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	v, err := registerAuthenticationFixture(f, ctx)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectRegistrationWrite(t)
	grant, err := grantAuthenticationFixture(f, ctx, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	for range 2 {
		if err = authenticateControllerFixture(f, ctx, grant.Token, nil); err != nil {
			t.Fatal("pre-upgrade authentication consumed grant", err)
		}
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connected, err := connectAuthenticationFixture(f, ctx, grant.Token, hello)
	if err != nil || connected.ConnectionEpoch != "1" {
		t.Fatal("authenticated bootstrap could not connect", connected, err)
	}
	f.SelectConnectionWrite(t)
	if err = authenticateControllerFixture(f, ctx, grant.Token, nil); err == nil {
		t.Fatal("consumed bootstrap authenticated")
	}
	reconnect, err := grantAuthenticationFixture(f, ctx, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	for range 2 {
		if err = authenticateControllerFixture(f, ctx, reconnect.Token, nil); err != nil {
			t.Fatal("reconnect grant was consumed", err)
		}
		if _, err = connectAuthenticationFixture(f, ctx, reconnect.Token, hello); err != nil {
			t.Fatal("reconnect failed", err)
		}
		f.SelectConnectionWrite(t)
	}
}

func TestControllerUpgradeAuthenticationRechecksGrantAuthority(t *testing.T) {
	for _, condition := range []string{"unknown", "expired", "consumed", "parent_revoked", "membership_removed", "claim_withdrawn", "storage_failure"} {
		t.Run(condition, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			grant, err := grantAuthenticationFixture(f, ctx, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectGrantWrite(t)
			f.SelectSessionWrite(t)
			if err = authenticateControllerFixture(f, ctx, grant.Token, nil); err != nil {
				t.Fatal(err)
			}
			work := map[string]int{}
			var lookupFailure error
			switch condition {
			case "unknown":
				grant.Token = "dncontroller_unknown"
				work = map[string]int{"LockTask": 0, "SessionBotID": 0, "LockSession": 0, "LockCredential": 0, "ProjectAccess": 0}
			case "expired":
				f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
			case "consumed":
				f.data.Session.GrantKind, f.data.Session.Consumed = "bootstrap", true
			case "parent_revoked":
				revokeFixtureCredential(t, f, f.p)
				work["ProjectAccess"] = 0
			case "membership_removed":
				denyFixtureProject(t, f, f.p)
			case "claim_withdrawn":
				f.data.Task.Worker = nil
			case "storage_failure":
				lookupFailure = errors.New("grant lookup unavailable")
				f.dao.SessionLocationByGrantFn = func(context.Context, []byte) (store.SessionLocation, error) {
					return store.SessionLocation{}, lookupFailure
				}
				work = map[string]int{"LockTask": 0, "SessionBotID": 0, "LockSession": 0, "LockCredential": 0, "ProjectAccess": 0}
			}
			if err != nil {
				t.Fatal(err)
			}
			err = authenticateControllerFixture(f, ctx, grant.Token, work)
			if err == nil {
				t.Fatal("changed grant authority authenticated", condition)
			}
			if condition == "storage_failure" {
				var refusal *model.Fault
				if errors.As(err, &refusal) || !errors.Is(err, lookupFailure) {
					t.Fatal("storage failure was hidden as invalid credentials", err)
				}
			}
		})
	}
}

func registerAuthenticationFixture(f fixture, ctx context.Context) (sp.Snapshot, error) {
	phase := f.RegistrationPhase(ctx, map[string]int{"InsertTaskSession": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Register(phase, f.p, f.project, f.task, f.r)
}

func grantAuthenticationFixture(f fixture, ctx context.Context, id string, grant sp.Grant) (GrantResult, error) {
	phase := f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Grant(phase, f.p, f.project, f.task, id, grant)
}

func authenticateControllerFixture(f fixture, ctx context.Context, token string, work map[string]int) error {
	phase := f.GrantPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.AuthenticateController(phase, token)
}

func connectAuthenticationFixture(f fixture, ctx context.Context, token string, hello sp.ControllerMessage) (sp.Snapshot, error) {
	phase := f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Connect(phase, token, hello, uuid.NewString())
}
