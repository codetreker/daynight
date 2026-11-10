package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type sessionReadMock struct {
	t       *testing.T
	current func(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error)
	list    func(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
	inspect func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)
	read    func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error)
	entry   func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error)
}

func newSessionReadFixture(t *testing.T) *entryFixture {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", []string{"https://client.test"}, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	f := &entryFixture{entry: e, server: httptest.NewServer(httpx.RequestLogging(logger, e))}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		f.server.Close()
	})
	return f
}

func (m sessionReadMock) unexpected(name string) error {
	m.t.Helper()
	m.t.Errorf("unexpected Session read operation: %s", name)
	return fmt.Errorf("unexpected Session read operation: %s", name)
}

func (m sessionReadMock) Current(ctx context.Context, p model.Principal, project, task string) (sp.TaskSessionCurrent, error) {
	if m.current == nil {
		return sp.TaskSessionCurrent{}, m.unexpected("Current")
	}
	return m.current(ctx, p, project, task)
}
func (m sessionReadMock) List(ctx context.Context, p model.Principal, project, task, cursor string, limit int) (sp.TaskSessionList, error) {
	if m.list == nil {
		return sp.TaskSessionList{}, m.unexpected("List")
	}
	return m.list(ctx, p, project, task, cursor, limit)
}
func (m sessionReadMock) Inspect(ctx context.Context, p model.Principal, project, task, id string) (sp.TaskSessionInspection, error) {
	if m.inspect == nil {
		return sp.TaskSessionInspection{}, m.unexpected("Inspect")
	}
	return m.inspect(ctx, p, project, task, id)
}
func (m sessionReadMock) Read(ctx context.Context, p model.Principal, project, task, id string, in ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
	if m.read == nil {
		return nil, m.unexpected("Read")
	}
	return m.read(ctx, p, project, task, id, in)
}
func (m sessionReadMock) Entry(ctx context.Context, p model.Principal, project, task, id string, in ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
	if m.entry == nil {
		return nil, m.unexpected("Entry")
	}
	return m.entry(ctx, p, project, task, id, in)
}

func sessionReadPage() sp.MessagePage {
	return sp.MessagePage{SessionID: testUserID, HistoryEpoch: testTargetID, Source: "live", Items: []sp.MessageItem{}, Coverage: sp.HistoryCoverage{State: "complete"}, ObservedAt: time.Date(2026, 11, 10, 1, 2, 3, 123456789, time.UTC)}
}
func sessionReadInspection() sp.TaskSessionInspection {
	return sp.TaskSessionInspection{SchemaVersion: 1, ContentReadVersion: 1, ProjectID: testProjectID, TaskID: testTargetID, SessionID: testUserID, Source: "live", Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: testUserID, ClaimID: testTargetID, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Session: observationFixture()}
}
func sessionReadArgs() map[string]any {
	return map[string]any{"projectId": testProjectID, "taskId": testTargetID, "sessionId": testUserID}
}

