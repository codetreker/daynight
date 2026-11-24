package session

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func windowReadFixture(t *testing.T) (sp.BotHistoryCheckpoint, []sp.BotHistoryWindowEntry) {
	t.Helper()
	low, high := "10", "30"
	boundary := sp.BotHistoryWindowBoundary{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "2"}, ConnectionEpoch: "3"}, BotHistoryWindowVersion: 1, HistoryEpoch: uuid.NewString(), WindowRevision: "5", RetainedFromSeq: &low, ThroughSeq: &high, EarlierHistoryUnavailable: true}
	cp := sp.BotHistoryCheckpoint{BotHistoryWindowBoundary: boundary, SourceEpoch: uuid.NewString(), SourceThrough: "7", Entries: []sp.BotHistoryCheckpointEntry{}}
	entries := []sp.BotHistoryWindowEntry{}
	for _, sequence := range []string{"10", "20", "30"} {
		size := "4"
		entry := sp.BotHistoryWindowEntry{EntryID: uuid.NewString(), EntrySeq: sequence, Revision: "2", Kind: "assistant_message", Preview: "text", OriginalBytes: &size, PreviewBytes: size, ResourceIDs: []string{}}
		digest, err := sp.BotHistoryWindowEntryDigest(entry)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
		cp.Entries = append(cp.Entries, sp.BotHistoryCheckpointEntry{EntryID: entry.EntryID, EntrySeq: sequence, Revision: "2", SHA256: digest, ResourceIDs: []string{}, ImageOccurrences: []sp.ImageOccurrence{}})
	}
	return cp, entries
}

func windowReadPage(cp sp.BotHistoryCheckpoint, entries ...sp.BotHistoryWindowEntry) sp.BotHistoryWindowPage {
	return sp.BotHistoryWindowPage{BotHistoryWindowBoundary: cp.BotHistoryWindowBoundary, Kind: "bot_history_window", Items: append([]sp.BotHistoryWindowEntry{}, entries...)}
}

func TestBotWindowCapabilityKeepsCompleteReadersSeparate(t *testing.T) {
	bot := uuid.NewString()
	r := &record{BotID: &bot, Live: &liveSession{BotHistoryWindowVersion: 1}}
	for _, kind := range []string{"timeline", "inspect_page", "entry_chunk"} {
		botFault(t, botWindowContentCapability(r, kind), "upgrade_required")
	}
	for _, kind := range []string{"resource", "bot_history_window"} {
		if err := botWindowContentCapability(r, kind); err != nil {
			t.Fatal(err)
		}
	}
	r.Live.BotHistoryWindowVersion = 0
	botFault(t, botWindowContentCapability(r, "bot_history_window"), "upgrade_required")
	if err := botWindowContentCapability(r, "timeline"); err != nil {
		t.Fatal(err)
	}
	r.Live.BotHistoryWindowVersion, r.BotID = 1, nil
	botFault(t, botWindowContentCapability(r, "bot_history_window"), "upgrade_required")
	if cloneLive(&liveSession{BotHistoryWindowVersion: 1}).BotHistoryWindowVersion != 1 {
		t.Fatal("negotiated capability was lost")
	}
}

func TestBotWindowInvalidRequestsDoNotEnterAuthorization(t *testing.T) {
	s := &Execution{}
	for _, in := range []BotHistoryWindowRequest{
		{Mode: "unknown"}, {Mode: "tail", Cursor: "unexpected"}, {Mode: "before"}, {Mode: "changes"},
		{Limit: -1}, {Limit: 201}, {ResponseOverhead: -1}, {ResponseOverhead: sp.MaxHistoryResponseBytes},
		{Mode: "before", Cursor: strings.Repeat("a", sp.MaxHistoryCursorBytes+1)},
	} {
		_, err := s.ReadBotHistoryWindow(t.Context(), model.Principal{}, "", "", "", in)
		botFault(t, err, "invalid_input")
	}
}

