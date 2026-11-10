package application

import (
	"context"
	"errors"
	"io"
	"net/url"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskwork "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type strictObservations struct{ t *testing.T }

var _ TaskObservationOperations = (*strictObservations)(nil)

func (m *strictObservations) unexpected(name string) error {
	m.t.Helper()
	m.t.Errorf("unexpected observation operation %s", name)
	return errors.New("unexpected observation operation: " + name)
}
func (m *strictObservations) ObserveGet(context.Context, model.Principal, string, string) (task.ObservedTask, error) {
	return task.ObservedTask{}, m.unexpected("ObserveGet")
}
func (m *strictObservations) ObserveList(context.Context, model.Principal, string, task.TaskListRequest) (task.ObservedTaskPage, error) {
	return task.ObservedTaskPage{}, m.unexpected("ObserveList")
}
func (m *strictObservations) ObserveGraph(context.Context, model.Principal, string, string) (task.ObservedGraph, error) {
	return task.ObservedGraph{}, m.unexpected("ObserveGraph")
}
func (m *strictObservations) ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (task.ObservedMCPPage, error) {
	return task.ObservedMCPPage{}, m.unexpected("ObservedMCPList")
}
func (m *strictObservations) WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error) {
	return taskwork.Page{}, m.unexpected("WorkList")
}

type strictIdentity struct {
	t *testing.T
}

var _ IdentityOperations = (*strictIdentity)(nil)

func (m *strictIdentity) unexpected(name string) error {
	m.t.Helper()
	m.t.Errorf("unexpected identity operation %s", name)
	return errors.New("unexpected identity operation: " + name)
}

func (m *strictIdentity) CallbackURL() string {
	m.unexpected("CallbackURL")
	return ""
}
func (m *strictIdentity) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return model.Principal{}, m.unexpected("Authenticate")
}
func (m *strictIdentity) ValidateLogin(string, string) error { return m.unexpected("ValidateLogin") }
func (m *strictIdentity) StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error) {
	return identitycore.LoginStart{}, m.unexpected("StartLogin")
}
func (m *strictIdentity) CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error) {
	return identitycore.LoginCompletion{}, m.unexpected("CompleteLogin")
}
func (m *strictIdentity) User(context.Context, model.Principal) (model.User, error) {
	return model.User{}, m.unexpected("User")
}
func (m *strictIdentity) Logout(context.Context, model.Principal) error {
	return m.unexpected("Logout")
}
func (m *strictIdentity) CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, m.unexpected("CreatePAT")
}
func (m *strictIdentity) ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error) {
	return nil, m.unexpected("ListPATs")
}
func (m *strictIdentity) RevokePAT(context.Context, model.Principal, string) error {
	return m.unexpected("RevokePAT")
}
func (m *strictIdentity) UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	return model.PersonalAccessToken{}, m.unexpected("UpdatePATExpiry")
}
func (m *strictIdentity) Providers(context.Context) ([]string, error) {
	return nil, m.unexpected("Providers")
}
func (m *strictIdentity) StartDevice(context.Context, string, string) (identitycore.DeviceStart, error) {
	return identitycore.DeviceStart{}, m.unexpected("StartDevice")
}
func (m *strictIdentity) InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error) {
	return identitycore.DeviceInspection{}, m.unexpected("InspectDevice")
}
func (m *strictIdentity) DecideDevice(context.Context, model.Principal, string, string, string) error {
	return m.unexpected("DecideDevice")
}
func (m *strictIdentity) RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, m.unexpected("RedeemDevice")
}
func (m *strictIdentity) LogoutDevice(context.Context, model.Principal) error {
	return m.unexpected("LogoutDevice")
}

