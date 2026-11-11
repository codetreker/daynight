package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type botReceiptAuthenticator struct{ principal model.Principal }

func (a botReceiptAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	if kind == model.PATCredential && token == "alice" {
		return a.principal, nil
	}
	return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "invalid credential"}
}

type botReceiptCall struct {
	name   string
	args   []any
	result []any
	check  func([]any)
}
type botReceiptScript struct {
	t     *testing.T
	calls []botReceiptCall
	next  int
}

func receiptCall(name string, args []any, result ...any) botReceiptCall {
	return botReceiptCall{name: name, args: args, result: result}
}
func (s *botReceiptScript) call(name string, args ...any) []any {
	s.t.Helper()
	if s.next >= len(s.calls) {
		unexpectedHTTPCall(s.t, "Bot receipt "+name)
	}
	c := s.calls[s.next]
	s.next++
	if name != c.name || (c.check == nil && !reflect.DeepEqual(args, c.args)) {
		s.t.Errorf("Bot receipt call %d: got %s %#v, want %s %#v", s.next, name, args, c.name, c.args)
		panic("Bot receipt DAO call mismatch")
	}
	if c.check != nil {
		c.check(args)
	}
	return c.result
}
func (s *botReceiptScript) verify() {
	if s.next != len(s.calls) {
		s.t.Errorf("Bot receipt calls = %d, want %d", s.next, len(s.calls))
	}
}
func receiptError(value any) error {
	if value == nil {
		return nil
	}
	return value.(error)
}

// The callback boundary makes even an unconfigured embedded capability fail
// the test when the SDK recovers a panic on a server goroutine.
func receiptCallback(t *testing.T, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Bot receipt callback panic: %v", r)
			panic(r)
		}
	}()
	return fn()
}

type botReceiptStore struct {
	t       *testing.T
	read    func(context.Context, func(store.SnapshotScope) error) error
	bot     func(context.Context, func(store.BotScope) error) (store.Completion, error)
	session func(context.Context, func(store.SessionScope) error) (store.Completion, error)
}

func (s *botReceiptStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	return receiptCallback(s.t, func() error { return requireCallback(s.t, "Bot receipt ReadSnapshot", s.read)(ctx, fn) })
}
func (s *botReceiptStore) WriteBot(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
	var c store.Completion
	err := receiptCallback(s.t, func() error {
		var err error
		c, err = requireCallback(s.t, "Bot receipt WriteBot", s.bot)(ctx, fn)
		return err
	})
	return c, err
}
func (s *botReceiptStore) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	var c store.Completion
	err := receiptCallback(s.t, func() error {
		var err error
		c, err = requireCallback(s.t, "Bot receipt WriteSession", s.session)(ctx, fn)
		return err
	})
	return c, err
}
func receiptCompletion(err error) (store.Completion, error) {
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type botReceiptSelection struct{ s *botReceiptScript }

func (d botReceiptSelection) BotPreferredWorker(_ context.Context, owner string) (*string, error) {
	r := d.s.call("BotPreferredWorker", owner)
	return r[0].(*string), receiptError(r[1])
}
func (d botReceiptSelection) BotCreationCandidate(_ context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidate", owner, id)
	return r[0].(model.BotDefaultsInput), receiptError(r[1])
}
func (d botReceiptSelection) BotCreationCandidates(_ context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidates", owner)
	return r[0].(model.BotDefaultsInput), receiptError(r[1])
}
func (d botReceiptSelection) BotCreationWorker(_ context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationWorker", owner, id)
	return r[0].(model.BotDefaultsInput), receiptError(r[1])
}

type botReceiptReader struct {
	store.BotReader
	botReceiptSelection
}

func (d botReceiptReader) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	return d.botReceiptSelection.BotPreferredWorker(ctx, owner)
}
func (d botReceiptReader) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationCandidate(ctx, owner, id)
}
func (d botReceiptReader) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationCandidates(ctx, owner)
}
func (d botReceiptReader) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationWorker(ctx, owner, id)
}

func (d botReceiptReader) Bot(_ context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), receiptError(r[1])
}

type botReceiptWriter struct {
	store.BotWriteDAO
	botReceiptSelection
}

