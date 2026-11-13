package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type Dependencies struct {
	Store store.Transactions
	Ready func(context.Context) error
	Files filestorage.Storage
}

func newTestHandler(d Dependencies, c config.Config, logger *slog.Logger) (http.Handler, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := service.NewIdentityClient(c.UniAuth)
	if err != nil {
		return nil, err
	}
	app := service.NewModules(c, d.Store, d.Ready, d.Files, client)
	app.CredentialUsage = unusedUsageRecorder(logger)
	return New(app, c, logger)
}

func unusedUsageRecorder(logger *slog.Logger) *credentialusage.Recorder {
	r, err := credentialusage.New(runtimeUsageWriter(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}), logger, nil)
	if err != nil {
		panic(err)
	}
	return r
}

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func resourceTestServer(t *testing.T, database store.Transactions, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	return resourceTestServerForPrincipal(t, database, files, output, defaultHTTPPrincipal())
}

func resourceTestServerForPrincipal(t *testing.T, database store.Transactions, files filestorage.Storage, output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Files: files}, configuredTestConfig(), logger)
	if err != nil {
		t.Fatal(err)
	}
	application := handler.(Handler)
	t.Cleanup(func() {
		application.BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return &resourceTestHandler{Handler: httpx.RequestLogging(logger, handler), token: httpTestToken(principal.Kind), principal: principal}
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if resource, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+resource.token)
	}
}

// Each callback supplies independent facts; writes never determine later reads.
type httpTestStore struct {
	t                           *testing.T
	ReadSnapshotCall            func(ctx context.Context, fn func(store.SnapshotScope) error) error
	WriteIdentityCall           func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error)
	WriteProjectCall            func(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error)
	WriteProjectCreationCall    func(ctx context.Context, owner string, fn func(store.ProjectCreationDAO) error) (store.Completion, error)
	CreateTeamCall              func(ctx context.Context, owner string, fn func(store.TeamCreationDAO) error) (store.Completion, error)
	WriteTeamCall               func(ctx context.Context, id string, fn func(store.TeamWriteScope) error) (store.Completion, error)
	WriteWorkerCall             func(ctx context.Context, fn func(store.WorkerScope) error) (store.Completion, error)
	ReadPromptSnapshotCall      func(ctx context.Context, fn func(store.PromptSnapshot) error) error
	WritePromptCall             func(ctx context.Context, fn func(store.PromptWriteScope) error) (store.Completion, error)
	WriteBotCall                func(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error)
	WriteSessionCall            func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error)
	WriteThreadCall             func(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error)
	WriteAttachmentMutationCall func(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error)
	PutAttachmentCall           func(ctx context.Context, item model.Attachment) (model.Attachment, bool, error)
	DeleteAttachmentCall        func(ctx context.Context, project, task, path string) error
	WritePrivateTransferCall    func(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error)
	WriteOAuthClientsCall       func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error)
	WriteAuthorizationsCall     func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error)
	WriteCredentialFamilyCall   func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error)
	WriteCredentialUsageCall    func(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error)
	WriteGrantLifecycleCall     func(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error)
	ReadTaskSearchCall          func(ctx context.Context, fn func(store.TaskSearchSnapshot) error) error
	WriteWebhookCall            func(ctx context.Context, owner webhook.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error)
	ReadWebhookSnapshotCall     func(ctx context.Context, fn func(store.WebhookReadScope) error) error
}

var _ store.Transactions = (*httpTestStore)(nil)

func (s *httpTestStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, fn)
}

func (s *httpTestStore) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	if s.WriteIdentityCall == nil {
		unexpectedHTTPCall(s.t, "WriteIdentity")
	}
	return s.WriteIdentityCall(ctx, fn)
}

func (s *httpTestStore) WriteProject(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
	if s.WriteProjectCall == nil {
		unexpectedHTTPCall(s.t, "WriteProject")
	}
	return s.WriteProjectCall(ctx, id, fn)
}

func (s *httpTestStore) WriteProjectCreation(ctx context.Context, owner string, fn func(store.ProjectCreationDAO) error) (store.Completion, error) {
	if s.WriteProjectCreationCall == nil {
		unexpectedHTTPCall(s.t, "WriteProjectCreation")
	}
	return s.WriteProjectCreationCall(ctx, owner, fn)
}

