package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpBotExpectedCall struct {
	name   string
	args   []any
	result []any
	check  func([]any)
}
type mcpBotCallScript struct {
	t     *testing.T
	calls []mcpBotExpectedCall
	next  int
}

func mcpBotScript(t *testing.T, calls ...mcpBotExpectedCall) *mcpBotCallScript {
	s := &mcpBotCallScript{t: t, calls: calls}
	t.Cleanup(s.verify)
	return s
}
func (s *mcpBotCallScript) call(name string, args ...any) []any {
	if s.next >= len(s.calls) {
		unexpectedHTTPCall(s.t, "MCP Bot "+name)
	}
	c := s.calls[s.next]
	s.next++
	if name != c.name || c.check == nil && !reflect.DeepEqual(args, c.args) {
		s.t.Errorf("MCP Bot call %d got %s %#v, want %s %#v", s.next, name, args, c.name, c.args)
		panic("MCP Bot DAO call mismatch")
	}
	if c.check != nil {
		c.check(args)
	}
	return mcpCloneFixture(c.result)
}
func (s *mcpBotCallScript) verify() {
	if s.next != len(s.calls) {
		s.t.Errorf("MCP Bot calls=%d, want %d", s.next, len(s.calls))
	}
}
func mcpBotCall(name string, args []any, result ...any) mcpBotExpectedCall {
	return mcpBotExpectedCall{name: name, args: mcpCloneFixture(args), result: result}
}
func mcpBotErr(value any) error {
	if value == nil {
		return nil
	}
	return value.(error)
}
func mcpCloneFixture[T any](value T) T {
	if any(value) == nil {
		return value
	}
	errorType := reflect.TypeFor[error]()
	var clone func(reflect.Value) reflect.Value
	clone = func(in reflect.Value) reflect.Value {
		if !in.IsValid() {
			return in
		}
		if in.Type().Implements(errorType) || in.Type() == reflect.TypeFor[time.Time]() {
			return in
		}
		switch in.Kind() {
		case reflect.Interface:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.New(in.Type()).Elem()
			out.Set(clone(in.Elem()))
			return out
		case reflect.Pointer:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.New(in.Type().Elem())
			out.Elem().Set(clone(in.Elem()))
			return out
		case reflect.Slice:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.MakeSlice(in.Type(), in.Len(), in.Len())
			for i := 0; i < in.Len(); i++ {
				out.Index(i).Set(clone(in.Index(i)))
			}
			return out
		case reflect.Map:
			if in.IsNil() {
				return reflect.Zero(in.Type())
			}
			out := reflect.MakeMapWithSize(in.Type(), in.Len())
			iter := in.MapRange()
			for iter.Next() {
				out.SetMapIndex(iter.Key(), clone(iter.Value()))
			}
			return out
		case reflect.Struct:
			out := reflect.New(in.Type()).Elem()
			out.Set(in)
			for i := 0; i < in.NumField(); i++ {
				if out.Field(i).CanSet() && in.Field(i).CanInterface() {
					out.Field(i).Set(clone(in.Field(i)))
				}
			}
			return out
		default:
			return in
		}
	}
	return clone(reflect.ValueOf(value)).Interface().(T)
}

func mcpBotCredentialCall(p model.Principal) mcpBotExpectedCall {
	return mcpBotCall("Credential", []any{p}, nil)
}
func mcpBotLockCredentialCall(t *testing.T, p model.Principal) mcpBotExpectedCall {
	earliest := time.Now()
	return mcpBotExpectedCall{name: "LockCredential", result: []any{nil}, check: func(args []any) {
		observed := time.Now()
		if len(args) != 2 {
			t.Errorf("MCP Bot credential arguments = %#v, want principal and query time", args)
			panic("MCP Bot credential argument count")
		}
		now, ok := args[1].(time.Time)
		if args[0] != p || !ok || now.IsZero() || now.Before(earliest) || now.After(observed) {
			t.Errorf("MCP Bot credential actor=%#v want=%#v queryTime=%v (%T), allowed=[%v,%v]", args[0], p, args[1], args[1], earliest, observed)
			panic("MCP Bot credential actor or query time mismatch")
		}
	}}
}

type mcpBotReader struct {
	s *mcpBotCallScript
}

