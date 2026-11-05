package bot

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const workerID = "624f73c9-e6b5-4806-8c8d-4c04690d1d1b"
const botID = "adb5dd26-9410-4145-b328-6f7a7c7d39de"

func ptr(s string) *string { return &s }
func assertFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}
func input() CreateBot {
	return CreateBot{ID: botID, Name: "  Assistant  ", ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/work", Provider: "codex"}}
}

type botDAO struct {
	store.BotWriteDAO
	current         *model.Bot
	defaults        model.BotDefaultsInput
	fail            map[string]error
	credentialCalls int
	credentialAt    int
}

func (d *botDAO) Credential(context.Context, model.Principal) error {
	d.credentialCalls++
	if d.credentialAt == 0 || d.credentialAt == d.credentialCalls {
		return d.fail["credential"]
	}
	return nil
}
func (d *botDAO) LockCreation(context.Context, string) error { return d.fail["lock"] }
func (d *botDAO) Bot(context.Context, string) (model.Bot, error) {
	if e := d.fail["bot"]; e != nil {
		return model.Bot{}, e
	}
	if d.current == nil {
		return model.Bot{}, model.ErrNotFound
	}
	return *d.current, nil
}
func (d *botDAO) Worker(context.Context, string, string) error { return d.fail["worker"] }
func (d *botDAO) BotDefaults(context.Context, string) (model.BotDefaultsInput, error) {
	return d.defaults, d.fail["defaults"]
}
func (d *botDAO) InsertBot(_ context.Context, b model.Bot) error {
	if e := d.fail["insert"]; e != nil {
		return e
	}
	b.Version = 1
	d.current = &b
	return nil
}
func (d *botDAO) DeleteBot(_ context.Context, _ string, _ int64, deletion model.BotDeletion) (model.Bot, error) {
	if e := d.fail["delete"]; e != nil {
		return model.Bot{}, e
	}
	b := *d.current
	b.Version++
	b.Deletion = &deletion
	d.current = &b
	return b, nil
}

type reader struct {
	store.BotReader
	current  model.Bot
	records  store.BotPage
	defaults model.BotDefaultsInput
	fail     map[string]error
}

func (r *reader) Bot(context.Context, string) (model.Bot, error) { return r.current, r.fail["bot"] }
func (r *reader) Bots(context.Context, string, *string, store.Page) (store.BotPage, error) {
	return r.records, r.fail["list"]
}
func (r *reader) BotWorker(context.Context, string, string) error { return r.fail["worker"] }
func (r *reader) BotDefaults(context.Context, string) (model.BotDefaultsInput, error) {
	return r.defaults, r.fail["defaults"]
}

type credentialReader struct{ err error }

func (c credentialReader) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, c.err
}

type snapshot struct {
	store.SnapshotScope
	r   *reader
	err error
}

func (s snapshot) CredentialDAO() store.CredentialReader { return credentialReader{s.err} }
func (s snapshot) BotDAO() store.BotReader               { return s.r }