func (s *httpTestStore) CreateTeam(ctx context.Context, owner string, fn func(store.TeamCreationDAO) error) (store.Completion, error) {
	if s.CreateTeamCall == nil {
		unexpectedHTTPCall(s.t, "CreateTeam")
	}
	return s.CreateTeamCall(ctx, owner, fn)
}

func (s *httpTestStore) WriteTeam(ctx context.Context, id string, fn func(store.TeamWriteScope) error) (store.Completion, error) {
	if s.WriteTeamCall == nil {
		unexpectedHTTPCall(s.t, "WriteTeam")
	}
	return s.WriteTeamCall(ctx, id, fn)
}

func (s *httpTestStore) WriteWorker(ctx context.Context, fn func(store.WorkerScope) error) (store.Completion, error) {
	if s.WriteWorkerCall == nil {
		unexpectedHTTPCall(s.t, "WriteWorker")
	}
	return s.WriteWorkerCall(ctx, fn)
}

func (s *httpTestStore) ReadPromptSnapshot(ctx context.Context, fn func(store.PromptSnapshot) error) error {
	if s.ReadPromptSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadPromptSnapshot")
	}
	return s.ReadPromptSnapshotCall(ctx, fn)
}

func (s *httpTestStore) WritePrompt(ctx context.Context, fn func(store.PromptWriteScope) error) (store.Completion, error) {
	if s.WritePromptCall == nil {
		unexpectedHTTPCall(s.t, "WritePrompt")
	}
	return s.WritePromptCall(ctx, fn)
}

func (s *httpTestStore) WriteBot(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
	if s.WriteBotCall == nil {
		unexpectedHTTPCall(s.t, "WriteBot")
	}
	return s.WriteBotCall(ctx, fn)
}

func (s *httpTestStore) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	if s.WriteSessionCall == nil {
		unexpectedHTTPCall(s.t, "WriteSession")
	}
	return s.WriteSessionCall(ctx, fn)
}

func (s *httpTestStore) WriteThread(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
	if s.WriteThreadCall == nil {
		unexpectedHTTPCall(s.t, "WriteThread")
	}
	return s.WriteThreadCall(ctx, fn)
}

func (s *httpTestStore) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	if s.WriteAttachmentMutationCall == nil {
		unexpectedHTTPCall(s.t, "WriteAttachmentMutation")
	}
	return s.WriteAttachmentMutationCall(ctx, fn)
}

func (s *httpTestStore) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	if s.PutAttachmentCall == nil {
		unexpectedHTTPCall(s.t, "PutAttachment")
	}
	return s.PutAttachmentCall(ctx, item)
}

func (s *httpTestStore) DeleteAttachment(ctx context.Context, project, task, path string) error {
	if s.DeleteAttachmentCall == nil {
		unexpectedHTTPCall(s.t, "DeleteAttachment")
	}
	return s.DeleteAttachmentCall(ctx, project, task, path)
}

func (s *httpTestStore) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	if s.WritePrivateTransferCall == nil {
		unexpectedHTTPCall(s.t, "WritePrivateTransfer")
	}
	return s.WritePrivateTransferCall(ctx, fn)
}

func (s *httpTestStore) WriteOAuthClients(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	if s.WriteOAuthClientsCall == nil {
		unexpectedHTTPCall(s.t, "WriteOAuthClients")
	}
	return s.WriteOAuthClientsCall(ctx, fn)
}

func (s *httpTestStore) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	if s.WriteAuthorizationsCall == nil {
		unexpectedHTTPCall(s.t, "WriteAuthorizations")
	}
	return s.WriteAuthorizationsCall(ctx, fn)
}

func (s *httpTestStore) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	if s.WriteCredentialUsageCall == nil {
		unexpectedHTTPCall(s.t, "WriteCredentialUsage")
	}
	return s.WriteCredentialUsageCall(ctx, events)
}

func (s *httpTestStore) WriteCredentialFamily(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
	if s.WriteCredentialFamilyCall == nil {
		unexpectedHTTPCall(s.t, "WriteCredentialFamily")
	}
	return s.WriteCredentialFamilyCall(ctx, fn)
}