func TestBotWindowNegotiationRejectsLegacyContentBeforeDispatch(t *testing.T) {
	now := time.Now()
	expiry := now.Add(time.Hour)
	bot := uuid.NewString()
	r := &record{BotID: &bot, Live: &liveSession{Synced: true, BotHistoryWindowVersion: 1}, LastSeen: &now, ConnectionExpiry: &expiry, Snapshot: sp.Snapshot{Lifecycle: "active", Synchronized: true, ConnectionState: "connected"}}
	s := &Execution{Engine: NewEngine(nil)}
	s.browserRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, work func(*Access) error) error {
		return work(&Access{record: r})
	}
	_, err := s.Timeline(t.Context(), model.Principal{}, "", "", "", "tail", "", 50)
	botFault(t, err, "upgrade_required")
	for _, kind := range []string{"inspect_page", "entry_chunk"} {
		_, err := s.localContent(t.Context(), model.Principal{}, "", "", "", map[string]any{"kind": kind})
		botFault(t, err, "upgrade_required")
	}
	if len(s.content.pending) != 0 {
		t.Fatal("legacy request was dispatched to a window producer")
	}
}

func TestBotWindowHandshakeRejectsNonBotsAndUnknownVersions(t *testing.T) {
	s := &Execution{}
	_, err := s.ConnectWithOnlineMode(t.Context(), "", sp.ControllerMessage{BotHistoryWindowVersion: 2}, "", 0, false, false)
	botFault(t, err, "unsupported_protocol")
	s.grantRun = func(_ context.Context, _ []byte, work func(*Access) error) error {
		return work(&Access{record: &record{}})
	}
	_, err = s.ConnectWithOnlineMode(t.Context(), "", sp.ControllerMessage{BotHistoryWindowVersion: 1}, "", 0, false, false)
	botFault(t, err, "unsupported_protocol")
}

func TestBotWindowCursorFencesAndEviction(t *testing.T) {
	cp, _ := windowReadFixture(t)
	for _, mode := range []string{"before", "changes"} {
		sequence := "20"
		if mode == "changes" {
			sequence = "0"
		}
		token := botWindowCursor(cp.BotHistoryWindowBoundary, mode, sequence)
		p, err := parseBotWindowCursor(token, cp.BotHistoryWindowBoundary, mode)
		if err != nil || p.Sequence != sequence || p.Boundary.WindowRevision != "5" {
			t.Fatalf("cursor %v %v", p, err)
		}
		for _, changed := range []func(*sp.BotHistoryWindowBoundary){
			func(b *sp.BotHistoryWindowBoundary) { b.SessionID = uuid.NewString() },
			func(b *sp.BotHistoryWindowBoundary) { b.TestExecutionID = uuid.NewString() },
			func(b *sp.BotHistoryWindowBoundary) { b.ExecutionGeneration = "3" },
			func(b *sp.BotHistoryWindowBoundary) { b.ConnectionEpoch = "4" },
			func(b *sp.BotHistoryWindowBoundary) { b.HistoryEpoch = uuid.NewString() },
			func(b *sp.BotHistoryWindowBoundary) { b.WindowRevision = "4" },
			func(b *sp.BotHistoryWindowBoundary) { low := "31"; b.RetainedFromSeq = &low; b.WindowRevision = "6" },
		} {
			boundary := cp.BotHistoryWindowBoundary
			changed(&boundary)
			_, err := parseBotWindowCursor(token, boundary, mode)
			var reset *BotHistoryWindowResetError
			if !errors.As(err, &reset) || !jsonEqual(encode(reset.Boundary), encode(boundary)) {
				t.Fatalf("missing current reset boundary: %v", err)
			}
		}
	}
	for _, token := range []string{"bad", strings.Repeat("a", sp.MaxHistoryCursorBytes+1), botWindowCursor(cp.BotHistoryWindowBoundary, "before", "01"), botWindowCursor(cp.BotHistoryWindowBoundary, "before", "0")} {
		_, err := parseBotWindowCursor(token, cp.BotHistoryWindowBoundary, "before")
		botFault(t, err, "reset_required")
	}
	advanced := cp.BotHistoryWindowBoundary
	advanced.WindowRevision = "6"
	if _, err := parseBotWindowCursor(botWindowCursor(cp.BotHistoryWindowBoundary, "before", "20"), advanced, "before"); err != nil {
		t.Fatal("covered paging reset", err)
	}
	_, err := parseBotWindowCursor(botWindowCursor(cp.BotHistoryWindowBoundary, "changes", "20"), advanced, "changes")
	botFault(t, err, "reset_required")
}

