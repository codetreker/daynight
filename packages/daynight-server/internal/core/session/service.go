// Package session owns execution Session state and routing. Native effects remain in
// the controller; database commits never claim that a native operation ran.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const PollInterval = 250 * time.Millisecond
const HeartbeatTimeout = 30 * time.Second

type Engine struct {
	captureMutex          sync.Mutex
	captureJobs           map[string]bool
	mediaWork             imageWorkRegistry
	archiveSlots          chan struct{}
	archivePreflightSlots chan struct{}
	Origin                string
	files                 filestorage.Storage
	imageDecoder          ImageDecoder
	releaseMediaLeaseRun  func(context.Context, string, string) error
	recoverMediaLeasesRun func(context.Context) error
	now                   func() time.Time
	liveMutex             sync.Mutex
	live                  map[string]*liveCell
	instance              string
	content               contentBroker
	terminalMutex         sync.Mutex
	terminalPending       map[string]map[string]*terminalBodyWrite
	terminalFrames        map[string]*terminalFrameWrite
	terminalFrameWrites   map[string]*terminalFrameWrite
	admissionMutex        sync.Mutex
	closing               bool
	activeOperations      int
	idle                  chan struct{}
	stopping              chan struct{}
	workCanceled          bool
}

func NewEngine(files filestorage.Storage) *Engine {
	return &Engine{archiveSlots: make(chan struct{}, 1), archivePreflightSlots: make(chan struct{}, 1), files: files, now: time.Now, live: map[string]*liveCell{}, instance: uuid.NewString()}
}
func fault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func conflict() error {
	return fault("session_conflict", "Session identity or state no longer matches.")
}
func denied() error          { return fault("forbidden", "Session access is not available.") }
func number(s string) int64  { n, _ := strconv.ParseInt(s, 10, 64); return n }
func decimal(n int64) string { return strconv.FormatInt(n, 10) }
func next(s string) string   { return decimal(number(s) + 1) }
func encode(v any) []byte    { b, _ := json.Marshal(v); return b }

type record struct {
	BotID                                               *string
	Live                                                *liveSession
	ServerInstance                                      *string
	FirstInputBlocked                                   bool
	DrainTimelineSeq                                    *int64
	Snapshot                                            sp.Snapshot
	Owner, Parent                                       string
	ConnectionParent                                    string
	Registration                                        []byte
	StopProof                                           []byte
	SourceEpoch                                         *string
	SourceEpochs                                        []string
	SourceSeq, OperationSeq                             int64
	GrantHash                                           []byte
	GrantExpiry, ConnectionExpiry, LastSeen, DrainUntil *time.Time
	GrantKind                                           string
	Consumed                                            bool
}

func loadWithBot(ctx context.Context, tx *operationTx, id string, bot *model.Bot) (*record, error) {
	persisted, err := tx.dao.LockSession(ctx, id)
	if err != nil {
		return nil, err
	}
	r := &record{BotID: persisted.BotID, ServerInstance: persisted.ServerInstance, FirstInputBlocked: persisted.FirstInputBlocked, DrainTimelineSeq: persisted.DrainTimelineSeq, Snapshot: persisted.Snapshot, Owner: persisted.Owner, Parent: persisted.Parent, ConnectionParent: persisted.ConnectionParent, Registration: persisted.Registration, StopProof: persisted.StopProof, SourceEpoch: persisted.SourceEpoch, SourceEpochs: persisted.SourceEpochs, SourceSeq: persisted.SourceSeq, OperationSeq: persisted.OperationSeq, GrantHash: persisted.GrantHash, GrantExpiry: persisted.GrantExpiry, ConnectionExpiry: persisted.ConnectionExpiry, LastSeen: persisted.LastSeen, DrainUntil: persisted.DrainUntil, GrantKind: persisted.GrantKind, Consumed: persisted.Consumed}
	if !validSessionBot(bot, r) {
		return nil, conflict()
	}
	r.Snapshot = durableSnapshot(r.Snapshot)
	err = attachLive(tx, r)
	return r, err
}
func save(ctx context.Context, tx *operationTx, r *record) error {
	r.Snapshot.Operations = sp.Operations{}
	if r.Live != nil {
		r.Live.LastSeen = r.LastSeen
		r.Live.Snapshot = r.Snapshot
		if err := r.Live.checkCapacity(); err != nil {
			return err
		}
	}
	return tx.dao.SaveSession(ctx, store.SessionRecord{Snapshot: durableSnapshot(r.Snapshot), SourceEpoch: r.SourceEpoch, SourceEpochs: r.SourceEpochs, SourceSeq: r.SourceSeq, OperationSeq: r.OperationSeq})
}
func credential(ctx context.Context, tx *operationTx, p model.Principal, now time.Time) error {
	if p.Kind != model.PATCredential && p.Kind != model.SessionCredential {
		return denied()
	}
	if err := tx.dao.LockCredential(ctx, p, now); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return fault("unauthenticated", "Credential expired or was revoked.")
		}
		return err
	}
	return nil
}

