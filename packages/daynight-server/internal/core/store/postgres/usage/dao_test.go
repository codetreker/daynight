package usage_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgusage "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/usage"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func sampleRecord() model.UsageRecord {
	now := time.Now().UTC().Truncate(time.Microsecond)
	return model.UsageRecord{ID: uuid.NewString(), Kind: "measurement", Scope: "task", ProjectID: core.Ptr(uuid.NewString()), TaskID: core.Ptr(uuid.NewString()), SessionID: uuid.NewString(), ClaimID: core.Ptr(uuid.NewString()), Generation: "1", WorkerID: core.Ptr(uuid.NewString()), AuthorityUserID: uuid.NewString(), Provider: "copilot", NativeSessionID: "native", StateID: core.Ptr(uuid.NewString()), SourceKey: core.Ptr("source"), ProfileID: "copilot-event-1.0.11-v1", ProviderVersion: "fixture", RevisionAuthority: core.Ptr("immutable"), SourceRevision: core.Ptr("1"), Finality: core.Ptr("final"), Disposition: core.Ptr("active"), AggregationRole: core.Ptr("counted"), Metrics: model.UsageMetrics{Input: core.Ptr("9007199254740993"), Output: core.Ptr("7"), Total: core.Ptr("9007199254741000")}, NativeMetrics: map[string]any{"outputTokens": "7"}, ReasonCodes: []string{}, ObservedAt: now, CreatedAt: now, UpdatedAt: now, RowVersion: "1", BodyHash: strings.Repeat("ab", 32)}
}

