package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaptureAudienceAndPersistence(t *testing.T) {
	ctx := context.Background()
	databaseURL := testutil.ScopedDatabaseURL(t)
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	schema, err := os.ReadFile("../schema/current.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	projectID, userID, teamID, taskID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{userID, "capture:" + userID}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, []any{teamID, userID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, userID}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'capture','capture')`, []any{projectID}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{projectID, teamID}},
		{`INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'source')`, []any{taskID, projectID}},
	} {
		if _, err = conn.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d := New(tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	configuration := sampleDestination()
	ep := model.Endpoint{ID: uuid.NewString(), Owner: model.Owner{Kind: "personal", ID: userID}, Name: "endpoint", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationConfiguration: configuration, ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 51; i++ {
		subID := uuid.NewString()
		sub := model.Subscription{ID: subID, EndpointID: ep.ID, ProjectID: projectID, Owner: ep.Owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
		if err = d.PutSubscription(ctx, sub); err != nil {
			t.Fatal(err)
		}
		if err = d.PutBinding(ctx, model.Binding{ID: uuid.NewString(), SubscriptionID: subID, EventType: "task.created", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d = New(tx)
	// Production capture follows a source write; allocate its transaction ID
	// here because this fixture reads an already committed source.
	if _, err = tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
		t.Fatal(err)
	}
	if _, err = NewProjectCapture(tx, projectID).FreezeAudience(ctx, uuid.NewString(), []string{"task.created"}); err == nil {
		t.Fatal("accepted an audience for another project")
	}
	if _, err = d.FreezeAudience(ctx, projectID, nil); err == nil {
		t.Fatal("accepted an empty capture batch")
	}
	if _, err = d.FreezeAudience(ctx, projectID, []string{"task.created", "task.created"}); err == nil {
		t.Fatal("accepted duplicate capture types")
	}
	if _, err = d.FreezeAudience(ctx, uuid.NewString(), []string{"task.created"}); err == nil {
		t.Fatal("accepted an unavailable project")
	}
	audience, err := d.FreezeAudience(ctx, projectID, []string{"task.created", "task.paused"})
	if err != nil {
		t.Fatal(err)
	}
	if len(audience) != 51 {
		t.Fatalf("got %d matches", len(audience))
	}
	for _, a := range audience {
		if a.EventType != "task.created" || a.Endpoint.ID != ep.ID || a.ProjectID != projectID || a.AuthorizationEpoch != 1 || !bytes.Equal(a.Endpoint.DestinationConfiguration, configuration) {
			t.Fatalf("unexpected audience: %+v", a)
		}
	}
	other, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(ctx)
	if _, err = other.Exec(ctx, `UPDATE webhook_endpoints SET enabled=false,destination_revision=2,destination_configuration=$2 WHERE id=$1`, ep.ID, []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/changed"}}`)); err != nil {
		t.Fatal(err)
	}
	later, err := d.FreezeAudience(ctx, projectID, []string{"task.created"})
	if err != nil || len(later) != 0 {
		t.Fatalf("new snapshot audience=%+v err=%v", later, err)
	}
	if audience[0].Endpoint.DestinationRevision != 1 || !bytes.Equal(audience[0].Endpoint.DestinationConfiguration, configuration) {
		t.Fatalf("frozen destination changed: %+v", audience[0].Endpoint)
	}
	policy, err := d.Policy(ctx, 1)
	if err != nil || policy.Version != 1 {
		t.Fatalf("policy=%+v err=%v", policy, err)
	}
	recorded, err := d.RecordedAt(ctx)
	if err != nil || recorded.IsZero() {
		t.Fatalf("recorded=%v err=%v", recorded, err)
	}
	fact := []byte(`{"projectId":"` + projectID + `"}`)
	body := []byte(`{"specversion":"1.0"}`)
	factHash, bodyHash := sha256.Sum256(fact), sha256.Sum256(body)
	version := int64(1)
	event := store.WebhookCapturedEvent{ID: uuid.NewString(), EventType: "task.created", WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + projectID, Subject: "tasks/" + taskID, ProjectID: projectID, TaskID: taskID, TaskVersion: &version, OccurredAt: now, RecordedAt: recorded, FactCodecVersion: 1, FactBytes: fact, FactSHA256: factHash[:]}
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	matches := make([]store.WebhookCapturedMatch, 0, len(audience))
	for _, a := range audience {
		matches = append(matches, store.WebhookCapturedMatch{SubscriptionID: a.SubscriptionID, BindingID: a.BindingID, ProjectID: a.ProjectID, EventType: a.EventType, AuthorizationEpoch: a.AuthorizationEpoch})
	}
	proof := sha256.Sum256([]byte("proof"))
	delivery := store.WebhookCapturedDelivery{ID: uuid.NewString(), EndpointID: ep.ID, Owner: ep.Owner, OriginalMatchSHA256: proof[:], PolicyVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: 1, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationOrigin: ep.Origin, DestinationConfiguration: configuration, RequestMethod: "POST", RequestMediaType: "application/cloudevents+json", DeterministicHeadersJSON: []byte("[]"), Body: body, BodySHA256: bodyHash[:], AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), PayloadExpiresAt: now.Add(7 * 24 * time.Hour), LastActivityAt: recorded, MetadataExpiresAt: recorded.Add(30 * 24 * time.Hour), Matches: matches}
	wrongProject := event
	wrongProject.ProjectID = uuid.NewString()
	if err = NewProjectCapture(tx, projectID).SaveCapture(ctx, wrongProject, []store.WebhookCapturedDelivery{delivery}); err == nil {
		t.Fatal("saved an event outside the source project")
	}
	if err = NewProjectCapture(tx, projectID).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery}); err != nil {
		t.Fatal(err)
	}
	var count int64
	var queue int64
	if err = tx.QueryRow(ctx, `SELECT original_match_count,queue_order FROM webhook_deliveries WHERE id=$1`, delivery.ID).Scan(&count, &queue); err != nil {
		t.Fatal(err)
	}
	if count != 51 || queue <= 0 {
		t.Fatalf("count=%d queue=%d", count, queue)
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$1`, delivery.ID).Scan(&count); err != nil || count != 51 {
		t.Fatalf("persisted matches=%d err=%v", count, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	admissionTx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	sources, err := New(admissionTx).AdmissionSources(ctx, delivery.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	lockedDelivery, err := New(admissionTx).LockDelivery(ctx, delivery.ID)
	if err != nil || lockedDelivery.ID != delivery.ID || !bytes.Equal(lockedDelivery.DestinationConfiguration, configuration) || bytes.Equal(sources.Endpoint.DestinationConfiguration, configuration) || !sources.ProjectEligible || !sources.TaskPresent || !sources.EndpointPresent || sources.Endpoint.DestinationRevision != 2 || len(sources.Matches) != 51 {
		t.Fatalf("admission sources=%+v delivery=%+v err=%v", sources, lockedDelivery, err)
	}
	for _, match := range sources.Matches {
		if !match.Continuous {
			t.Fatal("original active proof lost continuity")
		}
	}
	if err = admissionTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// An authorization revocation that takes the membership row first must
	// block admission, which then observes the committed loss of access.
	blockedCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	writer, err := other.Begin(blockedCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	var writerPID int
	if err = writer.QueryRow(blockedCtx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Exec(blockedCtx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, userID); err != nil {
		t.Fatal(err)
	}
	reader, err := pgx.Connect(blockedCtx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	var readerPID int
	if err = reader.QueryRow(blockedCtx, `SELECT pg_backend_pid()`).Scan(&readerPID); err != nil {
		t.Fatal(err)
	}
	type admissionResult struct {
		sources store.WebhookAdmissionSources
		err     error
	}
	result := make(chan admissionResult, 1)
	go func() {
		tx, e := reader.Begin(blockedCtx)
		if e != nil {
			result <- admissionResult{err: e}
			return
		}
		s, e := New(tx).AdmissionSources(blockedCtx, delivery.ID, now)
		_ = tx.Rollback(context.Background())
		result <- admissionResult{s, e}
	}()
	for {
		var blocked bool
		if err = conn.QueryRow(blockedCtx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, writerPID, readerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-blockedCtx.Done():
			t.Fatal("admission did not block on revocation")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err = writer.Commit(blockedCtx); err != nil {
		t.Fatal(err)
	}
	observed := <-result
	if observed.err != nil || observed.sources.ProjectEligible {
		t.Fatalf("revocation observed eligible=%v err=%v", observed.sources.ProjectEligible, observed.err)
	}
	if _, err = conn.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, teamID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `UPDATE projects SET deleted_at=$2 WHERE id=$1`, projectID, now); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, `DELETE FROM teams WHERE id=$1`, teamID); err != nil {
		t.Fatal(err)
	}
	admissionTx, err = conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	sources, err = New(admissionTx).AdmissionSources(ctx, delivery.ID, now)
	if err != nil || sources.ProjectEligible {
		t.Fatalf("deleted project with removed Team: eligible=%v err=%v", sources.ProjectEligible, err)
	}
	if err = admissionTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// A failed match insert aborts the event and delivery alongside source writes.
	tx2, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx2.Rollback(ctx)
	event.ID = uuid.NewString()
	delivery.ID = uuid.NewString()
	delivery.Matches = append(delivery.Matches, delivery.Matches[0])
	if err = New(tx2).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery}); err == nil {
		t.Fatal("duplicate match accepted")
	}
	if err = tx2.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM webhook_events WHERE id=$1`, event.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed event count=%d err=%v", count, err)
	}
	tx3, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = New(tx3).FreezeAudience(ctx, "not-a-uuid", []string{"task.created"}); err == nil {
		t.Fatal("invalid project query did not fail")
	}
	if err = tx3.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx4, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = New(tx4).RecordedAt(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled capture timestamp: %v", err)
	}
	_ = tx4.Rollback(ctx)
}