func (d *mcpBotReader) Bot(ctx context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotReader) Bots(ctx context.Context, owner string, worker *string, page store.Page) (store.BotPage, error) {
	r := d.s.call("Bots", owner, worker, page)
	return r[0].(store.BotPage), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	r := d.s.call("BotPreferredWorker", owner)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidate", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidates", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationWorker", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotReader) BotWorker(ctx context.Context, owner, id string) error {
	return mcpBotErr(d.s.call("BotWorker", owner, id)[0])
}
func (d *mcpBotReader) BotDefaults(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotDefaults", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}

type mcpBotWriteDAO struct {
	s *mcpBotCallScript
}

func (d *mcpBotWriteDAO) Credential(ctx context.Context, p model.Principal) error {
	return mcpBotErr(d.s.call("Credential", p)[0])
}
func (d *mcpBotWriteDAO) Worker(ctx context.Context, owner, id string) error {
	return mcpBotErr(d.s.call("Worker", owner, id)[0])
}
func (d *mcpBotWriteDAO) LockCreation(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("LockCreation", id)[0])
}
func (d *mcpBotWriteDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	r := d.s.call("Bot", id)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	r := d.s.call("BotPreferredWorker", owner)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationCandidate(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidate", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationCandidates", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotCreationWorker(ctx context.Context, owner, id string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotCreationWorker", owner, id)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BotDefaults(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	r := d.s.call("BotDefaults", owner)
	return r[0].(model.BotDefaultsInput), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) InsertBot(ctx context.Context, b model.Bot) error {
	return mcpBotErr(d.s.call("InsertBot", b)[0])
}
func (d *mcpBotWriteDAO) SaveBotDeletion(ctx context.Context, id string, v *model.BotDeletion) (model.Bot, error) {
	r := d.s.call("SaveBotDeletion", id, v)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) BindBotSession(ctx context.Context, id string, version int64, session string, role model.BotRoleConfiguration) (model.Bot, error) {
	r := d.s.call("BindBotSession", id, version, session, role)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	r := d.s.call("SetBotStartup", id, version, result)
	return r[0].(model.Bot), mcpBotErr(r[1])
}
func (d *mcpBotWriteDAO) CommitBotPreferences(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("CommitBotPreferences", id)[0])
}

type mcpBotCredentialReader struct{ s *mcpBotCallScript }

func (d mcpBotCredentialReader) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.s.call("Credential", p)
	return store.ThreadCredential{}, nil
}

type mcpBotScope struct{ dao store.BotWriteDAO }

func (s mcpBotScope) BotDAO() store.BotWriteDAO { return s.dao }

type mcpBotSessionScope struct {
	session store.SessionDAO
	bot     store.BotWriteDAO
}

func (s mcpBotSessionScope) SessionDAO() store.SessionDAO { return s.session }
func (s mcpBotSessionScope) BotDAO() store.BotWriteDAO    { return s.bot }

type mcpBotSessionDAO struct {
	sessionHTTPRejectedDAO
	s *mcpBotCallScript
}