func TestBotWindowRevisionScanIncludesExistingIDsAndPagination(t *testing.T) {
	cp, entries := windowReadFixture(t)
	old := cp.BotHistoryWindowBoundary
	old.WindowRevision = "4"
	position, err := parseBotWindowCursor(botWindowCursor(old, "changes", "0"), cp.BotHistoryWindowBoundary, "changes")
	if err != nil {
		t.Fatal(err)
	}
	in := BotHistoryWindowRequest{Mode: "changes", Limit: 2}
	page := windowReadPage(cp, entries[:2]...)
	if err := validateBotHistoryWindowPage(cp, page, in, position); err != nil {
		t.Fatal(err)
	}
	setBotWindowCursors(&page, cp, in, position)
	position, err = parseBotWindowCursor(*page.NextCursor, cp.BotHistoryWindowBoundary, "changes")
	if err != nil || position.Sequence != "20" {
		t.Fatalf("scan continuation %v %v", position, err)
	}
	page = windowReadPage(cp, entries[2:]...)
	if err := validateBotHistoryWindowPage(cp, page, in, position); err != nil {
		t.Fatal(err)
	}
	setBotWindowCursors(&page, cp, in, position)
	position, err = parseBotWindowCursor(*page.NextCursor, cp.BotHistoryWindowBoundary, "changes")
	if err != nil || position.Sequence != "0" {
		t.Fatal("completed scan did not settle", err)
	}
	if err := validateBotHistoryWindowPage(cp, windowReadPage(cp), in, position); err != nil {
		t.Fatal("unchanged window fabricated updates", err)
	}
	botFault(t, validateBotHistoryWindowPage(cp, page, in, position), "content_unavailable")
}

func TestBotWindowPageRejectsMissingRevisedAndEvictedEntries(t *testing.T) {
	cp, entries := windowReadFixture(t)
	in := BotHistoryWindowRequest{Mode: "tail", Limit: 2}
	page := windowReadPage(cp, entries[1:]...)
	if err := validateBotHistoryWindowPage(cp, page, in, botWindowPosition{}); err != nil {
		t.Fatal(err)
	}
	setBotWindowCursors(&page, cp, in, botWindowPosition{})
	if !page.HasEarlierHistory || page.BeforeCursor == nil || page.NextCursor == nil {
		t.Fatal("lost retained/evicted distinctions")
	}
	botFault(t, validateBotHistoryWindowPage(cp, windowReadPage(cp), in, botWindowPosition{}), "content_unavailable")
	botFault(t, validateBotHistoryWindowPage(cp, windowReadPage(cp, entries[0]), in, botWindowPosition{}), "content_changed")
	changed := entries[2]
	changed.Revision = "1"
	botFault(t, validateBotHistoryWindowPage(cp, windowReadPage(cp, changed), in, botWindowPosition{}), "content_changed")
	changed = entries[2]
	changed.Preview = "evil"
	botFault(t, validateBotHistoryWindowPage(cp, windowReadPage(cp, changed), in, botWindowPosition{}), "content_changed")
	page = windowReadPage(cp, entries[2])
	page.WindowRevision = "4"
	botFault(t, validateBotHistoryWindowPage(cp, page, in, botWindowPosition{}), "reset_required")
	cp.Entries, cp.RetainedFromSeq = []sp.BotHistoryCheckpointEntry{}, nil
	page = windowReadPage(cp)
	if err := validateBotHistoryWindowPage(cp, page, in, botWindowPosition{}); err != nil {
		t.Fatal(err)
	}
	setBotWindowCursors(&page, cp, in, botWindowPosition{})
	if !page.EarlierHistoryUnavailable || page.ThroughSeq == nil || page.HasEarlierHistory {
		t.Fatal("eviction became complete empty history")
	}
}