func TestNormalizeRequestsAndFrozenConfiguration(t *testing.T) {
	valid := input()
	valid.ID = strings.ToUpper(valid.ID)
	valid.Overrides.WorkerID = ptr(strings.ToUpper(workerID))
	valid.Overrides.Cwd = ptr("/work")
	valid.Overrides.Provider = ptr("codex")
	normalized, fingerprint, err := NormalizeBotRequest(valid)
	if err != nil || normalized.ID != botID || normalized.Name != "Assistant" || *normalized.Overrides.WorkerID != workerID || len(fingerprint) != 64 {
		t.Fatalf("normalization: %+v %s %v", normalized, fingerprint, err)
	}
	c, err := normalizeBotConfiguration(normalized)
	if err != nil || c.Args == nil {
		t.Fatalf("config: %+v %v", c, err)
	}
	for _, mutate := range []func(*CreateBot){func(v *CreateBot) { v.ID = "bad" }, func(v *CreateBot) { v.Name = "\x00" }, func(v *CreateBot) { v.Name = " " }, func(v *CreateBot) { v.Name = strings.Repeat("a", 41) }, func(v *CreateBot) { v.Overrides.WorkerID = ptr("bad") }, func(v *CreateBot) { v.Overrides.Cwd = ptr("relative") }, func(v *CreateBot) { v.Overrides.Provider = ptr("bad") }} {
		v := input()
		mutate(&v)
		_, _, err := NormalizeBotRequest(v)
		assertFault(t, err, "invalid_input")
	}
	for _, mutate := range []func(*CreateBot){func(v *CreateBot) { v.ResolvedConfiguration.WorkerID = "bad" }, func(v *CreateBot) { v.ResolvedConfiguration.Cwd = "relative" }, func(v *CreateBot) { v.ResolvedConfiguration.Provider = "bad" }, func(v *CreateBot) { v.ResolvedConfiguration.Model = ptr(" ") }, func(v *CreateBot) { v.ResolvedConfiguration.Args = []string{"x\x00"} }, func(v *CreateBot) { v.Overrides.WorkerID = ptr(botID) }, func(v *CreateBot) { v.Overrides.Cwd = ptr("/other") }, func(v *CreateBot) { v.Overrides.Provider = ptr("claude") }} {
		v := input()
		mutate(&v)
		_, err := normalizeBotConfiguration(v)
		assertFault(t, err, "invalid_input")
	}
	for _, v := range []string{"/x", `C:\x`, `D:/x`, `\\host\share\x`} {
		if !botAbsolutePath(v) {
			t.Fatalf("valid path %q", v)
		}
	}
	for _, v := range []string{"x", `\\host`, "/bad\npath", string([]byte{0xff})} {
		if botAbsolutePath(v) {
			t.Fatalf("invalid path %q", v)
		}
	}
}

