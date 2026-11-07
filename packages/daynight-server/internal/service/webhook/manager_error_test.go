package webhook

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

type boundaryCredential struct {
	t    *testing.T
	read func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (d *boundaryCredential) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	if d.read == nil {
		d.t.Fatal("unexpected credential lookup")
	}
	return d.read(ctx, p)
}

type boundaryDAO struct {
	t                                    *testing.T
	owner                                func(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error)
	endpoint                             func(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error)
	endpoints                            func(context.Context, webhookmodel.Owner, string, store.WebhookEndpointQuery) (store.WebhookEndpointPage, error)
	receipt                              func(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error)
	projects                             func(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error)
	policy                               func(context.Context) (webhookmodel.Policy, error)
	lock                                 func(context.Context, store.WebhookConfigurationLock) error
	reserveOperation                     func(context.Context, webhookmodel.Owner, time.Time) error
	reserveConfiguration                 func(context.Context, webhookmodel.Owner, store.WebhookChangeCost) error
	insertEndpoint                       func(context.Context, webhookmodel.Endpoint) error
	saveEndpoint                         func(context.Context, webhookmodel.Endpoint, int64) error
	insertOperation                      func(context.Context, webhookmodel.OperationReceipt) error
	insertCalls, saveCalls, receiptCalls int
}

func (d *boundaryDAO) OwnerAccess(c context.Context, o webhookmodel.Owner, u string) (webhookmodel.OwnerAccess, error) {
	if d.owner == nil {
		d.t.Fatal("unexpected owner lookup")
	}
	return d.owner(c, o, u)
}
func (d *boundaryDAO) Endpoint(c context.Context, o webhookmodel.Owner, id string) (webhookmodel.Endpoint, error) {
	if d.endpoint == nil {
		d.t.Fatal("unexpected endpoint lookup")
	}
	return d.endpoint(c, o, id)
}
func (d *boundaryDAO) Endpoints(c context.Context, o webhookmodel.Owner, u string, q store.WebhookEndpointQuery) (store.WebhookEndpointPage, error) {
	if d.endpoints == nil {
		d.t.Fatal("unexpected endpoint list")
	}
	return d.endpoints(c, o, u, q)
}
func (d *boundaryDAO) Operation(c context.Context, o webhookmodel.Owner, id string) (webhookmodel.OperationReceipt, error) {
	if d.receipt == nil {
		d.t.Fatal("unexpected receipt lookup")
	}
	return d.receipt(c, o, id)
}
func (d *boundaryDAO) Projects(c context.Context, o webhookmodel.Owner, u string, ids []string) ([]webhookmodel.ProjectAccess, error) {
	if d.projects == nil {
		d.t.Fatal("unexpected project qualification")
	}
	return d.projects(c, o, u, ids)
}
func (d *boundaryDAO) Policy(c context.Context) (webhookmodel.Policy, error) {
	if d.policy == nil {
		d.t.Fatal("unexpected policy lookup")
	}
	return d.policy(c)
}
func (d *boundaryDAO) LockConfiguration(c context.Context, l store.WebhookConfigurationLock) error {
	if d.lock == nil {
		d.t.Fatal("unexpected configuration lock")
	}
	return d.lock(c, l)
}
func (d *boundaryDAO) ReserveOperation(c context.Context, o webhookmodel.Owner, n time.Time) error {
	if d.reserveOperation == nil {
		d.t.Fatal("unexpected operation reservation")
	}
	return d.reserveOperation(c, o, n)
}
func (d *boundaryDAO) ReserveConfiguration(c context.Context, o webhookmodel.Owner, cost store.WebhookChangeCost) error {
	if d.reserveConfiguration == nil {
		d.t.Fatal("unexpected configuration reservation")
	}
	return d.reserveConfiguration(c, o, cost)
}
func (d *boundaryDAO) InsertEndpoint(c context.Context, e webhookmodel.Endpoint) error {
	d.insertCalls++
	if d.insertEndpoint == nil {
		d.t.Fatal("unexpected endpoint insertion")
	}
	return d.insertEndpoint(c, e)
}
func (d *boundaryDAO) SaveEndpoint(c context.Context, e webhookmodel.Endpoint, v int64) error {
	d.saveCalls++
	if d.saveEndpoint == nil {
		d.t.Fatal("unexpected endpoint save")
	}
	return d.saveEndpoint(c, e, v)
}
func (d *boundaryDAO) InsertOperation(c context.Context, r webhookmodel.OperationReceipt) error {
	d.receiptCalls++
	if d.insertOperation == nil {
		d.t.Fatal("unexpected receipt insertion")
	}
	return d.insertOperation(c, r)
}