func (d *mcpBotSessionDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	return mcpBotErr(d.s.call("LockCredential", p, now)[0])
}
func (d *mcpBotSessionDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	r := d.s.call("SessionLocation", id)
	return r[0].(store.SessionLocation), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	r := d.s.call("SessionBotID", id)
	return r[0].(*string), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	r := d.s.call("LockSession", id)
	return r[0].(store.SessionRecord), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) InsertBotSession(ctx context.Context, v store.SessionRegistration) (bool, error) {
	r := d.s.call("InsertBotSession", v)
	return r[0].(bool), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) LockBotSessions(ctx context.Context, id string) ([]store.BotSession, error) {
	r := d.s.call("LockBotSessions", id)
	return r[0].([]store.BotSession), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) RevokeBotSessions(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("RevokeBotSessions", id)[0])
}
func (d *mcpBotSessionDAO) LockBotSessionStop(ctx context.Context, id, bot, owner string) (store.BotSessionStop, error) {
	r := d.s.call("LockBotSessionStop", id, bot, owner)
	return r[0].(store.BotSessionStop), mcpBotErr(r[1])
}
func (d *mcpBotSessionDAO) DeleteBotSession(ctx context.Context, id, bot string) error {
	return mcpBotErr(d.s.call("DeleteBotSession", id, bot)[0])
}
func (d *mcpBotSessionDAO) RedactDeletedBot(ctx context.Context, id string) error {
	return mcpBotErr(d.s.call("RedactDeletedBot", id)[0])
}
func mcpBotResult(err error) (store.Completion, error) {
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func mcpBotSnapshot(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("ReadSnapshot", nil)}, calls...)...)
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		s.call("ReadSnapshot")
		scope := newHTTPTestSnapshot(t)
		scope.Credentials = mcpBotCredentialReader{s: s}
		scope.Bots = &mcpBotReader{s: s}
		err := fn(scope)
		s.verify()
		return err
	}
}
func mcpBotWrite(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("WriteBot", nil)}, calls...)...)
	tx.WriteBotCall = func(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
		s.call("WriteBot")
		err := fn(mcpBotScope{dao: &mcpBotWriteDAO{s: s}})
		s.verify()
		return mcpBotResult(err)
	}
}
func mcpBotSession(t *testing.T, tx *httpTestStore, calls ...mcpBotExpectedCall) {
	s := mcpBotScript(t, append([]mcpBotExpectedCall{mcpBotCall("WriteSession", nil)}, calls...)...)
	tx.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		s.call("WriteSession")
		err := fn(mcpBotSessionScope{session: &mcpBotSessionDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, s: s}, bot: &mcpBotWriteDAO{s: s}})
		s.verify()
		return mcpBotResult(err)
	}
}
func mcpBotDefaults(owner, worker string, now time.Time) model.BotDefaultsInput {
	modelName, reason := "gpt-5", "not_found"
	host := &model.WorkerAssistantHost{
		ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot,
		Providers: []model.WorkerAssistantProvider{
			{Provider: model.AgentCodex, Available: true, Args: []string{}},
			{Provider: model.AgentClaude, Available: false, Reason: &reason, Args: []string{}},
			{Provider: model.AgentCopilot, Available: true, Model: &modelName, Args: []string{"--effort", "high"}},
		},
	}
	return model.BotDefaultsInput{
		ObservedAt:        now,
		Workers:           []model.WorkerSnapshot{{UserID: owner, WorkerID: worker, CreatedAt: now.Add(-time.Minute), LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}}},
		WorkerPreferences: map[string]model.BotWorkerPreference{},
	}
}
func mcpBotCreation(t *testing.T, tx *httpTestStore, p model.Principal, defaults model.BotDefaultsInput, want model.Bot) {
	selection := func() []mcpBotExpectedCall {
		if want.RequestedOverrides.WorkerID != nil {
			return []mcpBotExpectedCall{mcpBotCall("BotCreationWorker", []any{p.UserID, want.WorkerID}, defaults, nil)}
		}
		return []mcpBotExpectedCall{mcpBotCall("BotPreferredWorker", []any{p.UserID}, (*string)(nil), nil), mcpBotCall("BotCreationCandidates", []any{p.UserID}, defaults, nil), mcpBotCall("BotCreationWorker", []any{p.UserID, want.WorkerID}, defaults, nil)}
	}
	reads := append([]mcpBotExpectedCall{mcpBotCredentialCall(p), mcpBotCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	mcpBotSnapshot(t, tx, reads...)
	insert := model.Bot{ID: want.ID, OwnerUserID: p.UserID, WorkerID: want.WorkerID, Name: want.Name, RequestFingerprint: want.RequestFingerprint, RequestedOverrides: want.RequestedOverrides, ResolvedConfiguration: want.ResolvedConfiguration}
	writes := append([]mcpBotExpectedCall{mcpBotCredentialCall(p), mcpBotCall("LockCreation", []any{want.ID}, nil), mcpBotCall("Bot", []any{want.ID}, model.Bot{}, model.ErrNotFound)}, selection()...)
	writes = append(writes, mcpBotCall("Worker", []any{p.UserID, want.WorkerID}, nil), mcpBotCall("InsertBot", []any{insert}, nil), mcpBotCall("Bot", []any{want.ID}, want, nil), mcpBotCredentialCall(p))
	mcpBotWrite(t, tx, writes...)
}
func mcpBotModel(owner, worker, id, name string, overrides model.BotOverrides, configuration model.BotConfiguration, now time.Time) model.Bot {
	raw, _ := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
	}{Name: name, Overrides: overrides})
	sum := sha256.Sum256(raw)
	return model.Bot{ID: id, OwnerUserID: owner, WorkerID: worker, Name: name, Version: 1, CreationOrder: 1, RequestFingerprint: hex.EncodeToString(sum[:]), RequestedOverrides: overrides, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}

var _ store.BotReader = (*mcpBotReader)(nil)
var _ store.BotWriteDAO = (*mcpBotWriteDAO)(nil)
var _ store.SessionDAO = (*mcpBotSessionDAO)(nil)