func TestSessionReadToolsPreserveIdentityDefaultsAndDiscoveredSchemas(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(version, func(t *testing.T) {
			f := newSessionReadFixture(t)
			calls := 0
			check := func(p model.Principal, project, task, id string) {
				t.Helper()
				calls++
				if p.UserID != "alice" || project != testProjectID || task != testTargetID || id != "" && id != testUserID {
					t.Errorf("identity changed: %+v %s %s %s", p, project, task, id)
				}
			}
			mock := sessionReadMock{t: t,
				current: func(_ context.Context, p model.Principal, project, task string) (sp.TaskSessionCurrent, error) {
					check(p, project, task, "")
					return sp.TaskSessionCurrent{Status: "not_applicable"}, nil
				},
				list: func(_ context.Context, p model.Principal, project, task, cursor string, limit int) (sp.TaskSessionList, error) {
					check(p, project, task, "")
					if cursor != "older" || limit != 20 {
						t.Errorf("list input %s %d", cursor, limit)
					}
					return sp.TaskSessionList{Items: []sp.TaskSessionDirectoryItem{{SessionID: testUserID, ClaimID: testTargetID, ExecutionGeneration: "1", AgentControlMode: "web", ContentKind: "native_timeline", CreatedAt: "2026-11-10T01:02:03Z", Archive: sp.SessionDirectoryArchive{State: "unavailable"}}}}, nil
				},
				inspect: func(_ context.Context, p model.Principal, project, task, id string) (sp.TaskSessionInspection, error) {
					check(p, project, task, id)
					return sessionReadInspection(), nil
				},
				read: func(_ context.Context, p model.Principal, project, task, id string, in ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
					check(p, project, task, id)
					if in.Limit != 20 || in.Before != "older" || !in.Conversation || in.ResponseOverhead <= 0 {
						t.Errorf("read input %+v", in)
					}
					return ss.NewReadResult(sessionReadPage(), nil), nil
				},
				entry: func(_ context.Context, p model.Principal, project, task, id string, in ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
					check(p, project, task, id)
					if in.Cursor != "body" || in.ResponseOverhead <= 0 {
						t.Errorf("entry input %+v", in)
					}
					return ss.NewReadResult(sp.EntryChunk{SessionID: id, HistoryEpoch: testTargetID, Source: "live", EntryID: testTargetID, Revision: "1", SHA256: strings.Repeat("a", 64), ByteLength: "4", Offset: "0", Fragment: "🙂", EOF: true, ObservedAt: sessionReadPage().ObservedAt}, nil), nil
				},
			}
			if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, version, "alice")
			for _, name := range []string{"current", "list", "show", "read", "entry"} {
				args := sessionReadArgs()
				if name == "current" || name == "list" {
					delete(args, "sessionId")
				}
				if name == "list" {
					args["cursor"] = "older"
				}
				if name == "read" {
					args["before"] = "older"
					args["conversation"] = true
				}
				if name == "entry" {
					args["cursor"] = "body"
				}
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_" + name, Arguments: args})
				if err != nil || result.IsError {
					t.Fatalf("%s: %+v %v", name, result, err)
				}
				validateDiscoveredResult(t, client, "task_session_"+name, result)
				if object(t, structured(t, result)["meta"])["writeOutcome"] != nil {
					t.Fatal("read invented write outcome")
				}
			}
			if calls != 5 {
				t.Fatalf("calls=%d", calls)
			}
			for _, patch := range []map[string]any{{"limit": 0}, {"limit": 201}, {"before": ""}, {"before": strings.Repeat("x", 4097)}, {"before": "🙂"}, {"responseOverhead": 0}, {"sessionId": "invalid"}, {"conversation": "true"}} {
				args := sessionReadArgs()
				for key, value := range patch {
					args[key] = value
				}
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_read", Arguments: args})
				if err != nil || !result.IsError || calls != 5 {
					t.Fatalf("invalid reached service: %+v %v calls=%d", patch, err, calls)
				}
				validateDiscoveredResult(t, client, "task_session_read", result)
			}
		})
	}
}

func TestSessionReadErrorsPreserveReferencesWithoutWriteReceipts(t *testing.T) {
	f := newSessionReadFixture(t)
	calls := 0
	mock := sessionReadMock{t: t, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
		calls++
		if calls == 1 {
			return nil, &model.Fault{Code: "reset_required", Message: "The content source changed."}
		}
		return nil, nil
	}}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, code := range []string{"reset_required", "internal_error"} {
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_read", Arguments: sessionReadArgs()})
		if err != nil || !result.IsError {
			t.Fatalf("%+v %v", result, err)
		}
		validateDiscoveredResult(t, client, "task_session_read", result)
		e := object(t, structured(t, result)["error"])
		if e["code"] != code || e["writeOutcome"] != nil || object(t, e["refs"])["sessionId"] != testUserID {
			t.Fatalf("read error lost facts: %+v", e)
		}
	}
}

func TestSessionReadSchemasRejectMalformedHistory(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name != "task_session_read" {
			continue
		}
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Fatal("readOnlyHint missing")
		}
		schema, err := resolveSchema(tool.OutputSchema)
		if err != nil {
			t.Fatal(err)
		}
		page := sessionReadPage()
		page.Items = []sp.MessageItem{{EntryID: testTargetID, EntrySeq: "1", Revision: "1", Kind: "reasoning", Body: json.RawMessage(`{"entryId":"` + testTargetID + `","entrySeq":"1","revision":"1","kind":"reasoning","text":"valid"}`), Resources: []sp.InspectionResource{}}}
		raw, _ := json.Marshal(envelope{Data: page, Meta: &envelopeMeta{RequestID: "r"}})
		if err := validateJSON(schema, raw); err != nil {
			t.Fatalf("valid body rejected: %v", err)
		}
		for _, body := range []string{`{"kind":"reasoning"}`, `{"entryId":"` + testTargetID + `","entrySeq":"1","revision":"1","kind":"reasoning","text":"valid","extra":true}`} {
			page.Items[0].Body = json.RawMessage(body)
			raw, _ := json.Marshal(envelope{Data: page, Meta: &envelopeMeta{RequestID: "r"}})
			if validateJSON(schema, raw) == nil {
				t.Fatal("malformed timeline body accepted")
			}
		}
	}
}