type boundarySnapshot struct {
	store.SnapshotScope
	credential *boundaryCredential
	dao        *boundaryDAO
	now        func(context.Context) (time.Time, error)
}

func (s *boundarySnapshot) CredentialDAO() store.CredentialReader { return s.credential }
func (s *boundarySnapshot) WebhookDAO() store.WebhookReadDAO      { return s.dao }
func (s *boundarySnapshot) ObservedAt(c context.Context) (time.Time, error) {
	if s.now == nil {
		s.dao.t.Fatal("unexpected snapshot clock")
	}
	return s.now(c)
}

type boundaryWriteScope struct {
	credential *boundaryCredential
	dao        *boundaryDAO
	now        func(context.Context) (time.Time, error)
}

func (s *boundaryWriteScope) CredentialDAO() store.CredentialReader { return s.credential }
func (s *boundaryWriteScope) WebhookDAO() store.WebhookWriteDAO     { return s.dao }
func (s *boundaryWriteScope) ObservedAt(c context.Context) (time.Time, error) {
	if s.now == nil {
		s.dao.t.Fatal("unexpected write clock")
	}
	return s.now(c)
}

type boundaryDatabase struct {
	t     *testing.T
	read  func(context.Context, func(store.SnapshotScope) error) error
	write func(context.Context, webhookmodel.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error)
}

func (d *boundaryDatabase) ReadSnapshot(c context.Context, f func(store.SnapshotScope) error) error {
	if d.read == nil {
		d.t.Fatal("unexpected snapshot")
	}
	return d.read(c, f)
}
func (d *boundaryDatabase) WriteWebhook(c context.Context, o webhookmodel.Owner, id string, f func(store.WebhookWriteScope) error) (store.Completion, error) {
	if d.write == nil {
		d.t.Fatal("unexpected write transaction")
	}
	return d.write(c, o, id, f)
}

type boundaryFixture struct {
	manager   *Manager
	database  *boundaryDatabase
	read      *boundarySnapshot
	write     *boundaryWriteScope
	endpoint  webhookmodel.Endpoint
	principal model.Principal
	owner     webhookmodel.Owner
	input     webhookcore.Operation
}

