package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func hashBytes(raw []byte) string { value := sha256.Sum256(raw); return hex.EncodeToString(value[:]) }

func checkpointFixture() sp.BotHistoryCheckpoint {
	low, through := "2", "3"
	return sp.BotHistoryCheckpoint{BotHistoryWindowBoundary: sp.BotHistoryWindowBoundary{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, BotHistoryWindowVersion: 1, HistoryEpoch: uuid.NewString(), WindowRevision: "2", RetainedFromSeq: &low, ThroughSeq: &through, EarlierHistoryUnavailable: true}, SourceEpoch: uuid.NewString(), SourceThrough: "4", Entries: []sp.BotHistoryCheckpointEntry{{EntryID: uuid.NewString(), EntrySeq: "2", Revision: "1", SHA256: hashBytes([]byte("first")), ResourceIDs: []string{}, ImageOccurrences: []sp.ImageOccurrence{}}, {EntryID: uuid.NewString(), EntrySeq: "3", Revision: "1", SHA256: hashBytes([]byte("last")), ResourceIDs: []string{}, ImageOccurrences: []sp.ImageOccurrence{}}}}
}

func TestBotHistoryCheckpointAdvance(t *testing.T) {
	for _, kind := range []string{"repeat", "fence", "source rebind", "source rebind changed content", "source rebind regression", "advance", "epoch", "backwards revision", "changed same revision", "backwards low", "backwards through", "forgot eviction", "entry sequence", "late revision", "same revision hash", "resurrect", "empty then resurrect"} {
		t.Run(kind, func(t *testing.T) {
			old := checkpointFixture()
			next, _ := sp.DecodeBotHistoryCheckpoint(encode(old))
			next.WindowRevision = "3"
			bad := true
			switch kind {
			case "repeat":
				next = old
				bad = false
			case "fence":
				next = old
				next.ConnectionEpoch = "2"
				bad = false
			case "source rebind", "source rebind changed content", "source rebind regression":
				next.SourceEpoch = uuid.NewString()
				next.SourceThrough = "0"
				next.WindowRevision = old.WindowRevision
				bad = kind != "source rebind"
				if kind == "source rebind changed content" {
					next.Entries[0].Revision = "2"
				}
				if kind == "source rebind regression" {
					next.WindowRevision = "1"
				}
			case "advance":
				next.Entries = next.Entries[1:]
				next.RetainedFromSeq = &next.Entries[0].EntrySeq
				bad = false
			case "epoch":
				next.HistoryEpoch = uuid.NewString()
				next.WindowRevision = "1"
				bad = false
			case "backwards revision":
				next.WindowRevision = "1"
			case "changed same revision":
				next.WindowRevision = old.WindowRevision
				next.Entries[0].Revision = "2"
			case "backwards low":
				low := "1"
				next.RetainedFromSeq = &low
			case "backwards through":
				through := "2"
				next.ThroughSeq = &through
			case "forgot eviction":
				next.EarlierHistoryUnavailable = false
			case "entry sequence":
				next.Entries[0].EntrySeq = "4"
			case "late revision":
				old.Entries[0].Revision = "2"
			case "same revision hash":
				next.Entries[0].SHA256 = hashBytes([]byte("changed"))
			case "resurrect":
				next.Entries[0].EntryID = uuid.NewString()
			case "empty then resurrect":
				old.Entries = []sp.BotHistoryCheckpointEntry{}
				old.RetainedFromSeq = nil
			}
			err := validateBotHistoryCheckpointAdvance(old, next)
			if (err != nil) != bad {
				t.Fatalf("unexpected advancement result: %v", err)
			}
		})
	}
}

type checkpointRuleDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	store.BotHistoryWindowDAO
	read     func(context.Context, string) ([]byte, error)
	save     func(context.Context, string, []byte) error
	refs     func(context.Context, string, string) ([]store.SessionResourceReference, error)
	resource func(context.Context, string, string) (store.SessionResourceRecord, error)
	add      func(context.Context, store.SessionResourceReference) error
	remove   func(context.Context, store.SessionResourceReference) error
	capture  func(context.Context, string, string) (store.SessionCaptureRecord, error)
	queue    func(context.Context, string, string) error
}

