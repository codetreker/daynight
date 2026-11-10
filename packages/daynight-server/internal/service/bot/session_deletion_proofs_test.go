package bot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type sessionDeletionProofDAO struct {
	store.SessionDAO
	calls      *sessionDeletionProofCalls
	credential func(context.Context, model.Principal, time.Time) error
	sessions   func(context.Context, string) ([]store.BotSession, error)
	revoke     func(context.Context, string) error
	stop       func(context.Context, string, string, string) (store.BotSessionStop, error)
	remove     func(context.Context, string, string) error
	redact     func(context.Context, string) error
}

func (d *sessionDeletionProofDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.calls.take("credential")
	return d.credential(ctx, p, now)
}
func (d *sessionDeletionProofDAO) LockBotSessions(ctx context.Context, id string) ([]store.BotSession, error) {
	d.calls.take("sessions")
	return d.sessions(ctx, id)
}
func (d *sessionDeletionProofDAO) RevokeBotSessions(ctx context.Context, id string) error {
	d.calls.take("revoke")
	return d.revoke(ctx, id)
}
func (d *sessionDeletionProofDAO) LockBotSessionStop(ctx context.Context, session, bot, owner string) (store.BotSessionStop, error) {
	d.calls.take("stop")
	return d.stop(ctx, session, bot, owner)
}
func (d *sessionDeletionProofDAO) DeleteBotSession(ctx context.Context, session, bot string) error {
	d.calls.take("remove")
	return d.remove(ctx, session, bot)
}
func (d *sessionDeletionProofDAO) RedactDeletedBot(ctx context.Context, id string) error {
	d.calls.take("redact")
	return d.redact(ctx, id)
}

type sessionDeletionProofBots struct {
	store.BotWriteDAO
	calls *sessionDeletionProofCalls
	read  func(context.Context, string) (model.Bot, error)
	save  func(context.Context, string, *model.BotDeletion) (model.Bot, error)
}

func (d *sessionDeletionProofBots) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.calls.take("bot")
	bot, err := d.read(ctx, id)
	if bot.Deletion != nil {
		deletion := *bot.Deletion
		bot.Deletion = &deletion
	}
	return bot, err
}
func (d *sessionDeletionProofBots) SaveBotDeletion(ctx context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
	d.calls.take("save")
	return d.save(ctx, id, value)
}

type sessionDeletionProofCalls struct {
	t         *testing.T
	remaining map[string]int
}

func expectSessionDeletionProofCalls(t *testing.T, expected map[string]int) *sessionDeletionProofCalls {
	t.Helper()
	calls := &sessionDeletionProofCalls{t: t, remaining: expected}
	t.Cleanup(func() {
		for method, count := range calls.remaining {
			if count != 0 {
				t.Errorf("deletion DAO expectation %s has %d remaining calls", method, count)
			}
		}
	})
	return calls
}

func (c *sessionDeletionProofCalls) take(method string) {
	c.t.Helper()
	if c.remaining[method] < 1 {
		c.t.Errorf("unexpected deletion DAO call %s", method)
		panic("unexpected deletion DAO call " + method)
	}
	c.remaining[method]--
}

type sessionDeletionProofScope struct {
	dao  *sessionDeletionProofDAO
	bots *sessionDeletionProofBots
}

func (s sessionDeletionProofScope) SessionDAO() store.SessionDAO { return s.dao }
func (s sessionDeletionProofScope) BotDAO() store.BotWriteDAO    { return s.bots }

type sessionDeletionProofWriter struct {
	write func(context.Context, func(store.SessionScope) error) (store.Completion, error)
}

func (w sessionDeletionProofWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	return w.write(ctx, fn)
}

func sessionDeletionProofIdentity() (model.Principal, model.Bot, store.DeleteBot) {
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	bot := model.Bot{ID: uuid.NewString(), OwnerUserID: p.UserID, WorkerID: uuid.NewString(), Version: 2, Name: "助手", CreationOrder: 41, CreatedAt: time.Date(2026, 11, 8, 1, 0, 0, 123456000, time.UTC), UpdatedAt: time.Date(2026, 11, 8, 2, 0, 0, 654321000, time.UTC)}
	request := store.DeleteBot{Version: bot.Version, DeletionID: uuid.NewString()}
	return p, bot, request
}