func newBoundaryFixture(t *testing.T) *boundaryFixture {
	t.Helper()
	manager, endpoint, _ := boundaryCrypto(t)
	p := model.Principal{UserID: boundaryUserID, CredentialID: boundaryCredentialID, Kind: model.PATCredential}
	op := webhookcore.Operation{ID: boundaryOperationID, IssuedAt: boundaryNow.Format(time.RFC3339Nano), ExpectedUserID: p.UserID, RequestSHA256: strings.Repeat("a", 64)}
	credential := func(context.Context, model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{}, nil
	}
	owner := func(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error) {
		return webhookmodel.OwnerAccess{CanRead: true, CanManage: true}, nil
	}
	lookup := func(_ context.Context, o webhookmodel.Owner, id string) (webhookmodel.Endpoint, error) {
		if o != endpoint.Owner || id != endpoint.ID {
			t.Fatal("unexpected endpoint identity")
		}
		return endpoint, nil
	}
	projects := func(_ context.Context, o webhookmodel.Owner, u string, ids []string) ([]webhookmodel.ProjectAccess, error) {
		if o != endpoint.Owner || u != p.UserID {
			t.Fatal("qualification crossed owner or principal")
		}
		result := []webhookmodel.ProjectAccess{}
		for _, id := range ids {
			if id != boundaryProjectID {
				t.Fatal("unexpected qualification identity")
			}
			name := "Project"
			result = append(result, webhookmodel.ProjectAccess{ProjectID: id, ProjectName: &name, Present: true, CanRead: true})
		}
		return result, nil
	}
	readDAO := &boundaryDAO{t: t, owner: owner, endpoint: lookup, projects: projects, policy: func(context.Context) (webhookmodel.Policy, error) { return webhookmodel.DefaultPolicy(), nil }, receipt: func(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error) {
		return webhookmodel.OperationReceipt{OperationID: op.ID, Owner: endpoint.Owner, ActorUserID: p.UserID}, nil
	}, endpoints: func(context.Context, webhookmodel.Owner, string, store.WebhookEndpointQuery) (store.WebhookEndpointPage, error) {
		return store.WebhookEndpointPage{Items: []webhookmodel.Endpoint{endpoint}}, nil
	}}
	writeDAO := &boundaryDAO{t: t, owner: owner, endpoint: lookup, projects: projects, policy: readDAO.policy, receipt: func(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error) {
		return webhookmodel.OperationReceipt{}, model.ErrNotFound
	}, lock: func(context.Context, store.WebhookConfigurationLock) error { return nil }, reserveOperation: func(context.Context, webhookmodel.Owner, time.Time) error { return nil }, reserveConfiguration: func(context.Context, webhookmodel.Owner, store.WebhookChangeCost) error { return nil }, insertEndpoint: func(context.Context, webhookmodel.Endpoint) error { return nil }, saveEndpoint: func(context.Context, webhookmodel.Endpoint, int64) error { return nil }, insertOperation: func(context.Context, webhookmodel.OperationReceipt) error { return nil }}
	now := func(context.Context) (time.Time, error) { return boundaryNow, nil }
	read := &boundarySnapshot{credential: &boundaryCredential{t: t, read: credential}, dao: readDAO, now: now}
	write := &boundaryWriteScope{credential: &boundaryCredential{t: t, read: credential}, dao: writeDAO, now: now}
	db := &boundaryDatabase{t: t, read: func(_ context.Context, f func(store.SnapshotScope) error) error { return f(read) }, write: func(_ context.Context, _ webhookmodel.Owner, _ string, f func(store.WebhookWriteScope) error) (store.Completion, error) {
		if err := f(write); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	manager.database, manager.settings = db, Settings{ConfigurationExpansionAvailable: true}
	return &boundaryFixture{manager: manager, database: db, read: read, write: write, endpoint: endpoint, principal: p, owner: endpoint.Owner, input: op}
}

func (f *boundaryFixture) readCall(kind string) error {
	c := context.Background()
	switch kind {
	case "catalog":
		_, err := f.manager.Catalog(c, f.principal)
		return err
	case "get":
		_, err := f.manager.Get(c, f.principal, f.owner, f.endpoint.ID)
		return err
	case "list":
		_, err := f.manager.List(c, f.principal, f.owner, ListInput{Limit: 50})
		return err
	case "operation":
		_, err := f.manager.Operation(c, f.principal, f.owner, f.input.ID)
		return err
	case "secret":
		_, err := f.manager.SigningSecret(c, f.principal, f.owner, f.endpoint.ID)
		return err
	default:
		panic("unknown boundary read")
	}
}

func TestReadFailuresPreserveCauseInsteadOfReportingEmptyOrRevokedState(t *testing.T) {
	for _, kind := range []string{"catalog", "get", "list", "operation", "secret"} {
		for _, stage := range []string{"snapshot", "credential", "lookup", "owner", "clock", "projects"} {
			if kind == "catalog" && (stage == "owner" || stage == "clock" || stage == "projects") || kind == "operation" && (stage == "clock" || stage == "projects") || kind == "secret" && stage == "projects" {
				continue
			}
			t.Run(kind+"/"+stage, func(t *testing.T) {
				f := newBoundaryFixture(t)
				cause := errors.New("temporary dependency failure")
				switch stage {
				case "snapshot":
					f.database.read = func(context.Context, func(store.SnapshotScope) error) error { return cause }
				case "credential":
					f.read.credential.read = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, cause
					}
				case "owner":
					f.read.dao.owner = func(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error) {
						return webhookmodel.OwnerAccess{}, cause
					}
				case "clock":
					f.read.now = func(context.Context) (time.Time, error) { return time.Time{}, cause }
				case "projects":
					f.read.dao.projects = func(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error) {
						return nil, cause
					}
				case "lookup":
					switch kind {
					case "catalog":
						f.read.dao.policy = func(context.Context) (webhookmodel.Policy, error) { return webhookmodel.Policy{}, cause }
					case "list":
						f.read.dao.endpoints = func(context.Context, webhookmodel.Owner, string, store.WebhookEndpointQuery) (store.WebhookEndpointPage, error) {
							return store.WebhookEndpointPage{}, cause
						}
					case "operation":
						f.read.dao.receipt = func(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error) {
							return webhookmodel.OperationReceipt{}, cause
						}
					default:
						f.read.dao.endpoint = func(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error) {
							return webhookmodel.Endpoint{}, cause
						}
					}
				}
				if err := f.readCall(kind); !errors.Is(err, cause) {
					t.Fatalf("read converted a dependency failure: %v", err)
				}
			})
		}
	}
}

func TestReadAdmissionAndStoredConsistencyFailuresRemainVisible(t *testing.T) {
	for _, kind := range []string{"catalog", "get", "list", "operation", "secret"} {
		t.Run(kind+" credential missing", func(t *testing.T) {
			f := newBoundaryFixture(t)
			f.read.credential.read = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{}, model.ErrNotFound
			}
			var fault *model.Fault
			if err := f.readCall(kind); !errors.As(err, &fault) || fault.Code != "unauthenticated" || !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("credential absence became a resource result: %v", err)
			}
		})
		if kind != "catalog" {
			t.Run(kind+" owner denied", func(t *testing.T) {
				f := newBoundaryFixture(t)
				f.read.dao.owner = func(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error) {
					return webhookmodel.OwnerAccess{}, nil
				}
				var fault *model.Fault
				if err := f.readCall(kind); !errors.As(err, &fault) || fault.Code != "forbidden" {
					t.Fatalf("definite owner refusal: %v", err)
				}
			})
		}
	}
	for _, state := range []struct {
		name, kind string
		mutate     func(*boundaryFixture)
	}{
		{"corrupt policy", "catalog", func(f *boundaryFixture) {
			f.read.dao.policy = func(context.Context) (webhookmodel.Policy, error) {
				p := webhookmodel.DefaultPolicy()
				p.Version++
				return p, nil
			}
		}},
		{"missing continuation position", "list", func(f *boundaryFixture) {
			f.read.dao.endpoints = func(context.Context, webhookmodel.Owner, string, store.WebhookEndpointQuery) (store.WebhookEndpointPage, error) {
				return store.WebhookEndpointPage{HasMore: true}, nil
			}
		}},
		{"cross-owner endpoint", "get", func(f *boundaryFixture) {
			e := f.endpoint
			e.Owner.ID = boundaryOperationID
			f.read.dao.endpoint = func(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error) { return e, nil }
		}},
		{"missing signing state", "get", func(f *boundaryFixture) {
			e := f.endpoint
			e.SigningKeys = nil
			f.read.dao.endpoint = func(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error) { return e, nil }
		}},
		{"missing project qualification", "get", func(f *boundaryFixture) {
			f.read.dao.projects = func(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error) {
				return []webhookmodel.ProjectAccess{}, nil
			}
		}},
		{"duplicate project qualification", "get", func(f *boundaryFixture) {
			f.read.dao.projects = func(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error) {
				return []webhookmodel.ProjectAccess{{ProjectID: boundaryProjectID}, {ProjectID: boundaryProjectID}}, nil
			}
		}},
		{"invalid authorization epoch", "get", func(f *boundaryFixture) {
			e := f.endpoint
			e.Subscriptions[0].AuthorizationEpoch = 0
			f.read.dao.endpoint = func(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error) { return e, nil }
		}},
	} {
		t.Run(state.name, func(t *testing.T) {
			f := newBoundaryFixture(t)
			state.mutate(f)
			if err := f.readCall(state.kind); err == nil {
				t.Fatal("stored inconsistency was silently projected")
			}
		})
	}
}