func (d botReceiptWriter) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	return d.botReceiptSelection.BotPreferredWorker(ctx, owner)
}
func (d botReceiptWriter) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationCandidate(ctx, owner, id)
}
func (d botReceiptWriter) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationCandidates(ctx, owner)
}
func (d botReceiptWriter) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	return d.botReceiptSelection.BotCreationWorker(ctx, owner, id)
}

func (d botReceiptWriter) Credential(_ context.Context, p model.Principal) error {
	return receiptError(d.s.call("Credential", p)[0])
}
func (d botReceiptWriter) LockCreation(_ context.Context, id string) error {
	return receiptError(d.s.call("LockCreation", id)[0])
}
func (d botReceiptWriter) Worker(_ context.Context, owner, id string) error {
	return receiptError(d.s.call("Worker", owner, id)[0])
}
func (d botReceiptWriter) Bot(_ context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), receiptError(r[1])
}
func (d botReceiptWriter) InsertBot(_ context.Context, b model.Bot) error {
	return receiptError(d.s.call("InsertBot", b)[0])
}
func (d botReceiptWriter) SaveBotDeletion(_ context.Context, id string, v *model.BotDeletion) (model.Bot, error) {
	r := d.s.call("SaveBotDeletion", id, v)
	return r[0].(model.Bot), receiptError(r[1])
}

type botReceiptCredential struct{ s *botReceiptScript }

func (d botReceiptCredential) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	r := d.s.call("Credential", p)
	return store.ThreadCredential{}, receiptError(r[0])
}

type botReceiptSnapshot struct {
	store.SnapshotScope
	s *botReceiptScript
}

func (s botReceiptSnapshot) BotDAO() store.BotReader {
	return botReceiptReader{botReceiptSelection: botReceiptSelection{s.s}}
}
func (s botReceiptSnapshot) CredentialDAO() store.CredentialReader { return botReceiptCredential{s.s} }

type botReceiptBotScope struct{ s *botReceiptScript }

func (s botReceiptBotScope) BotDAO() store.BotWriteDAO {
	return botReceiptWriter{botReceiptSelection: botReceiptSelection{s.s}}
}

type botReceiptSession struct {
	store.SessionDAO
	s *botReceiptScript
}

func (d botReceiptSession) LockCredential(_ context.Context, p model.Principal, now time.Time) error {
	return receiptError(d.s.call("LockCredential", p, now)[0])
}
func (d botReceiptSession) LockBotSessions(_ context.Context, id string) ([]store.BotSession, error) {
	r := d.s.call("LockBotSessions", id)
	return r[0].([]store.BotSession), receiptError(r[1])
}
func (d botReceiptSession) RevokeBotSessions(_ context.Context, id string) error {
	return receiptError(d.s.call("RevokeBotSessions", id)[0])
}

type botReceiptSessionScope struct{ s *botReceiptScript }