func sessionDeletionProofTransaction(t *testing.T, expectedContext context.Context, scope store.SessionScope, outcome store.TransactionOutcome, callbackError callbackExpectation, finishError error) sessionDeletionProofWriter {
	return sessionDeletionProofWriter{write: func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		identical(t, ctx, expectedContext)
		actual := fn(scope)
		callbackError.check(t, actual)
		return store.Completion{Outcome: outcome}, finishError
	}}
}

func TestSessionDeletionRechecksExpiryAfterBotOrSessionAdmissionBarrier(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		for _, phase := range []string{"bot", "session", "replay"} {
			t.Run(string(kind)+"/"+phase, func(t *testing.T) {
				p, bot, request := sessionDeletionProofIdentity()
				p.Kind = kind
				if phase == "replay" {
					bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
						WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
				}
				before := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
				after := before.Add(time.Minute)
				now := before
				entered, release := make(chan struct{}), make(chan struct{})
				ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
				defer cancel()
				barrier := func() error {
					close(entered)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				credentials, writes := 0, 0
				expected := map[string]int{"credential": 2, "bot": 1}
				if phase != "replay" {
					expected["sessions"], expected["revoke"], expected["save"] = 1, 1, 1
				}
				calls := expectSessionDeletionProofCalls(t, expected)
				dao := &sessionDeletionProofDAO{calls: calls, credential: func(actual context.Context, actor model.Principal, at time.Time) error {
					credentials++
					if actual != ctx || actor != p {
						t.Error("credential recheck changed context or actor")
					}
					if credentials == 1 {
						if at != before {
							t.Error("initial admission did not use the initial clock")
						}
						return nil
					}
					if credentials != 2 || at != after {
						t.Errorf("post-barrier credential call: count=%d time=%s", credentials, at)
					}
					return model.ErrNotFound
				}}
				bots := &sessionDeletionProofBots{calls: calls, read: func(actual context.Context, id string) (model.Bot, error) {
					if actual != ctx || id != bot.ID {
						t.Error("Bot admission changed identity")
					}
					if phase != "session" {
						if err := barrier(); err != nil {
							return model.Bot{}, err
						}
					}
					return bot, nil
				}, save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
					writes++
					if id != bot.ID || value.DeletionID != request.DeletionID {
						t.Error("proposed deletion changed identity")
					}
					proposed := bot
					proposed.Deletion = value
					return proposed, nil
				}}
				dao.sessions = func(_ context.Context, id string) ([]store.BotSession, error) {
					if id != bot.ID {
						t.Error("Session admission changed Bot identity")
					}
					if phase == "session" {
						if err := barrier(); err != nil {
							return nil, err
						}
					}
					return []store.BotSession{{ID: uuid.NewString()}}, nil
				}
				dao.revoke = func(_ context.Context, id string) error {
					if id != bot.ID {
						t.Error("revocation changed Bot identity")
					}
					return nil
				}
				live := &discardedSessions{}
				refusal := &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
				svc := NewDeletions(sessionDeletionProofTransaction(t, ctx, sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionNotCommitted, callbackFreshFault(refusal), refusal), nil, live)
				operationCalls := map[string]int{"owner": 1, "request": 1}
				if phase != "replay" {
					operationCalls["save"] = 1
				}
				bindDeletionFacts(t, svc, bots, p, bot, request, deletionFacts{ctx: ctx, calls: operationCalls, replay: phase == "replay"})
				svc.now = func() time.Time { return now }
				result := make(chan error, 1)
				finished := false
				t.Cleanup(func() {
					cancel()
					if finished {
						return
					}
					select {
					case <-result:
					case <-time.After(time.Second):
						t.Error("deletion did not drain after cancellation")
					}
				})
				go func() { _, err := svc.DeleteBot(ctx, p, bot.ID, request); result <- err }()
				select {
				case <-entered:
				case err := <-result:
					finished = true
					t.Fatalf("deletion ended before the admission barrier: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				now = after
				close(release)
				select {
				case err := <-result:
					finished = true
					requireCleanupFault(t, err, "unauthenticated")
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				wantWrites := 1
				if phase == "replay" {
					wantWrites = 0
				}
				if credentials != 2 || writes != wantWrites || len(live.ids) != 0 {
					t.Fatalf("expired admission changed publication: checks=%d writes=%d live=%v", credentials, writes, live.ids)
				}
			})
		}
	}
}

func TestSessionDeletionRejectsUnauthorizedActorsBeforeAnyProposedWrite(t *testing.T) {
	for _, phase := range []string{"intent", "receipt"} {
		for _, actor := range []string{"revoked", "expired", "other_owner"} {
			t.Run(phase+"/"+actor, func(t *testing.T) {
				p, bot, request := sessionDeletionProofIdentity()
				if phase == "receipt" {
					bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
						WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
				}
				principal := p
				want := "unauthenticated"
				if actor == "other_owner" {
					principal.UserID = uuid.NewString()
					want = "forbidden"
				}
				credentialCalls, botCalls := 0, 0
				expected := map[string]int{"credential": 1}
				if actor == "other_owner" {
					expected["bot"] = 1
				}
				calls := expectSessionDeletionProofCalls(t, expected)
				dao := &sessionDeletionProofDAO{calls: calls, credential: func(_ context.Context, actual model.Principal, _ time.Time) error {
					credentialCalls++
					if actual != principal {
						t.Fatal("admission checked another actor")
					}
					if actor != "other_owner" {
						return model.ErrNotFound
					}
					return nil
				}}
				bots := &sessionDeletionProofBots{calls: calls, read: func(_ context.Context, id string) (model.Bot, error) {
					botCalls++
					if id != bot.ID {
						t.Fatal("admission read another Bot")
					}
					return bot, nil
				}}
				live := &discardedSessions{}
				refusal := &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
				if actor == "other_owner" {
					refusal = &model.Fault{Code: "forbidden", Message: "not owner"}
				}
				expectedCallback := callbackFreshFault(refusal)
				if actor == "other_owner" {
					expectedCallback = callbackCause(refusal)
				}
				svc := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionNotCommitted, expectedCallback, refusal), nil, live)
				operationCalls := map[string]int{}
				var ownerError error
				if actor == "other_owner" {
					operationCalls["owner"] = 1
					ownerError = refusal
				}
				bindDeletionFacts(t, svc, bots, principal, bot, request, deletionFacts{ctx: t.Context(), calls: operationCalls, ownerError: ownerError})
				var err error
				if phase == "intent" {
					_, err = svc.DeleteBot(t.Context(), principal, bot.ID, request)
				} else {
					_, err = svc.CompleteBotDeletion(t.Context(), principal, bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}})
				}
				requireCleanupFault(t, err, want)
				wantBots := 0
				if actor == "other_owner" {
					wantBots = 1
				}
				if credentialCalls != 1 || botCalls != wantBots || len(live.ids) != 0 {
					t.Fatalf("unauthorized admission advanced: credentials=%d bots=%d live=%v", credentialCalls, botCalls, live.ids)
				}
			})
		}
	}
}