func (d *checkpointRuleDAO) BotHistoryCheckpoint(ctx context.Context, id string) ([]byte, error) {
	return d.read(ctx, id)
}
func (d *checkpointRuleDAO) SaveBotHistoryCheckpoint(ctx context.Context, id string, data []byte) error {
	return d.save(ctx, id, data)
}
func (d *checkpointRuleDAO) SessionResourceReferences(ctx context.Context, id, kind string) ([]store.SessionResourceReference, error) {
	return d.refs(ctx, id, kind)
}
func (d *checkpointRuleDAO) SavedSessionResource(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
	return d.resource(ctx, session, id)
}
func (d *checkpointRuleDAO) AddSessionResourceReference(ctx context.Context, ref store.SessionResourceReference) error {
	return d.add(ctx, ref)
}
func (d *checkpointRuleDAO) RemoveSessionResourceReference(ctx context.Context, ref store.SessionResourceReference) error {
	return d.remove(ctx, ref)
}
func (d *checkpointRuleDAO) SessionCaptureByImage(ctx context.Context, session, id string) (store.SessionCaptureRecord, error) {
	return d.capture(ctx, session, id)
}
func (d *checkpointRuleDAO) QueueBotHistoryReclaim(ctx context.Context, session, id string) error {
	return d.queue(ctx, session, id)
}

func TestBotHistoryCheckpointCommitPreservesUnknownOutcomeAndAuthority(t *testing.T) {
	for _, kind := range []string{"success", "duplicate", "unknown", "revoked", "wrong token", "not bot", "old source", "other source epoch", "missing source epoch", "old epoch", "unsupported", "save failure"} {
		t.Run(kind, func(t *testing.T) {
			in := checkpointFixture()
			in.Entries = []sp.BotHistoryCheckpointEntry{}
			in.RetainedFromSeq = nil
			token := "controller-secret"
			hash := sha256.Sum256([]byte(token))
			bot := uuid.NewString()
			r := &record{BotID: &bot, GrantHash: hash[:], SourceEpoch: &in.SourceEpoch, SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: in.ControllerFence, HistoryEpoch: in.HistoryEpoch, Lifecycle: "active"}, Live: &liveSession{BotHistoryWindowVersion: 1}}
			writes := 0
			cause := errors.New("write completion unknown")
			dao := &checkpointRuleDAO{read: func(_ context.Context, id string) ([]byte, error) {
				if id != in.SessionID {
					t.Fatal(id)
				}
				if kind == "duplicate" {
					return encode(in), nil
				}
				return nil, model.ErrNotFound
			}, save: func(_ context.Context, id string, data []byte) error {
				writes++
				if id != in.SessionID || !jsonEqual(data, encode(in)) {
					t.Fatal("wrong checkpoint")
				}
				if kind == "save failure" {
					return cause
				}
				return nil
			}, refs: func(_ context.Context, id, kind string) ([]store.SessionResourceReference, error) {
				if id != in.SessionID || kind != "message" && kind != "bot_window" {
					t.Fatal(id, kind)
				}
				return nil, nil
			}}
			s := &Execution{Engine: NewEngine(nil)}
			s.controllerRun = func(ctx context.Context, f sp.ControllerFence, work func(*Access) error) error {
				if kind == "revoked" {
					return denied()
				}
				if f != in.ControllerFence {
					t.Fatal("wrong fence")
				}
				if err := work(&Access{tx: &operationTx{dao: dao}, record: r}); err != nil {
					return err
				}
				if kind == "unknown" {
					return cause
				}
				return nil
			}
			switch kind {
			case "wrong token":
				token = "wrong"
			case "not bot":
				r.BotID = nil
			case "old source":
				r.SourceSeq = 5
			case "other source epoch":
				epoch := uuid.NewString()
				r.SourceEpoch = &epoch
			case "missing source epoch":
				r.SourceEpoch = nil
			case "old epoch":
				r.Snapshot.HistoryEpoch = uuid.NewString()
			case "unsupported":
				r.Live.BotHistoryWindowVersion = 0
			}
			out, err := s.CommitBotHistoryCheckpoint(t.Context(), token, in)
			if kind == "success" || kind == "duplicate" {
				if err != nil || out.WindowRevision != in.WindowRevision {
					t.Fatal(out, err)
				}
			} else {
				if err == nil || out.WindowRevision != "" {
					t.Fatal("failure published a receipt", out, err)
				}
			}
			want := 0
			if kind == "success" || kind == "unknown" || kind == "save failure" {
				want = 1
			}
			if writes != want {
				t.Fatalf("writes=%d want %d", writes, want)
			}
		})
	}
}

