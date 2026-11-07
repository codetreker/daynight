package bot

import (
	"context"
	"errors"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type creationErrorReader struct {
	store.BotReader
	err error
}

func (r creationErrorReader) Bot(context.Context, string) (model.Bot, error) {
	return model.Bot{}, model.ErrNotFound
}
func (r creationErrorReader) BotPreferredWorker(context.Context, string) (*string, error) {
	return nil, r.err
}

type creationErrorCredential struct{ store.CredentialReader }

func (creationErrorCredential) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, nil
}

type creationErrorScope struct {
	store.SnapshotScope
	reader creationErrorReader
}

func (s creationErrorScope) CredentialDAO() store.CredentialReader { return creationErrorCredential{} }
func (s creationErrorScope) BotDAO() store.BotReader               { return s.reader }

type creationErrorStore struct {
	store.BotWriter
	reader  creationErrorReader
	cleanup error
}

func (s creationErrorStore) ReadSnapshot(_ context.Context, operation func(store.SnapshotScope) error) error {
	err := operation(creationErrorScope{reader: s.reader})
	if s.cleanup != nil {
		return errors.Join(err, s.cleanup)
	}
	return err
}

func TestCreationSnapshotPreservesReadAndCleanupErrors(t *testing.T) {
	fault := &model.Fault{Code: "active_worker_limit_exceeded", Message: "limit"}
	sentinel := errors.New("database failure")
	for _, tc := range []struct {
		name                string
		read, cleanup, want error
	}{
		{"joined read", errors.Join(fault, sentinel), nil, sentinel},
		{"snapshot cleanup", fault, sentinel, sentinel},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := New(creationErrorStore{reader: creationErrorReader{err: tc.read}, cleanup: tc.cleanup})
			_, err := service.prepareCreation(context.Background(), model.Principal{UserID: "owner"}, botcore.CreateBot{ID: "bot"})
			if !errors.Is(err, tc.want) || !errors.Is(err, fault) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
}