func sessionDeletionProofBound(p model.Principal, bot model.Bot, request store.DeleteBot) (model.Bot, store.BotSessionStop, BotDeletionReceipt) {
	id := uuid.NewString()
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	bot.SessionID = &id
	bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}
	v := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"},
		Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}}
	proof := store.BotSessionStop{Snapshot: v, Consumed: true}
	receipt := BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"},
		Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID,
			StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: now.Format(time.RFC3339Nano)}}}
	return bot, proof, receipt
}

func TestSessionDeletionReceiptRejectsUnprovenConnectedExecution(t *testing.T) {
	for name, change := range map[string]func(*sp.TestStop){
		"missing proof":     func(*sp.TestStop) {},
		"valid":             func(*sp.TestStop) {},
		"generation":        func(s *sp.TestStop) { s.ExecutionGeneration = "2" },
		"controller":        func(s *sp.TestStop) { s.ControllerID = uuid.NewString() },
		"previous instance": func(s *sp.TestStop) { s.StopProof.PreviousControllerInstanceID = uuid.NewString() },
		"future stop":       func(s *sp.TestStop) { s.StopProof.StoppedAt = "2026-11-08T01:00:00Z" },
		"never started":     func(s *sp.TestStop) { s.StopProof.Kind = "never_started" },
	} {
		t.Run(name, func(t *testing.T) {
			p, bot, request := sessionDeletionProofIdentity()
			bot, proof, receipt := sessionDeletionProofBound(p, bot, request)
			change(receipt.Stop)
			if name == "missing proof" {
				receipt.Stop = nil
			}
			checks, saves := 0, 0
			expected := map[string]int{"credential": 1, "bot": 1}
			if name != "missing proof" {
				expected["stop"] = 1
			}
			if name == "valid" {
				expected["save"] = 1
			}
			calls := expectSessionDeletionProofCalls(t, expected)
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }, stop: func(_ context.Context, session, id, owner string) (store.BotSessionStop, error) {
				checks++
				if session != *bot.SessionID || id != bot.ID || owner != p.UserID {
					t.Fatal("stop proof checked another binding")
				}
				return proof, nil
			}}
			bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
				saves++
				if name != "valid" || id != bot.ID || value.WorkerCleanup.State != "completed" || value.ReceiptDigest == "" {
					t.Fatal("unproven execution reached completed receipt write")
				}
				out := bot
				out.Deletion = value
				return out, nil
			}}
			outcome := store.TransactionCommitted
			var refusal error
			expectedCallback := callbackCause(nil)
			if name != "valid" {
				outcome = store.TransactionNotCommitted
				fault := &model.Fault{Code: "session_conflict", Message: "Session identity or state no longer matches."}
				refusal = fault
				expectedCallback = callbackFreshFault(fault)
			}
			svc := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, outcome, expectedCallback, refusal), nil, &discardedSessions{})
			operationCalls := map[string]int{"owner": 1, "worker": 1}
			if name == "valid" {
				operationCalls["save"] = 1
			}
			bindDeletionFacts(t, svc, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: operationCalls, workerChange: true, needsProof: true, receipt: &receipt})
			svc.now = func() time.Time { return time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC) }
			out, err := svc.CompleteBotDeletion(t.Context(), p, bot.WorkerID, bot.ID, receipt)
			if name == "valid" {
				if err != nil || saves != 1 || out.Deletion.WorkerCleanup.State != "completed" {
					t.Fatalf("valid connected stop proof was refused: %+v saves=%d err=%v", out, saves, err)
				}
			} else {
				requireCleanupFault(t, err, "session_conflict")
				if saves != 0 {
					t.Fatal("invalid receipt proposed a write")
				}
			}
			wantChecks := 1
			if name == "missing proof" {
				wantChecks = 0
			}
			if checks != wantChecks {
				t.Fatalf("receipt bypassed binding proof: checks=%d", checks)
			}
		})
	}
}