func (s botReceiptSessionScope) BotDAO() store.BotWriteDAO {
	return botReceiptWriter{botReceiptSelection: botReceiptSelection{s.s}}
}
func (s botReceiptSessionScope) SessionDAO() store.SessionDAO { return botReceiptSession{s: s.s} }
func receiptSnapshot(t *testing.T, tx *botReceiptStore, calls ...botReceiptCall) {
	s := &botReceiptScript{t: t, calls: calls}
	count := 0
	tx.read = func(_ context.Context, fn func(store.SnapshotScope) error) error {
		count++
		if count != 1 {
			unexpectedHTTPCall(t, "repeated Bot receipt snapshot")
		}
		err := fn(botReceiptSnapshot{s: s})
		s.verify()
		return err
	}
	t.Cleanup(func() {
		if count != 1 {
			t.Errorf("Bot receipt snapshot count = %d", count)
		}
		s.verify()
	})
}
func receiptWriteBot(t *testing.T, tx *botReceiptStore, calls ...botReceiptCall) {
	s := &botReceiptScript{t: t, calls: calls}
	count := 0
	tx.bot = func(_ context.Context, fn func(store.BotScope) error) (store.Completion, error) {
		count++
		if count != 1 {
			unexpectedHTTPCall(t, "repeated Bot receipt WriteBot")
		}
		err := fn(botReceiptBotScope{s: s})
		s.verify()
		return receiptCompletion(err)
	}
	t.Cleanup(func() {
		if count != 1 {
			t.Errorf("Bot receipt WriteBot count = %d", count)
		}
		s.verify()
	})
}
func receiptWriteSession(t *testing.T, tx *botReceiptStore, calls ...botReceiptCall) {
	s := &botReceiptScript{t: t, calls: calls}
	count := 0
	tx.session = func(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		count++
		if count != 1 {
			unexpectedHTTPCall(t, "repeated Bot receipt WriteSession")
		}
		err := fn(botReceiptSessionScope{s: s})
		s.verify()
		return receiptCompletion(err)
	}
	t.Cleanup(func() {
		if count != 1 {
			t.Errorf("Bot receipt WriteSession count = %d", count)
		}
		s.verify()
	})
}
func receiptLockedCredential(t *testing.T, p model.Principal) botReceiptCall {
	earliest := time.Now()
	return botReceiptCall{name: "LockCredential", result: []any{nil}, check: func(args []any) {
		observed := time.Now()
		if len(args) != 2 {
			unexpectedHTTPCall(t, "Bot receipt credential arguments")
		}
		now, ok := args[1].(time.Time)
		if args[0] != p || !ok || now.IsZero() || now.Before(earliest) || now.After(observed) {
			unexpectedHTTPCall(t, "Bot receipt credential identity or time")
		}
	}}
}
func receiptDefaults(owner, worker string, now time.Time) model.BotDefaultsInput {
	name, reason := "gpt-5", "not_found"
	host := &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot, Providers: []model.WorkerAssistantProvider{
		{Provider: model.AgentCodex, Available: true, Args: []string{}},
		{Provider: model.AgentClaude, Available: false, Reason: &reason, Args: []string{}},
		{Provider: model.AgentCopilot, Available: true, Model: &name, Args: []string{"--effort", "high"}},
	}}
	return model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{{UserID: owner, WorkerID: worker, CreatedAt: now.Add(-time.Minute), LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}}}, WorkerPreferences: map[string]model.BotWorkerPreference{}}
}
func receiptBot(owner, worker, id, name string, configuration model.BotConfiguration, now time.Time) model.Bot {
	raw, _ := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
	}{Name: name})
	sum := sha256.Sum256(raw)
	return model.Bot{ID: id, OwnerUserID: owner, WorkerID: worker, Name: name, Version: 1, CreationOrder: 1, RequestFingerprint: hex.EncodeToString(sum[:]), ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}