func (s *httpTestStore) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	if s.WriteGrantLifecycleCall == nil {
		unexpectedHTTPCall(s.t, "WriteGrantLifecycle")
	}
	return s.WriteGrantLifecycleCall(ctx, fn)
}

func (s *httpTestStore) ReadTaskSearch(ctx context.Context, fn func(store.TaskSearchSnapshot) error) error {
	if s.ReadTaskSearchCall == nil {
		unexpectedHTTPCall(s.t, "ReadTaskSearch")
	}
	return s.ReadTaskSearchCall(ctx, fn)
}

func (s *httpTestStore) WriteWebhook(ctx context.Context, owner webhook.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	if s.WriteWebhookCall == nil {
		unexpectedHTTPCall(s.t, "WriteWebhook")
	}
	return s.WriteWebhookCall(ctx, owner, id, fn)
}

func (s *httpTestStore) ReadWebhookSnapshot(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	if s.ReadWebhookSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadWebhookSnapshot")
	}
	return s.ReadWebhookSnapshotCall(ctx, fn)
}

func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}

func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}

func httpTestToken(kind model.CredentialKind) string {
	const value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	switch kind {
	case model.PATCredential:
		return "dnpat_" + value
	case model.SessionCredential:
		return "dnst_" + value
	case model.OAuthCredential:
		return model.OAuthAccessPrefix + value
	default:
		panic("unsupported HTTP fixture credential kind: " + string(kind))
	}
}

func defaultHTTPToken() string { return httpTestToken(model.PATCredential) }

func newHTTPTestStore(t *testing.T) *httpTestStore {
	return newHTTPTestStoreForPrincipal(t, defaultHTTPPrincipal())
}

func newHTTPTestStoreForPrincipal(t *testing.T, principal model.Principal) *httpTestStore {
	t.Helper()
	s := &httpTestStore{t: t}
	s.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		dao := &httpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, principal: principal, hash: secret.Hash(httpTestToken(principal.Kind))}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			t.Errorf("authentication DAO calls = %d, want 1", dao.calls)
		}
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	return s
}

type httpAuthenticationScope struct {
	t   *testing.T
	dao store.IdentityDAO
}

func (s httpAuthenticationScope) IdentityDAO() store.IdentityDAO { return s.dao }
func (s httpAuthenticationScope) PersonalTeamDAO() store.PersonalTeamDAO {
	unexpectedHTTPCall(s.t, "PersonalTeamDAO")
	return nil
}

type httpAuthenticationDAO struct {
	httpRejectedIdentityDAO
	principal model.Principal
	hash      []byte
	calls     int
}

func (d *httpAuthenticationDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	d.calls++
	if d.calls != 1 || kind != d.principal.Kind || !bytes.Equal(hash, d.hash) || now.IsZero() || now.Location() != time.UTC {
		d.t.Errorf("authentication arguments/calls = %s/%x/%v/%d", kind, hash, now, d.calls)
		panic("invalid authentication DAO call")
	}
	return d.principal, nil
}

type httpRejectedIdentityDAO struct{ t *testing.T }

func (d httpRejectedIdentityDAO) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.Authenticate")
	panic("unreachable")
}

func (d httpRejectedIdentityDAO) CleanupCredentials(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupCredentials")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupLoginCredentials")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.AdmitLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertLogin(context.Context, model.LoginTransaction) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.UpsertUser")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertSession(context.Context, model.Session) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityUser")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityPersonalTeam")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeleteSession(context.Context, model.Principal) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeleteSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertPAT(context.Context, model.PersonalAccessToken) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertPAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ListPATs")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeletePAT(context.Context, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeletePAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockActivePAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetPATExpiry")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) PruneDeviceRates(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDeviceRates")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IncrementDeviceRate")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) PruneDevices(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDevices")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertDevice(context.Context, model.DeviceAuthorization) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertDevice")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeviceByUserCode")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockDeviceByHash")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetDeviceDecision")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DelayDevicePoll")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ConsumeDevice(context.Context, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeDevice")
	panic("unreachable")
}

