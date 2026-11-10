package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type oauthBotReader struct {
	store.BotReader
	t               *testing.T
	ctx             context.Context
	principal       model.Principal
	steps           []string
	value           model.Bot
	credentialError error
}

func (r *oauthBotReader) called(ctx context.Context, name string) {
	r.t.Helper()
	if ctx != r.ctx || len(r.steps) == 0 || r.steps[0] != name {
		r.t.Fatalf("unexpected OAuth Bot %s: context matches=%v, remaining=%v", name, ctx == r.ctx, r.steps)
	}
	r.steps = r.steps[1:]
}
func (r *oauthBotReader) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	r.called(ctx, "credential")
	if p != r.principal {
		r.t.Fatalf("OAuth Bot principal: got=%+v want=%+v", p, r.principal)
	}
	return store.ThreadCredential{}, r.credentialError
}
func (r *oauthBotReader) Bot(ctx context.Context, id string) (model.Bot, error) {
	r.called(ctx, "bot")
	if id != r.value.ID {
		r.t.Fatalf("OAuth Bot read ID: %q", id)
	}
	return cloneContractBot(r.value), nil
}

type oauthBotSnapshot struct {
	store.SnapshotScope
	reader *oauthBotReader
}

func (s oauthBotSnapshot) CredentialDAO() store.CredentialReader { return s.reader }
func (s oauthBotSnapshot) BotDAO() store.BotReader               { return s.reader }

func TestOAuthBotCredentialGatesCreationAndRead(t *testing.T) {
	p := model.Principal{Kind: model.OAuthCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "f6666666-6666-4666-8666-666666666666"}
	const id = "a4444444-4444-4444-8444-444444444444"
	const worker = "b5555555-5555-4555-8555-555555555555"
	now := time.Date(2026, 11, 11, 1, 2, 3, 4000, time.UTC)
	in := CreateBot{ID: id, Name: "OAuth Bot", ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}}
	fingerprint := contractFingerprint(t, "OAuth Bot", model.BotOverrides{})
	want := model.Bot{ID: id, OwnerUserID: p.UserID, WorkerID: worker, Name: "OAuth Bot", Version: 1, RequestFingerprint: fingerprint, CreatedAt: now, UpdatedAt: now, ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}}
	candidate := cloneContractBot(want)
	candidate.Version = 0
	candidate.CreatedAt, candidate.UpdatedAt = time.Time{}, time.Time{}
	dao := &creationContractDAO{t: t, ctx: t.Context(), principal: p, steps: []string{"credential", "lock", "bot", "worker", "insert", "bot", "credential"}, candidate: candidate, result: cloneContractBot(want)}
	created, err := Create(t.Context(), dao, p, in, fingerprint, false)
	if err != nil || !reflect.DeepEqual(created, want) || len(dao.steps) != 0 {
		t.Fatalf("OAuth Bot create: got=%#v want=%#v error=%v remaining=%v", created, want, err, dao.steps)
	}
	for _, name := range []string{"valid", "forged", "revoked"} {
		t.Run(name, func(t *testing.T) {
			principal := p
			steps := []string{"credential", "bot"}
			var credentialError error
			if name != "valid" {
				steps = []string{"credential"}
				credentialError = model.ErrNotFound
				if name == "forged" {
					principal.CredentialID = "f3333333-3333-4333-8333-333333333333"
				}
			}
			reader := &oauthBotReader{t: t, ctx: t.Context(), principal: principal, steps: steps, value: cloneContractBot(want), credentialError: credentialError}
			got, err := Get(t.Context(), oauthBotSnapshot{reader: reader}, principal, id)
			if name == "valid" {
				if err != nil || !reflect.DeepEqual(got, want) {
					t.Fatalf("OAuth Bot read: got=%#v want=%#v error=%v", got, want, err)
				}
			} else {
				assertFault(t, err, "unauthenticated")
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("credential refusal lost cause: %v", err)
				}
				if !reflect.DeepEqual(got, model.Bot{}) {
					t.Fatalf("refused OAuth Bot returned %#v", got)
				}
			}
			if len(reader.steps) != 0 {
				t.Fatalf("remaining OAuth Bot calls: %v", reader.steps)
			}
		})
	}
}