func receiptCreation(t *testing.T, tx *botReceiptStore, p model.Principal, defaults model.BotDefaultsInput, want model.Bot) {
	selection := func() []botReceiptCall {
		return []botReceiptCall{
			receiptCall("BotPreferredWorker", []any{p.UserID}, (*string)(nil), nil),
			receiptCall("BotCreationCandidates", []any{p.UserID}, defaults, nil),
			receiptCall("BotCreationWorker", []any{p.UserID, want.WorkerID}, defaults, nil),
		}
	}
	reads := append([]botReceiptCall{receiptCall("Credential", []any{p}, nil), receiptCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	receiptSnapshot(t, tx, reads...)
	insert := model.Bot{ID: want.ID, OwnerUserID: p.UserID, WorkerID: want.WorkerID, Name: want.Name, RequestFingerprint: want.RequestFingerprint, RequestedOverrides: want.RequestedOverrides, ResolvedConfiguration: want.ResolvedConfiguration}
	writes := append([]botReceiptCall{receiptCall("Credential", []any{p}, nil), receiptCall("LockCreation", []any{want.ID}, nil), receiptCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	writes = append(writes, receiptCall("Worker", []any{p.UserID, want.WorkerID}, nil), receiptCall("InsertBot", []any{insert}, nil), receiptCall("Bot", []any{want.ID}, want, nil), receiptCall("Credential", []any{p}, nil))
	receiptWriteBot(t, tx, writes...)
}

type lostBotReceiptTransport struct {
	token       string
	createCalls atomic.Int32
	deleteCalls atomic.Int32
	completed   atomic.Int32
}

func (tr *lostBotReceiptTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+tr.token)
	var input struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if req.Body != nil {
		body, err := io.ReadAll(io.LimitReader(req.Body, 4<<20+1))
		if err != nil {
			return nil, err
		}
		if len(body) > 4<<20 {
			return nil, errors.New("test request exceeds bound")
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = json.Unmarshal(body, &input)
	}
	switch {
	case input.Method != "tools/call":
		return http.DefaultTransport.RoundTrip(r)
	case input.Params.Name == "bot_create":
		tr.createCalls.Add(1)
	case input.Params.Name == "bot_delete":
		tr.deleteCalls.Add(1)
	default:
		return http.DefaultTransport.RoundTrip(r)
	}
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(body) > 1<<20 || resp.StatusCode != http.StatusOK {
		return nil, errors.New("unexpected server response")
	}
	var doc struct {
		Result *struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			} `json:"structuredContent"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || len(doc.Error) != 0 || doc.Result == nil || doc.Result.IsError || doc.Result.StructuredContent.Data.ID == "" {
		return nil, errors.New("server did not confirm operation")
	}
	tr.completed.Add(1)
	return nil, errors.New("Bot receipt lost after response")
}

func TestMCPBotLostReceiptsRemainReconciliable(t *testing.T) {
	tx := &botReceiptStore{t: t}
	principal := defaultHTTPPrincipal()
	worker := uuid.NewString()
	now := time.Now().UTC()
	defaults := receiptDefaults(principal.UserID, worker, now)
	modelName := "gpt-5"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: &modelName, Args: []string{"--effort", "high"}}
	server, _ := newAdapterHost(t, botReceiptAuthenticator{principal}, io.Discard, func(entry *Entry, _ string) error {
		return RegisterBotTools(entry, botservice.New(tx), botservice.NewDeletions(tx, nil, nil))
	})
	tr := &lostBotReceiptTransport{token: "alice"}
	client := sdk.NewClient(&sdk.Implementation{Name: "lost-bot-receipt", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	lost, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: tr}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lost.Close() })
	reader := mcpPATClient(t, server.URL, "alice")
	callLost := func(name string, args map[string]any) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		if _, err := lost.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args}); err == nil {
			t.Fatalf("%s unexpectedly received a receipt", name)
		}
	}
	show := func(id string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := reader.CallTool(ctx, &sdk.CallToolParams{Name: "bot_show", Arguments: map[string]any{"botId": id}})
		if err != nil || result.IsError {
			t.Fatalf("show: %+v %v", result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Data map[string]any `json:"data"`
		}
		if err = json.Unmarshal(encoded, &doc); err != nil {
			t.Fatal(err)
		}
		return doc.Data
	}
	id, deletionID := uuid.NewString(), uuid.NewString()
	expected := receiptBot(principal.UserID, worker, id, "Lost receipt", configuration, now)
	receiptCreation(t, tx, principal, defaults, expected)
	callLost("bot_create", map[string]any{"name": "Lost receipt", "requestId": id})
	receiptSnapshot(t, tx, receiptCall("Credential", []any{principal}, nil), receiptCall("Bot", []any{id}, expected, nil))
	created := show(id)
	if tr.createCalls.Load() != 1 || tr.completed.Load() != 1 || created["id"] != id || created["version"] != "1" || created["workerId"] != worker {
		t.Fatalf("create calls=%d completed=%d data=%+v", tr.createCalls.Load(), tr.completed.Load(), created)
	}
	deletionModel := expected
	deletionModel.Version = 2
	deletionModel.Deletion = &model.BotDeletion{DeletionID: deletionID, RequestedVersion: 1, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deletionModel.UpdatedAt = now.Add(time.Second)
	receiptWriteSession(t, tx, receiptLockedCredential(t, principal), receiptCall("Bot", []any{id}, expected, nil), receiptCall("LockBotSessions", []any{id}, []store.BotSession{}, nil), receiptCall("RevokeBotSessions", []any{id}, nil), receiptCall("SaveBotDeletion", []any{id, deletionModel.Deletion}, deletionModel, nil), receiptLockedCredential(t, principal))
	callLost("bot_delete", map[string]any{"botId": id, "ifVersion": "1", "requestId": deletionID})
	receiptSnapshot(t, tx, receiptCall("Credential", []any{principal}, nil), receiptCall("Bot", []any{id}, deletionModel, nil))
	deleted := show(id)
	deletion, ok := deleted["deletion"].(map[string]any)
	if tr.createCalls.Load() != 1 || tr.deleteCalls.Load() != 1 || tr.completed.Load() != 2 || deleted["id"] != id || deleted["version"] != "2" || !ok || deletion["deletionId"] != deletionID || deletion["requestedVersion"] != "1" {
		t.Fatalf("delete createCalls=%d deleteCalls=%d completed=%d data=%+v", tr.createCalls.Load(), tr.deleteCalls.Load(), tr.completed.Load(), deleted)
	}
}

const botTestID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const deletionTestID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type fakeBotOperations struct {
	bot                               model.Bot
	page                              botcore.BotPage
	principal                         model.Principal
	createInput                       botcore.CreateBot
	pageInput                         model.PageRequest
	readID                            string
	createCalls, listCalls, readCalls int
	err                               error
}

func (f *fakeBotOperations) CreateResolved(_ context.Context, p model.Principal, in botcore.CreateBot) (model.Bot, error) {
	f.createCalls++
	f.principal = p
	f.createInput = in
	out := f.bot
	out.ID = in.ID
	return out, f.err
}
func (f *fakeBotOperations) Get(_ context.Context, p model.Principal, id string) (model.Bot, error) {
	f.readCalls++
	f.principal = p
	f.readID = id
	return f.bot, f.err
}
func (f *fakeBotOperations) List(_ context.Context, p model.Principal, page model.PageRequest) (botcore.BotPage, error) {
	f.listCalls++
	f.principal = p
	f.pageInput = page
	return f.page, f.err
}

type fakeBotDeletion struct {
	bot       model.Bot
	principal model.Principal
	id        string
	input     store.DeleteBot
	calls     int
	err       error
}

func (f *fakeBotDeletion) DeleteBot(_ context.Context, p model.Principal, id string, in store.DeleteBot) (model.Bot, error) {
	f.calls++
	f.principal = p
	f.id = id
	f.input = in
	return f.bot, f.err
}
func sampleBot() model.Bot {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Bot{ID: botTestID, OwnerUserID: "alice", WorkerID: testTargetID, Name: "bot", Version: 9007199254740993, CreationOrder: 9007199254740994,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: testTargetID, Cwd: "/tmp", Provider: "codex", Args: []string{}},
		StartupResult:         model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}
func TestBotToolHTTPContract(t *testing.T) {
	f := newEntryFixture(t)
	bot := sampleBot()
	next, err := query.EncodeListCursor(query.ListScope{Kind: "bots", WorkerUserID: ptr("alice")}, bot.CreatedAt, bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	ops := &fakeBotOperations{bot: bot, page: botcore.BotPage{Items: []model.Bot{bot}, NextCursor: &next}}
	relay := &fakeBotDeletion{bot: bot}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range list.Tools {
		names[tool.Name] = true
	}
	for _, name := range []string{"bot_list", "bot_show", "bot_create", "bot_delete"} {
		if !names[name] {
			t.Fatalf("missing tool %s", name)
		}
	}
	call := func(name string, args any) *sdk.CallToolResult {
		t.Helper()
		r, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	result := call("bot_list", map[string]any{})
	if result.IsError || ops.pageInput.Limit != 50 || ops.pageInput.Cursor != nil || ops.principal.CredentialID != "credential-alice" {
		t.Fatalf("list: %+v page=%+v", structured(t, result), ops.pageInput)
	}
	page := object(t, structured(t, result)["data"])
	items, ok := page["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("list output: %+v", page)
	}
	cursor, ok := page["nextCursor"].(string)
	if !ok {
		t.Fatalf("missing cursor: %+v", page)
	}
	decoded, err := query.ListPage(model.PageRequest{Limit: 1, Cursor: &cursor}, query.ListScope{Kind: "bots", WorkerUserID: ptr("alice")})
	if err != nil || decoded.After == nil || decoded.After.ID != botTestID {
		t.Fatalf("cursor: %+v %v", decoded, err)
	}
	item := object(t, items[0])
	if item["version"] != "9007199254740993" || object(t, item["startupResult"])["state"] != "pending" {
		t.Fatalf("bot facts: %+v", item)
	}
	result = call("bot_list", map[string]any{"limit": 1, "cursor": "previous"})
	if result.IsError || ops.pageInput.Limit != 1 || ops.pageInput.Cursor == nil || *ops.pageInput.Cursor != "previous" {
		t.Fatalf("page input: %+v", ops.pageInput)
	}
	calls := ops.listCalls
	result = call("bot_list", map[string]any{"limit": 101})
	if !result.IsError || ops.listCalls != calls {
		t.Fatal("invalid limit reached business service")
	}
	result = call("bot_show", map[string]any{"botId": botTestID})
	if result.IsError || ops.readID != botTestID || object(t, structured(t, result)["data"])["id"] != botTestID {
		t.Fatalf("show %+v", structured(t, result))
	}
	result = call("bot_create", map[string]any{"name": "new", "requestId": botTestID})
	if result.IsError || ops.createInput.ID != botTestID || ops.createInput.Name != "new" || ops.createInput.Overrides.WorkerID != nil || ops.createInput.Overrides.Cwd != nil || ops.createInput.Overrides.Provider != nil {
		t.Fatalf("default create input %+v, output %+v", ops.createInput, structured(t, result))
	}
	result = call("bot_create", map[string]any{"name": "new", "workerId": testTargetID, "cwd": "/work", "agent": "claude", "model": "model-a", "reasoningEffort": "high"})
	in := ops.createInput
	if result.IsError || in.ID == "" || in.Overrides.WorkerID == nil || *in.Overrides.WorkerID != testTargetID || in.Overrides.Cwd == nil || *in.Overrides.Cwd != "/work" || in.Overrides.Provider == nil || *in.Overrides.Provider != "claude" || in.Overrides.Model == nil || *in.Overrides.Model != "model-a" || in.Overrides.ReasoningEffort == nil || *in.Overrides.ReasoningEffort != "high" || object(t, structured(t, result)["data"])["id"] != in.ID {
		t.Fatalf("override create %+v output %+v", in, structured(t, result))
	}
	relay.bot.Deletion = &model.BotDeletion{DeletionID: deletionTestID, RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}
	result = call("bot_delete", map[string]any{"botId": botTestID, "ifVersion": "9007199254740993", "requestId": deletionTestID})
	if result.IsError || relay.calls != 1 || relay.id != botTestID || relay.input.Version != bot.Version || relay.input.DeletionID != deletionTestID {
		t.Fatalf("delete %+v result %+v", relay, structured(t, result))
	}
	deleted := object(t, structured(t, result)["data"])
	cleanup := object(t, deleted["deletion"])
	if _, exists := deleted["name"]; exists || object(t, cleanup["workerCleanup"])["state"] != "pending" || object(t, cleanup["serverCleanup"])["state"] != "completed" {
		t.Fatalf("deletion facts %+v", deleted)
	}
	for _, version := range []any{nil, "0", "01", "9223372036854775808", 1} {
		args := map[string]any{"botId": botTestID}
		if version != nil {
			args["ifVersion"] = version
		}
		calls = relay.calls
		result = call("bot_delete", args)
		if !result.IsError || relay.calls != calls {
			t.Fatalf("bad version %v accepted", version)
		}
	}
}

func TestBotUnknownWriteRetainsOriginalIDs(t *testing.T) {
	f := newEntryFixture(t)
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("lost receipt")}
	ops := &fakeBotOperations{bot: sampleBot(), err: unknown}
	relay := &fakeBotDeletion{err: unknown}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(name string, args any) map[string]any {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || !result.IsError {
			t.Fatalf("call %s: %+v %v", name, result, err)
		}
		return object(t, structured(t, result)["error"])
	}
	e := call("bot_create", map[string]any{"name": "new"})
	refs := object(t, e["refs"])
	if e["writeOutcome"] != "unknown" || refs["botId"] != ops.createInput.ID || ops.createCalls != 1 {
		t.Fatalf("unknown create: %+v input %+v", e, ops.createInput)
	}
	e = call("bot_delete", map[string]any{"botId": botTestID, "ifVersion": "1"})
	refs = object(t, e["refs"])
	if e["writeOutcome"] != "unknown" || refs["botId"] != botTestID || refs["deletionId"] != relay.input.DeletionID || relay.input.DeletionID == "" || relay.calls != 1 {
		t.Fatalf("unknown delete: %+v input %+v", e, relay.input)
	}
}

func TestBotWriteOutputFailurePreservesCompletion(t *testing.T) {
	f := newEntryFixture(t)
	bot := sampleBot()
	bot.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	ops := &fakeBotOperations{bot: bot}
	relay := &fakeBotDeletion{bot: bot}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_create", Arguments: map[string]any{"name": "new", "requestId": botTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("output failure: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	if failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" || object(t, failure["refs"])["botId"] != botTestID || ops.createCalls != 1 {
		t.Fatalf("completion facts: %+v", failure)
	}
}

func TestBotCreateBodySize(t *testing.T) {
	name := "a\"\\\n\t\x01\u2028\u2029"
	worker, cwd, provider := testTargetID, "/tmp/\"x\"\n\u2028", "codex"
	tests := []struct {
		name      string
		overrides model.BotOverrides
		want      string
	}{
		{"omitted", model.BotOverrides{}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `"}`},
		{"worker", model.BotOverrides{WorkerID: &worker}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"workerId":"` + worker + `"}}`},
		{"cwd", model.BotOverrides{Cwd: &cwd}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"cwd":"/tmp/\"x\"\n` + "\u2028" + `"}}`},
		{"all", model.BotOverrides{WorkerID: &worker, Cwd: &cwd, Provider: &provider}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"workerId":"` + worker + `","cwd":"/tmp/\"x\"\n` + "\u2028" + `","provider":"codex"}}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := botCreateBodySize(botTestID, name, tc.overrides); got != len(tc.want) {
				t.Fatalf("got %d, want %d from %s", got, len(tc.want), tc.want)
			}
		})
	}

	f := newEntryFixture(t)
	ops := &fakeBotOperations{bot: sampleBot()}
	if err := RegisterBotTools(f.entry, ops, &fakeBotDeletion{}); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	overhead := botCreateBodySize(botTestID, "", model.BotOverrides{})
	for _, extra := range []int{0, 1} {
		input := strings.Repeat("a", httpx.MaxJSONBody-overhead+extra)
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_create", Arguments: map[string]any{"name": input, "requestId": botTestID}})
		if err != nil {
			t.Fatal(err)
		}
		if result.IsError != (extra == 1) || ops.createCalls != 1 {
			t.Fatalf("boundary %d: error=%v calls=%d", extra, result.IsError, ops.createCalls)
		}
	}
}