func TestBotWindowPageBudgetUsesActualWireEncoding(t *testing.T) {
	cp, entries := windowReadFixture(t)
	for i := 1; i < len(entries); i++ {
		entries[i].Preview = strings.Repeat("<", sp.MaxBotHistoryWindowPreviewBytes)
		entries[i].PreviewBytes = decimal(int64(len(entries[i].Preview)))
		size := entries[i].PreviewBytes
		entries[i].OriginalBytes = &size
		digest, err := sp.BotHistoryWindowEntryDigest(entries[i])
		if err != nil {
			t.Fatal(err)
		}
		cp.Entries[i].SHA256 = digest
	}
	page := windowReadPage(cp, entries[1:]...)
	wire, err := sp.MarshalWire(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) >= sp.MaxHistoryResponseBytes || len(encode(page)) <= sp.MaxHistoryResponseBytes {
		t.Fatal("fixture did not distinguish wire from HTML escaping")
	}
	if err := validateBotHistoryWindowPage(cp, page, BotHistoryWindowRequest{Mode: "tail", Limit: 2}, botWindowPosition{}); err != nil {
		t.Fatal("valid wire page was rejected", err)
	}
}

func TestBotWindowBeforePagePreservesCoveredRangeAfterAdvance(t *testing.T) {
	cp, entries := windowReadFixture(t)
	previous := cp.BotHistoryWindowBoundary
	previous.WindowRevision = "4"
	position, err := parseBotWindowCursor(botWindowCursor(previous, "before", "30"), cp.BotHistoryWindowBoundary, "before")
	if err != nil {
		t.Fatal("covered continuation was reset", err)
	}
	in := BotHistoryWindowRequest{Mode: "before", Limit: 1}
	page := windowReadPage(cp, entries[1])
	if err := validateBotHistoryWindowPage(cp, page, in, position); err != nil {
		t.Fatal("wrong covered page", err)
	}
	setBotWindowCursors(&page, cp, in, position)
	if !page.HasEarlierHistory || page.BeforeCursor == nil {
		t.Fatal("omitted retained older page")
	}
	position, err = parseBotWindowCursor(*page.BeforeCursor, cp.BotHistoryWindowBoundary, "before")
	if err != nil {
		t.Fatal(err)
	}
	page = windowReadPage(cp, entries[0])
	if err := validateBotHistoryWindowPage(cp, page, in, position); err != nil {
		t.Fatal(err)
	}
	setBotWindowCursors(&page, cp, in, position)
	if page.HasEarlierHistory || page.BeforeCursor != nil || !page.EarlierHistoryUnavailable {
		t.Fatal("retained beginning lost the separate eviction boundary")
	}
	botFault(t, validateBotHistoryWindowPage(cp, windowReadPage(cp, entries[2]), in, position), "content_changed")
}

type windowReadDAO struct {
	store.SessionDAO
	store.BotHistoryWindowDAO
	checkpoint func(context.Context, string) ([]byte, error)
}

type windowConnectDAO struct {
	*windowReadDAO
	connect func(string, string, time.Time, *time.Time) error
	save    func(store.SessionRecord) error
}

func (d *windowConnectDAO) ConnectSession(_ context.Context, id, instance string, now time.Time, expiry *time.Time) error {
	return d.connect(id, instance, now, expiry)
}
func (d *windowConnectDAO) SaveSession(_ context.Context, record store.SessionRecord) error {
	return d.save(record)
}

