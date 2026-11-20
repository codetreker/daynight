package usage_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageRegistrationRejectsUnavailableOriginalExecution(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	for index, tc := range []struct {
		name   string
		change func(*testing.T, *workflowFixture)
		code   string
	}{
		{"legacy backend", func(t *testing.T, f *workflowFixture) {
			testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET backend='herdr',snapshot=NULL,terminal_state='{}' WHERE id=$1`, f.session)
		}, "unsupported_scope"},
		{"expired lifetime", func(t *testing.T, f *workflowFixture) {
			testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET created_at=clock_timestamp()-interval '91 days' WHERE id=$1`, f.session)
		}, "upload_expired"},
		{"worker identity mismatch", func(t *testing.T, f *workflowFixture) {
			testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,workerId}',to_jsonb($2::text)) WHERE id=$1`, f.session, uuid.NewString())
		}, "registration_unavailable"},
		{"unknown profile", func(t *testing.T, f *workflowFixture) { f.registration.ProfileID = "unknown-profile" }, "profile_unverified"},
		{"expired parent", func(t *testing.T, f *workflowFixture) {
			testutil.MustExec(t, f.db.Pool, `UPDATE personal_access_tokens SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.actor.CredentialID)
		}, "permission_revoked"},
		{"paused task", func(t *testing.T, f *workflowFixture) {
			testutil.PutTaskProperty(t, f.db.Pool, f.task, "blocked", []byte("true"))
		}, "permission_revoked"},
	} {
		if !t.Run(tc.name, func(t *testing.T) {
			f := workflowInStore(t, database, 400+index)
			tc.change(t, f)
			_, err := f.service.Register(t.Context(), f.actor, f.registration)
			requireCode(t, err, tc.code)
			var count int
			if err = f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_records`).Scan(&count); err != nil || count != 0 {
				t.Fatal("failed registration persisted usage", count, err)
			}
		}) {
			return
		}
	}
}

func TestUsageRotationRefusesExpiredSealedAndInactiveExecutions(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	for index, state := range []string{"expired", "sealed", "revoked", "completed claim", "stale controller", "wrong session"} {
		if !t.Run(state, func(t *testing.T) {
			f := workflowInStore(t, database, 400+index)
			ctx := t.Context()
			reg, err := f.service.Register(ctx, f.actor, f.registration)
			if err != nil {
				t.Fatal(err)
			}
			input := app.GrantRequest{ExpectedRowVersion: "1", SessionID: f.session, Generation: "1", ControllerInstanceID: f.registration.ControllerInstanceID, ConnectionEpoch: "1"}
			want := "registration_unavailable"
			switch state {
			case "expired":
				testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, reg.State.ID)
				want = "upload_expired"
			case "sealed":
				if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(stateEvent(reg.State, "1", "partial", true))); err != nil {
					t.Fatal(err)
				}
			case "revoked":
				if _, err = f.service.Revoke(ctx, f.actor, reg.State.ID, "1"); err != nil {
					t.Fatal(err)
				}
			case "completed claim":
				testutil.MustExec(t, f.db.Pool, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task)
			case "stale controller":
				input.ControllerInstanceID = uuid.NewString()
			case "wrong session":
				input.SessionID = uuid.NewString()
			}
			_, err = f.service.Rotate(ctx, f.actor, reg.State.ID, input)
			requireCode(t, err, want)
		}) {
			return
		}
	}
}

func TestUsageMemberCannotInspectOrRevokeAnotherOwnersGrant(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	_, member, _ := testutil.AuthRecords(t, f.db)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.project, member.UserID)
	if _, err = f.service.TaskSummaries(ctx, member, f.project, []string{f.task}); err != nil {
		t.Fatal("member cannot read aggregate usage", err)
	}
	_, err = f.service.State(ctx, member, reg.State.ID)
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.Revoke(ctx, member, reg.State.ID, "1")
	requireCode(t, err, "resource_unavailable")
	testutil.MustExec(t, f.db.Pool, `UPDATE project_grants SET role='admin' WHERE project_id=$1 AND user_id=$2`, f.project, member.UserID)
	_, err = f.service.Revoke(ctx, member, reg.State.ID, "2")
	requireCode(t, err, "usage_changed")
	revoked, err := f.service.Revoke(ctx, member, reg.State.ID, "1")
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := f.service.Revoke(ctx, member, reg.State.ID, revoked.RowVersion)
	if err != nil || repeated.RowVersion != revoked.RowVersion || repeated.GrantRevokedAt == nil || !repeated.GrantRevokedAt.Equal(*revoked.GrantRevokedAt) {
		t.Fatal("revocation not idempotent", repeated, err)
	}
}

func TestUsageDeletedSessionRejectsEveryGrantOperation(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `DELETE FROM task_sessions WHERE id=$1`, f.session)
	check := func(err error) {
		t.Helper()
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatal("deleted Session remained available", err)
		}
	}
	_, err = f.service.Register(ctx, f.actor, f.registration)
	check(err)
	_, err = f.service.Rotate(ctx, f.actor, reg.State.ID, app.GrantRequest{ExpectedRowVersion: "1", SessionID: f.session, Generation: "1", ControllerInstanceID: f.registration.ControllerInstanceID, ConnectionEpoch: "1"})
	check(err)
	_, err = f.service.Revoke(ctx, f.actor, reg.State.ID, "1")
	check(err)
	_, err = f.service.State(ctx, f.actor, reg.State.ID)
	check(err)
	_, err = f.service.Sources(ctx, reg.State.ID, reg.Grant.Token, []string{"copilot-event-v1:missing"})
	check(err)
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	check(err)
}