func TestBotHistoryCheckpointReadsAndConnectionDowngrade(t *testing.T) {
	in := checkpointFixture()
	bot := uuid.NewString()
	r := &record{BotID: &bot, SourceEpoch: &in.SourceEpoch, SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: in.ControllerFence, HistoryEpoch: in.HistoryEpoch}}
	dao := &checkpointRuleDAO{read: func(context.Context, string) ([]byte, error) { return encode(in), nil }}
	tx := &operationTx{dao: dao}
	if _, err := readBotHistoryCheckpoint(t.Context(), tx, r); err != nil {
		t.Fatal(err)
	}
	if err := requireBotHistoryWindowConnection(t.Context(), tx, r, 0); err == nil {
		t.Fatal("downgrade admitted")
	}
	if err := requireBotHistoryWindowConnection(t.Context(), tx, r, 1); err != nil {
		t.Fatal(err)
	}
	r.SourceSeq++
	if _, err := readBotHistoryCheckpoint(t.Context(), tx, r); err == nil {
		t.Fatal("stale source published")
	}
}

func TestBotHistoryCheckpointFirstEvictionCannotClaimCompleteHistory(t *testing.T) {
	old := checkpointFixture()
	old.EarlierHistoryUnavailable = false
	next, _ := sp.DecodeBotHistoryCheckpoint(encode(old))
	next.WindowRevision = "3"
	next.Entries = next.Entries[1:]
	next.RetainedFromSeq = &next.Entries[0].EntrySeq
	if err := validateBotHistoryCheckpointAdvance(old, next); err == nil {
		t.Fatal("first eviction lost its omission fact")
	}
	next.EarlierHistoryUnavailable = true
	if err := validateBotHistoryCheckpointAdvance(old, next); err != nil {
		t.Fatal(err)
	}
}

func TestBotHistoryCheckpointUsesProtocolBytesAcrossStorageEncoding(t *testing.T) {
	in := checkpointFixture()
	for i := 0; i < 400; i++ {
		in.Entries[0].ImageOccurrences = append(in.Entries[0].ImageOccurrences, sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: in.Entries[0].EntryID, Container: "content", SourceKey: strings.Repeat("<", 1024)})
	}
	wire, err := sp.MarshalWire(in)
	if err != nil {
		t.Fatal(err)
	}
	stored := encode(in)
	if len(wire) >= sp.MaxFrameBytes || len(stored) <= sp.MaxFrameBytes {
		t.Fatal("fixture did not distinguish encodings", len(wire), len(stored))
	}
	if _, err = decodeSavedBotHistoryCheckpoint(stored); err != nil {
		t.Fatal("storage escaping changed valid admission", err)
	}
	called := errors.New("controller scope reached")
	s := &Execution{Engine: NewEngine(nil)}
	s.controllerRun = func(context.Context, sp.ControllerFence, func(*Access) error) error { return called }
	if _, err = s.CommitBotHistoryCheckpoint(t.Context(), "credential", in); !errors.Is(err, called) {
		t.Fatal("valid wire checkpoint rejected before its authorized scope", err)
	}
}