// Independent operations use independent plans rather than a cross-goroutine FIFO.
type httpCallPlan struct {
	t          *testing.T
	mu         sync.Mutex
	want, seen map[string]int
}

func newHTTPCallPlan(t *testing.T, want map[string]int) *httpCallPlan {
	t.Helper()
	p := &httpCallPlan{t: t, want: make(map[string]int, len(want)), seen: make(map[string]int)}
	for name, count := range want {
		p.want[name] = count
	}
	t.Cleanup(p.Verify)
	return p
}
func (p *httpCallPlan) Called(name string) {
	p.mu.Lock()
	p.seen[name]++
	got, want := p.seen[name], p.want[name]
	p.mu.Unlock()
	if got > want {
		unexpectedHTTPCall(p.t, name)
	}
}
func (p *httpCallPlan) Verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, want := range p.want {
		if p.seen[name] != want {
			p.t.Errorf("DAO %s calls = %d, want %d", name, p.seen[name], want)
		}
	}
}

type httpTestSnapshot struct {
	t              *testing.T
	Credentials    store.CredentialReader
	Teams          store.TeamReader
	Projects       store.ProjectReader
	Tasks          store.TaskReader
	Workers        store.WorkerReader
	Sessions       store.SessionReader
	Bots           store.BotReader
	Attachments    store.AttachmentReader
	ObservedAtCall func(context.Context) (time.Time, error)
}

func newHTTPTestSnapshot(t *testing.T) *httpTestSnapshot { return &httpTestSnapshot{t: t} }
func (s *httpTestSnapshot) CredentialDAO() store.CredentialReader {
	if s.Credentials == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.CredentialDAO")
	}
	return s.Credentials
}
func (s *httpTestSnapshot) TeamDAO() store.TeamReader {
	if s.Teams == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.TeamDAO")
	}
	return s.Teams
}
func (s *httpTestSnapshot) ProjectDAO() store.ProjectReader {
	if s.Projects == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.ProjectDAO")
	}
	return s.Projects
}
func (s *httpTestSnapshot) TaskDAO() store.TaskReader {
	if s.Tasks == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.TaskDAO")
	}
	return s.Tasks
}
func (s *httpTestSnapshot) WorkerDAO() store.WorkerReader {
	if s.Workers == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.WorkerDAO")
	}
	return s.Workers
}
func (s *httpTestSnapshot) SessionDAO() store.SessionReader {
	if s.Sessions == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.SessionDAO")
	}
	return s.Sessions
}
func (s *httpTestSnapshot) BotDAO() store.BotReader {
	if s.Bots == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.BotDAO")
	}
	return s.Bots
}
func (s *httpTestSnapshot) AttachmentDAO() store.AttachmentReader {
	if s.Attachments == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.AttachmentDAO")
	}
	return s.Attachments
}
func (s *httpTestSnapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	if s.ObservedAtCall == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.ObservedAt")
	}
	return s.ObservedAtCall(ctx)
}

func TestReadinessUsesResourceAndReportsFailure(t *testing.T) {
	mux := http.NewServeMux()
	var failure error
	calls := 0
	healthRoutes(mux, func(ctx context.Context) error {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("readiness has no deadline")
		}
		return failure
	}, testLogger())
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		if status != http.StatusOK {
			failure = errors.New("private database failure")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("readiness status=%d headers=%v", response.Code, response.Header())
		}
	}
	if calls != 2 {
		t.Fatalf("readiness called %d times", calls)
	}
}

const uiTestScriptPath = "/assets/app-12345678.js"

func uiTestHandler(t *testing.T, output io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: &httpTestStore{t: t}}, configuredTestConfig(), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handler.(Handler).Shutdown(context.Background()) })
	return httpx.RequestLogging(logger, handler)
}