func TestSessionDeletionChangedFailedReceiptAdvancesWhileExactReplayDoesNotWrite(t *testing.T) {
	p, bot, request := sessionDeletionProofIdentity()
	code := "process_not_stopped"
	receipt := BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "failed", Code: &code}}
	bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
		WorkerCleanup: receipt.Result, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact replay", true: "changed failure"}[changed], func(t *testing.T) {
			input := receipt
			if changed {
				otherCode := "private_cleanup_failed"
				input.Result.Code = &otherCode
			}
			writes := 0
			expected := map[string]int{"credential": 1, "bot": 1}
			if changed {
				expected["save"] = 1
			}
			calls := expectSessionDeletionProofCalls(t, expected)
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }}
			bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
				writes++
				if !changed || id != bot.ID || value.WorkerCleanup.Code == nil || *value.WorkerCleanup.Code != "private_cleanup_failed" || value.ServerCleanup.State != "pending" || value.ReceiptDigest != "" {
					t.Fatal("changed receipt lost cleanup responsibility or identity")
				}
				out := bot
				out.Version++
				out.Deletion = value
				return out, nil
			}}
			svc := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionCommitted, callbackCause(nil), nil), nil, &discardedSessions{})
			operationCalls := map[string]int{"owner": 1, "worker": 1}
			if changed {
				operationCalls["save"] = 1
			}
			bindDeletionFacts(t, svc, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: operationCalls, workerChange: changed, receipt: &input})
			out, err := svc.CompleteBotDeletion(t.Context(), p, bot.WorkerID, bot.ID, input)
			if !changed {
				same(t, out, bot)
			}
			if err != nil || changed && (writes != 1 || out.Version != bot.Version+1) || !changed && (writes != 0 || out.Version != bot.Version) {
				t.Fatalf("receipt result: changed=%v writes=%d out=%+v err=%v", changed, writes, out, err)
			}
		})
	}
}

