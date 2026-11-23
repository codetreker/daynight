package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestCheckedContentSumRejectsInvalidOrOverflowingFacts(t *testing.T) {
	for _, tc := range []struct {
		a, b    int64
		want    int64
		invalid bool
	}{
		{-1, 0, 0, true}, {0, -1, 0, true}, {math.MaxInt64, 1, 0, true}, {math.MaxInt64 - 1, 1, math.MaxInt64, false}, {13, 17, 30, false},
	} {
		got, err := checkedContentSum(tc.a, tc.b)
		if (err != nil) != tc.invalid || got != tc.want {
			t.Fatalf("%d + %d = %d, %v", tc.a, tc.b, got, err)
		}
	}
	cause := fault("quota_exceeded", "Session content capacity is exhausted.")
	capacity := &contentCapacityError{cause: cause}
	if capacity.Error() != cause.Error() || !errors.Is(capacity, cause) {
		t.Fatalf("capacity diagnostic or cause lost: %v", capacity)
	}
}

func TestDefiniteArchiveValidationRequiresKnownRollback(t *testing.T) {
	cause := fault("quota_exceeded", "full")
	invalid := &archiveValidationError{cause: cause}
	other := errors.New("cleanup also failed")
	cases := []struct {
		name     string
		err      error
		definite bool
	}{
		{"nil", nil, false}, {"direct", invalid, true}, {"wrapped", fmt.Errorf("outer: %w", invalid), true},
		{"confirmed rollback", &store.TransactionError{Outcome: store.TransactionNotCommitted, Cause: invalid}, true},
		{"unknown commit", &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: invalid}, false},
		{"attempted commit", &store.TransactionError{Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: invalid}, false},
		{"failed cleanup", &store.TransactionError{Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: invalid}, false},
		{"single joined cause", errors.Join(invalid), true}, {"multiple joined causes", errors.Join(invalid, other), false}, {"unrelated error", other, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := definiteArchiveValidation(tc.err)
			if (got != nil) != tc.definite || got != nil && !errors.Is(got, cause) {
				t.Fatalf("classification = %v", got)
			}
		})
	}
}

func TestHistorySourceAdvanceRequiresVerifiedEpochAndRetainedEntries(t *testing.T) {
	entry := archiveLedgerEntry{ID: "entry", Sequence: "1", Revision: "1", SHA256: "hash", SourceSHA256: "source", ByteLength: 3}
	previous := archiveLedger{HistoryEpoch: "history", SourceEpoch: "source-old", SourceThrough: "9", Entries: []archiveLedgerEntry{entry}}
	candidate := archiveLedger{HistoryEpoch: "history", SourceEpoch: "source-new", SourceThrough: "1", Entries: []archiveLedgerEntry{entry}}
	if err := verifySourceHistoryAdvance(previous, candidate); err == nil {
		t.Fatal("unproved source epoch accepted")
	}
	previous.TargetSourceEpoch = "different"
	if err := verifySourceHistoryAdvance(previous, candidate); err == nil {
		t.Fatal("different target epoch accepted")
	}
	previous.TargetSourceEpoch = "source-new"
	if err := verifySourceHistoryAdvance(previous, candidate); err != nil {
		t.Fatal("proven source handoff rejected", err)
	}
	candidate.Entries = nil
	if err := verifySourceHistoryAdvance(previous, candidate); err == nil {
		t.Fatal("source handoff discarded accepted entry")
	}
}

type noArchiveCapability struct{ store.SessionDAO }

type historyAdmissionDAO struct {
	*archiveFlowDAO
	failure error
}

func (d *historyAdmissionDAO) SessionArchiveBundle(ctx context.Context, id string) (store.ArchiveBundle, error) {
	if d.failure != nil {
		return store.ArchiveBundle{}, d.failure
	}
	return d.archiveFlowDAO.SessionArchiveBundle(ctx, id)
}