func TestUsageDetailCursorTraversesStableSnapshotAndRejectsChangedFilter(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1"), measurement(reg.State.ID, "2"))); err != nil {
		t.Fatal(err)
	}
	filter := app.PageRequest{Kind: "measurement", Limit: 1}
	first, err := f.service.Records(ctx, f.actor, f.project, f.task, "", filter)
	if err != nil || first.NextCursor == nil {
		t.Fatal(first, err)
	}
	filter.Cursor = *first.NextCursor
	second, err := f.service.Records(ctx, f.actor, f.project, f.task, "", filter)
	if err != nil || len(second.Items) != 1 || second.NextCursor != nil || second.Items[0].ID == first.Items[0].ID || second.SnapshotToken != first.SnapshotToken {
		t.Fatal("unstable keyset page", first, second, err)
	}
	filter.Model = "other-model"
	_, err = f.service.Records(ctx, f.actor, f.project, f.task, "", filter)
	requireCode(t, err, "reset_required")
	filter.Model = ""
	filter.Cursor = "malformed"
	_, err = f.service.Records(ctx, f.actor, f.project, f.task, "", filter)
	requireCode(t, err, "invalid_cursor")
	_, err = f.service.TestSummary(ctx, f.actor, f.session)
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.Records(ctx, f.actor, "", "", f.session, app.PageRequest{Kind: "measurement", Limit: 1})
	requireCode(t, err, "resource_unavailable")
}

func TestUsageAggregateReflectsUnsupportedAndUnverifiedExecutions(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	for index, provider := range []string{"unverified", "codex"} {
		if !t.Run(provider, func(t *testing.T) {
			f := workflowInStore(t, database, 400+index)
			ctx := t.Context()
			service, err := app.New(f.db, app.Options{WriteEnabled: true})
			if err != nil {
				t.Fatal(err)
			}
			want := "unavailable"
			if provider == "codex" {
				f.registration.ProfileID = "codex-snapshot-unaccountable-v1"
				testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,provider}','"codex"') WHERE id=$1`, f.session)
				testutil.MustExec(t, f.db.Pool, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agent}','"codex"')::text WHERE task_id=$1 AND name='worker'`, f.task)
				want = "unsupported"
			}
			reg, err := service.Register(ctx, f.actor, f.registration)
			if err != nil || core.Value(reg.State.CollectionState) != want {
				t.Fatal(reg, err)
			}
			group, err := service.Aggregate(ctx, f.actor, f.project, "chain", f.task, "")
			if err != nil || group.Summary.Completeness != want || group.Members.Total != "1" || group.Summary.Metrics["outputTokens"].Known != nil {
				t.Fatal(group, err)
			}
		}) {
			return
		}
	}
}

func TestUsageMissingMemberCursorContinuesWithoutRepeatingMembers(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) SELECT gen_random_uuid(),$1,'task','No usage','','todo' FROM generate_series(1,100)`, f.project)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) SELECT $1,$2,id FROM tasks WHERE project_id=$1 AND id<>$2`, f.project, f.task)
	first, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", f.task, "")
	if err != nil || len(first.MissingMembers) != 100 || first.NextMembersCursor == nil {
		t.Fatal(first, err)
	}
	second, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", f.task, *first.NextMembersCursor)
	if err != nil || len(second.MissingMembers) != 1 || second.NextMembersCursor != nil || second.MembershipRevision != first.MembershipRevision || second.MissingMembers[0].TaskID <= first.MissingMembers[99].TaskID {
		t.Fatal(second, err)
	}
	_, err = f.service.Aggregate(ctx, f.actor, f.project, "chain", f.task, "malformed")
	requireCode(t, err, "invalid_cursor")
	_, err = f.service.Aggregate(ctx, f.actor, uuid.NewString(), "chain", f.task, "")
	requireCode(t, err, "resource_unavailable")
}

func TestUsageStateAndSummaryReauthorizeCredentialAndProjectAccess(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	_, outsider, _ := testutil.AuthRecords(t, f.db)
	_, err = f.service.State(ctx, outsider, reg.State.ID)
	requireCode(t, err, "resource_unavailable")
	testutil.MustExec(t, f.db.Pool, `UPDATE personal_access_tokens SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.actor.CredentialID)
	_, err = f.service.State(ctx, f.actor, reg.State.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("expired credential retained state access", err)
	}
	_, err = f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("expired credential retained aggregate access", err)
	}
}

func TestUsageConflictAtRevisionCapacityCannotClaimCommittedDiagnostic(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	original := measurement(reg.State.ID, "7")
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(original)); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET row_version=9223372036854775807 WHERE id=$1`, reg.State.ID)
	conflict := original
	conflict.Metrics.Output = core.Ptr("8")
	conflict.NativeMetrics = map[string]any{"outputTokens": "8"}
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(conflict))
	requireCode(t, err, "revision_overflow")
	var fault *model.UsageFault
	if !errors.As(err, &fault) || fault.DiagnosticCommitted {
		t.Fatal("failed diagnostic was reported committed", err)
	}
	state, err := f.service.State(ctx, f.actor, reg.State.ID)
	if err != nil || state.RowVersion != "9223372036854775807" || core.Value(state.CollectionState) != "collecting" {
		t.Fatal("failed diagnostic changed stored state", state, err)
	}
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 100})
	if err != nil || len(page.Items) != 1 || core.Value(page.Items[0].Metrics.Output) != "7" {
		t.Fatal("conflict changed original measurement", page, err)
	}
}
