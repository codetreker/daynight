package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// The empty maintenance batches are explicit startup facts. Metadata writes do
// not change later reads; only resource opening and closure retain local state.
type appBackend struct {
	store.Transactions
	store.WebhookDeliveryTransactions
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
	t                                                                                 *testing.T
	mu                                                                                sync.Mutex
	calls                                                                             map[string]int
	opened, closed                                                                    bool
	closes, policiesRead, referencesRead                                              int
	expectedPolicies, expectedReferences                                              int
	oauthCompletion, authorizationCompletion, credentialCompletion, privateCompletion store.Completion
	policies                                                                          []wm.Policy
	referencesErr, oauthErr, privateErr, deliveryErr                                  error
	deliveryWait, deliveryStarted                                                     chan struct{}
	deliveryOnce                                                                      sync.Once
	runtimeBlocked                                                                    bool
	privateRecord, privateUpdated                                                     *model.PrivateTransfer
	privateActor                                                                      *model.Principal
	privateGets, privatePuts                                                          int
}

func newAppBackend(t *testing.T) *appBackend {
	t.Helper()
	b := &appBackend{t: t, expectedPolicies: 1, expectedReferences: 1, oauthCompletion: store.Completion{Outcome: store.TransactionCommitted}, authorizationCompletion: store.Completion{Outcome: store.TransactionCommitted}, credentialCompletion: store.Completion{Outcome: store.TransactionCommitted}, privateCompletion: store.Completion{Outcome: store.TransactionCommitted}, policies: []wm.Policy{{Version: 1, MaxAutomaticAttempts: 10, AutomaticWindowSeconds: 259200,
		AutomaticOffsetsSeconds: []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600}, MaxManualOperations: 3,
		PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000, OperationRetentionSeconds: 2592000,
		OperationMaxAgeSeconds: 300, OperationFutureSkewSeconds: 60, HTTPTimeoutSeconds: 15, LeaseSeconds: 45,
		MinimumFailureWaitSeconds: 5, JitterBasisPoints: 1000, JitterMaxSeconds: 1800, KeyOverlapDefaultSeconds: 86400, KeyOverlapMaxSeconds: 604800}}}
	b.Transactions = unexpectedAppTransactions{backend: b}
	t.Cleanup(func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.opened && b.closes != 1 {
			t.Errorf("App backend close calls=%d, want 1", b.closes)
		}
		if b.opened && (b.policiesRead != b.expectedPolicies || b.referencesRead != b.expectedReferences) {
			t.Errorf("App startup calls policies=%d references=%d, want %d/%d", b.policiesRead, b.referencesRead, b.expectedPolicies, b.expectedReferences)
		}

	})
	return b
}
func (b *appBackend) record(name string, maximum int) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.calls == nil {
		b.calls = make(map[string]int)
	}
	b.calls[name]++
	if b.calls[name] > maximum {
		return b.unexpected("extra " + name)
	}
	return nil
}