func TestBotHistoryCheckpointUnreadableStateCannotBecomeEmptyHistory(t *testing.T) {
	for _, kind := range []string{"unsupported store", "not published", "read failure", "broken JSON", "invalid schema", "other connection", "other epoch"} {
		t.Run(kind, func(t *testing.T) {
			checkpoint := checkpointFixture()
			r := &record{SourceEpoch: &checkpoint.SourceEpoch, SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: checkpoint.ControllerFence, HistoryEpoch: checkpoint.HistoryEpoch}}
			cause := errors.New("checkpoint storage failed")
			ctx := t.Context()
			dao := &checkpointRuleDAO{read: func(actual context.Context, id string) ([]byte, error) {
				if actual != ctx || id != checkpoint.SessionID {
					t.Fatal("checkpoint read lost its scope")
				}
				switch kind {
				case "not published":
					return nil, model.ErrNotFound
				case "read failure":
					return nil, cause
				case "broken JSON":
					return []byte(`{"windowRevision":`), nil
				case "invalid schema":
					return []byte(`{"windowRevision":"2"}`), nil
				}
				return encode(checkpoint), nil
			}}
			tx := &operationTx{dao: dao}
			if kind == "unsupported store" {
				tx.dao = &struct{ store.SessionDAO }{}
			}
			if kind == "other connection" {
				r.Snapshot.ConnectionEpoch = "2"
			}
			if kind == "other epoch" {
				r.Snapshot.HistoryEpoch = uuid.NewString()
			}
			_, err := readBotHistoryCheckpoint(ctx, tx, r)
			if kind == "read failure" {
				if !errors.Is(err, cause) {
					t.Fatal("storage cause lost", err)
				}
				return
			}
			code := "history_unavailable"
			if kind == "unsupported store" {
				code = "component_unsupported"
			}
			if kind == "broken JSON" || kind == "invalid schema" {
				code = "source_corrupt"
			}
			botFault(t, err, code)
		})
	}
}

func TestBotHistoryCheckpointPublicationFailsBeforeReplacingOwnership(t *testing.T) {
	for _, kind := range []string{"invalid input", "unsupported store", "missing resource capability", "read failure", "corrupt prior checkpoint", "regressed revision", "missing resource"} {
		t.Run(kind, func(t *testing.T) {
			in := checkpointFixture()
			resource := uuid.NewString()
			in.Entries[0].ResourceIDs = []string{resource}
			token := "original-controller-token"
			hash := sha256.Sum256([]byte(token))
			bot := uuid.NewString()
			r := &record{BotID: &bot, GrantHash: hash[:], SourceEpoch: &in.SourceEpoch, SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: in.ControllerFence, HistoryEpoch: in.HistoryEpoch, Lifecycle: "active"}, Live: &liveSession{BotHistoryWindowVersion: 1}}
			cause := errors.New("checkpoint query failed")
			trace := []string{}
			dao := &checkpointRuleDAO{read: func(ctx context.Context, id string) ([]byte, error) {
				if ctx != t.Context() || id != in.SessionID {
					t.Fatal("read identity changed")
				}
				trace = append(trace, "read")
				switch kind {
				case "read failure":
					return nil, cause
				case "corrupt prior checkpoint":
					return []byte(`null`), nil
				case "regressed revision":
					previous := in
					previous.WindowRevision = "3"
					return encode(previous), nil
				}
				return nil, model.ErrNotFound
			}, resource: func(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
				if ctx != t.Context() || session != in.SessionID || id != resource {
					t.Fatal("resource identity changed")
				}
				trace = append(trace, "resource")
				return store.SessionResourceRecord{}, model.ErrNotFound
			}}
			s := &Execution{Engine: NewEngine(nil)}
			s.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				if ctx != t.Context() || fence != in.ControllerFence {
					t.Fatal("publication identity changed")
				}
				trace = append(trace, "scope")
				tx := &operationTx{dao: dao}
				if kind == "unsupported store" {
					tx.dao = &struct{ store.SessionDAO }{}
				}
				if kind == "missing resource capability" {
					tx.dao = &windowReadDAO{checkpoint: dao.read}
				}
				return work(&Access{tx: tx, record: r})
			}
			if kind == "invalid input" {
				in.Entries[0].SHA256 = "invalid"
			}
			out, err := s.CommitBotHistoryCheckpoint(t.Context(), token, in)
			if out.WindowRevision != "" {
				t.Fatal("failure published receipt", out)
			}
			want := []string{"scope", "read"}
			switch kind {
			case "invalid input":
				botFault(t, err, "invalid_input")
				want = []string{}
			case "unsupported store":
				botFault(t, err, "component_unsupported")
				want = []string{"scope"}
			case "missing resource capability":
				botFault(t, err, "component_unsupported")
			case "read failure":
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "corrupt prior checkpoint":
				botFault(t, err, "source_corrupt")
			case "regressed revision":
				botFault(t, err, "content_changed")
			case "missing resource":
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal(err)
				}
				want = append(want, "resource")
			}
			if !slices.Equal(trace, want) {
				t.Fatalf("publication continued beyond refusal: %v, want %v", trace, want)
			}
		})
	}
}

