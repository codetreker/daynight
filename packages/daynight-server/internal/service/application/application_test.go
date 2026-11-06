package application

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

func TestApplicationSharesSessionEngineAndBusinessStore(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	app := New(database, files, nil, "https://daynight.test/callback", time.Second)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})

	app.Sessions.SetOrigin("https://daynight.test")
	if app.Sessions.Engine != app.Engine || app.Engine.Origin != "https://daynight.test" {
		t.Fatal("session service does not share the application engine")
	}
	op, err := app.Sessions.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := app.Engine.Stop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("engine stopped with active session operation: %v", err)
	}
	op.Close()
	if err := app.Engine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Sessions.BeginOperation(); err == nil {
		t.Fatal("session service admitted work after engine stop")
	}

	ctx = context.Background()
	project, err := app.Projects.Create(ctx, principal, projectcore.CreateProject{ExpectedUserID: principal.UserID, Name: "Shared application", RepoURL: "git@host:shared"})
	if err != nil {
		t.Fatal(err)
	}
	task, err := app.Tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Attachment owner"})
	if err != nil {
		t.Fatal(err)
	}
	attachment, created, err := app.Attachments.Put(ctx, principal, project.ID, task.ID, "sample.txt", "text/plain", strings.NewReader("shared data"))
	if err != nil || !created {
		t.Fatalf("put attachment: %v, created %v", err, created)
	}
	metadata, object, err := app.Attachments.Open(ctx, principal, project.ID, task.ID, "sample.txt")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "shared data" || metadata.Path != attachment.Path {
		t.Fatalf("read attachment: %q, %v, %v", data, readErr, closeErr)
	}
	got, err := app.Projects.Get(ctx, principal, project.ID)
	if err != nil || got.ID != project.ID {
		t.Fatalf("read shared project: %#v, %v", got, err)
	}
}