type task struct {
	Worker        *model.WorkerClaim
	Type          model.TaskType
	Deleted       bool
	Status        string
	StartupReport *sp.StartupReport
}

func lockTask(ctx context.Context, tx *operationTx, project, id string) (task, error) {
	persisted, err := tx.dao.LockTask(ctx, project, id)
	return taskFromStore(persisted), err
}
func taskFromStore(persisted store.SessionTask) task {
	return task{Worker: persisted.Worker, Type: persisted.Type, Deleted: persisted.Deleted, Status: persisted.Status, StartupReport: persisted.StartupReport}
}
func current(t task, r *record) bool {
	if r.Snapshot.TestExecutionID != "" {
		return true
	}
	w := t.Worker
	return w != nil && w.ClaimID == r.Snapshot.ClaimID && w.AgentControlMode == model.AgentControlModeWeb
}
func active(t task, r *record) bool {
	return r.Snapshot.Lifecycle == "active" && (r.Snapshot.TestExecutionID != "" || !t.Deleted && t.Type != model.TaskTypeGoal && current(t, r) && t.Status == "in_progress" && t.Worker.State == model.WorkerActive)
}
func (s *Execution) browser(ctx context.Context, p model.Principal, project, taskID, id string, fn func(*operationTx, *record, task, bool) error) error {
	return s.browserRun(ctx, p, project, taskID, id, BrowserAccess, func(a *Access) error {
		return fn(a.tx, a.record, a.task, a.write)
	})
}

func (s *Execution) archiveExpired(ctx context.Context, tx *operationTx, r *record) error {
	if r.Snapshot.Lifecycle != "draining" || r.DrainUntil == nil || s.now().Before(*r.DrainUntil) {
		return nil
	}
	r.Snapshot.Lifecycle = "archived"
	r.Snapshot.ConnectionState = "disconnected"
	r.Snapshot.Synchronized = false
	if err := s.emit(ctx, tx, r, "snapshot", r.Snapshot, nil); err != nil {
		return err
	}
	return save(ctx, tx, r)
}
func controlActivity(activity string) bool {
	return activity == "idle" || activity == "working" || activity == "waiting_input"
}

