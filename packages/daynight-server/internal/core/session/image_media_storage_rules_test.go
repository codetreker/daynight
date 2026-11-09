package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mediaStorageRuleDAO struct {
	store.SessionDAO
	store.SessionMediaDAO
	row          store.SessionMediaRequest
	found        bool
	autoComplete bool
	saved        []store.SessionMediaRequest
}

func (d *mediaStorageRuleDAO) SessionMediaRequest(context.Context, string, string) (store.SessionMediaRequest, error) {
	if !d.found {
		return store.SessionMediaRequest{}, model.ErrNotFound
	}
	return d.row, nil
}
func (d *mediaStorageRuleDAO) PendingSessionMediaRequests(context.Context, string) ([]store.SessionMediaRequest, error) {
	return []store.SessionMediaRequest{d.row}, nil
}
func (d *mediaStorageRuleDAO) SaveSessionMediaRequest(_ context.Context, row store.SessionMediaRequest) error {
	d.saved = append(d.saved, row)
	d.row, d.found = row, true
	if d.autoComplete {
		d.row.Complete, d.row.Result = true, []byte(`{"original":"result"}`)
	}
	return nil
}

func mediaStorageRuleRecord() *record {
	now := time.Now()
	expiry := now.Add(time.Hour)
	return &record{Live: &liveSession{Synced: true}, LastSeen: &now, ConnectionExpiry: &expiry, Snapshot: sp.Snapshot{ContentRevision: 2, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "2"}, Lifecycle: "active", Synchronized: true, ConnectionState: "connected"}}
}

func TestMediaRequestCreationUsesExactCompactJSONBudget(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		bad  bool
	}{
		{"below", (1 << 20) - 1, false},
		{"exact", 1 << 20, false},
		{"over", (1 << 20) + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := mediaStorageRuleRecord()
			d := &mediaStorageRuleDAO{autoComplete: true}
			body := map[string]string{"original": strings.Repeat("x", tc.size-len(`{"original":""}`))}
			if len(encode(body)) != tc.size {
				t.Fatal("test did not use the exact production JSON encoding")
			}
			s := &Execution{Engine: NewEngine(nil)}
			access := func(ctx context.Context, fn func(*operationTx, *record) error) error {
				return fn(&operationTx{dao: d}, r)
			}
			out, err := s.controllerMediaWithAccess(t.Context(), r.Snapshot.SessionID, uuid.NewString(), "status", body, access)
			if tc.bad {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "quota_exceeded" || len(d.saved) != 0 {
					t.Fatal("oversized media body reached storage", err, len(d.saved))
				}
			} else if err != nil || len(d.saved) != 1 || !bytes.Equal(d.saved[0].Body, encode(body)) || string(out) != `{"original":"result"}` {
				t.Fatal("valid exact-budget media body was not retained", err, len(d.saved))
			}
		})
	}
}

func TestMediaRequestRebindingValidatesPendingStateBeforeDAO(t *testing.T) {
	for _, path := range []string{"observer", "offers"} {
		for _, tc := range []struct {
			name   string
			result []byte
			error  *sp.ImageError
		}{
			{"result", []byte(`{"original":"result"}`), nil},
			{"error", nil, &sp.ImageError{Code: "source_unavailable", Message: "Original unavailable."}},
			{"both", []byte(`{"original":"result"}`), &sp.ImageError{Code: "source_unavailable", Message: "Original unavailable."}},
		} {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				r := mediaStorageRuleRecord()
				d := &mediaStorageRuleDAO{found: true, autoComplete: true, row: store.SessionMediaRequest{SessionID: r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "status", Fence: r.Snapshot.ControllerFence, Body: []byte(`{}`), Result: tc.result, Error: tc.error}}
				d.row.Fence.ConnectionEpoch = "1"
				s := &Execution{Engine: NewEngine(nil)}
				var err error
				if path == "offers" {
					_, err = s.mediaOffers(t.Context(), &operationTx{dao: d}, r)
				} else {
					access := func(ctx context.Context, fn func(*operationTx, *record) error) error {
						return fn(&operationTx{dao: d}, r)
					}
					_, err = s.controllerMediaWithAccess(t.Context(), r.Snapshot.SessionID, d.row.RequestID, "status", map[string]any{}, access)
				}
				if err == nil || len(d.saved) != 0 {
					t.Fatal("invalid pending state reached storage", err, len(d.saved))
				}
			})
		}
	}
}