func TestUsageRegistrationFailsClosedOnMalformedTaskAuthorizationProperties(t *testing.T) {
	for _, property := range []struct {
		name string
		raw  []byte
	}{
		{"worker", []byte(`{}`)},
		{"paused", []byte(`"not-a-boolean"`)},
	} {
		t.Run(property.name, func(t *testing.T) {
			f := workflow(t)
			testutil.PutTaskProperty(t, f.db.Pool, f.task, property.name, property.raw)
			_, err := f.service.Register(t.Context(), f.actor, f.registration)
			if err == nil {
				t.Fatal("malformed authorization properties admitted a usage grant")
			}
			var count int
			if err = f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_records`).Scan(&count); err != nil || count != 0 {
				t.Fatal("failed authorization persisted usage", count, err)
			}
		})
	}
}
func TestUsageTaskAuthorizationReadRejectsChildHiddenByDeletedGoal(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	if err := f.db.ReadUsage(ctx, func(scope store.UsageScope) error {
		session, err := scope.UsageDAO().Session(ctx, f.session)
		if err != nil {
			return err
		}
		auth, err := scope.UsageDAO().ReadTask(ctx, session)
		if err == nil && (!auth.AllowAgents || !auth.ClaimActive) {
			t.Fatal("live original execution lost its authorization", auth)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	goal := uuid.NewString()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) VALUES($1,$2,'goal','Parent','','todo')`, goal, f.project)
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task)
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, goal)
	err := f.db.ReadUsage(ctx, func(scope store.UsageScope) error {
		session, err := scope.UsageDAO().Session(ctx, f.session)
		if err != nil {
			t.Fatal("retained execution Session disappeared", err)
		}
		_, err = scope.UsageDAO().ReadTask(ctx, session)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("retained Session authorized a Task hidden by its deleted Goal", err)
	}
}

func TestUsagePersistenceAndAtomicity(t *testing.T) {
	db := testutil.OpenStore(t, postgres.Open)
	ctx := t.Context()
	r := sampleRecord()
	c, err := db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Insert(ctx, r) })
	if err != nil || c.Outcome != store.TransactionCommitted {
		var detail *pgconn.PgError
		if errors.As(err, &detail) {
			t.Fatalf("usage insert: %s (%s)", detail.Message, detail.Code)
		}
		for cause := err; cause != nil; cause = errors.Unwrap(cause) {
			t.Logf("%T: %v", cause, cause)
		}
		t.Fatal(c, err, errors.Unwrap(err))
	}
	var revision store.UsageRevision
	read := func(s store.UsageScope) error {
		dao := s.UsageDAO()
		got, e := dao.Source(ctx, r, *r.SourceKey)
		if e != nil {
			return e
		}
		if got.RowVersion != "1" || got.BodyHash != r.BodyHash || core.Value(got.Metrics.Input) != "9007199254740993" {
			t.Fatalf("persisted %+v", got)
		}
		filter := store.UsageFilter{ProjectID: *r.ProjectID, TaskIDs: []string{*r.TaskID}}
		summary, e := dao.Metrics(ctx, filter)
		if e != nil {
			return e
		}
		if core.Value(summary.Metrics["totalTokens"].Known) != "9007199254741000" || summary.Metrics["cacheReadTokens"].UnknownRecords != "1" {
			t.Fatalf("summary %+v", summary)
		}
		byTask, e := dao.TaskMetrics(ctx, filter)
		if e != nil {
			return e
		}
		if byTask[*r.TaskID].MeasurementRecords != "1" {
			t.Fatal(byTask)
		}
		revision, e = dao.Revision(ctx, filter)
		if e != nil {
			return e
		}
		rows, e := dao.Records(ctx, store.UsageFilter{ProjectID: *r.ProjectID, Kind: "measurement", Limit: 1})
		if e != nil {
			return e
		}
		if len(rows) != 1 {
			t.Fatal(rows)
		}
		return nil
	}
	if err = db.ReadUsage(ctx, read); err != nil {
		t.Fatal(err)
	}
	duplicate := r
	duplicate.ID = uuid.NewString()
	c, err = db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Insert(ctx, duplicate) })
	if err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatal("unique insert", c, err)
	}
	updated := r
	updated.RowVersion = "2"
	updated.Metrics.Total = core.Ptr("0")
	updated.UpdatedAt = r.UpdatedAt.Add(time.Second)
	c, err = db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Replace(ctx, updated, "0") })
	if err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatal("CAS", c, err)
	}
	stop := errors.New("rollback")
	c, err = db.WriteUsage(ctx, func(s store.UsageScope) error {
		if e := s.UsageDAO().Replace(ctx, updated, "1"); e != nil {
			return e
		}
		return stop
	})
	if !errors.Is(err, stop) || c.Outcome != store.TransactionNotCommitted {
		t.Fatal(c, err)
	}
	if err = db.ReadUsage(ctx, read); err != nil {
		t.Fatal(err)
	}
	c, err = db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Replace(ctx, updated, "1") })
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatal(c, err)
	}
	if err = db.ReadUsage(ctx, func(s store.UsageScope) error {
		next, e := s.UsageDAO().Revision(ctx, store.UsageFilter{ProjectID: *r.ProjectID})
		if e != nil {
			return e
		}
		if next.Hash == revision.Hash {
			t.Fatal("revision unchanged")
		}
		got, e := s.UsageDAO().Source(ctx, r, *r.SourceKey)
		if e != nil {
			return e
		}
		if core.Value(got.Metrics.Total) != "0" {
			t.Fatal(got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	dao := pgusage.New(tx)
	if _, err = dao.Now(ctx); err == nil {
		t.Fatal("closed transaction success")
	}
}
func TestUsageAggregatePrecisionAndFilters(t *testing.T) {
	db := testutil.OpenStore(t, postgres.Open)
	ctx := t.Context()
	r := sampleRecord()
	c, err := db.WriteUsage(ctx, func(s store.UsageScope) error {
		for i := 0; i < 4; i++ {
			copy := r
			copy.ID = uuid.NewString()
			copy.SourceKey = core.Ptr(copy.ID)
			switch i {
			case 0:
				copy.Metrics.Input = core.Ptr(strings.Repeat("9", 38))
			case 1:
				copy.Metrics.Input = core.Ptr(strings.Repeat("9", 38))
			case 2:
				copy.Metrics = model.UsageMetrics{}
			case 3:
				copy.AggregationRole = core.Ptr("included")
			}
			if e := s.UsageDAO().Insert(ctx, copy); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatal(c, err)
	}
	err = db.ReadUsage(ctx, func(s store.UsageScope) error {
		dao := s.UsageDAO()
		summary, e := dao.Metrics(ctx, store.UsageFilter{ProjectID: *r.ProjectID})
		if e != nil {
			return e
		}
		if core.Value(summary.Metrics["inputTokens"].Known) != "199999999999999999999999999999999999998" || summary.Metrics["inputTokens"].UnknownRecords != "1" || summary.MeasurementRecords != "3" {
			t.Fatalf("%+v", summary)
		}
		none, e := dao.Metrics(ctx, store.UsageFilter{ProjectID: uuid.NewString()})
		if e != nil {
			return e
		}
		if none.Metrics["inputTokens"].Known != nil || none.MeasurementRecords != "0" {
			t.Fatal(none)
		}
		filtered, e := dao.Records(ctx, store.UsageFilter{ProjectID: *r.ProjectID, Role: "included", Limit: 100})
		if e != nil {
			return e
		}
		if len(filtered) != 1 {
			t.Fatal(filtered)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestUsageStateUniquenessAndGrantLock(t *testing.T) {
	db := testutil.OpenStore(t, postgres.Open)
	ctx := t.Context()
	r := sampleRecord()
	r.Kind = "execution_state"
	r.StateID = nil
	r.SourceKey = nil
	r.Metrics = model.UsageMetrics{}
	r.Capability = &model.UsageCapability{ProfileID: r.ProfileID}
	r.CollectionState = core.Ptr("collecting")
	r.StateSequence = core.Ptr("0")
	r.RegistrationID = core.Ptr(uuid.NewString())
	r.GrantHash = (core.GrantVerifier{}).Encode()
	end := r.CreatedAt.Add(time.Hour)
	r.GrantExpiresAt = &end
	_, err := db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Insert(ctx, r) })
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"generation", "anchor"} {
		copy := r
		copy.ID = uuid.NewString()
		if kind == "anchor" {
			copy.SessionID = uuid.NewString()
		}
		completion, e := db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Insert(ctx, copy) })
		if e == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatal(kind, completion, e)
		}
	}
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	dao := pgusage.New(holder)
	if err = dao.Guard(ctx, r); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 80*time.Millisecond)
	defer cancel()
	_, err = db.Pool.Exec(waitCtx, `UPDATE usage_records SET grant_revoked_at=clock_timestamp() WHERE id=$1`, r.ID)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("grant guard did not block revoke: %v", err)
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, db.Pool, `UPDATE usage_records SET grant_revoked_at=clock_timestamp() WHERE id=$1`, r.ID)
	_, err = db.WriteUsage(ctx, func(s store.UsageScope) error { return s.UsageDAO().Guard(ctx, r) })
	if err == nil {
		t.Fatal("revoked grant accepted")
	}
}