func permissions(r *record, write bool, now time.Time) sp.Snapshot {
	v := r.Snapshot
	v.Operations = sp.Operations{}
	// Permission projection must not mutate the persisted controller catalog.
	if v.Controls != nil {
		controls := *v.Controls
		controls.Settings = append([]sp.Setting{}, v.Controls.Settings...)
		controls.Commands = append([]sp.NativeCommand{}, v.Controls.Commands...)
		v.Controls = &controls
	}
	if r.DrainUntil != nil && !now.Before(*r.DrainUntil) {
		v.Lifecycle = "archived"
	}
	if r.LastSeen == nil || now.Sub(*r.LastSeen) > HeartbeatTimeout {
		v.ConnectionState = "disconnected"
	}
	if v.Controls != nil && (!write || v.Lifecycle != "active" || v.ConnectionState != "connected" || !v.Synchronized || !controlActivity(v.Activity)) {
		for i := range v.Controls.Settings {
			v.Controls.Settings[i].Mutable = false
		}
		for i := range v.Controls.Commands {
			v.Controls.Commands[i].Available = false
		}
	}
	if !write || v.Lifecycle == "archived" || v.ConnectionState != "connected" || !v.Synchronized {
		return v
	}
	if v.Lifecycle == "draining" {
		return v
	}
	_, sendReason := messageSendEligibility(v, r.FirstInputBlocked)
	v.Operations.CanSend = sendReason == "allowed"
	v.Operations.CanCancel = v.Capabilities.Cancel && v.CurrentTurnID != nil
	v.Operations.CanRespond = v.Capabilities.Respond
	return v
}
func (s *Execution) Register(ctx context.Context, p model.Principal, project, taskID string, input sp.Registration) (sp.Snapshot, error) {
	var result sp.Snapshot
	if p.Kind != model.PATCredential {
		return result, denied()
	}
	err := s.taskRegistrationRun(ctx, p, project, taskID, input, func(op *Operation, scope store.SessionScope, existing *Access) error {
		_, tx := op.scoped(scope)
		if existing != nil {
			r := existing.record
			var prior sp.Registration
			if json.Unmarshal(r.Registration, &prior) != nil || prior != input {
				return conflict()
			}
			result = permissions(r, true, s.now())
			return nil
		}
		result = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: input.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: project, TaskID: taskID, WorkerID: input.WorkerID, WorktreeID: input.WorktreeID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, AgentControlMode: "web", Provider: input.Provider}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
		return tx.dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: result.SessionID, ProjectID: project, TaskID: taskID}, ClaimID: input.ClaimID, OwnerID: p.UserID, RegistrationID: input.RegistrationID, Registration: encode(input), Snapshot: durableSnapshot(result)})
	})
	return result, err
}

type GrantResult struct {
	TestExecutionID      string    `json:"testExecutionId,omitempty"`
	Token                string    `json:"token"`
	ExpiresAt            time.Time `json:"expiresAt"`
	SessionID            string    `json:"sessionId"`
	ClaimID              string    `json:"claimId,omitempty"`
	ExecutionGeneration  string    `json:"executionGeneration"`
	ControllerID         string    `json:"controllerId"`
	ControllerInstanceID string    `json:"controllerInstanceId"`
}

func (s *Execution) Grant(ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant) (GrantResult, error) {
	var out GrantResult
	if p.Kind != model.PATCredential {
		return out, denied()
	}
	err := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, t task, _ bool) error {
		if r.BotID != nil {
			return denied()
		}
		if r.Snapshot.TestExecutionID != "" && (g.PreviousGeneration != nil || g.StopProof != nil) {
			return conflict()
		}
		var err error
		out, err = s.grantRecord(ctx, tx, p, r, t, g)
		return err
	})
	return out, err
}