type sessionDeletionProofFiles struct {
	filestorage.Storage
	remove func(context.Context, sessionarchive.Namespace) error
}

func (f sessionDeletionProofFiles) DeleteSessionArchives(ctx context.Context, namespace sessionarchive.Namespace) error {
	return f.remove(ctx, namespace)
}

func TestSessionDeletionCleanupEnumeratesResidualsAndRetainsFailedResponsibility(t *testing.T) {
	for _, invalid := range []string{"", "owner", "scope", "backend", "files", "session_delete", "redaction"} {
		t.Run("residual "+invalid, func(t *testing.T) {
			p, bot, request := sessionDeletionProofIdentity()
			bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
				WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}, ReceiptDigest: "original-worker-receipt"}
			current, residual := uuid.NewString(), uuid.NewString()
			bot.SessionID = &current
			rows := []store.BotSession{{ID: residual, Owner: p.UserID, Scope: "test", Backend: "web"}, {ID: current, Owner: p.UserID, Scope: "test", Backend: "web"}}
			switch invalid {
			case "owner":
				rows[0].Owner = uuid.NewString()
			case "scope":
				rows[0].Scope = "task"
			case "backend":
				rows[0].Backend = "herdr"
			}
			var calls []string
			transactions, saves := 0, 0
			invalidOwnership := invalid == "owner" || invalid == "scope" || invalid == "backend"
			cause := errors.New("injected cleanup failure")
			expected := map[string]int{"credential": 1, "bot": 1, "sessions": 1, "save": 1}
			if invalid != "" {
				expected["credential"], expected["bot"] = 2, 2
			}
			switch invalid {
			case "", "redaction":
				expected["remove"], expected["redact"] = 2, 1
			case "session_delete":
				expected["remove"] = 1
			}
			proofCalls := expectSessionDeletionProofCalls(t, expected)
			dao := &sessionDeletionProofDAO{calls: proofCalls, credential: func(context.Context, model.Principal, time.Time) error { return nil }, sessions: func(_ context.Context, id string) ([]store.BotSession, error) {
				if id != bot.ID {
					t.Fatal("cleanup enumerated another Bot")
				}
				return rows, nil
			}, remove: func(_ context.Context, session, id string) error {
				if invalidOwnership || id != bot.ID {
					t.Fatal("cleanup removed an invalid binding")
				}
				calls = append(calls, "row:"+session)
				if invalid == "session_delete" {
					return cause
				}
				return nil
			}, redact: func(_ context.Context, id string) error {
				if invalidOwnership || id != bot.ID {
					t.Fatal("invalid cleanup reached redaction")
				}
				calls = append(calls, "redact")
				if invalid == "redaction" {
					return cause
				}
				return nil
			}}
			bots := &sessionDeletionProofBots{calls: proofCalls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
				saves++
				want := "completed"
				if invalid != "" {
					want = "failed"
				}
				if id != bot.ID || value.ServerCleanup.State != want || value.WorkerCleanup.State != "completed" || value.ReceiptDigest != "original-worker-receipt" {
					t.Fatal("cleanup result lost its original Worker obligation")
				}
				out := bot
				out.Deletion = value
				return out, nil
			}}
			writer := sessionDeletionProofWriter{write: func(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
				transactions++
				if transactions > 2 {
					t.Fatal("cleanup added an unexpected transaction")
				}
				err := fn(sessionDeletionProofScope{dao: dao, bots: bots})
				if transactions == 1 && invalid != "" {
					var expected error = cause
					expectedCallback := callbackCause(cause)
					if invalidOwnership {
						fault := &model.Fault{Code: "session_conflict", Message: "Session identity or state no longer matches."}
						expected = fault
						expectedCallback = callbackFreshFault(fault)
					}
					expectedCallback.check(t, err)
					return store.Completion{Outcome: store.TransactionNotCommitted}, expected
				}
				callbackCause(nil).check(t, err)
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			files := sessionDeletionProofFiles{remove: func(_ context.Context, namespace sessionarchive.Namespace) error {
				if invalidOwnership {
					t.Fatal("invalid binding reached file removal")
				}
				found := false
				for _, id := range []string{residual, current} {
					want, err := sessionarchive.NewNamespace(sessionarchive.Users, p.UserID, id)
					if err != nil {
						t.Fatal(err)
					}
					if namespace == want {
						calls = append(calls, "files:"+id)
						found = true
					}
				}
				if !found {
					t.Fatal("cleanup changed archive owner or Session namespace")
				}
				if invalid == "files" {
					return cause
				}
				return nil
			}}
			live := &discardedSessions{}
			svc := NewDeletions(writer, files, live)
			operationCalls := map[string]int{"owner": 1, "server": 1, "save": 1}
			if invalid != "" {
				operationCalls["owner"] = 2
				operationCalls["fail"] = 1
			}
			bindDeletionFacts(t, svc, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: operationCalls, serverChange: true, failChange: invalid != ""})
			out, err := svc.clean(t.Context(), p, bot.ID, request.DeletionID)
			if err != nil || saves != 1 {
				t.Fatalf("cleanup result: out=%+v saves=%d err=%v", out, saves, err)
			}
			if invalid == "" {
				want := []string{"files:" + residual, "row:" + residual, "files:" + current, "row:" + current, "redact"}
				if transactions != 1 || !reflect.DeepEqual(calls, want) || !reflect.DeepEqual(live.ids, []string{residual, current}) {
					t.Fatalf("cleanup omitted residual binding: tx=%d calls=%v live=%v", transactions, calls, live.ids)
				}
			} else {
				var want []string
				switch invalid {
				case "files":
					want = []string{"files:" + residual}
				case "session_delete":
					want = []string{"files:" + residual, "row:" + residual}
				case "redaction":
					want = []string{"files:" + residual, "row:" + residual, "files:" + current, "row:" + current, "redact"}
				}
				if transactions != 2 || !reflect.DeepEqual(calls, want) || len(live.ids) != 0 || out.Deletion.ServerCleanup.State != "failed" {
					t.Fatalf("failed cleanup did not preserve rollback and separate failure: tx=%d calls=%v live=%v", transactions, calls, live.ids)
				}
			}
		})
	}
}

