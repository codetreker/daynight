package sessionrelay

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestControllerUpgradeAuthenticationDoesNotConsumeGrant(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	v, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = f.s.AuthenticateController(ctx, grant.Token); err != nil {
			t.Fatal("pre-upgrade authentication consumed grant", err)
		}
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	connected, err := f.s.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil || connected.ConnectionEpoch != "1" {
		t.Fatal("authenticated bootstrap could not connect", connected, err)
	}
	if err = f.s.AuthenticateController(ctx, grant.Token); err == nil {
		t.Fatal("consumed bootstrap authenticated")
	}
	reconnect, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = f.s.AuthenticateController(ctx, reconnect.Token); err != nil {
			t.Fatal("reconnect grant was consumed", err)
		}
		if _, err = f.s.Connect(ctx, reconnect.Token, hello, uuid.NewString()); err != nil {
			t.Fatal("reconnect failed", err)
		}
	}
}

func TestControllerUpgradeAuthenticationRechecksGrantAuthority(t *testing.T) {
	for _, condition := range []string{"unknown", "expired", "consumed", "parent_revoked", "membership_removed", "claim_withdrawn", "storage_failure"} {
		t.Run(condition, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			grant, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
			if err != nil {
				t.Fatal(err)
			}
			if err = f.s.AuthenticateController(ctx, grant.Token); err != nil {
				t.Fatal(err)
			}
			switch condition {
			case "unknown":
				grant.Token = "dncontroller_unknown"
			case "expired":
				f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
			case "consumed":
				_, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET grant_kind='bootstrap',grant_consumed=true WHERE id=$1`, v.SessionID)
			case "parent_revoked":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID)
			case "membership_removed":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID)
			case "claim_withdrawn":
				_, err = service.NewTasks(f.s.DB).WithdrawWorker(ctx, f.p, f.project, f.task, service.WithdrawWorker{Version: 1, ClaimID: v.ClaimID})
			case "storage_failure":
				_, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE task_sessions RENAME TO unavailable_task_sessions`)
			}
			if err != nil {
				t.Fatal(err)
			}
			err = f.s.AuthenticateController(ctx, grant.Token)
			if err == nil {
				t.Fatal("changed grant authority authenticated", condition)
			}
			if condition == "storage_failure" {
				var refusal *service.Fault
				if errors.As(err, &refusal) {
					t.Fatal("storage failure was hidden as invalid credentials", err)
				}
			}
		})
	}
}