func TestCreateIdentityAndFailurePaths(t *testing.T) {
	ctx := context.Background()
	p := model.Principal{UserID: "owner"}
	in, fp, err := NormalizeBotRequest(input())
	if err != nil {
		t.Fatal(err)
	}
	d := &botDAO{fail: map[string]error{}}
	made, err := Create(ctx, d, p, in, fp, false)
	if err != nil || made.OwnerUserID != p.UserID || made.Name != "Assistant" {
		t.Fatalf("create: %+v %v", made, err)
	}
	d.fail["worker"] = model.ErrNotFound
	in.ResolvedConfiguration.Cwd = "/changed"
	replay, err := Create(ctx, d, p, in, fp, true)
	if err != nil || replay.ResolvedConfiguration.Cwd != "/work" {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	_, err = Create(ctx, d, model.Principal{UserID: "other"}, in, fp, false)
	assertFault(t, err, "forbidden")
	_, err = Create(ctx, d, p, in, "other", false)
	assertFault(t, err, "resource_conflict")
	sentinel := errors.New("failure")
	for _, stage := range []string{"lock", "bot", "worker", "insert", "defaults"} {
		t.Run(stage, func(t *testing.T) {
			d := &botDAO{fail: map[string]error{stage: sentinel}}
			_, e := Create(ctx, d, p, in, fp, stage == "defaults")
			if !errors.Is(e, sentinel) {
				t.Fatalf("%s: %v", stage, e)
			}
		})
	}
	for _, at := range []int{1, 2} {
		d := &botDAO{fail: map[string]error{"credential": model.ErrNotFound}, credentialAt: at}
		_, err := Create(ctx, d, p, in, fp, false)
		assertFault(t, err, "unauthenticated")
	}
	d = &botDAO{fail: map[string]error{"worker": model.ErrNotFound}}
	_, err = Create(ctx, d, p, in, fp, false)
	assertFault(t, err, "forbidden")
	d = &botDAO{fail: map[string]error{}, defaults: model.BotDefaultsInput{}}
	_, err = Create(ctx, d, p, in, fp, true)
	assertFault(t, err, "resource_conflict")
}

func TestDeleteIntentAndErrors(t *testing.T) {
	ctx := context.Background()
	p := model.Principal{UserID: "owner"}
	request := store.DeleteBot{Version: 1, DeletionID: botID}
	d := &botDAO{current: &model.Bot{ID: botID, OwnerUserID: p.UserID, Version: 1}, fail: map[string]error{}}
	deleted, err := Delete(ctx, d, p, botID, request)
	if err != nil || deleted.Version != 2 || deleted.Deletion.WorkerCleanup.State != "pending" {
		t.Fatalf("delete: %+v %v", deleted, err)
	}
	replay, err := Delete(ctx, d, p, botID, request)
	if err != nil || replay.Version != 2 {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	changed := request
	changed.DeletionID = workerID
	_, err = Delete(ctx, d, p, botID, changed)
	assertFault(t, err, "resource_conflict")
	for _, tc := range []struct {
		name string
		bot  *model.Bot
		req  store.DeleteBot
		code string
	}{
		{"missing", nil, request, "not_found"}, {"owner", &model.Bot{OwnerUserID: "other"}, request, "forbidden"}, {"stale", &model.Bot{OwnerUserID: "owner", Version: 2}, request, "version_conflict"}, {"bound", &model.Bot{OwnerUserID: "owner", Version: 1, SessionID: ptr(botID)}, request, "resource_conflict"}, {"exhausted", &model.Bot{OwnerUserID: "owner", Version: math.MaxInt64}, store.DeleteBot{Version: math.MaxInt64}, "version_exhausted"}} {
		t.Run(tc.name, func(t *testing.T) {
			d := &botDAO{current: tc.bot, fail: map[string]error{}}
			_, err := Delete(ctx, d, p, botID, tc.req)
			assertFault(t, err, tc.code)
		})
	}
	sentinel := errors.New("failed")
	for _, stage := range []string{"bot", "delete"} {
		d := &botDAO{current: &model.Bot{OwnerUserID: "owner", Version: 1}, fail: map[string]error{stage: sentinel}}
		_, err := Delete(ctx, d, p, botID, request)
		if !errors.Is(err, sentinel) {
			t.Fatal(err)
		}
	}
	for _, at := range []int{1, 2} {
		d := &botDAO{current: &model.Bot{OwnerUserID: "owner", Version: 1}, fail: map[string]error{"credential": model.ErrNotFound}, credentialAt: at}
		_, err := Delete(ctx, d, p, botID, request)
		assertFault(t, err, "unauthenticated")
	}
}

func TestReadScopeAndCompletionErrors(t *testing.T) {
	ctx := context.Background()
	p := model.Principal{UserID: "owner"}
	r := &reader{current: model.Bot{ID: botID, OwnerUserID: "owner", CreatedAt: time.Now()}, fail: map[string]error{}}
	s := snapshot{r: r}
	if _, err := Get(ctx, s, p, botID); err != nil {
		t.Fatal(err)
	}
	_, err := Get(ctx, snapshot{r: r, err: model.ErrNotFound}, p, botID)
	assertFault(t, err, "unauthenticated")
	r.fail["bot"] = model.ErrNotFound
	_, err = Get(ctx, s, p, botID)
	assertFault(t, err, "not_found")
	delete(r.fail, "bot")
	_, err = Get(ctx, s, model.Principal{UserID: "other"}, botID)
	assertFault(t, err, "forbidden")
	r.records = store.BotPage{Items: []model.Bot{r.current}, HasMore: true}
	page, err := ListPage(p, nil, model.PageRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	records, err := List(ctx, s, p, nil, page)
	if err != nil {
		t.Fatal(err)
	}
	result, err := ListResult(p, nil, records)
	if err != nil || result.NextCursor == nil {
		t.Fatalf("cursor: %+v %v", result, err)
	}
	r.fail["worker"] = model.ErrNotFound
	_, err = List(ctx, s, p, ptr(workerID), page)
	assertFault(t, err, "forbidden")
	_, err = List(ctx, snapshot{r: r, err: model.ErrNotFound}, p, nil, page)
	assertFault(t, err, "unauthenticated")
	_, err = Defaults(ctx, snapshot{r: r, err: model.ErrNotFound}, p, nil)
	assertFault(t, err, "unauthenticated")
	sentinel := errors.New("failed")
	r.fail["bot"] = sentinel
	_, err = Get(ctx, s, p, botID)
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	r.fail["defaults"] = sentinel
	_, err = Defaults(ctx, s, p, nil)
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	refusal := &model.Fault{Code: "forbidden"}
	tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refusal}
	if ResultError("create", tx) != refusal {
		t.Fatal("confirmed refusal lost")
	}
	tx.CleanupFailed = true
	var op *model.BotOperationError
	if !errors.As(ResultError("create", tx), &op) {
		t.Fatal("uncertain cleanup became refusal")
	}
}