func TestSessionDeletionWriteErrorsRetainCauseAndDoNotPublishProposals(t *testing.T) {
	for _, phase := range []string{"intent", "receipt"} {
		t.Run(phase, func(t *testing.T) {
			p, bot, request := sessionDeletionProofIdentity()
			var receipt BotDeletionReceipt
			var proof store.BotSessionStop
			if phase == "receipt" {
				bot, proof, receipt = sessionDeletionProofBound(p, bot, request)
			}
			cause := errors.New("deletion DAO write failed")
			writes := 0
			expected := map[string]int{"credential": 1, "bot": 1, "save": 1}
			if phase == "intent" {
				expected["sessions"], expected["revoke"] = 1, 1
			} else {
				expected["stop"] = 1
			}
			calls := expectSessionDeletionProofCalls(t, expected)
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil },
				sessions: func(context.Context, string) ([]store.BotSession, error) {
					return []store.BotSession{{ID: uuid.NewString()}}, nil
				},
				revoke: func(context.Context, string) error { return nil },
				stop:   func(context.Context, string, string, string) (store.BotSessionStop, error) { return proof, nil }}
			bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
				writes++
				if id != bot.ID || value.DeletionID != request.DeletionID {
					t.Fatal("write failure tested another deletion")
				}
				return model.Bot{}, cause
			}}
			live := &discardedSessions{}
			svc := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionNotCommitted, callbackCause(cause), cause), nil, live)
			operationCalls := map[string]int{"owner": 1, "save": 1}
			if phase == "intent" {
				operationCalls["request"] = 1
			} else {
				operationCalls["worker"] = 1
			}
			bindDeletionFacts(t, svc, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: operationCalls, workerChange: true, needsProof: true, receipt: &receipt})
			svc.now = func() time.Time { return time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC) }
			var out model.Bot
			var err error
			if phase == "intent" {
				out, err = svc.DeleteBot(t.Context(), p, bot.ID, request)
			} else {
				out, err = svc.CompleteBotDeletion(t.Context(), p, bot.WorkerID, bot.ID, receipt)
			}
			if !errors.Is(err, cause) || writes != 1 || !reflect.DeepEqual(out, model.Bot{}) || len(live.ids) != 0 {
				t.Fatalf("failed proposal was published or cause lost: writes=%d out=%+v live=%v err=%v", writes, out, live.ids, err)
			}
		})
	}
}