func TestBotHistoryReferenceReplacementFailureOrder(t *testing.T) {
	for _, kind := range []string{"read resource failure", "reclaiming resource", "unavailable resource", "pin failure", "reference query failure", "unpin failure", "queue failure", "already retained"} {
		t.Run(kind, func(t *testing.T) {
			in := checkpointFixture()
			resource, old := uuid.NewString(), uuid.NewString()
			in.Entries[0].ResourceIDs = []string{resource}
			retained := store.SessionResourceReference{SessionID: in.SessionID, ResourceID: resource, Kind: "bot_window", ReferenceID: in.Entries[0].EntryID}
			obsolete := store.SessionResourceReference{SessionID: in.SessionID, ResourceID: old, Kind: "bot_window", ReferenceID: uuid.NewString()}
			cause := errors.New("resource transaction failed")
			trace := []string{}
			dao := &checkpointRuleDAO{resource: func(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
				if ctx != t.Context() || session != in.SessionID || id != resource {
					t.Fatal("wrong original resource")
				}
				trace = append(trace, "resource")
				if kind == "read resource failure" {
					return store.SessionResourceRecord{}, cause
				}
				out := store.SessionResourceRecord{SessionID: session, Resource: sp.Resource{ResourceID: id, Status: "available"}, GCPending: kind == "reclaiming resource"}
				if kind == "unavailable resource" {
					out.Resource.Status = "unavailable"
				}
				return out, nil
			}, add: func(ctx context.Context, ref store.SessionResourceReference) error {
				if ctx != t.Context() || ref != retained {
					t.Fatal("wrong new pin")
				}
				trace = append(trace, "pin")
				if kind == "pin failure" {
					return cause
				}
				return nil
			}, refs: func(ctx context.Context, session, referenceKind string) ([]store.SessionResourceReference, error) {
				if ctx != t.Context() || session != in.SessionID {
					t.Fatal("reference scope changed")
				}
				trace = append(trace, referenceKind)
				if kind == "reference query failure" {
					return nil, cause
				}
				if referenceKind == "bot_window" {
					if kind == "already retained" {
						return []store.SessionResourceReference{retained}, nil
					}
					return []store.SessionResourceReference{obsolete}, nil
				}
				if referenceKind != "message" {
					t.Fatal("queried independent owners", referenceKind)
				}
				return nil, nil
			}, remove: func(ctx context.Context, ref store.SessionResourceReference) error {
				if ctx != t.Context() || ref != obsolete {
					t.Fatal("removed surviving or unrelated pin")
				}
				trace = append(trace, "unpin")
				if kind == "unpin failure" {
					return cause
				}
				return nil
			}, queue: func(ctx context.Context, session, id string) error {
				if ctx != t.Context() || session != in.SessionID || id != old {
					t.Fatal("queued wrong resource")
				}
				trace = append(trace, "queue")
				if kind == "queue failure" {
					return cause
				}
				return nil
			}}
			err := (&Execution{}).replaceBotWindowReferences(t.Context(), &operationTx{dao: dao}, &record{Live: &liveSession{}}, in)
			want := []string{"resource"}
			switch kind {
			case "reclaiming resource", "unavailable resource":
				botFault(t, err, "resource_conflict")
			case "read resource failure":
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "pin failure":
				want = append(want, "pin")
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "reference query failure":
				want = append(want, "pin", "bot_window")
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "unpin failure":
				want = append(want, "pin", "bot_window", "unpin")
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "queue failure":
				want = append(want, "pin", "bot_window", "unpin", "queue")
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "already retained":
				want = append(want, "pin", "bot_window", "message")
				if err != nil {
					t.Fatal(err)
				}
			}
			if !slices.Equal(trace, want) {
				t.Fatalf("wrong ownership operation order: %v want %v", trace, want)
			}
		})
	}
}