func TestBotOperationIDsCanonicalized(t *testing.T) {
	f := newEntryFixture(t)
	ops := &fakeBotOperations{bot: sampleBot()}
	relay := &fakeBotDeletion{bot: sampleBot()}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(name string, args any) {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s: %+v %v", name, result, err)
		}
	}
	call("bot_create", map[string]any{"name": "bot", "requestId": strings.ToUpper(botTestID)})
	if ops.createInput.ID != botTestID {
		t.Fatalf("create ID: %q", ops.createInput.ID)
	}
	call("bot_delete", map[string]any{"botId": strings.ToUpper(botTestID), "ifVersion": "1", "requestId": strings.ToUpper(deletionTestID)})
	if relay.id != botTestID || relay.input.DeletionID != deletionTestID {
		t.Fatalf("delete IDs: %s %s", relay.id, relay.input.DeletionID)
	}
}

func TestBotDeleteCleanupFailureRetainsBarrier(t *testing.T) {
	f := newEntryFixture(t)
	cause := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("cleanup failed")}
	relay := &fakeBotDeletion{err: &botservice.DeletionCleanupError{Cause: cause}}
	if err := RegisterBotTools(f.entry, &fakeBotOperations{}, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_delete", Arguments: map[string]any{"botId": botTestID, "ifVersion": "1", "requestId": deletionTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("delete: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	refs := object(t, failure["refs"])
	if failure["writeOutcome"] != "confirmed" || failure["phase"] != "cleanup" || refs["botId"] != botTestID || refs["deletionId"] != deletionTestID || relay.calls != 1 {
		t.Fatalf("cleanup facts: %+v", failure)
	}
}