func (b *appBackend) check(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		b.t.Error("operation used closed App backend")
		return errors.New("App backend closed")
	}
	if ctx == nil {
		b.t.Error("nil App dependency context")
		return errors.New("nil App dependency context")
	}
	return ctx.Err()
}
func (b *appBackend) unexpected(name string) error {
	b.t.Helper()
	b.t.Errorf("unconfigured App dependency call: %s", name)
	return errors.New("unconfigured App dependency call: " + name)
}
func (b *appBackend) Ready(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.closed {
		return errors.New("App backend closed")
	}
	return nil
}
func (b *appBackend) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closes++
	b.closed = true
	if b.closes != 1 {
		b.t.Errorf("App backend closed %d times", b.closes)
	}
}
func (b *appBackend) WebhookStartupPolicies(ctx context.Context) ([]wm.Policy, error) {
	if err := b.check(ctx); err != nil {
		return nil, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.policiesRead++
	if b.policiesRead != 1 {
		return nil, b.unexpected("WebhookStartupPolicies")
	}
	return b.policies, nil
}
func (b *appBackend) CheckWebhookCurrentReferences(ctx context.Context) error {
	if err := b.check(ctx); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.referencesRead++
	if b.referencesRead != 1 {
		return b.unexpected("CheckWebhookCurrentReferences")
	}
	return b.referencesErr
}
func (b *appBackend) guardCallback() {
	if recovered := recover(); recovered != nil {
		b.t.Errorf("unconfigured App callback dependency panicked: %v", recovered)
		panic(recovered)
	}
}
func (b *appBackend) WriteOAuthClients(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	if err := b.record("WriteOAuthClients", 1); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if err := b.check(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if b.oauthErr != nil {
		return b.oauthCompletion, b.oauthErr
	}
	defer b.guardCallback()
	dao := &appMaintenanceDAO{backend: b}
	err := fn(appOAuthScope{dao})
	if dao.used == 0 {
		err = errors.Join(err, b.unexpected("OAuth callback without configured DAO operation"))
	}
	return b.oauthCompletion, err
}
func (b *appBackend) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	if err := b.record("WriteAuthorizations", 1); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if err := b.check(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	defer b.guardCallback()
	dao := &appMaintenanceDAO{backend: b}
	err := fn(appAuthorizationScope{dao: dao})
	if dao.used == 0 {
		err = errors.Join(err, b.unexpected("authorization callback without configured DAO operation"))
	}
	return b.authorizationCompletion, err
}
func (b *appBackend) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	if err := b.record("WriteGrantLifecycle", 1); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if err := b.check(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	defer b.guardCallback()
	dao := &appMaintenanceDAO{backend: b}
	err := fn(dao)
	if dao.used == 0 {
		err = errors.Join(err, b.unexpected("credential callback without configured DAO operation"))
	}
	return b.credentialCompletion, err
}
func (b *appBackend) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	maximum := 3
	if b.privateRecord != nil {
		maximum++
	}
	if err := b.record("WritePrivateTransfer", maximum); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if err := b.check(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	defer b.guardCallback()
	dao := &appMaintenanceDAO{backend: b}
	err := fn(dao)
	if dao.used == 0 {
		err = errors.Join(err, b.unexpected("private callback without configured DAO operation"))
	}
	return b.privateCompletion, err
}

type appOAuthScope struct{ dao *appMaintenanceDAO }

func (s appOAuthScope) OAuthClientDAO() store.OAuthClientDAO           { return s.dao }
func (s appOAuthScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

type appAuthorizationScope struct {
	store.AuthorizationScope
	dao *appMaintenanceDAO
}

func (s appAuthorizationScope) AuthorizationDAO() store.AuthorizationDAO { return s.dao }

type appMaintenanceDAO struct {
	store.OAuthClientDAO
	store.AuthorizationDAO
	store.GrantLifecycleDAO
	store.PrivateTransferDAO
	backend *appBackend
	used    int
}

func (d *appMaintenanceDAO) LockClientCapacity(ctx context.Context) error {
	d.used++
	if err := d.backend.record("LockClientCapacity", 1); err != nil {
		return err
	}
	return d.backend.check(ctx)
}
func (d *appMaintenanceDAO) ExpiredClients(ctx context.Context, now time.Time, limit int) ([]string, error) {
	d.used++
	if err := d.backend.record("ExpiredClients", 1); err != nil {
		return nil, err
	}
	if now.IsZero() || limit != 100 {
		return nil, d.backend.unexpected("ExpiredClients arguments")
	}
	return []string{}, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) LockAuthorizationCapacity(ctx context.Context) error {
	d.used++
	if err := d.backend.record("LockAuthorizationCapacity", 1); err != nil {
		return err
	}
	return d.backend.check(ctx)
}
func (d *appMaintenanceDAO) AuthorizationCleanupCursor(ctx context.Context) (int, error) {
	d.used++
	if err := d.backend.record("AuthorizationCleanupCursor", 1); err != nil {
		return 0, err
	}
	return 0, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) SetAuthorizationCleanupCursor(ctx context.Context, value int) error {
	d.used++
	if err := d.backend.record("SetAuthorizationCleanupCursor", 1); err != nil {
		return err
	}
	if value != 0 {
		return d.backend.unexpected("SetAuthorizationCleanupCursor arguments")
	}
	return d.backend.check(ctx)
}
func (d *appMaintenanceDAO) ExpiredAuthorizations(ctx context.Context, now time.Time, limit int) ([]store.OAuthAuthorization, error) {
	d.used++
	if err := d.backend.record("ExpiredAuthorizations", 2); err != nil {
		return nil, err
	}
	if now.IsZero() || (limit != 50 && limit != 100) {
		return nil, d.backend.unexpected("ExpiredAuthorizations arguments")
	}
	return []store.OAuthAuthorization{}, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) DeleteRetainedAuthorizations(ctx context.Context, now time.Time, limit int) (int, error) {
	d.used++
	if err := d.backend.record("DeleteRetainedAuthorizations", 2); err != nil {
		return 0, err
	}
	if now.IsZero() || (limit != 50 && limit != 100) {
		return 0, d.backend.unexpected("DeleteRetainedAuthorizations arguments")
	}
	return 0, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) PruneCredentials(ctx context.Context, now time.Time, limit int) (int, error) {
	d.used++
	if err := d.backend.record("PruneCredentials", 1); err != nil {
		return 0, err
	}
	if now.IsZero() || limit != 100 {
		return 0, d.backend.unexpected("PruneCredentials arguments")
	}
	return 0, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	d.used++
	return time.Time{}, d.backend.unexpected("FreshTime")
}
func (d *appMaintenanceDAO) Due(ctx context.Context, now time.Time, limit int) ([]model.PrivateTransfer, error) {
	d.used++
	if err := d.backend.record("Due", 1); err != nil {
		return nil, err
	}
	if now.IsZero() || limit != 100 {
		return nil, d.backend.unexpected("Due arguments")
	}
	if err := d.backend.check(ctx); err != nil {
		return nil, err
	}
	if d.backend.privateErr != nil {
		return nil, d.backend.privateErr
	}
	return []model.PrivateTransfer{}, nil
}
func (d *appMaintenanceDAO) Prune(ctx context.Context, now time.Time, limit int) (int64, error) {
	d.used++
	if err := d.backend.record("Prune", 1); err != nil {
		return 0, err
	}
	if now.IsZero() || limit != 100 {
		return 0, d.backend.unexpected("Prune arguments")
	}
	return 0, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) Stats(ctx context.Context) (store.PrivateTransferStats, error) {
	d.used++
	if err := d.backend.record("Stats", 1); err != nil {
		return store.PrivateTransferStats{}, err
	}
	return store.PrivateTransferStats{ReservedBytes: 0, CleanupPending: 0}, d.backend.check(ctx)
}
func (d *appMaintenanceDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	d.used++
	if err := d.backend.check(ctx); err != nil {
		return model.PrivateTransfer{}, err
	}
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.privateRecord == nil || id != b.privateRecord.ID {
		return model.PrivateTransfer{}, b.unexpected("Get private transfer")
	}
	b.privateGets++
	if b.privateGets > 2 {
		return model.PrivateTransfer{}, b.unexpected("extra Get private transfer")
	}
	return *b.privateRecord, nil
}
func (d *appMaintenanceDAO) Authorize(ctx context.Context, p model.Principal, kind, id, project, task string) error {
	d.used++
	if err := d.backend.check(ctx); err != nil {
		return err
	}
	b := d.backend
	if b.privateRecord == nil || b.privateActor == nil || p != *b.privateActor || kind != b.privateRecord.AuthorityKind || id != b.privateRecord.AuthorityID || project != b.privateRecord.ProjectID || task != b.privateRecord.TaskID {
		return b.unexpected("private transfer authorization")
	}
	return nil
}
func (d *appMaintenanceDAO) Put(ctx context.Context, r model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	d.used++
	if err := d.backend.check(ctx); err != nil {
		return model.PrivateTransfer{}, err
	}
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.privateRecord == nil || b.privateUpdated == nil || r.ID != b.privateRecord.ID || version != b.privateRecord.Version || r.ExpiresAt.IsZero() {
		return model.PrivateTransfer{}, b.unexpected("Put private transfer")
	}
	b.privatePuts++
	if b.privatePuts != 1 {
		return model.PrivateTransfer{}, b.unexpected("extra Put private transfer")
	}
	return *b.privateUpdated, nil
}
func (b *appBackend) blockWebhookRuntime() {
	b.runtimeBlocked = true
	b.deliveryStarted = make(chan struct{})
}
func (b *appBackend) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	if err := b.check(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if !b.runtimeBlocked {
		return store.Completion{Outcome: store.TransactionNotCommitted}, b.unexpected("WriteWebhookDelivery")
	}
	b.deliveryOnce.Do(func() { close(b.deliveryStarted) })
	if b.deliveryWait != nil {
		select {
		case <-b.deliveryWait:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	if b.deliveryErr != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, b.deliveryErr
	}
	<-ctx.Done()
	return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
}
func (b *appBackend) ScanWebhookConfigGC(ctx context.Context, _ *store.WebhookConfigGCCandidate, _ int) (store.WebhookConfigGCScan, error) {
	if !b.runtimeBlocked {
		return store.WebhookConfigGCScan{}, b.unexpected("ScanWebhookConfigGC")
	}
	<-ctx.Done()
	return store.WebhookConfigGCScan{}, ctx.Err()
}
func (b *appBackend) WriteWebhookRetention(context.Context, func(store.WebhookRetentionScope) error) (store.Completion, error) {
	return store.Completion{}, b.unexpected("WriteWebhookRetention")
}
func (b *appBackend) ObserveWebhookRetention(context.Context, string, string) error {
	return b.unexpected("ObserveWebhookRetention")
}
func (b *appBackend) ExpiredWebhookReceipts(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error) {
	return nil, b.unexpected("ExpiredWebhookReceipts")
}
func (b *appBackend) WriteWebhookReceiptGC(context.Context, store.WebhookReceiptIdentity, func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	return store.Completion{}, b.unexpected("WriteWebhookReceiptGC")
}
func (b *appBackend) ObserveWebhookReceipt(context.Context, store.WebhookReceiptIdentity) (time.Time, bool, error) {
	return time.Time{}, false, b.unexpected("ObserveWebhookReceipt")
}
func (b *appBackend) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return false, b.unexpected("WebhookConfigGCBarrierPassed")
}
func (b *appBackend) WriteWebhookConfigGC(context.Context, store.WebhookConfigGCCandidate, func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	return store.Completion{}, b.unexpected("WriteWebhookConfigGC")
}
func (b *appBackend) ObserveWebhookConfigGC(context.Context, store.WebhookConfigGCCandidate) (bool, error) {
	return false, b.unexpected("ObserveWebhookConfigGC")
}

type appObservedStorage struct {
	*local.Storage
	backend *appBackend
	mu      sync.Mutex
	closes  int
}

func (f *appObservedStorage) Close() error {
	f.mu.Lock()
	f.closes++
	closes := f.closes
	f.mu.Unlock()
	if closes != 1 {
		f.backend.t.Errorf("App files closed %d times", closes)
	}
	f.backend.mu.Lock()
	opened, closed := f.backend.opened, f.backend.closed
	f.backend.mu.Unlock()
	if opened && !closed {
		f.backend.t.Error("App files closed before persistence")
	}
	return f.Storage.Close()
}
func appTestOpeners(t *testing.T, c config.Config, b *appBackend) appOpeners {
	t.Helper()
	return appOpeners{
		files: func(root string) (appStorage, error) {
			if err := b.record("openFiles", 1); err != nil {
				return nil, err
			}
			if root != c.StorageRoot {
				return nil, b.unexpected("storage root")
			}
			storage, err := local.New(root)
			if err != nil {
				return nil, err
			}
			observed := &appObservedStorage{Storage: storage, backend: b}
			t.Cleanup(func() {
				observed.mu.Lock()
				defer observed.mu.Unlock()
				if observed.closes != 1 {
					t.Errorf("App files close calls=%d, want 1", observed.closes)
				}
			})
			return observed, nil
		},
		database: func(ctx context.Context, url string) (persistenceBackend, error) {
			if err := b.record("openDatabase", 1); err != nil {
				return nil, err
			}
			if url != c.DatabaseURL {
				return nil, b.unexpected("database URL")
			}
			if _, ok := ctx.Deadline(); !ok {
				return nil, b.unexpected("database startup deadline")
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			b.mu.Lock()
			b.opened = true
			b.mu.Unlock()
			return b, nil
		},
	}
}
func openTestApp(t *testing.T, ctx context.Context, c config.Config, logger *slog.Logger) (*App, *appBackend, error) {
	t.Helper()
	b := newAppBackend(t)
	app, err := openApp(ctx, c, logger, appTestOpeners(t, c, b))
	if app != nil {
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := app.Close(cleanup); err != nil {
				t.Error(err)
			}
		})
	}
	return app, b, err
}

// Unconfigured capability calls mark the test independently of worker panic recovery.
type unexpectedAppTransactions struct{ backend *appBackend }

var _ store.Transactions = unexpectedAppTransactions{}

func (s unexpectedAppTransactions) CreateTeam(context.Context, string, func(store.TeamCreationDAO) error) (store.Completion, error) {
	failure := s.backend.unexpected("CreateTeam")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) DeleteAttachment(context.Context, string, string, string) error {
	failure := s.backend.unexpected("DeleteAttachment")
	return failure
}
func (s unexpectedAppTransactions) PutAttachment(context.Context, model.Attachment) (model.Attachment, bool, error) {
	failure := s.backend.unexpected("PutAttachment")
	var value0 model.Attachment
	var value1 bool
	return value0, value1, failure
}
func (s unexpectedAppTransactions) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	failure := s.backend.unexpected("ReadSnapshot")
	return failure
}
func (s unexpectedAppTransactions) ReadPromptSnapshot(context.Context, func(store.PromptSnapshot) error) error {
	return s.backend.unexpected("ReadPromptSnapshot")
}
func (s unexpectedAppTransactions) WritePrompt(context.Context, func(store.PromptWriteScope) error) (store.Completion, error) {
	return store.Completion{}, s.backend.unexpected("WritePrompt")
}
func (s unexpectedAppTransactions) ReadTaskSearch(context.Context, func(store.TaskSearchSnapshot) error) error {
	failure := s.backend.unexpected("ReadTaskSearch")
	return failure
}
func (s unexpectedAppTransactions) ReadWebhookSnapshot(context.Context, func(store.WebhookReadScope) error) error {
	failure := s.backend.unexpected("ReadWebhookSnapshot")
	return failure
}
func (s unexpectedAppTransactions) WriteAttachmentMutation(context.Context, func(store.AttachmentMutationScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteAttachmentMutation")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteAuthorizations(context.Context, func(store.AuthorizationScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteAuthorizations")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteBot(context.Context, func(store.BotScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteBot")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteCredentialFamily(context.Context, func(store.CredentialFamilyScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteCredentialFamily")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteGrantLifecycle(context.Context, func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteGrantLifecycle")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteIdentity(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteIdentity")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteOAuthClients(context.Context, func(store.OAuthClientScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteOAuthClients")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WritePrivateTransfer(context.Context, func(store.PrivateTransferDAO) error) (store.Completion, error) {
	failure := s.backend.unexpected("WritePrivateTransfer")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteProject(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteProject")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteProjectCreation(context.Context, string, func(store.ProjectCreationDAO) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteProjectCreation")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteSession(context.Context, func(store.SessionScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteSession")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteTeam(context.Context, string, func(store.TeamWriteScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteTeam")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteThread(context.Context, func(store.ThreadScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteThread")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteWebhook(context.Context, wm.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteWebhook")
	var value0 store.Completion
	return value0, failure
}
func (s unexpectedAppTransactions) WriteWorker(context.Context, func(store.WorkerScope) error) (store.Completion, error) {
	failure := s.backend.unexpected("WriteWorker")
	var value0 store.Completion
	return value0, failure
}