func TestUIWiringAndUnknownRoutes(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	root := projectRequest(handler, http.MethodGet, "/", "")
	if root.Code != http.StatusOK || root.Header().Get("Content-Type") != "text/html; charset=utf-8" || root.Header().Get("Cache-Control") != "no-store" || root.Body.String() != "<html><body>server test shell</body></html>\n" {
		t.Fatalf("root UI response: %d %+v", root.Code, root.Header())
	}
	var entries []map[string]any
	decoder := json.NewDecoder(&logs)
	for decoder.More() {
		var entry map[string]any
		if err := decoder.Decode(&entry); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
	}
	if len(entries) != 1 || entries[0]["type"] != "http_request" || entries[0]["route"] != "GET /{$}" || entries[0]["request_id"] != "project-test" {
		t.Fatalf("UI must reuse exactly one request logger: %+v", entries)
	}
	device := projectRequest(handler, http.MethodGet, "/device?user_code=BCDFG-HJKLM", "")
	if device.Code != http.StatusOK || !bytes.Equal(device.Body.Bytes(), root.Body.Bytes()) || device.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("device shell wiring: %d %+v", device.Code, device.Header())
	}
	asset := projectRequest(handler, http.MethodGet, uiTestScriptPath, "")
	if asset.Code != http.StatusOK || asset.Body.String() != "console.log(\"server test asset\");\n" || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset wiring: %d %+v", asset.Code, asset.Header())
	}
	for _, target := range []string{
		"/unknown-private-page", "/team-invitations/child", "/team-invitations/", "/setup/", "/setup/private-child", "/setup-private", "/login/", "/login/private-child", "/login-private", "/projects/", "/projects-list", "/projects/id/extra", "/projects/id/members/extra", "/projects/id/settings/extra",
		"/projects/id/tasks", "/projects/id/tasks/task/unknown", "/projects/id/tasks/task/unknown/file", "/projects/id/tasks/task/attachment/file",
		"/workers/", "/workers-list", "/workers/id/extra", "/workers/id/assets/missing.js",
		"/teams/", "/teams/id/extra", "/teams/id/settings/extra", "/teams/id/members/extra", "/shared-projects/extra",
		"/test-sessions/id/extra", "/test-sessions/id/assets/missing.js", "/assets/missing-test-session.js",
		"/bots/", "/bots-list", "/bots/id/extra", "/bots/id/assets/missing.js",
		"/api/unknown-private-route", "/api/v1/projects/id/unknown", "/assets/", "/assets/missing-private.js",
		"/assets/%2e%2e/index.html", "/assets/%2findex.html",
	} {
		response := projectRequest(handler, http.MethodGet, target, "")
		assertProjectError(t, response, http.StatusNotFound, "not_found")
		if strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("unknown path returned SPA HTML: %s", target)
		}
	}
	if strings.Contains(logs.String(), "private") || strings.Contains(logs.String(), "BCDFG-HJKLM") {
		t.Fatalf("UI request leaked to logs: %s", &logs)
	}
}

func TestUIRegistrationPreservesAPIResponses(t *testing.T) {
	f := newTaskHTTPFixture(t)
	path := taskCollection(f.project.ID) + "/" + f.target.ID
	graph := graphPath(f.project.ID, f.target.ID)
	for _, target := range []string{"/api/v1/projects", "/api/v1/projects/" + f.project.ID, "/api/v1/projects/" + f.project.ID + "/members", taskCollection(f.project.ID), path, graph} {
		switch target {
		case "/api/v1/projects":
			accessHTTPProject(t, f.store, f.principal, f.project, taskHTTPMockAccess(f.project, f.principal), "list", nil, nil)
		case "/api/v1/projects/" + f.project.ID:
			accessHTTPProject(t, f.store, f.principal, f.project, taskHTTPMockAccess(f.project, f.principal), "project", nil, nil)
		case "/api/v1/projects/" + f.project.ID + "/members":
			accessHTTPProject(t, f.store, f.principal, f.project, taskHTTPMockAccess(f.project, f.principal), "members", nil, nil)
		case taskCollection(f.project.ID):
			f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: []model.Task{f.target}}})
		case path:
			f.expectRead(f.target)
		case graph:
			f.expectGraph(f.target.ID, []model.GraphTask{{ID: f.target.ID, TitlePreview: f.target.Title, Status: f.target.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: f.target.AssignedTo, Ready: true, CreatedAt: f.target.CreatedAt, UpdatedAt: f.target.UpdatedAt}})
		}
		response := projectRequest(f.handler, http.MethodGet, target, "")
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("UI registration changed API response: %s %d %+v", target, response.Code, response.Header())
		}
		if (target == path || target == graph) && response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("latest task read may be cached: %s %+v", target, response.Header())
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+f.project.ID+"/members", nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	if response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
		t.Fatal("member API must retain authenticated JSON behavior")
	}
}

