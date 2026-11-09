package server

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

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