func TestBotHistoryMessagePinsRequireSettledCaptureAndCompleteClosure(t *testing.T) {
	for _, kind := range []string{"private upload", "capture read failure", "pending approval", "capture pending", "retained without resource", "retained with resource", "evicted occurrence"} {
		t.Run(kind, func(t *testing.T) {
			in := checkpointFixture()
			image, resource := uuid.NewString(), uuid.NewString()
			occurrence := sp.ImageOccurrence{ImageID: image, EntryID: in.Entries[0].EntryID, Container: "content", SourceKey: "original"}
			in.Entries[0].ImageOccurrences = []sp.ImageOccurrence{occurrence}
			if kind == "retained with resource" || kind == "pending approval" {
				in.Entries[0].ResourceIDs = []string{resource}
			}
			ref := store.SessionResourceReference{SessionID: in.SessionID, ResourceID: resource, Kind: "message", ReferenceID: image}
			r := &record{Live: &liveSession{PendingInteractions: map[string]sp.TimelineEntry{}}}
			if kind == "pending approval" {
				r.Live.PendingInteractions[occurrence.EntryID] = sp.TimelineEntry{EntryID: occurrence.EntryID, Kind: "interaction"}
			}
			cause := errors.New("capture read failed")
			pins, removed, queued := 0, 0, 0
			dao := &checkpointRuleDAO{resource: func(_ context.Context, s, id string) (store.SessionResourceRecord, error) {
				if s != in.SessionID || id != resource {
					t.Fatal("wrong resource")
				}
				return store.SessionResourceRecord{Resource: sp.Resource{ResourceID: id, Status: "available"}}, nil
			}, add: func(_ context.Context, v store.SessionResourceReference) error {
				pins++
				if v.SessionID != in.SessionID || v.ResourceID != resource || v.Kind != "bot_window" || v.ReferenceID != occurrence.EntryID {
					t.Fatal("wrong pin", v)
				}
				return nil
			}, refs: func(_ context.Context, s, kind string) ([]store.SessionResourceReference, error) {
				if s != in.SessionID {
					t.Fatal("wrong Session")
				}
				if kind == "message" {
					return []store.SessionResourceReference{ref}, nil
				}
				if kind != "bot_window" {
					t.Fatal("independent owner queried")
				}
				return nil, nil
			}, capture: func(_ context.Context, s, id string) (store.SessionCaptureRecord, error) {
				if s != in.SessionID || id != image {
					t.Fatal("wrong capture identity")
				}
				if kind == "private upload" {
					return store.SessionCaptureRecord{}, model.ErrNotFound
				}
				if kind == "capture read failure" {
					return store.SessionCaptureRecord{}, cause
				}
				out := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: occurrence}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}
				if kind == "capture pending" {
					out.Receipt.State = "receiving"
				}
				if kind == "evicted occurrence" {
					out.Request.Occurrence.SourceKey = "earlier revision"
				}
				return out, nil
			}, remove: func(_ context.Context, v store.SessionResourceReference) error {
				removed++
				if v != ref {
					t.Fatal("wrong retirement")
				}
				return nil
			}, queue: func(_ context.Context, s, id string) error {
				queued++
				if s != in.SessionID || id != resource {
					t.Fatal("wrong queue")
				}
				return nil
			}}
			err := (&Execution{}).replaceBotWindowReferences(t.Context(), &operationTx{dao: dao}, r, in)
			if kind == "capture read failure" {
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			} else if kind == "retained without resource" {
				botFault(t, err, "resource_conflict")
			} else if err != nil {
				t.Fatal(err)
			}
			wantRemoval, wantPins := 0, 0
			if kind == "retained with resource" {
				wantRemoval, wantPins = 1, 1
			}
			if kind == "pending approval" {
				wantPins = 1
			}
			if kind == "evicted occurrence" {
				wantRemoval = 1
			}
			if pins != wantPins || removed != wantRemoval || queued != wantRemoval {
				t.Fatalf("ownership changed unexpectedly: pins=%d removed=%d queued=%d", pins, removed, queued)
			}
		})
	}
}