func TestUIRegistrationKeepsDataRoutesProtected(t *testing.T) {
	handler := uiTestHandler(t, io.Discard)
	for _, path := range []string{
		"/api/v1/test-sessions",
		"/api/v1/test-sessions/10000000-0000-0000-0000-000000000001",
		"/api/v1/me/bots",
		"/api/v1/me/bots/10000000-0000-0000-0000-000000000001",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized || response.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("UI registration changed protected API: %s %d %+v", path, response.Code, response.Header())
		}
	}
}
func TestSessionShutdownDisconnectsControllerBeforeStoppingEngine(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.controller(t, uuid.NewString())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f.mu.Lock()
	connected := f.writes.instance != "" && f.writes.connectionExpiry != nil
	before := f.writes.disconnected
	f.mu.Unlock()
	if !connected {
		t.Fatal("controller connection DAO was not called")
	}
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	after := f.writes.disconnected
	f.mu.Unlock()
	if after != before+1 {
		t.Fatalf("shutdown disconnect calls=%d, want%d", after-before, 1)
	}
	if err := f.application.engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if op, err := f.application.engine.BeginOperation(); err == nil {
		op.Close()
		t.Fatal("shutdown left Session engine accepting operations")
	}
}

func TestApplicationShutdownWaitsForMCPBeforeStoppingRelay(t *testing.T) {
	fixture := sessionHTTPSetup(t)
	controller, _ := fixture.controller(t, uuid.NewString())
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseWork := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseWork)
	schema := map[string]any{"type": "object"}
	err := fixture.application.mcp.RegisterTool(&sdk.Tool{Name: "test_shutdown", InputSchema: schema, OutputSchema: schema}, mcphttp.BudgetControl,
		func(ctx context.Context, _ mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
			close(entered)
			<-ctx.Done()
			close(canceled)
			<-release
			return mcphttp.ToolResult{}, ctx.Err()
		})
	if err != nil {
		t.Fatal(err)
	}
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test_shutdown","arguments":{}}}`))
		if err != nil {
			return
		}
		request.Header.Set("Authorization", "Bearer "+fixture.handler.token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("MCP-Protocol-Version", "2025-11-25")
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	t.Cleanup(func() {
		releaseWork()
		select {
		case <-clientDone:
		case <-time.After(5 * time.Second):
			t.Error("MCP client did not stop")
		}
	})
	await(t, entered)
	shutdown, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	err = fixture.application.Shutdown(shutdown)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected MCP drain timeout, got %v", err)
	}
	await(t, canceled)
	if fixture.application.relay.ActiveConnections() != 1 {
		t.Fatal("MCP drain timeout stopped the controller relay")
	}
	operation, err := fixture.application.engine.BeginOperation()
	if err != nil {
		t.Fatalf("MCP drain timeout stopped the session engine: %v", err)
	}
	operation.Close()

	releaseWork()
	await(t, clientDone)
	shutdown, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := fixture.application.Shutdown(shutdown); err != nil {
		t.Fatalf("shutdown after MCP handler exit: %v", err)
	}
	if fixture.application.relay.ActiveConnections() != 0 {
		t.Fatal("controller relay retained its connection after shutdown")
	}
	operation, err = fixture.application.engine.BeginOperation()
	if err != nil {
		t.Fatalf("transport shutdown unexpectedly stopped the session engine: %v", err)
	}
	operation.Close()
	if err := fixture.application.engine.Stop(shutdown); err != nil {
		t.Fatalf("application engine drain failed: %v", err)
	}
	if operation, err := fixture.application.engine.BeginOperation(); err == nil {
		operation.Close()
		t.Fatal("session engine admitted work after application drain")
	}
	read, stopRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRead()
	if _, _, err := controller.Read(read); err == nil {
		t.Fatal("controller connection remained open after shutdown")
	}
}