func (f *boundaryFixture) writeCall(kind string) (MutationResult, error) {
	c := context.Background()
	name := "Changed release"
	switch kind {
	case "create":
		_, _, d := boundaryCrypto(f.database.t)
		return f.manager.Create(c, f.principal, f.owner, webhookcore.CreateInput{Operation: f.input, Name: "Release", Enabled: true, Destination: d, Subscriptions: []webhookcore.SubscriptionInput{{ProjectID: boundaryProjectID, EventTypes: []string{"task.paused"}}}})
	case "patch":
		return f.manager.Patch(c, f.principal, f.owner, f.endpoint.ID, webhookcore.PatchInput{Operation: f.input, IfVersion: 3, Name: &name})
	case "delete":
		return f.manager.Delete(c, f.principal, f.owner, f.endpoint.ID, webhookcore.DeleteInput{Operation: f.input, IfVersion: 3})
	case "rotate":
		return f.manager.Rotate(c, f.principal, f.owner, f.endpoint.ID, webhookcore.RotateInput{Operation: f.input, IfVersion: 3, Mode: "immediate"})
	default:
		panic("unknown boundary write")
	}
}

func TestMutationFailuresRetainCompletionFactsAndNeverReturnConfirmedEffects(t *testing.T) {
	for _, kind := range []string{"create", "patch", "delete", "rotate"} {
		for _, stage := range []string{"transaction", "credential", "owner", "receipt", "policy", "clock", "lock", "projects", "reserve operation", "reserve configuration", "save", "insert receipt"} {
			t.Run(kind+"/"+stage, func(t *testing.T) {
				f := newBoundaryFixture(t)
				cause := errors.New("injected DAO failure")
				switch stage {
				case "transaction":
					f.database.write = func(context.Context, webhookmodel.Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error) {
						return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: cause}
					}
				case "credential":
					f.write.credential.read = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, cause
					}
				case "owner":
					f.write.dao.owner = func(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error) {
						return webhookmodel.OwnerAccess{}, cause
					}
				case "receipt":
					f.write.dao.receipt = func(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error) {
						return webhookmodel.OperationReceipt{}, cause
					}
				case "policy":
					f.write.dao.policy = func(context.Context) (webhookmodel.Policy, error) { return webhookmodel.Policy{}, cause }
				case "clock":
					f.write.now = func(context.Context) (time.Time, error) { return time.Time{}, cause }
				case "lock":
					f.write.dao.lock = func(context.Context, store.WebhookConfigurationLock) error { return cause }
				case "projects":
					f.write.dao.projects = func(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error) {
						return nil, cause
					}
				case "reserve operation":
					f.write.dao.reserveOperation = func(context.Context, webhookmodel.Owner, time.Time) error { return cause }
				case "reserve configuration":
					f.write.dao.reserveConfiguration = func(context.Context, webhookmodel.Owner, store.WebhookChangeCost) error { return cause }
				case "save":
					if kind == "create" {
						f.write.dao.insertEndpoint = func(context.Context, webhookmodel.Endpoint) error { return cause }
					} else {
						f.write.dao.saveEndpoint = func(context.Context, webhookmodel.Endpoint, int64) error { return cause }
					}
				case "insert receipt":
					f.write.dao.insertOperation = func(context.Context, webhookmodel.OperationReceipt) error { return cause }
				}
				result, err := f.writeCall(kind)
				if !errors.Is(err, cause) || result.Operation.OperationID != "" || result.Endpoint.Endpoint.ID != "" {
					t.Fatalf("mutation failure returned confirmed effect or lost cause: %+v %v", result, err)
				}
				facts := operation.CompletionFacts(err)
				expected := store.TransactionNotCommitted
				if stage == "transaction" {
					expected = store.TransactionUnknown
				}
				if facts.Outcome != expected {
					t.Fatalf("completion changed from explicit %s: %+v", expected, facts)
				}
				if stage != "insert receipt" && f.write.dao.receiptCalls != 0 {
					t.Fatal("failed stage proceeded to insert a receipt")
				}
			})
		}
	}
}