func TestBotRegistrationRejectsInvalidDefinitions(t *testing.T) {
	original := botToolsJSON
	t.Cleanup(func() { botToolsJSON = original })
	botToolsJSON = []byte("[")
	fixture := newEntryFixture(t)
	if err := RegisterBotTools(fixture.entry, &fakeBotOperations{}, &fakeBotDeletion{}); err == nil {
		t.Fatal("malformed definitions accepted")
	}
	var definitions []map[string]any
	if err := json.Unmarshal(original, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"bot_list", "bot_show", "bot_create", "bot_delete"} {
		t.Run(name, func(t *testing.T) {
			var remaining []map[string]any
			for _, definition := range definitions {
				if definition["name"] != name {
					remaining = append(remaining, definition)
				}
			}
			var err error
			botToolsJSON, err = json.Marshal(remaining)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newEntryFixture(t)
			if err := RegisterBotTools(fixture.entry, &fakeBotOperations{}, &fakeBotDeletion{}); err == nil {
				t.Fatalf("missing %s definition accepted", name)
			}
		})
	}
}

func TestBotShowPreservesBusinessRefusal(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := &fakeBotOperations{err: &model.Fault{Code: "forbidden", Message: "Bot access denied."}}
	if err := RegisterBotTools(fixture.entry, ops, &fakeBotDeletion{}); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_show", Arguments: map[string]any{"botId": botTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("show refusal: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	if failure["code"] != "forbidden" || failure["message"] != "Bot access denied." || failure["requestId"] != "test-request" || ops.readCalls != 1 || ops.readID != botTestID {
		t.Fatalf("show refusal: %+v calls=%d id=%s", failure, ops.readCalls, ops.readID)
	}
}