type webhookHTTPApplicationFixture struct {
	t           *testing.T
	cfg         config.Config
	store       *httpTestStore
	runtime     *Runtime
	cancel      context.CancelFunc
	done        chan error
	user, token string
}

func (f *webhookHTTPApplicationFixture) start() {
	f.t.Helper()
	client, err := service.NewIdentityClient(f.cfg.UniAuth)
	if err != nil {
		f.t.Fatal(err)
	}
	app := service.NewModules(f.cfg, f.store, func(context.Context) error { return nil }, attachmentTestFiles(f.t), client)
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	// Routes consume the selected service. Process tests own OpenApp's worker and resource assembly.
	app.Webhooks = &webhookservice.Service{DB: f.store, ConfigurationExpansionAvailable: f.cfg.Webhook.Enabled, DispatchEnabled: f.cfg.Webhook.Enabled, Random: bytes.NewReader(nil)}
	handler, err := New(app, f.cfg, testLogger())
	if err != nil {
		if cleanup := app.Close(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		f.t.Fatal(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.Server.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		if cleanup := handler.Shutdown(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		if cleanup := app.Close(context.Background()); cleanup != nil {
			f.t.Error(cleanup)
		}
		f.t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
}
func (f *webhookHTTPApplicationFixture) stop() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	select {
	case err := <-f.done:
		if err != nil {
			f.t.Errorf("runtime shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		f.t.Error("runtime shutdown timed out")
	}
	f.cancel = nil
}
func (f *webhookHTTPApplicationFixture) request(method, path, body string) (int, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(method, "http://"+f.runtime.Address()+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: f.token})
	req.Header.Set("Origin", f.cfg.Server.PublicOrigin)
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			f.t.Error(err)
		}
	}()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if path != "/readyz" && (response.Header.Get("Daynight-User-ID") != f.user || response.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatalf("missing authentication headers: %v", response.Header)
	}
	return response.StatusCode, data
}
func (f *webhookHTTPApplicationFixture) expect(method, path, body string, status int) []byte {
	f.t.Helper()
	got, data := f.request(method, path, body)
	if got != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, got, status, data)
	}
	return data
}

type rootWebhookReadScope struct {
	store.WebhookHistoryReader
	store.WebhookReadScope
	store.WebhookReader
	store.CredentialReader
	t         *testing.T
	principal model.Principal
	mu        sync.Mutex
	calls     []string
}

func (s *rootWebhookReadScope) CredentialDAO() store.CredentialReader { return s }
func (s *rootWebhookReadScope) WebhookDAO() store.WebhookReader       { return s }
func (s *rootWebhookReadScope) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "Credential")
	if p != s.principal {
		s.t.Fatalf("principal = %#v", p)
	}
	return store.ThreadCredential{}, nil
}
func (s *rootWebhookReadScope) Policy(_ context.Context, version int64) (webhook.Policy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "Policy")
	if version != 1 {
		s.t.Fatalf("policy version = %d", version)
	}
	return webhook.Policy{Version: 1}, nil
}
func (s *rootWebhookReadScope) Endpoints(_ context.Context, owner webhook.Owner) ([]webhook.Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "Endpoints")
	if owner != (webhook.Owner{Kind: "personal", ID: s.principal.UserID}) {
		s.t.Fatalf("owner = %#v", owner)
	}
	return []webhook.Endpoint{}, nil
}

