package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"
)

type realIdentityWriter struct {
	t         *testing.T
	principal model.Principal
	hash      []byte
}
type realIdentityScope struct{ dao store.IdentityDAO }

func (s realIdentityScope) IdentityDAO() store.IdentityDAO { return s.dao }
func (s realIdentityScope) PersonalTeamDAO() store.PersonalTeamDAO {
	panic("unexpected PersonalTeamDAO")
}

type realIdentityDAO struct {
	store.IdentityDAO
	writer realIdentityWriter
	calls  int
}

func (d *realIdentityDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	d.calls++
	if d.calls != 1 || kind != d.writer.principal.Kind || !bytes.Equal(hash, d.writer.hash) || now.IsZero() || now.Location() != time.UTC || ctx.Err() != nil {
		d.writer.t.Error("identity DAO changed credential, context, time or call count")
		panic("unexpected identity DAO call")
	}
	return d.writer.principal, nil
}
func (w realIdentityWriter) WriteIdentity(ctx context.Context, work func(store.IdentityScope) error) (store.Completion, error) {
	defer func() {
		if caught := recover(); caught != nil {
			w.t.Errorf("unexpected Identity DAO call: %v", caught)
			panic(caught)
		}
	}()
	dao := &realIdentityDAO{writer: w}
	err := work(realIdentityScope{dao: dao})
	if dao.calls != 1 {
		w.t.Errorf("authentication DAO calls=%d, want 1", dao.calls)
	}
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type realSessionApplication struct {
	http.Handler
	routes  *sessionhttp.Routes
	service *sessionservice.Service
	engine  *sessioncore.Engine
}

func (a *realSessionApplication) Shutdown(ctx context.Context) error {
	if err := a.routes.Shutdown(ctx); err != nil {
		return err
	}
	return a.engine.Stop(ctx)
}

type realSessionFixture struct {
	store              *realSessionStore
	mu                 sync.Mutex
	record             store.SessionRecord
	sessionTask        store.SessionTask
	operations         []store.SessionOperation
	intentIDs          []string
	acceptedPlans      [][]string
	queryRevision      int64
	connectionCaptured chan struct{}
	connectionCommit   chan struct{}
	writes             realSessionWrites
	calls              map[string]int
	credentialRevoked  bool
	mediaRecoveryRead  func(context.Context) ([]store.SessionResourceLease, error)
	handler            *resourceTestHandler
	server             *httptest.Server
	application        *realSessionApplication
	task               api.Task
	base               string
	registration       sp.Registration
	snapshot           sp.Snapshot
	grant              sessioncore.GrantResult
}

func realSessionSetup(t *testing.T) *realSessionFixture {
	t.Helper()
	return realSessionSetupMode(t, model.AgentControlModeWeb, true)
}

func realSessionSetupMode(t *testing.T, mode model.WorkerAgentControlMode, prepare bool) *realSessionFixture {
	t.Helper()
	f := &realSessionFixture{calls: map[string]int{}}
	f.store = &realSessionStore{t: t, fixture: f}
	f.store.WriteSessionCall = f.store.run
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), State: model.WorkerActive, UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Session test"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: mode, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, ClaimedAt: now}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Description: "", Status: "in_progress", AllowAgents: true, CreatedAt: now, UpdatedAt: now, Version: 1, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Properties: map[string]json.RawMessage{}, AssignedTo: &principal.UserID}
	f.task.Properties["worker"] = json.RawMessage(jsonBody(t, api.WorkerClaim{ClaimID: worker.ClaimID, State: "active", UserID: worker.UserID, WorkerID: worker.WorkerID, Machine: api.WorkerMachine{ID: worker.Machine.ID, Name: worker.Machine.Name}, Platform: "linux", Agent: "codex", AgentControlMode: string(mode), WorktreeID: worker.WorktreeID, Phase: "executing", ClaimedAt: now}))
	f.sessionTask = store.SessionTask{Worker: &worker, Status: "in_progress"}
	f.base = taskPath(f.task) + "/sessions"
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.task.ProjectID, TaskID: f.task.ID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	f.record = store.SessionRecord{Snapshot: f.snapshot, Owner: principal.UserID, Registration: []byte(jsonBody(t, f.registration))}
	token := secret.Random("dnpat_")
	identity := identityservice.New(realIdentityWriter{t: t, principal: principal, hash: secret.Hash(token)}, nil, "https://daynight.example.com/auth/callback")
	auth, err := authhttp.NewRequestAuthentication(identity.Authenticate, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	engine := sessioncore.NewEngine(files)
	service := sessionservice.New(f.store, engine)
	routes := sessionhttp.NewRoutes(service, &authhttp.Authentication{RequestAuthentication: auth}, testLogger())
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	f.application = &realSessionApplication{Handler: mux, routes: routes, service: service, engine: engine}
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), mux), token: token, principal: principal}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	f.server = httptest.NewServer(httpx.RequestLogging(testLogger(), mux))
	t.Cleanup(f.server.Close)
	if prepare {
		registered := decodeResponse[struct {
			Session sp.Snapshot `json:"session"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
		if registered.Session.SessionID != f.snapshot.SessionID || registered.Session.ClaimID != worker.ClaimID {
			t.Fatal("registered Session changed declared identity")
		}
		f.grant = f.mint(t, "bootstrap")
	}

	return f
}
func (f *realSessionFixture) mint(t *testing.T, kind string) sessioncore.GrantResult {
	t.Helper()
	return f.mintGrant(t, sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind})
}
func (f *realSessionFixture) mintGrant(t *testing.T, g sp.Grant) sessioncore.GrantResult {
	t.Helper()
	out := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, g)), http.StatusOK)
	f.mu.Lock()
	defer f.mu.Unlock()
	h := sha256.Sum256([]byte(out.Token))
	if f.writes.grant == nil || !bytes.Equal(f.writes.grant.Hash, h[:]) || f.writes.grant.Kind != g.Kind || out.SessionID != f.snapshot.SessionID || out.ExecutionGeneration != g.ExecutionGeneration {
		t.Fatal("grant write changed declared intent")
	}
	f.record.GrantHash = h[:]
	f.record.GrantExpiry = &out.ExpiresAt
	f.record.GrantKind = g.Kind
	f.record.Parent = f.handler.principal.CredentialID
	return out
}
func (f *realSessionFixture) controller(t *testing.T, epoch string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	f.mu.Lock()
	expectedEpoch, _ := strconv.ParseInt(f.record.Snapshot.ConnectionEpoch, 10, 64)
	captured, commit := make(chan struct{}), make(chan struct{})
	f.connectionCaptured, f.connectionCommit = captured, commit
	f.mu.Unlock()
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(commit) }) })
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	select {
	case <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not reach connection DAO")
	}
	f.mu.Lock()
	if f.writes.instance == "" || f.writes.seen == nil {
		f.mu.Unlock()
		t.Fatal("connection DAO did not capture relay identity")
	}
	f.record.Snapshot.ConnectionEpoch = strconv.FormatInt(expectedEpoch+1, 10)
	f.record.ServerInstance = new(f.writes.instance)
	f.record.ConnectionExpiry = f.record.GrantExpiry
	f.record.LastSeen = new(*f.writes.seen)
	f.record.ConnectionParent = f.handler.principal.CredentialID
	f.record.Consumed = true
	f.record.SourceEpoch = new(epoch)
	f.record.SourceEpochs = []string{epoch}
	f.mu.Unlock()
	release.Do(func() { close(commit) })
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ConnectionEpoch != strconv.FormatInt(expectedEpoch+1, 10) || snapshot.Identity.WorkerID != f.registration.WorkerID || snapshot.Identity.ControllerInstanceID != f.registration.ControllerInstanceID {
		t.Fatal("welcome changed declared connection fence or owner")
	}
	f.mu.Lock()
	f.record.Snapshot.HistoryEpoch = snapshot.HistoryEpoch
	f.mu.Unlock()
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, conn, "sync_ack")
	return conn, snapshot
}

type realSessionStore struct {
	t                *testing.T
	WriteSessionCall func(context.Context, func(store.SessionScope) error) (store.Completion, error)
	fixture          *realSessionFixture
}

func (s *realSessionStore) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	return s.WriteSessionCall(ctx, fn)
}

type realSessionScope struct {
	t   *testing.T
	dao store.SessionDAO
}

func (s realSessionScope) SessionDAO() store.SessionDAO { return s.dao }
func (s realSessionScope) BotDAO() store.BotWriteDAO    { return nil }

type realSessionWrites struct {
	session          *store.SessionRecord
	grant            *store.SessionGrant
	instance         string
	seen             *time.Time
	connectionExpiry *time.Time
	disconnected     int
	operations       []store.SessionOperation
	receipts         []sp.Operation
	epochs           []struct {
		id    string
		epoch int64
	}
}

type realSessionDAO struct {
	ctx context.Context
	store.SessionDAO
	t             *testing.T
	f             *realSessionFixture
	record        store.SessionRecord
	task          store.SessionTask
	operations    []store.SessionOperation
	intentIDs     []string
	queryRevision int64
	calls         map[string]int
	first         string
}

func realSessionCopy[T any](v T) T {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (s *realSessionStore) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	defer func() {
		if caught := recover(); caught != nil {
			s.t.Errorf("unexpected Session scope or DAO call: %v", caught)
			panic(caught)
		}
	}()
	f := s.fixture
	f.mu.Lock()
	d := &realSessionDAO{t: s.t, ctx: ctx, f: f, record: realSessionCopy(f.record), task: realSessionCopy(f.sessionTask), operations: realSessionCopy(f.operations), intentIDs: append([]string(nil), f.intentIDs...), queryRevision: f.queryRevision, calls: map[string]int{}}
	f.mu.Unlock()
	err := fn(realSessionScope{t: s.t, dao: d})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	d.verify()
	if d.calls["ConnectSession"] == 1 {
		f.mu.Lock()
		commit := f.connectionCommit
		f.mu.Unlock()
		if commit == nil {
			d.fail("connection commit has no test barrier")
		}
		select {
		case <-commit:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (d *realSessionDAO) called(ctx context.Context, name string) {
	if ctx != d.ctx {
		d.fail("Session DAO %s escaped transaction context", name)
	}
	if d.first == "" {
		d.first = name
	}
	d.calls[name]++
	d.f.mu.Lock()
	d.f.calls[name]++
	d.f.mu.Unlock()
}
func (d *realSessionDAO) fail(format string, args ...any) {
	d.t.Helper()
	d.t.Errorf(format, args...)
	panic(fmt.Sprintf(format, args...))
}
func (d *realSessionDAO) id(id string) {
	if id != d.record.Snapshot.SessionID {
		d.fail("Session DAO id=%q, want %q", id, d.record.Snapshot.SessionID)
	}
}
func (d *realSessionDAO) verify() {
	required := map[string]int{}
	switch d.first {
	case "ListSessionMediaLeases":
		if len(d.calls) != 1 || d.calls["ListSessionMediaLeases"] != 1 {
			d.fail("media recovery listing retained or reused its database scope")
		}
		return
	case "LockTaskRegistration":
		required = map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1}
	case "SessionLocation":
		required = map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "SessionLocationByGrant":
		required = map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "LockTask", "LockArchiveTask":
		required = map[string]int{d.first: 1, "LockCredential": 1, "ProjectAccess": 1}
	default:
		d.fail("unconfigured Session transaction begins with %q", d.first)
	}
	// Each offered operation rechecks its submitting authority within its callback.
	if d.first == "SessionLocation" && d.calls["SessionOperation"] != 0 {
		required["LockCredential"] += d.calls["SessionOperation"]
		required["ProjectAccess"] += d.calls["SessionOperation"]
	}
	for name, n := range required {
		if d.calls[name] != n {
			d.fail("Session callback %s=%d, want %d (first=%s)", name, d.calls[name], n, d.first)
		}
	}
	if d.calls["SessionBotID"] != d.calls["LockSession"] {
		d.fail("Session lookup and lock count differ")
	}
	for _, name := range []string{"SaveSession", "TouchSession", "DisconnectSession", "ConnectSession", "SetSessionGrant", "SetSessionGenerationStop", "InsertSessionOperation", "AcceptedSessionOperations", "CurrentTaskSession", "PendingSessionOperationCount", "UnreconciledSessionOperationCount"} {
		if d.calls[name] > 1 {
			d.fail("extra Session callback %s", name)
		}
	}
	if d.calls["TouchSession"] != 0 || d.calls["ConnectSession"] != 0 || d.calls["DisconnectSession"] != 0 || d.calls["SetSessionGrant"] != 0 || d.calls["InsertSessionOperation"] != 0 || d.calls["SetSessionOperationReceipt"] != 0 {
		if d.calls["SaveSession"] != 1 {
			d.fail("Session callback omitted exact SaveSession")
		}
	}
	if d.calls["PendingSessionOperationCount"] != 0 && d.calls["InsertSessionOperation"] != 1 {
		d.fail("accepted command did not insert exact operation")
	}
	for _, name := range []string{"SetSessionOperationReceipt", "SetSessionOperationEpoch"} {
		if d.calls[name] > d.calls["SessionOperation"] {
			d.fail("extra %s compared with selected operation reads", name)
		}
	}

}
func (d *realSessionDAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	d.called(ctx, "ListSessionMediaLeases")
	d.f.mu.Lock()
	read := d.f.mediaRecoveryRead
	d.f.mu.Unlock()
	if read == nil {
		d.fail("unconfigured media recovery lease listing")
	}
	return read(ctx)
}

func (d *realSessionDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.called(ctx, "LockCredential")
	if now.IsZero() || p != d.f.handler.principal {
		d.fail("Session credential changed principal or time: %+v", p)
	}
	d.f.mu.Lock()
	revoked := d.f.credentialRevoked
	d.f.mu.Unlock()
	if revoked {
		return model.ErrNotFound
	}
	return ctx.Err()
}
func (d *realSessionDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.called(ctx, "ProjectAccess")
	if user != d.f.handler.principal.UserID || project != d.f.task.ProjectID {
		d.fail("Session project access args %q/%q", user, project)
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, ctx.Err()
}
func (d *realSessionDAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session Task lock changed address %q/%q", project, id)
	}
	return d.task, ctx.Err()
}
func (d *realSessionDAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	d.called(ctx, "LockArchiveTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session archive Task lock changed address")
	}
	return d.task, false, ctx.Err()
}
func (d *realSessionDAO) LockTaskRegistration(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTaskRegistration")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("registration lock changed address")
	}
	return d.task, ctx.Err()
}
func (d *realSessionDAO) FindTaskRegistration(ctx context.Context, project, registration, task, claim string) (string, error) {
	d.called(ctx, "FindTaskRegistration")
	if project != d.f.task.ProjectID || task != d.f.task.ID || registration != d.f.registration.RegistrationID || claim != d.f.registration.ClaimID {
		d.fail("registration lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *realSessionDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.called(ctx, "SessionBotID")
	d.id(id)
	return nil, ctx.Err()
}
func (d *realSessionDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.called(ctx, "LockSession")
	d.id(id)
	return d.record, ctx.Err()
}
func (d *realSessionDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocation")
	d.id(id)
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: id}, ctx.Err()
}
func (d *realSessionDAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocationByGrant")
	if !bytes.Equal(hash, d.record.GrantHash) {
		return store.SessionLocation{}, model.ErrNotFound
	}
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: d.record.Snapshot.SessionID}, ctx.Err()
}
func (d *realSessionDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.called(ctx, "CurrentTaskSession")
	if project != d.f.task.ProjectID || task != d.f.task.ID || claim != d.record.Snapshot.ClaimID {
		d.fail("current Session lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *realSessionDAO) SaveSession(ctx context.Context, in store.SessionRecord) error {
	d.called(ctx, "SaveSession")
	d.id(in.Snapshot.SessionID)
	if in.Snapshot.ClaimID != d.record.Snapshot.ClaimID || in.Snapshot.Identity.ProjectID != d.f.task.ProjectID || in.Snapshot.Identity.TaskID != d.f.task.ID {
		d.fail("saved Session changed owner binding")
	}
	d.f.mu.Lock()
	d.f.writes.session = new(realSessionCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) SetSessionGrant(ctx context.Context, in store.SessionGrant) error {
	d.called(ctx, "SetSessionGrant")
	d.id(in.SessionID)
	if in.ParentCredentialID != d.f.handler.principal.CredentialID || len(in.Hash) != 32 || in.ExpiresAt.IsZero() {
		d.fail("grant changed parent or token hash")
	}
	d.f.mu.Lock()
	d.f.writes.grant = new(realSessionCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) SetSessionGenerationStop(ctx context.Context, id string, proof []byte) error {
	d.called(ctx, "SetSessionGenerationStop")
	d.id(id)
	if !json.Valid(proof) {
		d.fail("generation stop is not JSON")
	}
	return ctx.Err()
}
func (d *realSessionDAO) ConnectSession(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
	d.called(ctx, "ConnectSession")
	d.id(id)
	if instance == "" || seen.IsZero() || expiry == nil || !expiry.Equal(*d.record.GrantExpiry) {
		d.fail("connection changed instance/time/grant expiry")
	}
	d.f.mu.Lock()
	d.f.writes.instance = instance
	d.f.writes.seen = &seen
	d.f.writes.connectionExpiry = expiry
	captured := d.f.connectionCaptured
	d.f.mu.Unlock()
	if captured == nil {
		d.fail("connection capture has no test barrier")
	}
	close(captured)
	return ctx.Err()
}
func (d *realSessionDAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	d.called(ctx, "TouchSession")
	d.id(id)
	if now.IsZero() {
		d.fail("heartbeat time is zero")
	}
	return ctx.Err()
}
func (d *realSessionDAO) DisconnectSession(ctx context.Context, id string) error {
	d.called(ctx, "DisconnectSession")
	d.id(id)
	if op, err := d.f.application.engine.BeginOperation(); err != nil {
		d.fail("engine stopped before controller disconnect: %v", err)
	} else {
		op.Close()
	}
	d.f.mu.Lock()
	d.f.writes.disconnected++
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) SessionOperation(ctx context.Context, session, id string) (store.SessionOperation, error) {
	d.called(ctx, "SessionOperation")
	d.id(session)
	for _, o := range d.operations {
		if o.OperationID == id {
			return o, ctx.Err()
		}
	}
	for _, expected := range d.intentIDs {
		if expected == id {
			return store.SessionOperation{}, model.ErrNotFound
		}
	}
	d.fail("unconfigured operation lookup %q", id)
	return store.SessionOperation{}, model.ErrNotFound
}
func (d *realSessionDAO) InsertSessionOperation(ctx context.Context, in store.SessionOperation) error {
	d.called(ctx, "InsertSessionOperation")
	d.id(in.SessionID)
	if in.Actor != d.f.handler.principal || in.OperationID != in.Command.OperationID || in.Receipt.OperationID != in.OperationID || in.Receipt.State != "accepted" || len(in.Hash) != 32 {
		d.fail("operation insert changed actor, identity or receipt")
	}
	d.f.mu.Lock()
	d.f.writes.operations = append(d.f.writes.operations, realSessionCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) SetSessionOperationReceipt(ctx context.Context, in sp.Operation) error {
	d.called(ctx, "SetSessionOperationReceipt")
	if in.SessionID != d.record.Snapshot.SessionID || in.ClaimID != d.record.Snapshot.ClaimID {
		d.fail("receipt changed Session fence")
	}
	selected := false
	for _, o := range d.operations {
		if o.OperationID == in.OperationID {
			selected = true
		}
	}
	if !selected {
		d.fail("receipt targeted unconfigured operation")
	}
	d.f.mu.Lock()
	d.f.writes.receipts = append(d.f.writes.receipts, realSessionCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) SetSessionOperationEpoch(ctx context.Context, session, id string, epoch int64) error {
	d.called(ctx, "SetSessionOperationEpoch")
	d.id(session)
	if epoch <= 0 {
		d.fail("operation epoch not positive")
	}
	selected := false
	for _, o := range d.operations {
		if o.OperationID == id {
			selected = true
		}
	}
	if !selected {
		d.fail("epoch targeted unconfigured operation")
	}
	d.f.mu.Lock()
	d.f.writes.epochs = append(d.f.writes.epochs, struct {
		id    string
		epoch int64
	}{id, epoch})
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *realSessionDAO) HasOtherFirstInput(ctx context.Context, session, id string) (bool, error) {
	d.called(ctx, "HasOtherFirstInput")
	d.id(session)
	return false, ctx.Err()
}
func (d *realSessionDAO) HasInteractionResponse(ctx context.Context, session, id, interaction string) (bool, error) {
	d.called(ctx, "HasInteractionResponse")
	d.id(session)
	return false, ctx.Err()
}
func (d *realSessionDAO) PendingSessionOperationCount(ctx context.Context, id string) (int, error) {
	d.called(ctx, "PendingSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}
func (d *realSessionDAO) AcceptedSessionOperations(ctx context.Context, id string) ([]string, error) {
	d.called(ctx, "AcceptedSessionOperations")
	d.id(id)
	d.f.mu.Lock()
	defer d.f.mu.Unlock()
	ids := []string{}
	if len(d.f.acceptedPlans) > 0 && d.queryRevision == d.f.queryRevision {
		ids = append(ids, d.f.acceptedPlans[0]...)
		d.f.acceptedPlans = d.f.acceptedPlans[1:]
	}
	return ids, ctx.Err()
}
func (d *realSessionDAO) UnreconciledSessionOperations(ctx context.Context, id string, epoch int64) ([]string, error) {
	d.called(ctx, "UnreconciledSessionOperations")
	d.id(id)
	return []string{}, ctx.Err()
}
func (d *realSessionDAO) UnreconciledSessionOperationCount(ctx context.Context, id string, epoch int64) (int, error) {
	d.called(ctx, "UnreconciledSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}

func (f *realSessionFixture) supplyState(state sp.State) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record.Snapshot.Identity.NativeSessionID = state.NativeSessionID
	f.record.Snapshot.InitialInputState = state.InitialInputState
}
func (f *realSessionFixture) supplySource(seq int64) {
	f.mu.Lock()
	f.record.SourceSeq = seq
	f.mu.Unlock()
}
func (f *realSessionFixture) suppliedOperation(t *testing.T, c sp.Command, receipt sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.writes.operations) == 0 {
		t.Fatal("operation insert was not called")
	}
	captured := f.writes.operations[len(f.writes.operations)-1]
	if captured.OperationID != c.OperationID || captured.Command.Fence != c.Fence || captured.Command.Kind != c.Kind || receipt.OperationID != c.OperationID || receipt.State != "accepted" {
		t.Fatal("operation insert or HTTP receipt changed submitted command")
	}
	if !reflect.DeepEqual(captured.Receipt, receipt) {
		t.Fatal("inserted receipt differs from HTTP receipt")
	}
	// Intent, receipt state and sequence are declared independently; only the generated hash is selected.
	record := store.SessionOperation{SessionID: c.SessionID, OperationID: c.OperationID, Command: c, Receipt: receipt, Actor: f.handler.principal, Hash: bytes.Clone(captured.Hash), Seq: int64(len(f.operations) + 1), Deadline: time.Now().Add(time.Minute)}
	if captured.Seq != record.Seq {
		t.Fatalf("operation sequence=%d, want%d", captured.Seq, record.Seq)
	}
	f.operations = append(f.operations, record)
	f.queryRevision++
	f.record.OperationSeq = record.Seq
}
func (f *realSessionFixture) supplyReceipt(t *testing.T, operation sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	found := false
	for i := range f.operations {
		if f.operations[i].OperationID == operation.OperationID {
			f.operations[i].Receipt = operation
			found = true
		}
	}
	if !found {
		t.Fatal("receipt has no independently configured operation")
	}
}

var _ store.SessionDAO = (*realSessionDAO)(nil)

func (f *realSessionFixture) suppliedOffer(t *testing.T, id, epoch string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	parsed, err := strconv.ParseInt(epoch, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	foundEpoch, foundReceipt := false, false
	for _, in := range f.writes.epochs {
		if in.id == id && in.epoch == parsed {
			foundEpoch = true
		}
	}
	for _, in := range f.writes.receipts {
		if in.OperationID == id && in.State == "offered" {
			foundReceipt = true
		}
	}
	if !foundEpoch || !foundReceipt {
		t.Fatal("offer did not write exact epoch and offered receipt")
	}
	for i := range f.operations {
		if f.operations[i].OperationID == id {
			f.operations[i].Epoch = &parsed
			f.operations[i].Receipt.State = "offered"
			return
		}
	}
	t.Fatal("offer has no independently configured intent")
}

func (f *realSessionFixture) expectCommand(t *testing.T, c sp.Command) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.intentIDs {
		if id == c.OperationID {
			t.Fatal("duplicate command test identity")
		}
	}
	f.intentIDs = append(f.intentIDs, c.OperationID)
}

func (f *realSessionFixture) selectOffers(t *testing.T, ids ...string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range ids {
		found := false
		for _, o := range f.operations {
			if o.OperationID == id {
				found = true
			}
		}
		if !found {
			t.Fatal("offer query selected an unconfigured command")
		}
	}
	f.acceptedPlans = append(f.acceptedPlans, append([]string(nil), ids...))
	f.queryRevision++
}