func (s *Execution) grantRecord(ctx context.Context, tx *operationTx, p model.Principal, r *record, t task, g sp.Grant) (GrantResult, error) {
	var out GrantResult
	id := r.Snapshot.SessionID
	v := &r.Snapshot
	if !active(t, r) || r.Owner != p.UserID || g.ClaimID != v.ClaimID || g.TestExecutionID != v.TestExecutionID || g.ControllerID != v.Identity.ControllerID {
		return out, conflict()
	}
	if g.PreviousGeneration != nil && g.ExecutionGeneration == v.ExecutionGeneration {
		if g.StopProof == nil || number(*g.PreviousGeneration)+1 != number(v.ExecutionGeneration) || g.ControllerInstanceID != v.Identity.ControllerInstanceID || !jsonEqual(r.StopProof, encode(g.StopProof)) {
			return out, conflict()
		}
	} else if g.PreviousGeneration != nil {
		if g.StopProof == nil || *g.PreviousGeneration != v.ExecutionGeneration || number(g.ExecutionGeneration) != number(v.ExecutionGeneration)+1 || g.StopProof.PreviousControllerInstanceID != v.Identity.ControllerInstanceID || g.ControllerInstanceID == v.Identity.ControllerInstanceID {
			return out, conflict()
		}
		stopped, err := time.Parse(time.RFC3339Nano, g.StopProof.StoppedAt)
		if err != nil || stopped.After(s.now().Add(time.Second)) {
			return out, conflict()
		}
		if err = handoffActiveHistory(ctx, tx, r, g); err != nil {
			return out, err
		}
		v.Controls = nil
		v.TurnStartedAt = nil
		v.ExecutionGeneration = g.ExecutionGeneration
		v.Identity.ControllerInstanceID = g.ControllerInstanceID
		v.ConnectionState = "disconnected"
		v.Synchronized = false
		if err = tx.dao.SetSessionGenerationStop(ctx, id, encode(g.StopProof)); err != nil {
			return out, err
		}
		if err = s.emit(ctx, tx, r, "snapshot", *v, nil); err != nil {
			return out, err
		}
	} else if g.ExecutionGeneration != v.ExecutionGeneration || g.ControllerInstanceID != v.Identity.ControllerInstanceID || g.StopProof != nil {
		return out, conflict()
	}
	if g.Kind == "bootstrap" && v.ConnectionEpoch != "0" && g.PreviousGeneration == nil {
		return out, conflict()
	}
	ttl := 15 * time.Minute
	if g.Kind == "bootstrap" {
		ttl = 120 * time.Second
	}
	out = GrantResult{TestExecutionID: v.TestExecutionID, Token: "dncontroller_" + rand.Text(), ExpiresAt: s.now().Add(ttl).UTC(), SessionID: id, ClaimID: v.ClaimID, ExecutionGeneration: v.ExecutionGeneration, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID}
	h := sha256.Sum256([]byte(out.Token))
	err := tx.dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: id, Hash: h[:], ExpiresAt: out.ExpiresAt, Kind: g.Kind, ParentCredentialID: p.CredentialID})
	if err != nil {
		return out, err
	}
	return out, save(ctx, tx, r)
}

// AuthenticateController checks grant and parent authority before allocating a channel.
// Connect repeats these checks atomically with hello validation and grant consumption.
func (s *Execution) AuthenticateController(ctx context.Context, token string) error {
	hash := sha256.Sum256([]byte(token))
	return s.grantRun(ctx, hash[:], func(*Access) error { return nil })
}
func (s *Execution) Connect(ctx context.Context, token string, h sp.ControllerMessage, instance string) (sp.Snapshot, error) {
	return s.ConnectWithContentRead(ctx, token, h, instance, 0)
}

