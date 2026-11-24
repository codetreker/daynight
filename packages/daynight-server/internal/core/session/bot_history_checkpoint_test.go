package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
	return sp.BotHistoryCheckpoint{BotHistoryWindowBoundary: sp.BotHistoryWindowBoundary{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, BotHistoryWindowVersion: 1, HistoryEpoch: uuid.NewString(), WindowRevision: "2", RetainedFromSeq: &low, ThroughSeq: &through, EarlierHistoryUnavailable: true}, SourceThrough: "4", Entries: []sp.BotHistoryCheckpointEntry{{EntryID: uuid.NewString(), EntrySeq: "2", Revision: "1", SHA256: hashBytes([]byte("first")), ResourceIDs: []string{}, ImageOccurrences: []sp.ImageOccurrence{}}, {EntryID: uuid.NewString(), EntrySeq: "3", Revision: "1", SHA256: hashBytes([]byte("last")), ResourceIDs: []string{}, ImageOccurrences: []sp.ImageOccurrence{}}}}
}

func TestBotHistoryCheckpointAdvance(t *testing.T) {
	for _, kind := range []string{"repeat", "fence", "advance", "epoch", "backwards revision", "changed same revision", "backwards low", "backwards through", "forgot eviction", "entry sequence", "late revision", "same revision hash", "resurrect", "empty then resurrect"} {
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
	read func(context.Context, string) ([]byte, error)
	save func(context.Context, string, []byte) error
	refs func(context.Context, string, string) ([]store.SessionResourceReference, error)
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

func TestBotHistoryCheckpointCommitPreservesUnknownOutcomeAndAuthority(t *testing.T) {
	for _, kind := range []string{"success", "duplicate", "unknown", "revoked", "wrong token", "not bot", "old source", "old epoch", "unsupported", "save failure"} {
		t.Run(kind, func(t *testing.T) {
			in := checkpointFixture()
			in.Entries = []sp.BotHistoryCheckpointEntry{}
			in.RetainedFromSeq = nil
			token := "controller-secret"
			hash := sha256.Sum256([]byte(token))
			bot := uuid.NewString()
			r := &record{BotID: &bot, GrantHash: hash[:], SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: in.ControllerFence, HistoryEpoch: in.HistoryEpoch, Lifecycle: "active"}, Live: &liveSession{BotHistoryWindowVersion: 1}}
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
	r := &record{BotID: &bot, SourceSeq: 4, Snapshot: sp.Snapshot{ControllerFence: in.ControllerFence, HistoryEpoch: in.HistoryEpoch}}
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