func TestMediaResponseRequiresOneTerminalOutcomeBeforeDAO(t *testing.T) {
	for _, result := range [][]byte{nil, {}, []byte(`null`), []byte(`{broken`)} {
		t.Run(string(result), func(t *testing.T) {
			r := mediaStorageRuleRecord()
			d := &mediaStorageRuleDAO{found: true, row: store.SessionMediaRequest{SessionID: r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "status", Fence: r.Snapshot.ControllerFence, Body: []byte(`{}`)}}
			s := &Execution{Engine: NewEngine(nil)}
			_, err := s.acceptMediaResponse(t.Context(), &operationTx{dao: d}, r, sp.ControllerMessage{ControllerFence: d.row.Fence, RequestID: d.row.RequestID, Action: d.row.Action, MediaResult: json.RawMessage(result)})
			if err == nil || len(d.saved) != 0 {
				t.Fatal("missing or malformed terminal result reached storage", err, len(d.saved))
			}
		})
	}
}

func TestMediaReofferPreservesExactBudgetAfterJSONBWhitespaceExpansion(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		bad  bool
	}{
		{"exact", 1 << 20, false},
		{"over", (1 << 20) + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := mediaStorageRuleRecord()
			compact := encode(map[string]string{"original": strings.Repeat("x", tc.size-len(`{"original":""}`))})
			// PostgreSQL JSONB inserts a space after the object colon on readback.
			stored := bytes.Replace(compact, []byte(`":"`), []byte(`": "`), 1)
			if len(compact) != tc.size || len(stored) != tc.size+1 || !json.Valid(stored) {
				t.Fatal("test did not reproduce JSONB whitespace expansion")
			}
			d := &mediaStorageRuleDAO{found: true, row: store.SessionMediaRequest{SessionID: r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "status", Fence: r.Snapshot.ControllerFence, Body: stored}}
			d.row.Fence.ConnectionEpoch = "1"
			s := &Execution{Engine: NewEngine(nil)}
			offers, err := s.mediaOffers(t.Context(), &operationTx{dao: d}, r)
			if tc.bad {
				if err == nil || len(d.saved) != 0 {
					t.Fatal("oversized readback body reached storage", err, len(d.saved))
				}
			} else if err != nil || len(d.saved) != 1 || len(offers) != 1 || !bytes.Equal(d.saved[0].Body, compact) {
				t.Fatal("JSONB formatting shrank original request allowance", err, len(d.saved), len(offers))
			}
		})
	}
}

func TestMediaStorageRulesRejectInvalidJSONAndOutcomeCombinations(t *testing.T) {
	remote := &sp.ImageError{Code: "source_unavailable", Message: "Original unavailable."}
	for _, tc := range []struct {
		name     string
		body     []byte
		complete bool
		result   []byte
		error    *sp.ImageError
		bad      bool
	}{
		{name: "pending", body: []byte(`{}`)},
		{name: "success", body: []byte(`{}`), complete: true, result: []byte(`{"original":"result"}`)},
		{name: "remote error", body: []byte(`{}`), complete: true, error: remote},
		{name: "terminal both", body: []byte(`{}`), complete: true, result: []byte(`{}`), error: remote, bad: true},
		{name: "terminal neither", body: []byte(`{}`), complete: true, bad: true},
		{name: "pending result", body: []byte(`{}`), result: []byte(`{}`), bad: true},
		{name: "pending error", body: []byte(`{}`), error: remote, bad: true},
		{name: "missing body", bad: true},
		{name: "malformed body", body: []byte(`{broken`), bad: true},
		{name: "multiple JSON values", body: []byte(`{} {}`), bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &mediaStorageRuleDAO{}
			r := mediaStorageRuleRecord()
			row := store.SessionMediaRequest{SessionID: r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "status", Fence: r.Snapshot.ControllerFence, Body: tc.body, Complete: tc.complete, Result: tc.result, Error: tc.error}
			err := saveMediaRequest(t.Context(), d, row)
			if tc.bad {
				if err == nil || len(d.saved) != 0 {
					t.Fatal("invalid media state reached storage", err, len(d.saved))
				}
			} else if err != nil || len(d.saved) != 1 || !bytes.Equal(d.saved[0].Result, tc.result) || d.saved[0].Error != tc.error || d.saved[0].Complete != tc.complete {
				t.Fatal("valid media outcome changed before storage", err, d.saved)
			}
		})
	}
}