func TestBotReadErrorsDoNotClaimWriteOutcome(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
		for _, name := range []string{"bot_list", "bot_show"} {
			t.Run(name+"/"+string(outcome), func(t *testing.T) {
				fixture := newEntryFixture(t)
				ops := &fakeBotOperations{err: &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: errors.New("snapshot failed")}}
				if err := RegisterBotTools(fixture.entry, ops, &fakeBotDeletion{}); err != nil {
					t.Fatal(err)
				}
				client := fixture.client(t, "2026-07-28", "alice")
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				args := map[string]any{}
				if name == "bot_show" {
					args["botId"] = botTestID
				}
				result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || !result.IsError {
					t.Fatalf("read: %+v %v", result, err)
				}
				failure := object(t, structured(t, result)["error"])
				if _, present := failure["writeOutcome"]; present {
					t.Fatalf("snapshot reported a write: %+v", failure)
				}
				if name == "bot_show" && ops.readCalls != 1 || name == "bot_list" && ops.listCalls != 1 {
					t.Fatalf("wrong service calls: %+v", ops)
				}
			})
		}
	}
}

func TestBotCreateBodySizeIncludesNativeOnlyOverrides(t *testing.T) {
	modelValue, effort := "model-a", "high"
	for _, overrides := range []model.BotOverrides{{Model: &modelValue}, {ReasoningEffort: &effort}, {Model: &modelValue, ReasoningEffort: &effort}} {
		raw, err := json.Marshal(struct {
			ID        string             `json:"id"`
			Name      string             `json:"name"`
			Overrides model.BotOverrides `json:"overrides"`
		}{botTestID, "bot", overrides})
		if err != nil {
			t.Fatal(err)
		}
		if got := botCreateBodySize(botTestID, "bot", overrides); got != len(raw) {
			t.Fatalf("size %d != %d: %s", got, len(raw), raw)
		}
	}
}