func TestUnconfirmedCompletionCannotReturnPreparedMutationAsSuccess(t *testing.T) {
	for _, kind := range []string{"create", "patch", "delete", "rotate"} {
		for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
			t.Run(kind+"/"+string(outcome), func(t *testing.T) {
				f := newBoundaryFixture(t)
				write := f.database.write
				f.database.write = func(ctx context.Context, owner webhookmodel.Owner, id string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
					_, err := write(ctx, owner, id, callback)
					if err != nil {
						return store.Completion{Outcome: outcome}, err
					}
					return store.Completion{Outcome: outcome}, nil
				}
				result, err := f.writeCall(kind)
				if err == nil || result.Operation.OperationID != "" || result.Endpoint.Endpoint.ID != "" || operation.CompletionFacts(err).Outcome != outcome {
					t.Fatal("unconfirmed transaction exposed a prepared effect as success")
				}
			})
		}
	}
}

func TestServiceEntryRefusesInvalidIdentityBeforePersistence(t *testing.T) {
	for _, kind := range []string{"catalog", "get", "list", "operation", "secret"} {
		t.Run(kind, func(t *testing.T) {
			f := newBoundaryFixture(t)
			f.database.read = nil
			f.principal = model.Principal{}
			var fault *model.Fault
			if err := f.readCall(kind); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("invalid principal admission: %v", err)
			}
		})
	}
	for _, kind := range []string{"create", "patch", "delete", "rotate"} {
		t.Run(kind, func(t *testing.T) {
			f := newBoundaryFixture(t)
			f.database.read = nil
			f.database.write = nil
			f.input.ExpectedUserID = boundaryProjectID
			result, err := f.writeCall(kind)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "identity_mismatch" || result.Operation.OperationID != "" {
				t.Fatalf("wrong actor reached persistence: %v", err)
			}
		})
	}
	f := newBoundaryFixture(t)
	if _, err := New(nil, f.manager.keys, Settings{}); err == nil {
		t.Fatal("missing persistence accepted")
	}
	if _, err := New(f.database, nil, Settings{}); err == nil {
		t.Fatal("missing keyring accepted")
	}
	if manager, err := New(f.database, f.manager.keys, Settings{}); err != nil || manager.settings.ConfigurationExpansionAvailable {
		t.Fatal("construction changed explicit deployment state")
	}
	for _, kind := range []string{"get", "list", "operation", "secret"} {
		t.Run(kind+" owner syntax", func(t *testing.T) {
			f := newBoundaryFixture(t)
			f.database.read = nil
			f.owner.Kind = "invalid"
			var fault *model.Fault
			if err := f.readCall(kind); !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("invalid owner: %v", err)
			}
		})
	}
	for _, kind := range []string{"get", "operation", "secret"} {
		t.Run(kind+" resource syntax", func(t *testing.T) {
			f := newBoundaryFixture(t)
			f.database.read = nil
			var err error
			switch kind {
			case "get":
				_, err = f.manager.Get(context.Background(), f.principal, f.owner, "invalid")
			case "operation":
				_, err = f.manager.Operation(context.Background(), f.principal, f.owner, "invalid")
			case "secret":
				_, err = f.manager.SigningSecret(context.Background(), f.principal, f.owner, "invalid")
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("invalid resource: %v", err)
			}
		})
	}
}
