package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type bindingContextKey struct{}

type outputBindingStore struct {
	*borrowedStore
	marker    error
	snapshots int
	families  int
	sessions  int
}

func (s *outputBindingStore) checkContext(ctx context.Context) {
	s.t.Helper()
	if ctx == nil || ctx.Err() != nil || ctx.Value(bindingContextKey{}) != s.marker {
		s.t.Error("output used another application's request context")
	}
}

func (s *outputBindingStore) ReadSnapshot(ctx context.Context, _ func(store.SnapshotScope) error) error {
	s.checkContext(ctx)
	s.snapshots++
	return s.marker
}

func (s *outputBindingStore) WriteCredentialFamily(ctx context.Context, _ func(store.CredentialFamilyScope) error) (store.Completion, error) {
	s.checkContext(ctx)
	s.families++
	return store.Completion{Outcome: store.TransactionNotCommitted}, s.marker
}

func (s *outputBindingStore) WriteSession(ctx context.Context, _ func(store.SessionScope) error) (store.Completion, error) {
	s.checkContext(ctx)
	s.sessions++
	return store.Completion{Outcome: store.TransactionNotCommitted}, s.marker
}

func distinctConcreteOutputs[T comparable](t *testing.T, name string, first, second any, zero T) {
	t.Helper()
	one, oneOK := first.(T)
	two, twoOK := second.(T)
	if !oneOK || !twoOK || one == zero || two == zero || one == two {
		t.Fatalf("%s outputs do not retain distinct production instances: %T / %T", name, first, second)
	}
}

func TestApplicationOutputsKeepInstanceBindings(t *testing.T) {
	newApp := func(marker error) (*Application, *outputBindingStore) {
		database, files := borrowedDependencies(t)
		bound := &outputBindingStore{borrowedStore: database, marker: marker}
		app := New(bound, files, nil, "https://daynight.test/callback", time.Second)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := app.Engine.Stop(ctx); err != nil {
				t.Error(err)
			}
		})
		return app, bound
	}
	first, firstStore := newApp(errors.New("first application store"))
	second, secondStore := newApp(errors.New("second application store"))
	distinctConcreteOutputs(t, "Projects", first.Projects, second.Projects, (*project.Projects)(nil))
	distinctConcreteOutputs(t, "Memberships", first.Memberships, second.Memberships, (*project.Memberships)(nil))
	distinctConcreteOutputs(t, "Teams", first.Teams, second.Teams, (*team.Teams)(nil))
	distinctConcreteOutputs(t, "Bots", first.Bots, second.Bots, (*bot.Bots)(nil))
	distinctConcreteOutputs(t, "BotDeletions", first.BotDeletions, second.BotDeletions, (*bot.Deletions)(nil))
	distinctConcreteOutputs(t, "Tasks", first.Tasks, second.Tasks, (*task.Tasks)(nil))
	distinctConcreteOutputs(t, "TaskThreads", first.TaskThreads, second.TaskThreads, (*task.TaskThreads)(nil))
	distinctConcreteOutputs(t, "Attachments", first.Attachments, second.Attachments, (*attachment.Attachments)(nil))
	distinctConcreteOutputs(t, "OAuth", first.OAuth, second.OAuth, (*oauth.Authenticator)(nil))
	if first.Engine == second.Engine || first.Sessions == second.Sessions || first.Sessions.Engine != first.Engine || second.Sessions.Engine != second.Engine {
		t.Fatal("applications do not retain separate session resource owners")
	}
	if first.Downloads != nil || first.Uploads != nil || second.Downloads != nil || second.Uploads != nil {
		t.Fatal("application assembled private transfers without their outer storage owner")
	}
	const projectID = "33333333-3333-4333-8333-333333333333"
	const taskID = "55555555-5555-4555-8555-555555555555"
	const botID = "66666666-6666-4666-8666-666666666666"
	principal := model.Principal{Kind: model.PATCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	for _, binding := range []struct {
		app   *Application
		store *outputBindingStore
	}{{first, firstStore}, {second, secondStore}, {first, firstStore}} {
		ctx := context.WithValue(t.Context(), bindingContextKey{}, binding.store.marker)
		for _, operation := range []struct {
			name string
			run  func() error
		}{
			{"Projects", func() error { _, err := binding.app.Projects.Get(ctx, principal, projectID); return err }},
			{"Memberships", func() error { _, err := binding.app.Memberships.ListWithAccess(ctx, principal, projectID); return err }},
			{"Teams", func() error { _, err := binding.app.Teams.Get(ctx, principal, projectID); return err }},
			{"Bots", func() error { _, err := binding.app.Bots.Get(ctx, principal, botID); return err }},
			{"Tasks", func() error { _, err := binding.app.Tasks.Get(ctx, principal, projectID, taskID); return err }},
			{"TaskThreads", func() error {
				_, err := binding.app.TaskThreads.List(ctx, principal, projectID, taskID, task.ThreadListRequest{Count: 1})
				return err
			}},
			{"Attachments", func() error {
				_, err := binding.app.Attachments.List(ctx, principal, projectID, taskID, model.PageRequest{Limit: 1})
				return err
			}},
			{"OAuth", func() error {
				_, err := binding.app.OAuth.AuthenticateAccess(ctx, "access", "https://daynight.test/mcp")
				return err
			}},
			{"BotDeletions", func() error {
				_, err := binding.app.BotDeletions.DeleteBot(ctx, principal, botID, store.DeleteBot{Version: 1, DeletionID: taskID})
				return err
			}},
		} {
			if err := operation.run(); !errors.Is(err, binding.store.marker) {
				t.Fatalf("%s used another application's store: %v", operation.name, err)
			}
		}
	}
	if firstStore.snapshots != 14 || secondStore.snapshots != 7 || firstStore.families != 2 || secondStore.families != 1 || firstStore.sessions != 2 || secondStore.sessions != 1 {
		t.Fatalf("output calls crossed application instances: first snapshots/families/sessions=%d/%d/%d, second=%d/%d/%d", firstStore.snapshots, firstStore.families, firstStore.sessions, secondStore.snapshots, secondStore.families, secondStore.sessions)
	}
}
