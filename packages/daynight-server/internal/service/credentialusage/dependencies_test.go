package credentialusage

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type dependencyWriter struct{}

func (*dependencyWriter) WriteCredentialUsage(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
	panic("constructor must not call writer")
}

type dependencyFunc func(context.Context, []model.CredentialUsageEvent) (store.Completion, error)

func (f dependencyFunc) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	return f(ctx, events)
}

func TestConstructorRejectsTypedNilWriters(t *testing.T) {
	var pointer *dependencyWriter
	var function dependencyFunc
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for name, writer := range map[string]store.CredentialUsageWriter{"pointer": pointer, "function": function} {
		t.Run(name, func(t *testing.T) {
			if recorder, err := New(writer, logger, nil); recorder != nil || !errors.Is(err, ErrDependency) {
				t.Fatalf("New returned %v, %v; want missing dependency", recorder, err)
			}
		})
	}
	if _, err := New(&dependencyWriter{}, logger, nil); err != nil {
		t.Fatalf("non-nil writer rejected: %v", err)
	}
}