func TestImageHistoryAdmissionReportsUnavailableAndIncompleteFacts(t *testing.T) {
	f := newImageRuleFixture(t, []byte("image"))
	ctx := t.Context()
	if err := requireImageHistoryLedger(ctx, &operationTx{dao: noArchiveCapability{}}, f.r, true); err == nil {
		t.Fatal("missing archive DAO accepted")
	}
	d := &historyAdmissionDAO{archiveFlowDAO: &archiveFlowDAO{}}
	var fault *model.Fault
	if err := requireImageHistoryLedger(ctx, &operationTx{dao: d}, f.r, true); !errors.As(err, &fault) || fault.Code != "component_unsupported" {
		t.Fatalf("missing checkpoint: %v", err)
	}
	cause := errors.New("checkpoint unavailable")
	d.failure = cause
	if err := requireImageHistoryLedger(ctx, &operationTx{dao: d}, f.r, true); !errors.Is(err, cause) {
		t.Fatalf("DAO error lost: %v", err)
	}
	d.failure = nil
	bundle := f.d.bundle
	d.bundle = &bundle
	if err := requireImageHistoryLedger(ctx, &operationTx{dao: d}, f.r, false); err != nil {
		t.Fatalf("current sealed checkpoint rejected: %v", err)
	}
	f.r.SourceSeq++
	if err := requireImageHistoryLedger(ctx, &operationTx{dao: d}, f.r, false); !errors.As(err, &fault) || fault.Code != "capability_changed" {
		t.Fatalf("stale checkpoint accepted: %v", err)
	}
}

func TestHistorySourceHandoffRetainsIdentityAndReportsDAOFailures(t *testing.T) {
	ctx := t.Context()
	r := &record{}
	r.Snapshot.SessionID = "session"
	if err := handoffHistorySource(ctx, &operationTx{dao: noArchiveCapability{}}, r, "old", "new"); err != nil {
		t.Fatalf("unsupported optional archive: %v", err)
	}
	missing := &archiveFlowDAO{}
	if err := handoffHistorySource(ctx, &operationTx{dao: missing}, r, "old", "new"); err != nil {
		t.Fatalf("no archive: %v", err)
	}
	for _, kind := range []string{"bundle", "files", "save-file", "save-bundle"} {
		t.Run(kind, func(t *testing.T) {
			base := &archiveFlowDAO{bundle: &store.ArchiveBundle{SessionID: "session", Phase: "active", Ledger: encode(archiveLedger{SourceEpoch: "old"})}, files: map[string]store.ArchiveBundleFile{"file": {SessionID: "session", FileID: "file", Purpose: "history", State: "receiving"}}}
			dao := &archiveFailureDAO{archiveFlowDAO: base, fail: kind, seen: map[string]int{}}
			if err := handoffHistorySource(ctx, &operationTx{dao: dao}, r, "old", "new"); !errors.Is(err, archiveDependencyFailure) || dao.seen[kind] != 1 {
				t.Fatalf("%s failure not propagated: %v calls=%v", kind, err, dao.seen)
			}
		})
	}
	for _, tc := range []struct {
		name, phase string
		ledger      []byte
		previous    string
		wantErr     bool
	}{
		{"inactive", "sealed", []byte(`{}`), "old", false},
		{"invalid ledger", "active", []byte(`[`), "old", true},
		{"wrong source", "active", encode(archiveLedger{SourceEpoch: "other"}), "old", true},
		{"wrong target", "active", encode(archiveLedger{SourceEpoch: "old", TargetSourceEpoch: "other"}), "old", true},
		{"repeat handoff", "active", encode(archiveLedger{SourceEpoch: "first", TargetSourceEpoch: "old"}), "old", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := &archiveFlowDAO{bundle: &store.ArchiveBundle{SessionID: "session", Phase: tc.phase, Ledger: tc.ledger}, files: map[string]store.ArchiveBundleFile{}}
			err := handoffHistorySource(ctx, &operationTx{dao: base}, r, tc.previous, "new")
			if (err != nil) != tc.wantErr {
				t.Fatalf("handoff result: %v", err)
			}
			if tc.name == "repeat handoff" {
				var ledger archiveLedger
				if json.Unmarshal(base.bundle.Ledger, &ledger) != nil || ledger.SourceEpoch != "first" || ledger.TargetSourceEpoch != "new" {
					t.Fatalf("handoff lost original source: %+v", ledger)
				}
			}
		})
	}
}

