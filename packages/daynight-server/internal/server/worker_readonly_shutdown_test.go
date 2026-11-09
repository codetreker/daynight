package server

import (
	"context"
	"log/slog"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/google/uuid"
)

func TestApplicationBeginShutdownStopsWorkerReadOnlyAdmission(t *testing.T) {
	broker := ro.New(func(context.Context, model.Principal, string) error { return nil })
	routes := workerhttp.NewReadOnlyRoutes(broker, nil, slog.Default())
	app := &sessionApplication{workerReadOnly: routes}
	app.BeginShutdown()
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err := broker.Connect(context.Background(), p, uuid.NewString(), ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
	if ro.ErrorCode(err) != "offline" {
		t.Fatal("application shutdown retained Worker admission", err)
	}
	if err := routes.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