func (m *strictIdentity) PersonalTeamID(context.Context, model.Principal) (string, error) {
	return "", m.unexpected("PersonalTeamID")
}

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
		actual, ok := app.Identity.(*identity.Identity)
		if !ok || actual == nil || actual.CallbackURL() != "https://daynight.test/callback" {
			t.Fatalf("production Identity = %#v", app.Identity)
		}
		observations, ok := app.TaskObservations.(*task.Observations)
		if !ok || observations == nil {
			t.Fatalf("production TaskObservations = %#v", app.TaskObservations)
		}
		steps, ok := app.TaskSteps.(*task.TaskSteps)
		if !ok || steps == nil {
			t.Fatalf("production TaskSteps = %#v", app.TaskSteps)
		}
		verifySharedEngine(t, app)
	})
	t.Run("constructor dependencies", func(t *testing.T) {
		database, files := borrowedDependencies(t)
		client, err := uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example.com", AppID: "test", AppSecret: "secret"})
		if err != nil {
			t.Fatal(err)
		}
		const callbackURL = "https://daynight.test/callback"
		marker := identity.New(database, client, callbackURL)
		observationMarker := task.NewObservations(database, nil)
		capturer := &assemblyCapturer{t: t}
		var projects *project.Projects
		var tasks *task.Tasks
		var steps *task.TaskSteps
		var attachments *attachment.Attachments
		var projectEngine *sessioncore.Engine
		var observer task.SessionObserver
		projectCalls, taskCalls, stepCalls, attachmentCalls, identityCalls, observationCalls := 0, 0, 0, 0, 0, 0
		app := assemble(database, files, client, callbackURL, time.Second, constructors{
			identity: func(writer store.IdentityWriter, actualClient *uniauth.Client, actualCallback string) *identity.Identity {
				identityCalls++
				if writer != database || actualClient != client || actualCallback != callbackURL {
					t.Error("Identity received another writer, client or callback")
				}
				return marker
			},
			taskObservations: func(reader store.SnapshotReader, actualObserver task.SessionObserver) *task.Observations {
				observationCalls++
				if reader != database {
					t.Error("TaskObservations received another snapshot reader")
				}
				observer = actualObserver
				return observationMarker
			},
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
			taskSteps: func(actual task.StepsStore, captures ...task.Capturer) *task.TaskSteps {
				stepCalls++
				if actual != database || len(captures) != 1 || captures[0] != capturer {
					t.Error("TaskSteps received another business store or Capturer")
				}
				steps = task.NewTaskSteps(actual, captures...)
				return steps
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
		if projectCalls != 1 || taskCalls != 1 || stepCalls != 1 || attachmentCalls != 1 || identityCalls != 1 || observationCalls != 1 {
			t.Fatalf("constructor calls differ: Projects=%d Tasks=%d TaskSteps=%d Attachments=%d Identity=%d Observations=%d", projectCalls, taskCalls, stepCalls, attachmentCalls, identityCalls, observationCalls)
		}
		if app.Identity != marker || app.TaskObservations != observationMarker || observer != app.Engine || app.TaskSteps != steps || app.Projects != projects || app.Tasks != tasks || app.Attachments != attachments || app.Engine != projectEngine || app.TaskSearch != database {
			t.Fatal("application replaced a constructor result or shared dependency")
		}
		verifySharedEngine(t, app)
		app.Identity = &strictIdentity{t: t}
		app.TaskObservations = &strictObservations{t: t}
	})
	for _, tc := range []struct {
		name    string
		capture []task.Capturer
	}{
		{name: "omitted capture"},
		{name: "nil capture", capture: []task.Capturer{nil}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database, files := borrowedDependencies(t)
			var taskCapture task.Capturer
			var stepCapture task.Capturer
			var steps *task.TaskSteps
			taskCalls, stepCalls := 0, 0
			app := assemble(database, files, nil, "", time.Second, constructors{
				identity:         identity.New,
				taskObservations: task.NewObservations,
				projects: func(actual store.Transactions, engine *sessioncore.Engine) *project.Projects {
					return project.NewProjects(actual, engine)
				},
				tasks: func(actual store.Transactions, capture task.Capturer) *task.Tasks {
					taskCalls++
					if actual != database {
						t.Error("Tasks received another business store")
					}
					taskCapture = capture
					return task.NewTasks(actual, capture)
				},
				taskSteps: func(actual task.StepsStore, captures ...task.Capturer) *task.TaskSteps {
					stepCalls++
					if actual != database || len(captures) != 1 {
						t.Error("TaskSteps received another business store or Capturer count")
					} else {
						stepCapture = captures[0]
					}
					steps = task.NewTaskSteps(actual, captures...)
					return steps
				},
				attachments: attachment.NewAttachments,
			}, tc.capture...)
			selected, ok := taskCapture.(*webhook.Capturer)
			if !ok || selected == nil || stepCapture != taskCapture {
				t.Error("Tasks and TaskSteps did not receive the same default Capturer")
			}
			if taskCalls != 1 || stepCalls != 1 || steps == nil || app.TaskSteps != steps {
				t.Fatalf("constructor results differ: Tasks calls=%d TaskSteps calls=%d result=%p output=%v", taskCalls, stepCalls, steps, app.TaskSteps)
			}
			verifySharedEngine(t, app)
		})
	}
}
