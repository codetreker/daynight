package application

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

var errAssemblyResourceCall = errors.New("unexpected assembly resource call")

type borrowedStore struct {
	store.Transactions
	t             *testing.T
	capacityCalls int
	closeCalls    int
}

func (s *borrowedStore) MaxConnections() int {
	s.capacityCalls++
	return 8
}

func (s *borrowedStore) Close() {
	s.closeCalls++
	s.t.Error("application closed its borrowed store")
}

type borrowedFiles struct {
	*local.Storage
	t          *testing.T
	closeCalls int
}

func (f *borrowedFiles) unexpected(operation string) error {
	f.t.Helper()
	f.t.Errorf("assembly invoked file business operation %s", operation)
	return errAssemblyResourceCall
}

func (f *borrowedFiles) TryAcquireResidency(context.Context, string) (io.Closer, error) {
	return nil, f.unexpected("TryAcquireResidency")
}

func (f *borrowedFiles) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	return nil, f.unexpected("AcquireGate")
}

func (f *borrowedFiles) Put(context.Context, string, string, io.Reader) (filestorage.FileInfo, error) {
	return filestorage.FileInfo{}, f.unexpected("Put")
}

func (f *borrowedFiles) Open(context.Context, string, string) (filestorage.Object, error) {
	return filestorage.Object{}, f.unexpected("Open")
}

func (f *borrowedFiles) Delete(context.Context, string, string) error {
	return f.unexpected("Delete")
}

func (f *borrowedFiles) DeleteSessionArchives(context.Context, sessionarchive.Namespace) error {
	return f.unexpected("DeleteSessionArchives")
}

func (f *borrowedFiles) Close() error {
	f.closeCalls++
	return f.unexpected("Close")
}

type assemblyCapturer struct{ t *testing.T }

func (c *assemblyCapturer) CaptureBatch(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error {
	c.t.Error("assembly invoked webhook capture")
	return errAssemblyResourceCall
}

func borrowedDependencies(t *testing.T) (*borrowedStore, *borrowedFiles) {
	t.Helper()
	storage, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	database := &borrowedStore{t: t}
	files := &borrowedFiles{Storage: storage, t: t}
	t.Cleanup(func() {
		if database.capacityCalls != 1 || database.closeCalls != 0 || files.closeCalls != 0 {
			t.Errorf("borrowed resource calls differ: capacity=%d store close=%d files close=%d", database.capacityCalls, database.closeCalls, files.closeCalls)
		}
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	return database, files
}

func verifySharedEngine(t *testing.T, app *Application) {
	t.Helper()
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
	t.Cleanup(op.Close)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := app.Engine.Stop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("engine stopped with active session operation: %v", err)
	}
	op.Close()
	if err := app.Engine.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Sessions.BeginOperation(); err == nil {
		t.Fatal("session service admitted work after engine stop")
	}
}

func TestApplicationSharesSessionEngineAndBusinessStore(t *testing.T) {
	t.Run("production constructors", func(t *testing.T) {
		database, files := borrowedDependencies(t)
		app := New(database, files, nil, "https://daynight.test/callback", time.Second)
		verifySharedEngine(t, app)
	})
	t.Run("constructor dependencies", func(t *testing.T) {
		database, files := borrowedDependencies(t)
		capturer := &assemblyCapturer{t: t}
		var projects *project.Projects
		var tasks *task.Tasks
		var attachments *attachment.Attachments
		var projectEngine *sessioncore.Engine
		projectCalls, taskCalls, attachmentCalls := 0, 0, 0
		app := assemble(database, files, nil, "https://daynight.test/callback", time.Second, constructors{
			projects: func(actual store.Transactions, engine *sessioncore.Engine) *project.Projects {
				projectCalls++
				if actual != database {
					t.Error("Projects received another business store")
				}
				projectEngine = engine
				projects = project.NewProjects(actual, engine)
				return projects
			},
			tasks: func(actual store.Transactions, capture task.Capturer) *task.Tasks {
				taskCalls++
				if actual != database || capture != capturer {
					t.Error("Tasks received another business store or Capturer")
				}
				tasks = task.NewTasks(actual, capture)
				return tasks
			},
			attachments: func(reader store.SnapshotReader, writer store.AttachmentMutationWriter, storage filestorage.Storage) *attachment.Attachments {
				attachmentCalls++
				if reader != database || writer != database || storage != files {
					t.Error("Attachments received another business store or files")
				}
				attachments = attachment.NewAttachments(reader, writer, storage)
				return attachments
			},
		}, capturer)
		if projectCalls != 1 || taskCalls != 1 || attachmentCalls != 1 {
			t.Fatalf("constructor calls differ: Projects=%d Tasks=%d Attachments=%d", projectCalls, taskCalls, attachmentCalls)
		}
		if app.Projects != projects || app.Tasks != tasks || app.Attachments != attachments || app.Engine != projectEngine || app.TaskSearch != database {
			t.Fatal("application replaced a constructor result or shared dependency")
		}
		verifySharedEngine(t, app)
	})
}