func TestSessionReadCurrentKeepsPartialInspectionAndNoRuntimeOutputAdmission(t *testing.T) {
	f := newSessionReadFixture(t)
	value := sessionReadInspection()
	value.Session.Observation = "unavailable"
	mock := sessionReadMock{t: t, current: func(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error) {
		return sp.TaskSessionCurrent{Status: "registered", ClaimID: &value.Fence.ClaimID, Session: &value}, nil
	}, read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
		page := sessionReadPage()
		page.Source = "schema-drift-probe"
		return ss.NewReadResult(page, nil), nil
	}}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := sessionReadArgs()
	delete(args, "sessionId")
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_current", Arguments: args})
	if err != nil || result.IsError {
		t.Fatalf("current: %+v %v", result, err)
	}
	validateDiscoveredResult(t, client, "task_session_current", result)
	meta := object(t, structured(t, result)["meta"])
	if meta["partial"] != true || meta["observedAt"] != value.Session.ObservedAt.Format(time.RFC3339Nano) {
		t.Fatalf("observation lost: %+v", meta)
	}
	// The published schema is strict; success validation belongs to contract
	// tests and the producer, rather than a second runtime MCP admission pass.
	result, err = client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_read", Arguments: sessionReadArgs()})
	if err != nil || result.IsError || object(t, structured(t, result)["data"])["source"] != "schema-drift-probe" {
		t.Fatalf("success validation was restored: %+v %v", result, err)
	}
}

func TestSessionReadEntryNilResultAndRegistrationDependencies(t *testing.T) {
	f := newSessionReadFixture(t)
	mock := sessionReadMock{t: t, entry: func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
		return nil, nil
	}}
	if RegisterSessionReadTools(nil, mock, mock) == nil || RegisterSessionReadTools(f.entry, nil, mock) == nil || RegisterSessionReadTools(f.entry, mock, nil) == nil {
		t.Fatal("missing dependency accepted")
	}
	if err := RegisterSessionReadTools(f.entry, mock, mock); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := sessionReadArgs()
	args["cursor"] = "body"
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_session_entry", Arguments: args})
	if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "internal_error" {
		t.Fatalf("missing result: %+v %v", result, err)
	}
}

func TestSessionReadBodySchemaAcceptsSharedCanonicalFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/history-canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Entry json.RawMessage `json:"entry"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	schema, err := resolveSchema(sessionReadBodySchema())
	if err != nil {
		t.Fatal(err)
	}
	if err := validateJSON(schema, fixture.Entry); err != nil {
		t.Fatalf("fractional form and exact decimal sequences: %v", err)
	}
}

type sessionReadFailedCloser struct{ calls int }

func (c *sessionReadFailedCloser) Close() error {
	c.calls++
	return fmt.Errorf("archive close failed")
}

func TestSessionReadCleanupFailuresRemainObservableAfterDelivery(t *testing.T) {
	for _, scoped := range []bool{false, true} {
		t.Run(fmt.Sprintf("scope=%t", scoped), func(t *testing.T) {
			var logs strings.Builder
			entry := &Entry{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			lease := &sessionReadFailedCloser{}
			ctx := t.Context()
			scope := &requestScope{}
			if scoped {
				ctx = context.WithValue(ctx, scopeKey{}, scope)
			}
			retainSessionRead(ctx, entry, lease)
			if scoped {
				if lease.calls != 0 || logs.Len() != 0 {
					t.Fatal("archive released before response delivery")
				}
				scope.delivered()
				scope.delivered()
			}
			var record map[string]any
			if lease.calls != 1 || json.Unmarshal([]byte(logs.String()), &record) != nil || record["phase"] != "session_read_cleanup" || record["error_code"] != "internal_error" || record["level"] != "ERROR" || strings.Contains(logs.String(), "archive close failed") {
				t.Fatalf("cleanup failure lost or repeated: calls=%d logs=%s", lease.calls, logs.String())
			}
		})
	}
}