func TestWebhookRuntimeRouteAssembly(t *testing.T) {
	principal := defaultHTTPPrincipal()
	principal.Kind = model.SessionCredential
	database := newHTTPTestStoreForPrincipal(t, principal)
	var scopes []*rootWebhookReadScope
	var scopesMu sync.Mutex
	database.ReadWebhookSnapshotCall = func(_ context.Context, fn func(store.WebhookReadScope) error) error {
		scope := &rootWebhookReadScope{t: t, principal: principal}
		scopesMu.Lock()
		scopes = append(scopes, scope)
		scopesMu.Unlock()
		return fn(scope)
	}
	c := configuredTestConfig()
	c.Server.ShutdownTimeout = 5 * time.Second
	f := &webhookHTTPApplicationFixture{t: t, cfg: c, store: database, user: principal.UserID, token: httpTestToken(principal.Kind)}
	t.Cleanup(f.stop)
	f.start()
	f.expect("GET", "/readyz", "", 200)
	catalog := f.expect("GET", "/api/v1/webhook-event-types", "", 200)
	var data struct {
		Items   []any `json:"items"`
		Service struct {
			Dispatch bool `json:"dispatchEnabled"`
		} `json:"service"`
	}
	if err := json.Unmarshal(catalog, &data); err != nil || len(data.Items) != 6 || data.Service.Dispatch {
		t.Fatalf("catalog: %s (%v)", catalog, err)
	}
	empty := f.expect("GET", "/api/v1/me/webhooks", "", 200)
	if !bytes.Contains(empty, []byte(`"items":[]`)) {
		t.Fatalf("collection: %s", empty)
	}
	f.stop()
	scopesMu.Lock()
	defer scopesMu.Unlock()
	if len(scopes) != 2 {
		t.Fatalf("scope count: %d", len(scopes))
	}
	for i, want := range [][]string{{"Credential", "Policy"}, {"Credential", "Endpoints"}} {
		scopes[i].mu.Lock()
		got := append([]string(nil), scopes[i].calls...)
		scopes[i].mu.Unlock()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("scope %d calls: %v, want %v", i, got, want)
		}
	}
}

func TestRegisterMCPAdaptersStopsAndPropagatesFailures(t *testing.T) {
	projectErr := errors.New("project registration failed")
	invitationErr := errors.New("invitation registration failed")
	taskErr := errors.New("task registration failed")
	for _, tc := range []struct {
		name          string
		projectErr    error
		invitationErr error
		taskErr       error
		wantErr       error
		wantCalls     []string
	}{
		{name: "project fails", projectErr: projectErr, wantErr: projectErr, wantCalls: []string{"project"}},
		{name: "invitation fails", invitationErr: invitationErr, wantErr: invitationErr, wantCalls: []string{"project", "invitation"}},
		{name: "task fails", taskErr: taskErr, wantErr: taskErr, wantCalls: []string{"project", "invitation", "task"}},
		{name: "all succeed", wantCalls: []string{"project", "invitation", "task"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			err := registerMCPAdapters(func() error {
				calls = append(calls, "project")
				return tc.projectErr
			}, func() error {
				calls = append(calls, "invitation")
				return tc.invitationErr
			}, func() error {
				calls = append(calls, "task")
				return tc.taskErr
			})
			if !errors.Is(err, tc.wantErr) || !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("registration: err=%v calls=%v", err, calls)
			}
		})
	}
}

func TestMCPRegistrationStopsAtEveryFailure(t *testing.T) {
	failure := errors.New("registration failed")
	for _, index := range []int{0, 1, 2, 3, 4} {
		calls := 0
		adapters := make([]func() error, 5)
		for i := range adapters {
			adapters[i] = func() error {
				calls++
				if i == index {
					return failure
				}
				return nil
			}
		}
		err := registerMCPAdapters(adapters...)
		if !errors.Is(err, failure) || calls != index+1 {
			t.Fatalf("failure at %d: calls=%d err=%v", index, calls, err)
		}
	}
}

func TestApplicationBeginShutdownStopsWorkerReadOnlyAdmission(t *testing.T) {
	broker := ro.New(func(context.Context, model.Principal, string) error { return nil })
	routes := workerhttp.NewReadOnlyRoutes(broker, nil, slog.Default())
	app := &sessionApplication{workerReadOnly: routes}
	app.BeginShutdown()
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err := broker.Connect(context.Background(), p, uuid.NewString(), ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
	if ro.ErrorCode(err) != "offline" {
		t.Fatal("application shutdown retained Worker admission", err)
	}
	if err := routes.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (s *httpTestSnapshot) TagDAO() store.TagReader {
	unexpectedHTTPCall(s.t, "SnapshotScope.TagDAO")
	return nil
}

func (s *httpTestSnapshot) GitHubDAO() store.GitHubReadDAO { panic("unexpected GitHubDAO access") }