func TestBotHistoryLateCaptureRetirementKeepsUncertainOrProtectedEvidence(t *testing.T) {
	for _, kind := range []string{"not bot", "old store", "no checkpoint", "read failure", "corrupt checkpoint", "pending approval", "pending after source reset", "other source", "missing source", "queue failure"} {
		t.Run(kind, func(t *testing.T) {
			checkpoint := checkpointFixture()
			bot, resource := uuid.NewString(), uuid.NewString()
			capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}}}
			r := &record{BotID: &bot, SourceEpoch: &checkpoint.SourceEpoch, Snapshot: sp.Snapshot{ControllerFence: checkpoint.ControllerFence}, Live: &liveSession{PendingInteractions: map[string]sp.TimelineEntry{}}}
			cause := errors.New("retirement storage failed")
			reads, queues := 0, 0
			dao := &checkpointRuleDAO{read: func(ctx context.Context, id string) ([]byte, error) {
				reads++
				if ctx != t.Context() || id != checkpoint.SessionID {
					t.Fatal("wrong checkpoint")
				}
				switch kind {
				case "no checkpoint":
					return nil, model.ErrNotFound
				case "read failure":
					return nil, cause
				case "corrupt checkpoint":
					return []byte(`{`), nil
				}
				return encode(checkpoint), nil
			}, queue: func(ctx context.Context, s, id string) error {
				queues++
				if ctx != t.Context() || s != checkpoint.SessionID || id != resource {
					t.Fatal("wrong retirement")
				}
				return cause
			}}
			tx := &operationTx{dao: dao}
			if kind == "not bot" {
				r.BotID = nil
			}
			if kind == "old store" {
				tx.dao = &struct{ store.SessionDAO }{}
			}
			if kind == "pending approval" || kind == "pending after source reset" {
				r.Live.PendingInteractions[capture.Request.Occurrence.EntryID] = sp.TimelineEntry{EntryID: capture.Request.Occurrence.EntryID, Kind: "interaction"}
			}
			if kind == "other source" || kind == "pending after source reset" {
				epoch := uuid.NewString()
				r.SourceEpoch = &epoch
			}
			if kind == "missing source" {
				r.SourceEpoch = nil
			}
			retired, err := retireEvictedBotCapture(t.Context(), tx, r, capture, resource)
			if kind == "read failure" || kind == "queue failure" {
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			} else if kind == "other source" || kind == "missing source" {
				botFault(t, err, "history_unavailable")
			} else if kind == "corrupt checkpoint" {
				botFault(t, err, "source_corrupt")
			} else if err != nil {
				t.Fatal(err)
			}
			if retired != (kind == "queue failure") || queues != map[bool]int{true: 1, false: 0}[kind == "queue failure"] {
				t.Fatal("retirement decision or ownership queue changed", retired, queues)
			}
			wantReads := 1
			if kind == "not bot" || kind == "old store" {
				wantReads = 0
			}
			if reads != wantReads {
				t.Fatal("unnecessary checkpoint read", reads)
			}
		})
	}
}
