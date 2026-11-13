package github_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestGitHubWorkRuntimeAndConditionalHints(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	tx := begin(t, db, pgx.TxOptions{})
	hint, request, token := uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	mustExec(t, tx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,app_id,installation_id,repository_id,access_state,access_hint_id,access_delivery_id,last_webhook_received_at) VALUES($1,2,1,7,true,10,20,30,'available',$2,'delivery',$3)`, id, hint, now)
	mustExec(t, tx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES ($1,42,1,$2,'delivery',$3,$3)`, id, request, now)
	w := github.NewWriter(tx, id)
	clock, err := w.ObservedAt(ctx)
	if err != nil {
		t.Fatal(err)
	}
	claim := store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "webhook", Until: clock.Add(5 * time.Minute)}
	ok, err := w.Claim(ctx, claim)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	c, err := w.Connection(ctx)
	if err != nil || c.Revision != 8 {
		t.Fatalf("claim revision: %+v %v", c, err)
	}
	lease := store.GitHubLease{Generation: 1, Token: token}
	if ok, err = w.Renew(ctx, lease, clock.Add(time.Minute)); err != nil || ok {
		t.Fatalf("short renewal: %v %v", ok, err)
	}
	p, valid, err := w.HasPending(ctx, lease)
	if err != nil || !valid || !p {
		t.Fatalf("pending: %v %v %v", p, valid, err)
	}
	if ok, err = w.ReschedulePending(ctx, lease, 42, uuid.NewString(), now.Add(time.Hour)); err != nil || ok {
		t.Fatalf("stale reschedule: %v %v", ok, err)
	}
	later := now.Add(time.Hour)
	if ok, err = w.ReschedulePending(ctx, lease, 42, request, later); err != nil || !ok {
		t.Fatalf("reschedule: %v %v", ok, err)
	}
	pending, valid, err := w.Pending(ctx, lease, now.Add(time.Minute), 10)
	if err != nil || !valid || len(pending) != 0 {
		t.Fatalf("rescheduled due: %+v %v %v", pending, valid, err)
	}
	p, valid, err = w.HasPending(ctx, lease)
	if err != nil || !valid || !p {
		t.Fatalf("non-due remains pending: %v %v %v", p, valid, err)
	}
	if ok, err = w.AckAccessHint(ctx, lease, uuid.NewString()); err != nil || ok {
		t.Fatalf("stale access ack: %v %v", ok, err)
	}
	if ok, err = w.AckAccessHint(ctx, lease, hint); err != nil || !ok {
		t.Fatalf("access ack: %v %v", ok, err)
	}
	observed := store.GitHubRepositoryObservation{InstallationID: 20, RepositoryID: 30, InstallationAccountLogin: "org", RepositoryFullName: "org/renamed", RepositoryPrivate: true}
	wrong := observed
	wrong.RepositoryID = 31
	if ok, err = w.PublishRepository(ctx, lease, wrong); err != nil || ok {
		t.Fatalf("different repo: %v %v", ok, err)
	}
	if ok, err = w.PublishRepository(ctx, lease, observed); err != nil || !ok {
		t.Fatalf("repository observation: %v %v", ok, err)
	}
	if ok, err = w.PublishRepository(ctx, lease, observed); err != nil || !ok {
		t.Fatalf("same observation: %v %v", ok, err)
	}
	c, err = w.Connection(ctx)
	if err != nil || c.Revision != 9 || *c.RepositoryID != 30 || *c.RepositoryFullName != "org/renamed" || !*c.RepositoryPrivate || *c.InstallationAccountLogin != "org" || c.AccessHintID != nil || c.AccessDeliveryID != nil {
		t.Fatalf("repository and hint: %+v %v", c, err)
	}
	failure := "network"
	message := "retry later"
	gen := int64(1)
	runtime := store.GitHubRuntimeWrite{ExpectedRevision: 8, Revision: 10, AccessState: "unavailable", AccessReason: &failure, AccessCheckedAt: &now, NextAccessCheckAt: &later, NextPollAt: &later, NotBefore: &later, LastPollAttemptAt: &now, LastFullSuccessAt: &now, LastFullGeneration: &gen, PollErrorCode: &failure, PollErrorMessage: &message, PollErrorAt: &now, LastWebhookAttemptAt: &now, LastWebhookSuccessAt: &now, WebhookErrorCode: &failure, WebhookErrorMessage: &message, WebhookErrorAt: &now}
	if ok, err = w.SaveRuntime(ctx, lease, runtime); err != nil || ok {
		t.Fatalf("stale runtime: %v %v", ok, err)
	}
	runtime.ExpectedRevision = 9
	if ok, err = w.SaveRuntime(ctx, lease, runtime); err != nil || !ok {
		t.Fatalf("runtime: %v %v", ok, err)
	}
	c, err = w.Connection(ctx)
	if err != nil || c.Revision != 10 || c.AccessState != "unavailable" || *c.AccessReason != failure || !c.NextAccessCheckAt.Equal(later) || !c.NextPollAt.Equal(later) || !c.NotBefore.Equal(later) || !c.LastPollAttemptAt.Equal(now) || !c.LastFullSuccessAt.Equal(now) || *c.LastFullGeneration != 1 || *c.PollErrorCode != failure || *c.PollErrorMessage != message || !c.PollErrorAt.Equal(now) || !c.LastWebhookAttemptAt.Equal(now) || !c.LastWebhookSuccessAt.Equal(now) || *c.WebhookErrorCode != failure || *c.WebhookErrorMessage != message || !c.WebhookErrorAt.Equal(now) || !c.LastWebhookReceivedAt.Equal(now) || *c.RepositoryID != 30 {
		t.Fatalf("runtime readback: %+v %v", c, err)
	}
	if ok, err = w.AckPending(ctx, lease, 42, request); err != nil || !ok {
		t.Fatalf("pending ack: %v %v", ok, err)
	}
	p, valid, err = w.HasPending(ctx, lease)
	if err != nil || !valid || p {
		t.Fatalf("empty pending: %v %v %v", p, valid, err)
	}
	runtime.ExpectedRevision = 10
	runtime.Revision = 11
	runtime.ReleaseClaim = true
	if ok, err = w.SaveRuntime(ctx, lease, runtime); err != nil || !ok {
		t.Fatalf("release: %v %v", ok, err)
	}
	c, err = w.Connection(ctx)
	if err != nil || c.ClaimToken != nil || c.ClaimUntil != nil || c.ClaimKind != nil {
		t.Fatalf("released: %+v %v", c, err)
	}
	if ok, err = w.PublishRepository(ctx, lease, observed); err != nil || ok {
		t.Fatalf("released lease publish: %v %v", ok, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	check := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	c, err = github.NewReader(check).Connection(ctx, id)
	if err != nil || !reflect.DeepEqual(c, githubpr.DefaultConnection(id)) {
		t.Fatalf("rollback: %+v %v", c, err)
	}
}

func TestGitHubBindingsAndSignalReceptionTime(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	tx := begin(t, db, pgx.TxOptions{})
	other, deleted, different := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, project := range []string{id, other, deleted, different} {
		mustExec(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,'project','https://example.test/repo')`, project)
	}
	mustExec(t, tx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, deleted)
	for _, project := range []string{id, other, deleted} {
		mustExec(t, tx, `INSERT INTO project_github(project_id,enabled,app_id,installation_id,repository_id) VALUES($1,true,10,20,30)`, project)
	}
	mustExec(t, tx, `INSERT INTO project_github(project_id,enabled,app_id,installation_id,repository_id) VALUES($1,true,10,20,31)`, different)
	r := github.NewReader(tx)
	repo := int64(30)
	found, err := r.Bindings(ctx, store.GitHubBindingsQuery{AppID: 10, InstallationID: 20, RepositoryID: &repo, Limit: 100})
	if err != nil || len(found) != 2 || found[0].ProjectID >= found[1].ProjectID {
		t.Fatalf("bindings: %+v %v", found, err)
	}
	page, err := r.Bindings(ctx, store.GitHubBindingsQuery{AppID: 10, InstallationID: 20, RepositoryID: &repo, AfterProjectID: &found[0].ProjectID, Limit: 1})
	if err != nil || len(page) != 1 || page[0].ProjectID != found[1].ProjectID {
		t.Fatalf("binding cursor: %+v %v", page, err)
	}
	all, err := r.Bindings(ctx, store.GitHubBindingsQuery{AppID: 10, InstallationID: 20, Limit: 100})
	if err != nil || len(all) != 3 {
		t.Fatalf("all repositories: %+v %v", all, err)
	}
	if _, err = r.Bindings(ctx, store.GitHubBindingsQuery{Limit: 101}); err == nil {
		t.Fatal("accepted unbounded bindings")
	}
	latest := time.Now().UTC().Truncate(time.Microsecond)
	older := latest.Add(-time.Minute)
	sig := github.NewSignalWriter(tx)
	first, second := uuid.NewString(), uuid.NewString()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 42, RequestID: first, DeliveryID: "newer", ReceivedAt: latest, NextAttemptAt: latest}
	if n, err := sig.SignalPullRequest(ctx, signal); err != nil || n != 2 {
		t.Fatalf("signal: %d %v", n, err)
	}
	signal.RequestID, signal.DeliveryID, signal.ReceivedAt, signal.NextAttemptAt = second, "older", older, older
	if n, err := sig.SignalPullRequest(ctx, signal); err != nil || n != 2 {
		t.Fatalf("older signal: %d %v", n, err)
	}
	c, err := r.Connection(ctx, id)
	if err != nil || c.LastWebhookReceivedAt == nil || !c.LastWebhookReceivedAt.Equal(latest) {
		t.Fatalf("reception regressed: %+v %v", c, err)
	}
	var gotID, delivery string
	var received time.Time
	if err = tx.QueryRow(ctx, `SELECT request_id::text,delivery_id,received_at FROM project_github_pending_prs WHERE project_id=$1 AND number=42`, id).Scan(&gotID, &delivery, &received); err != nil || gotID != second || delivery != "older" || !received.Equal(older) {
		t.Fatalf("last committed hint: %s %s %v %v", gotID, delivery, received, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	fresh := begin(t, db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	c, err = github.NewReader(fresh).Connection(ctx, id)
	if err != nil || !c.LastWebhookReceivedAt.Equal(latest) {
		t.Fatalf("committed reception: %+v %v", c, err)
	}
}

func TestGitHubWorkRefusalsAndCancellation(t *testing.T) {
	db, id := dbFixture(t)
	ctx := t.Context()
	tx := begin(t, db, pgx.TxOptions{})
	mustExec(t, tx, `INSERT INTO project_github(project_id,enabled,app_id,generation) VALUES ($1,true,10,1)`, id)
	w := github.NewWriter(tx, id)
	token := uuid.NewString()
	now, err := w.ObservedAt(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, claim := range []store.GitHubClaim{{AppID: 10, Generation: 1, Token: token, Kind: "poll", Until: now.Add(-time.Minute)}, {AppID: 11, Generation: 1, Token: token, Kind: "poll", Until: now.Add(time.Minute)}, {AppID: 10, Generation: 2, Token: token, Kind: "poll", Until: now.Add(time.Minute)}} {
		if ok, err := w.Claim(ctx, claim); err != nil || ok {
			t.Fatalf("refused claim: %+v %v %v", claim, ok, err)
		}
	}
	lease := store.GitHubLease{Generation: 1, Token: token}
	if _, _, err = w.Pending(ctx, lease, now, 101); err == nil {
		t.Fatal("accepted unbounded pending")
	}
	if _, _, err = w.UnseenActive(ctx, lease, token, 0, 101); err == nil {
		t.Fatal("accepted unbounded unseen")
	}
	if _, err = github.NewWorkReader(db.Pool).DueGitHubProjects(ctx, 10, now, 33); err == nil {
		t.Fatal("accepted unbounded work scan")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = w.ValidLease(cancelled, lease); !errors.Is(err, context.Canceled) {
		t.Fatalf("lease cancellation: %v", err)
	}
}