func TestBotWindowHandshakeUsesBoundModeInsteadOfRelaySupportHeader(t *testing.T) {
	for _, scenario := range []struct {
		name, mode, expected string
		opted                bool
	}{
		{"legacy with relay support", "legacy", "legacy", true},
		{"legacy without relay support", "legacy", "legacy", false},
		{"first local connection", "", "legacy", false},
		{"bound relay", "relay", "relay", true},
		{"first relay connection", "", "relay", true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cp, _ := windowReadFixture(t)
			bot, policy := uuid.NewString(), "legacy"
			s := &Execution{Engine: NewEngine(nil)}
			expiry := time.Now().Add(time.Hour)
			r := &record{BotID: &bot, OnlineMode: scenario.mode, HistoryContentPolicy: &policy, GrantExpiry: &expiry, Snapshot: sp.Snapshot{ControllerFence: cp.ControllerFence, HistoryEpoch: cp.HistoryEpoch, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, SessionRevision: "1", LastEventSeq: "0", LastTimelineSeq: "0", Lifecycle: "active", Identity: sp.Identity{ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex"}}}
			connected, saved := 0, 0
			dao := &windowConnectDAO{windowReadDAO: &windowReadDAO{checkpoint: func(_ context.Context, id string) ([]byte, error) {
				if id != cp.SessionID {
					t.Fatal("checkpoint changed Session")
				}
				return nil, model.ErrNotFound
			}}, connect: func(id, instance string, now time.Time, expiry *time.Time) error {
				connected++
				if id != cp.SessionID || instance != s.instance || expiry == nil || !expiry.Equal(*r.GrantExpiry) {
					t.Fatal("connection binding changed")
				}
				return nil
			}, save: func(value store.SessionRecord) error {
				saved++
				if value.Snapshot.SessionID != cp.SessionID || value.OnlineMode != scenario.expected {
					t.Fatal("window changed the bound online mode")
				}
				return nil
			}}
			s.grantRun = func(_ context.Context, _ []byte, work func(*Access) error) error {
				op, err := s.BeginOperation()
				if err != nil {
					return err
				}
				defer op.Close()
				err = work(&Access{tx: &operationTx{dao: dao, op: op}, record: r})
				if err == nil {
					op.Finish(store.TransactionCommitted)
				}
				return err
			}
			hello := sp.ControllerMessage{ControllerFence: cp.ControllerFence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: "codex", SchemaVersion: 1, ProjectionVersion: 1, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", BotHistoryWindowVersion: 1}
			out, err := s.ConnectWithOnlineMode(t.Context(), "grant", hello, uuid.NewString(), 1, scenario.opted, false)
			if err != nil || out.OnlineMode != scenario.expected || out.BotHistoryWindowVersion != 1 || connected != 1 || saved != 1 {
				t.Fatalf("connection result %+v %v writes %d/%d", out, err, connected, saved)
			}
			if s.live[cp.SessionID].value.BotHistoryWindowVersion != 1 {
				t.Fatal("negotiated capability missing from live connection")
			}
		})
	}
}

func (d *windowReadDAO) BotHistoryCheckpoint(ctx context.Context, id string) ([]byte, error) {
	return d.checkpoint(ctx, id)
}

func TestBotWindowReaderRechecksCommittedWindowAndAuthority(t *testing.T) {
	for _, scenario := range []string{"success", "revoked", "checkpoint advanced", "identity changed", "source changed", "controller reset", "wrong body", "budget"} {
		t.Run(scenario, func(t *testing.T) {
			cp, entries := windowReadFixture(t)
			page := windowReadPage(cp, entries[1:]...)
			now := time.Now()
			expiry := now.Add(time.Hour)
			bot := uuid.NewString()
			r := &record{BotID: &bot, SourceEpoch: &cp.SourceEpoch, SourceSeq: 7, Snapshot: sp.Snapshot{ControllerFence: cp.ControllerFence, HistoryEpoch: cp.HistoryEpoch, ConnectionState: "connected", Lifecycle: "active", Synchronized: true}, Live: &liveSession{Synced: true, BotHistoryWindowVersion: 1}, LastSeen: &now, ConnectionExpiry: &expiry}
			s := &Execution{Engine: NewEngine(nil)}
			principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			reads, checkpoints := 0, 0
			dao := &windowReadDAO{checkpoint: func(_ context.Context, id string) ([]byte, error) {
				if id != cp.SessionID {
					t.Fatal("checkpoint identity changed")
				}
				checkpoints++
				return encode(cp), nil
			}}
			s.browserRun = func(ctx context.Context, actor model.Principal, project, taskID, id string, purpose BrowserPurpose, work func(*Access) error) error {
				reads++
				if actor != principal || project != "" || taskID != "" || id != cp.SessionID || purpose != BrowserAccess {
					t.Fatal("read authority changed")
				}
				if scenario == "revoked" && reads == 3 {
					return denied()
				}
				if reads == 4 {
					if scenario == "checkpoint advanced" {
						cp.WindowRevision = "6"
					}
					if scenario == "source changed" {
						cp.SourceEpoch = uuid.NewString()
					}
					if scenario == "identity changed" {
						cp.HistoryEpoch = uuid.NewString()
						r.Snapshot.HistoryEpoch = cp.HistoryEpoch
					}
				}
				return work(&Access{tx: &operationTx{dao: dao}, record: r})
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			type result struct {
				page sp.BotHistoryWindowPage
				err  error
			}
			done := make(chan result, 1)
			go func() {
				overhead := 0
				if scenario == "budget" {
					overhead = sp.MaxHistoryResponseBytes - 1
				}
				value, err := s.ReadBotHistoryWindow(ctx, principal, "", "", cp.SessionID, BotHistoryWindowRequest{Mode: "tail", Limit: 2, ResponseOverhead: overhead})
				done <- result{value, err}
			}()
			var requestID string
			var pending *pendingContent
			ticker := time.NewTicker(time.Millisecond)
			defer ticker.Stop()
			for pending == nil {
				select {
				case <-ctx.Done():
					t.Fatal("window request was not offered")
				case <-ticker.C:
				}
				s.content.mu.Lock()
				for id, request := range s.content.pending {
					requestID, pending = id, request
				}
				s.content.mu.Unlock()
			}
			if pending.kind != "bot_history_window" || pending.request["mode"] != "tail" || pending.request["limit"] != 2 || pending.request["historyEpoch"] != cp.HistoryEpoch {
				t.Fatal("window request changed", pending.request)
			}
			if scenario == "wrong body" {
				page.Items[1].Preview = "evil"
			}
			message := sp.ControllerMessage{ControllerFence: cp.ControllerFence, RequestID: requestID, SourceThrough: "7", ContentResult: &sp.ContentResult{Kind: "bot_history_window", BotHistoryWindow: &page}}
			if scenario == "controller reset" {
				message.ContentError = &sp.OperationError{Code: "reset_required", Message: "old cursor"}
				message.ContentResult = nil
			}
			op := &Operation{}
			if _, err := s.acceptContent(&operationTx{op: op}, r, message); err != nil {
				t.Fatal(err)
			}
			op.Finish(store.TransactionCommitted)
			got := <-done
			code := map[string]string{"revoked": "forbidden", "checkpoint advanced": "reset_required", "identity changed": "reset_required", "source changed": "reset_required", "controller reset": "reset_required", "wrong body": "content_changed", "budget": "content_unavailable"}[scenario]
			if code != "" {
				botFault(t, got.err, code)
				return
			}
			if got.err != nil || len(got.page.Items) != 2 || got.page.NextCursor == nil || reads != 4 || checkpoints != 2 {
				t.Fatalf("read result %#v error=%v scopes=%d checkpoints=%d", got.page, got.err, reads, checkpoints)
			}
		})
	}
}
