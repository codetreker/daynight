package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestGenerationGrantEntrypointsRecoverBeforeCallingTheirCoreOperations(t *testing.T) {
	for _, bot := range []bool{false, true} {
		for _, point := range []string{"ordinary", "generation", "recovery failure", "grant failure", "stopped"} {
			t.Run(map[bool]string{false: "task", true: "bot"}[bot]+"/"+point, func(t *testing.T) {
				engine := core.NewEngine(nil)
				service := &Service{engine: engine}
				if point == "stopped" {
					if err := engine.Stop(t.Context()); err != nil {
						t.Fatal(err)
					}
				}
				cause := errors.New("controlled " + point)
				p := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "parent"}
				previous := "1"
				g := sp.Grant{ExecutionGeneration: "2", PreviousGeneration: &previous}
				if point == "ordinary" {
					g.PreviousGeneration = nil
				}
				var calls []string
				var recovered context.Context
				recover := func(ctx context.Context) error {
					calls = append(calls, "recover")
					recovered = ctx
					if point == "recovery failure" {
						return cause
					}
					return nil
				}
				result := core.GrantResult{Token: "original", ExecutionGeneration: "2"}
				run := func(ctx context.Context, actual model.Principal, project, task, id string, grant sp.Grant) (core.GrantResult, error) {
					if actual != p || project != "project" || task != "task" || id != "session" || !reflect.DeepEqual(grant, g) {
						t.Fatal("grant binding changed")
					}
					if point != "ordinary" && ctx != recovered {
						t.Fatal("grant did not share recovery context")
					}
					calls = append(calls, "grant")
					if point == "grant failure" {
						return core.GrantResult{}, cause
					}
					return result, nil
				}
				var out core.GrantResult
				var err error
				if bot {
					input := core.BotGrant{BotVersion: 7, Grant: g}
					out, err = service.botGrantWithMediaRecovery(t.Context(), p, "worker", "bot", input, recover, func(ctx context.Context, actual model.Principal, worker, id string, got core.BotGrant) (core.GrantResult, error) {
						if worker != "worker" || id != "bot" || !reflect.DeepEqual(got, input) {
							t.Fatal("Bot grant binding changed")
						}
						return run(ctx, actual, "project", "task", "session", got.Grant)
					})
				} else {
					out, err = service.grantWithMediaRecovery(t.Context(), p, "project", "task", "session", g, recover, run)
				}
				switch point {
				case "recovery failure", "grant failure":
					if !errors.Is(err, cause) || out.Token != "" {
						t.Fatal("failed grant exposed result or lost cause", out, err)
					}
				case "stopped":
					if err == nil || out.Token != "" {
						t.Fatal("stopped engine admitted recovery")
					}
				default:
					if err != nil || out != result {
						t.Fatal(out, err)
					}
				}
				want := []string{"recover", "grant"}
				switch point {
				case "ordinary":
					want = []string{"grant"}
				case "recovery failure":
					want = []string{"recover"}
				case "stopped":
					want = nil
				}
				if !reflect.DeepEqual(calls, want) {
					t.Fatalf("entry order %v want %v", calls, want)
				}
			})
		}
	}
}

func TestArchivePreflightRecoversOutsideItsMetadataTransaction(t *testing.T) {
	for _, point := range []string{"success", "recovery failure", "preflight failure", "unknown"} {
		t.Run(point, func(t *testing.T) {
			engine := core.NewEngine(nil)
			cause := errors.New("controlled " + point)
			scope := &archiveCompletionOrderScope{}
			var calls []string
			active := false
			var recovered context.Context
			service := &Service{engine: engine, writer: archiveCompletionOrderWriter(func(ctx context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				if active || ctx != recovered {
					t.Fatal("metadata scope overlapped recovery")
				}
				calls = append(calls, "transaction")
				active = true
				err := run(scope)
				active = false
				outcome := store.TransactionCommitted
				if point == "preflight failure" {
					outcome = store.TransactionNotCommitted
				}
				if point == "unknown" {
					outcome = store.TransactionUnknown
					err = errors.Join(err, cause)
				}
				calls = append(calls, "completion")
				return store.Completion{Outcome: outcome}, err
			})}
			principal := model.Principal{UserID: "owner"}
			out, err := service.archivePreflightWithRecovery(t.Context(), principal, "project", "task", "session", core.ArchiveV1Upload, func(ctx context.Context) error {
				if active {
					t.Fatal("recovery held database scope")
				}
				recovered = ctx
				calls = append(calls, "recover")
				if point == "recovery failure" {
					return cause
				}
				return nil
			}, func(_ *core.Operation, ctx context.Context, actual store.SessionScope, p model.Principal, project, task, id string, mode core.ArchiveMode) (string, error) {
				if !active || ctx != recovered || actual != scope || p != principal || project != "project" || task != "task" || id != "session" || mode != core.ArchiveV1Upload {
					t.Fatal("preflight binding changed")
				}
				calls = append(calls, "preflight")
				if point == "preflight failure" {
					return "", cause
				}
				return "owner", nil
			})
			if point == "success" {
				if err != nil || out != "owner" {
					t.Fatal(out, err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("preflight recovery lost failure", err)
			}
			want := []string{"recover", "transaction", "preflight", "completion"}
			if point == "recovery failure" {
				want = want[:1]
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("preflight order %v want %v", calls, want)
			}
		})
	}
}

func TestShutdownCancelsRecoveryAndWaitsForItsActualExit(t *testing.T) {
	engine := core.NewEngine(nil)
	service := &Service{engine: engine}
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	cleanupFailure := errors.New("recovery cleanup failed")
	result := make(chan error, 1)
	go func() {
		result <- service.afterMediaRecovery(t.Context(), func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			close(canceled)
			<-release
			return errors.Join(ctx.Err(), cleanupFailure)
		}, func(context.Context) error { t.Error("grant ran after shutdown cancellation"); return nil })
	}()
	<-started
	stopped := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	go func() { stopped <- engine.Stop(ctx) }()
	<-canceled
	select {
	case err := <-stopped:
		t.Fatal("shutdown did not retain recovery resource ownership", err)
	default:
	}
	close(release)
	if err := <-result; !errors.Is(err, context.Canceled) || !errors.Is(err, cleanupFailure) {
		t.Fatal("shutdown lost recovery facts", err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
}