func TestSessionDeletionReceiptAcceptsUnconsumedNeverStartedExecution(t *testing.T) {
	ctx := context.WithValue(t.Context(), struct{}{}, "never-started receipt")
	now := time.Date(2026, 11, 11, 1, 0, 0, 123456000, time.UTC)
	p := model.Principal{Kind: model.PATCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	const botID = "a4444444-4444-4444-8444-444444444444"
	const workerID = "b5555555-5555-4555-8555-555555555555"
	const deletionID = "c6666666-6666-4666-8666-666666666666"
	const sessionID = "d7777777-7777-4777-8777-777777777777"
	const controllerID = "e8888888-8888-4888-8888-888888888888"
	const instanceID = "f9999999-9999-4999-8999-999999999999"
	fence := sp.Fence{SessionID: sessionID, TestExecutionID: "a0000000-0000-4000-8000-000000000000", ExecutionGeneration: "1"}
	receipt := func() BotDeletionReceipt {
		return BotDeletionReceipt{DeletionID: deletionID, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{
			Protocol: sp.Protocol, Fence: fence, ControllerID: controllerID, ControllerInstanceID: instanceID,
			StopProof: sp.StopProof{Kind: "never_started", RecordID: "b0000000-0000-4000-8000-000000000000", PreviousControllerInstanceID: instanceID, StoppedAt: now.Format(time.RFC3339Nano)},
		}}
	}
	raw, err := json.Marshal(receipt())
	if err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(raw))
	bot := func(version int64, worker, server, hash string) model.Bot {
		id := sessionID
		execution := fence.TestExecutionID
		return model.Bot{ID: botID, OwnerUserID: p.UserID, WorkerID: workerID, Name: "Assistant", Version: version, CreationOrder: 41,
			ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/workspace", Provider: "copilot", Model: pointer("gpt-5"), Args: []string{"--effort", "high"}},
			SessionID:             &id, TestExecutionID: &execution, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
			Deletion: &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: worker}, ServerCleanup: model.BotCleanupResult{State: server}, ReceiptDigest: hash}}
	}
	before := func() model.Bot { return bot(3, "pending", "pending", "") }
	workerComplete := func() model.Bot { return bot(4, "completed", "pending", digest) }
	final := func() model.Bot { return bot(5, "completed", "completed", digest) }
	plan := newPlan(t, "write", "credential", "bot", "owner", "worker", "stop", "save worker", "write_done",
		"write", "credential", "bot", "owner", "server", "sessions", "files", "remove", "redact", "save server", "write_done")
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 2, "bot": 2, "stop": 1, "sessions": 1, "remove": 1, "redact": 1})
	dao := &sessionDeletionProofDAO{calls: calls,
		credential: func(actual context.Context, actor model.Principal, at time.Time) error {
			plan.call("credential")
			identical(t, actual, ctx)
			same(t, actor, p)
			same(t, at, now)
			return nil
		},
		stop: func(actual context.Context, session, id, owner string) (store.BotSessionStop, error) {
			plan.call("stop")
			identical(t, actual, ctx)
			same(t, session, sessionID)
			same(t, id, botID)
			same(t, owner, p.UserID)
			return store.BotSessionStop{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence, ConnectionEpoch: "0"},
				Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: controllerID, ControllerInstanceID: instanceID}}, Consumed: false, SourceEpoch: nil}, nil
		},
		sessions: func(actual context.Context, id string) ([]store.BotSession, error) {
			plan.call("sessions")
			identical(t, actual, ctx)
			same(t, id, botID)
			return []store.BotSession{{ID: sessionID, Owner: p.UserID, Scope: "test", Backend: "web"}}, nil
		},
		remove: func(actual context.Context, session, id string) error {
			plan.call("remove")
			identical(t, actual, ctx)
			same(t, session, sessionID)
			same(t, id, botID)
			return nil
		},
		redact: func(actual context.Context, id string) error {
			plan.call("redact")
			identical(t, actual, ctx)
			same(t, id, botID)
			return nil
		},
	}
	reads := 0
	bots := &sessionDeletionProofBots{calls: calls, read: func(actual context.Context, id string) (model.Bot, error) {
		plan.call("bot")
		identical(t, actual, ctx)
		same(t, id, botID)
		reads++
		if reads == 1 {
			return before(), nil
		}
		return workerComplete(), nil
	}}
	transactions := 0
	writer := sessionDeletionProofWriter{write: func(actual context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		plan.call("write")
		identical(t, actual, ctx)
		transactions++
		callbackCause(nil).check(t, fn(sessionDeletionProofScope{dao: dao, bots: bots}))
		plan.call("write_done")
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	files := sessionDeletionProofFiles{remove: func(actual context.Context, namespace sessionarchive.Namespace) error {
		plan.call("files")
		identical(t, actual, ctx)
		want, e := sessionarchive.NewNamespace(sessionarchive.Users, p.UserID, sessionID)
		if e != nil {
			t.Fatal(e)
		}
		same(t, namespace, want)
		return nil
	}}
	live := &discardedSessions{}
	svc := NewDeletions(writer, files, live)
	svc.now = func() time.Time { return now }
	saves := 0
	svc.operations = deletionOperations{
		owner: func(v model.Bot, actor model.Principal) error {
			plan.call("owner")
			same(t, actor, p)
			if reads == 1 {
				same(t, v, before())
			} else {
				same(t, v, workerComplete())
			}
			return nil
		},
		worker: func(v model.Bot, worker, id string, result model.BotCleanupResult, hash string) (bool, bool, error) {
			plan.call("worker")
			same(t, v, before())
			same(t, worker, workerID)
			same(t, id, deletionID)
			same(t, result, receipt().Result)
			same(t, hash, digest)
			return true, true, nil
		},
		server: func(v model.Bot, id string) (bool, error) {
			plan.call("server")
			same(t, v, workerComplete())
			same(t, id, deletionID)
			return true, nil
		},
		save: func(actual context.Context, d store.BotWriteDAO, v model.Bot) (model.Bot, error) {
			identical(t, actual, ctx)
			identical(t, d, bots)
			saves++
			if saves == 1 {
				plan.call("save worker")
				want := before()
				want.Deletion = workerComplete().Deletion
				same(t, v, want)
				return workerComplete(), nil
			}
			plan.call("save server")
			want := workerComplete()
			want.Deletion = final().Deletion
			same(t, v, want)
			return final(), nil
		},
	}
	got, err := svc.CompleteBotDeletion(ctx, p, workerID, botID, receipt())
	if err != nil {
		t.Fatal(err)
	}
	same(t, got, final())
	same(t, transactions, 2)
	same(t, saves, 2)
	same(t, live.ids, []string{sessionID})
}