func TestCaptureAndRetryRequireCurrentSourceEpoch(t *testing.T) {
	for _, caller := range []string{"register", "retry"} {
		for _, state := range []string{"handoff pending", "wrong source", "current source", "legacy source"} {
			t.Run(caller+"/"+state, func(t *testing.T) {
				f := newImageRuleFixture(t, []byte("original"))
				capture := registerOccurrenceFixture(t, f)
				current := uuid.NewString()
				f.r.SourceEpoch = &current
				var ledger archiveLedger
				if err := json.Unmarshal(f.d.bundle.Ledger, &ledger); err != nil {
					t.Fatal(err)
				}
				ledger.Sealable = false // A complete checkpoint can still settle occurrences.
				switch state {
				case "handoff pending":
					ledger.SourceEpoch, ledger.TargetSourceEpoch = uuid.NewString(), current
				case "wrong source":
					ledger.SourceEpoch = uuid.NewString()
				case "current source":
					ledger.SourceEpoch = current
				case "legacy source":
					ledger.SourceEpoch = ""
				}
				allowed := state == "current source" || state == "legacy source"
				if caller == "register" {
					request := capture.Request
					request.CaptureID, request.AttemptID, request.Occurrence.ImageID = uuid.NewString(), uuid.NewString(), uuid.NewString()
					ledger.Occurrences = []archiveLedgerOccurrence{{EntryID: request.Occurrence.EntryID, ImageID: request.Occurrence.ImageID, Container: request.Occurrence.Container}}
					f.d.bundle.Ledger = encode(ledger)
					_, err := f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: encode(request)})
					if allowed && err != nil {
						t.Fatalf("current or legacy checkpoint refused: %v", err)
					}
					if !allowed {
						var refusal *CaptureRequestError
						if !errors.As(err, &refusal) || refusal.Code != "capability_changed" || f.d.captures[request.CaptureID].Receipt.State != "failed" {
							t.Fatalf("stale checkpoint registered capture: %v", err)
						}
					}
				} else {
					capture = failOccurrenceFixture(f, capture, "invalid_image")
					f.d.bundle.Ledger = encode(ledger)
					before := capture.Receipt.AttemptID
					ctx, cancel := context.WithCancel(t.Context())
					defer cancel()
					if allowed {
						browser := f.s.browserRun
						calls := 0
						f.s.browserRun = func(ctx context.Context, p model.Principal, project, task, id string, purpose BrowserPurpose, work func(*Access) error) error {
							calls++
							err := browser(ctx, p, project, task, id, purpose, work)
							if calls == 1 && err == nil {
								cancel()
							}
							return err
						}
					}
					out, err := f.s.RetryImageOccurrence(ctx, f.p, "", "", f.r.Snapshot.SessionID, capture.Request.Occurrence.ImageID)
					if allowed && (!errors.Is(err, context.Canceled) || out.Capture.AttemptID == before || out.Capture.State != "reserved") {
						t.Fatalf("current or legacy retry refused: %+v %v", out, err)
					}
					if !allowed {
						var refusal *model.Fault
						if !errors.As(err, &refusal) || refusal.Code != "capability_changed" || f.d.captures[capture.Request.CaptureID].Receipt.AttemptID != before {
							t.Fatalf("stale checkpoint retried capture: %v", err)
						}
					}
				}
			})
		}
	}
}
