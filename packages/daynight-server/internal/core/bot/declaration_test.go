package bot

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type declaredBotDAO struct {
	bot   model.Bot
	err   error
	reads []string
}

func (d *declaredBotDAO) Bot(_ context.Context, id string) (model.Bot, error) {
	d.reads = append(d.reads, id)
	return d.bot, d.err
}

func TestAdmitDeclaredBotAcceptsOnlyTheOwnersLiveBot(t *testing.T) {
	const owner, other, id = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	failure := errors.New("barrier failed")
	for _, tc := range []struct {
		name  string
		id    string
		oauth bool
		dao   declaredBotDAO
		code  string
		err   error
	}{
		{name: "own live Bot", id: id, dao: declaredBotDAO{bot: model.Bot{ID: id, OwnerUserID: owner}}},
		{name: "OAuth credential", id: id, oauth: true, dao: declaredBotDAO{bot: model.Bot{ID: id, OwnerUserID: owner}}, code: "forbidden"},
		{name: "missing", id: id, dao: declaredBotDAO{err: errors.Join(model.ErrNotFound, errors.New("no rows"))}, code: "forbidden"},
		{name: "foreign", id: id, dao: declaredBotDAO{bot: model.Bot{ID: id, OwnerUserID: other}}, code: "forbidden"},
		{name: "deleted", id: id, dao: declaredBotDAO{bot: model.Bot{ID: id, OwnerUserID: owner, Deletion: &model.BotDeletion{}}}, code: "forbidden"},
		{name: "barrier failure", id: id, dao: declaredBotDAO{err: failure}, err: failure},
		{name: "uppercase", id: "33333333-3333-4333-8333-33333333333A", code: "invalid_input"},
		{name: "nil", id: "00000000-0000-0000-0000-000000000000", code: "invalid_input"},
		{name: "malformed", id: "bad", code: "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			principal := model.Principal{UserID: owner, CredentialID: other, Kind: model.PATCredential}
			if tc.oauth {
				principal.Kind = model.OAuthCredential
			}
			err := AdmitDeclaredBot(t.Context(), &tc.dao, principal, tc.id)
			var fault *model.Fault
			switch {
			case tc.code == "" && tc.err == nil && err != nil:
				t.Fatalf("own Bot refused: %v", err)
			case tc.code != "" && (!errors.As(err, &fault) || fault.Code != tc.code):
				t.Fatalf("refusal = %v, want %s", err, tc.code)
			case tc.err != nil && !errors.Is(err, tc.err):
				t.Fatalf("failure = %v, want %v", err, tc.err)
			}
			refusedEarly := tc.code == "invalid_input" || tc.oauth
			if refusedEarly && len(tc.dao.reads) != 0 || !refusedEarly && (len(tc.dao.reads) != 1 || tc.dao.reads[0] != tc.id) {
				t.Fatalf("barrier reads: %v", tc.dao.reads)
			}
		})
	}
}