func (s *Execution) ConnectWithContentRead(ctx context.Context, token string, h sp.ControllerMessage, instance string, contentReadVersion int) (sp.Snapshot, error) {
	if contentReadVersion != 0 && contentReadVersion != 1 {
		return sp.Snapshot{}, fault("unsupported_protocol", "Unsupported content read version.")
	}
	var out sp.Snapshot
	hash := sha256.Sum256([]byte(token))
	err := s.grantRun(ctx, hash[:], func(access *Access) error {
		tx, r := access.tx, access.record
		v := &r.Snapshot
		if r.ServerInstance != nil && *r.ServerInstance != s.instance && r.LastSeen != nil && s.now().Sub(*r.LastSeen) < HeartbeatTimeout && r.ConnectionExpiry != nil && s.now().Before(*r.ConnectionExpiry) {
			return fault("relay_instance_unavailable", "The live controller belongs to another relay instance.")
		}
		id := v.SessionID
		if h.SessionID != id || h.ClaimID != v.ClaimID || h.TestExecutionID != v.TestExecutionID || h.ExecutionGeneration != v.ExecutionGeneration || h.ControllerID != v.Identity.ControllerID || h.ControllerInstanceID != v.Identity.ControllerInstanceID || h.Provider != v.Identity.Provider || h.SchemaVersion != 1 || h.ProjectionVersion != 1 {
			return conflict()
		}
		if r.SourceEpoch == nil {
			r.SourceEpoch = &h.SourceEpoch
			r.SourceEpochs = append(r.SourceEpochs, h.SourceEpoch)
		} else if *r.SourceEpoch != h.SourceEpoch {
			return conflict()
		}
		if h.SourceFloor != nil && number(*h.SourceFloor) > r.SourceSeq {
			r.SourceSeq = number(*h.SourceFloor)
		}
		if number(h.LastAckedSourceSeq) > r.SourceSeq {
			return conflict()
		}
		v.ContentRevision = 0
		if h.ContentRevision == 2 {
			v.ContentRevision = 2
		}
		if err := s.refreshImageState(ctx, tx, r, nil); err != nil {
			return err
		}
		v.ConnectionEpoch = next(v.ConnectionEpoch)
		v.ConnectionState = "synchronizing"
		v.Synchronized = false
		now := s.now()
		r.LastSeen = &now
		r.ConnectionExpiry = r.GrantExpiry
		historyEpoch := uuid.NewString()
		if err := handoffConnectedHistory(ctx, tx, r, historyEpoch); err != nil {
			return err
		}
		v.HistoryEpoch = historyEpoch
		if err := createLive(tx, r); err != nil {
			return err
		}
		r.Live.ContentReadVersion = contentReadVersion
		if err := tx.dao.ConnectSession(ctx, id, s.instance, now, r.GrantExpiry); err != nil {
			return err
		}
		if err := s.emit(ctx, tx, r, "snapshot", *v, nil); err != nil {
			return err
		}
		out = permissions(r, false, now)
		return save(ctx, tx, r)
	})
	return out, err
}
func (s *Execution) controller(ctx context.Context, f sp.ControllerFence, fn func(*operationTx, *record, task) error) error {
	return s.controllerRun(ctx, f, func(a *Access) error {
		return fn(a.tx, a.record, a.task)
	})
}

func (s *Execution) emit(ctx context.Context, tx *operationTx, r *record, kind string, payload any, source *sp.SourceEvent) error {
	v := &r.Snapshot
	v.LastEventSeq = next(v.LastEventSeq)
	if kind == "snapshot" {
		v.SessionRevision = next(v.SessionRevision)
		payload = *v
	}
	event := map[string]any{"protocol": sp.Protocol, "sessionId": v.SessionID, "claimId": v.ClaimID, "executionGeneration": v.ExecutionGeneration, "connectionEpoch": v.ConnectionEpoch, "eventSeq": v.LastEventSeq, "historyEpoch": v.HistoryEpoch, "kind": kind, "payload": payload}
	sp.BindingFields(v.Fence, event)
	if operation, ok := payload.(sp.Operation); ok {
		event["executionGeneration"] = operation.ExecutionGeneration
	}
	if r.Live == nil {
		return nil
	}
	raw, err := sp.MarshalWire(event)
	if err != nil {
		return err
	}
	if len(raw) > maxEventBytes-1024 {
		return fault("payload_too_large", "Live event exceeds relay capacity.")
	}
	r.Live.Events = append(r.Live.Events, raw)
	r.Live.EventBytes += len(raw)
	for r.Live.EventBytes > maxEventBytes || len(r.Live.Events) > 1000 {
		first := r.Live.Events[0]
		var value struct {
			EventSeq string `json:"eventSeq"`
		}
		_ = json.Unmarshal(first, &value)
		r.Live.MinEventSeq = number(value.EventSeq)
		r.Live.EventBytes -= len(first)
		r.Live.Events = r.Live.Events[1:]
	}
	return nil
}
