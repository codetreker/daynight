package assistanttask_test

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMetricsAggregateTheTaskWindowFromRecordsEventsAndClosures(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	foreignTask := uuid.NewString()
	// Ages are relative to statement time, so one row uses one clock reading; 31 days lies outside the 30-day window.
	type row struct {
		task string
		age  string
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	record := func(r row, kind string, outcome *string) {
		exec(`INSERT INTO assistant_task_records(id,owner_user_id,task_id,request_fingerprint,author,kind,text,refs,created_at,outcome) VALUES($1,$2,$3,'f','bot',$4,'text','[]',statement_timestamp()-$5::interval,$6)`, uuid.NewString(), f.owner, r.task, kind, r.age, outcome)
	}
	event := func(r row, kind string) {
		exec(`INSERT INTO assistant_task_events(id,owner_user_id,task_id,request_fingerprint,target_bot_id,type,payload,state,attention,created_at) VALUES($1,$2,$3,'f',$4,$5,'{}','pending',false,statement_timestamp()-$6::interval)`, uuid.NewString(), f.owner, r.task, uuid.NewString(), kind, r.age)
	}
	closure := func(r row, item string, episode int64, duration *string) {
		exec(`INSERT INTO assistant_task_item_closures(id,owner_user_id,task_id,item_id,episode,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,statement_timestamp()-$6::interval-$7::interval,statement_timestamp()-$6::interval)`, uuid.NewString(), f.owner, r.task, item, episode, r.age, duration)
	}
	in, old, foreign := row{f.task.ID, "1 day"}, row{f.task.ID, "31 days"}, row{foreignTask, "1 day"}
	outcome := func(v string) *string { return &v }
	hour, threeHours := "1 hour", "3 hours"
	for _, r := range []row{in, in, old, foreign} {
		record(r, "action", nil)
	}
	record(in, "note", nil)
	for _, value := range []string{"effective", "effective", "ineffective", "inconclusive"} {
		record(in, "outcome", outcome(value))
	}
	record(old, "outcome", outcome("ineffective"))
	record(foreign, "outcome", outcome("effective"))
	for _, kind := range []string{"escalation", "escalation", "result_unknown", "report"} {
		event(in, kind)
	}
	event(old, "escalation")
	event(foreign, "result_unknown")
	recurring, first := uuid.NewString(), uuid.NewString()
	closure(in, first, 1, &hour)
	closure(in, recurring, 2, &threeHours)
	closure(in, uuid.NewString(), 1, nil)
	closure(old, uuid.NewString(), 3, &hour)
	closure(foreign, uuid.NewString(), 2, &hour)
	// A recurrence still open in the window counts once beside closed ones.
	exec(`INSERT INTO assistant_task_items(id,owner_user_id,task_id,request_fingerprint,key,episode,state,category,app_state,version,created_at,updated_at,opened_at) VALUES($1,$2,$3,'f','again',2,'open','','{}',1,statement_timestamp(),statement_timestamp(),statement_timestamp()-interval '2 hours')`, uuid.NewString(), f.owner, f.task.ID)
	exec(`INSERT INTO assistant_task_items(id,owner_user_id,task_id,request_fingerprint,key,episode,state,category,app_state,version,created_at,updated_at,opened_at,closed_at) VALUES($1,$2,$3,'f','closed',2,'closed','','{}',1,statement_timestamp(),statement_timestamp(),statement_timestamp()-interval '5 hours',statement_timestamp()-interval '2 hours')`, recurring, f.owner, f.task.ID)

	var got model.AssistantTaskMetrics
	f.write(t, func(d store.AssistantTaskDAO) error {
		before, err := d.Now(ctx)
		if err != nil {
			return err
		}
		got, err = d.Metrics(ctx, f.owner, f.task.ID, 30*24*time.Hour)
		if err != nil {
			return err
		}
		if got.ObservedAt.Before(before) || got.WindowEnd != got.ObservedAt || got.WindowStart != got.ObservedAt.Add(-30*24*time.Hour) || got.ObservedAt.Location() != time.UTC {
			t.Fatalf("window bounds: before=%s %+v", before, got)
		}
		return nil
	})
	average := 2 * time.Hour
	got.ObservedAt, got.WindowStart, got.WindowEnd = time.Time{}, time.Time{}, time.Time{}
	want := model.AssistantTaskMetrics{ActionCount: 2, EffectiveCount: 2, IneffectiveCount: 1, InconclusiveCount: 1, EscalationCount: 2, ResultUnknownCount: 1,
		ClosureCount: 3, UntimedClosureCount: 1, RecurringItemCount: 2, AverageResolution: &average}
	if got.AverageResolution == nil || *got.AverageResolution != average {
		t.Fatalf("average resolution: %v", got.AverageResolution)
	}
	got.AverageResolution = want.AverageResolution
	if got != want {
		t.Fatalf("metrics=%+v want %+v", got, want)
	}

	// Another owner sees nothing, and a window without timed closures has no average.
	f.write(t, func(d store.AssistantTaskDAO) error {
		empty, err := d.Metrics(ctx, uuid.NewString(), f.task.ID, 30*24*time.Hour)
		if err != nil {
			return err
		}
		if empty.ActionCount != 0 || empty.ClosureCount != 0 || empty.RecurringItemCount != 0 || empty.AverageResolution != nil {
			t.Fatalf("foreign owner metrics: %+v", empty)
		}
		return nil
	})
}
