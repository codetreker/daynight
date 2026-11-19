package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBotRecoveryGrantCoordinatesMediaRecovery(t *testing.T) {
	for _, point := range []string{"same generation", "generation", "recovery failure", "grant failure", "stopped"} {
		t.Run(point, func(t *testing.T) {
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			service := &Service{engine: engine}
			if point == "stopped" {
				stopHistoryEngine(t, engine)
			}
			previous := "1"
			input := core.BotRecoveryGrant{OperationID: uuid.NewString(), Grant: sp.Grant{PreviousGeneration: &previous, ExecutionGeneration: "2"}}
			if point == "same generation" {
				input.Grant.PreviousGeneration = nil
			}
			principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "current"}
			cause := errors.New("controlled " + point)
			var calls []string
			var recovered context.Context
			result := core.BotRecoveryResult{Current: true, Receipt: core.BotRecoveryReceipt{OperationID: input.OperationID}}
			out, err := service.botRecoveryGrantWithMediaRecovery(t.Context(), principal, "worker", "bot", input, func(ctx context.Context) error {
				calls = append(calls, "recover")
				recovered = ctx
				if point == "recovery failure" {
					return cause
				}
				return nil
			}, func(ctx context.Context, actual model.Principal, worker, id string, got core.BotRecoveryGrant) (core.BotRecoveryResult, error) {
				calls = append(calls, "grant")
				if actual != principal || worker != "worker" || id != "bot" || !reflect.DeepEqual(got, input) || point != "same generation" && ctx != recovered {
					t.Fatal("recovery grant binding changed")
				}
				if point == "grant failure" {
					return core.BotRecoveryResult{}, cause
				}
				return result, nil
			})
			want := []string{"recover", "grant"}
			switch point {
			case "same generation":
				want = []string{"grant"}
			case "recovery failure":
				want = []string{"recover"}
			case "stopped":
				want = nil
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("operation order %v, want %v", calls, want)
			}
			switch point {
			case "recovery failure", "grant failure":
				if !errors.Is(err, cause) || out != (core.BotRecoveryResult{}) {
					t.Fatal("failed recovery lost its cause or exposed a result", out, err)
				}
			case "stopped":
				if err == nil || out != (core.BotRecoveryResult{}) {
					t.Fatal("shutdown admitted recovery", out, err)
				}
			default:
				if err != nil || out != result {
					t.Fatal(out, err)
				}
			}
		})
	}
}

func TestBotRecoveryEntrypointsStopAfterUnconfirmedMediaRecovery(t *testing.T) {
	for _, takeover := range []bool{false, true} {
		for _, point := range []string{"list failure", "unknown completion", "same generation"} {
			t.Run(map[bool]string{false: "grant", true: "takeover"}[takeover]+"/"+point, func(t *testing.T) {
				cause := errors.New("controlled recovery failure")
				calls := 0
				writer := archiveCompletionOrderWriter(func(ctx context.Context, run func(store.SessionScope) error) (store.Completion, error) {
					calls++
					if calls != 1 || point == "same generation" {
						t.Fatal("unexpected transaction after failed recovery or without generation change")
					}
					err := run(mediaRecoveryScope{dao: mediaRecoveryListOnlyDAO{list: func(actual context.Context) ([]store.SessionResourceLease, error) {
						if actual != ctx {
							t.Fatal("listing context changed")
						}
						if point == "list failure" {
							return nil, cause
						}
						return nil, nil
					}}})
					if point == "unknown completion" {
						if err != nil {
							t.Fatal(err)
						}
						return store.Completion{Outcome: store.TransactionUnknown}, cause
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				})
				engine := core.NewEngine(nil)
				t.Cleanup(func() { stopHistoryEngine(t, engine) })
				service := New(writer, engine)
				previous := "1"
				input := core.BotRecoveryGrant{Grant: sp.Grant{PreviousGeneration: &previous}}
				if point == "same generation" {
					input.Grant.PreviousGeneration = nil
				}
				run := service.GrantBotRecovery
				if takeover {
					run = service.TakeoverBot
				}
				out, err := run(t.Context(), model.Principal{}, "worker", "bot", input)
				if out != (core.BotRecoveryResult{}) {
					t.Fatal("failed recovery returned a receipt", out)
				}
				if point == "same generation" {
					requireServiceError(t, err, "invalid_input")
					if calls != 0 {
						t.Fatal("same-generation grant ran recovery")
					}
				} else if !errors.Is(err, cause) || calls != 1 {
					t.Fatal("runtime validation replaced the recovery failure", calls, err)
				}
			})
		}
	}
}

func TestBotRecoveryEntrypointsReapOrphanMediaAndPreserveLiveOwners(t *testing.T) {
	for _, takeover := range []bool{false, true} {
		for _, live := range []bool{false, true} {
			t.Run(map[bool]string{false: "grant", true: "takeover"}[takeover]+"/"+map[bool]string{false: "orphan", true: "live"}[live], func(t *testing.T) {
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				files, err := local.New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := files.Close(); err != nil {
						t.Error(err)
					}
				})
				f, registered := serviceBoundBot(t, newServiceFixture(t), files)
				f.service.SetOrigin("https://recovery.example")
				v := registered.Session
				native := "original-native"
				v.Identity.NativeSessionID = &native
				snapshot, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, v.SessionID, snapshot); err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Pool.Exec(ctx, `UPDATE workers SET telemetry='{"machine":{"ID":"same-machine","Name":"Same machine"}}' WHERE user_id=$1 AND worker_id=$2`, f.owner.UserID, registered.Bot.WorkerID); err != nil {
					t.Fatal(err)
				}
				identity := core.BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: "https://recovery.example", RecoveryIdentity: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}
				binding := core.BotRecoveryBinding{SessionID: v.SessionID, TestExecutionID: v.TestExecutionID, NativeSessionID: &native}
				if _, err = f.service.RegisterBotRecovery(ctx, f.owner, registered.Bot.WorkerID, registered.Bot.ID, core.BotRecoveryRegistration{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), BotVersion: registered.Bot.Version}); err != nil {
					t.Fatal(err)
				}
				archiveIdentity, err := json.Marshal(sp.ArchivePrepareRequest{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Pool.Exec(ctx, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity) VALUES($1,$2,'active',1,$3)`, v.SessionID, uuid.NewString(), archiveIdentity); err != nil {
					t.Fatal(err)
				}
				lease := uuid.NewString()
				if _, err = f.db.Pool.Exec(ctx, `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,delete_epoch) VALUES($1,$2,$3,'archive',0)`, v.SessionID, lease, f.owner.UserID); err != nil {
					t.Fatal(err)
				}
				previous := v.ExecutionGeneration
				input := core.BotRecoveryGrant{BotRecoveryIdentity: identity, BotRecoveryBinding: binding, OperationID: uuid.NewString(), ExpectedHostingGeneration: 1, ControllerToken: "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32)), Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", PreviousGeneration: &previous, Kind: "reconnect", StopProof: &sp.StopProof{RecordID: v.SessionID, PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
				run := f.service.GrantBotRecovery
				if takeover {
					run = f.service.TakeoverBot
				}
				if live {
					gate, err := files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+lease)
					if err != nil {
						t.Fatal(err)
					}
					defer gate.Close()
					_, err = run(ctx, f.owner, registered.Bot.WorkerID, registered.Bot.ID, input)
					requireServiceError(t, err, "archive_conflict")
					var leases int
					var generation string
					if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_resource_leases WHERE session_id=$1),snapshot->>'executionGeneration' FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&leases, &generation); err != nil || leases != 1 || generation != previous {
						t.Fatal("live lease or generation changed", leases, generation, err)
					}
					if err = gate.Close(); err != nil {
						t.Fatal(err)
					}
				}
				out, err := run(ctx, f.owner, registered.Bot.WorkerID, registered.Bot.ID, input)
				kind, hosting := "grant", int64(1)
				if takeover {
					kind, hosting = "takeover", 2
				}
				if err != nil || !out.Current || out.Receipt.ExecutionGeneration != "2" || out.Receipt.Kind != kind || out.Receipt.HostingGeneration != hosting {
					t.Fatal("orphan recovery did not advance original Session through the requested operation", out, err)
				}
				var leases int
				var generation, archiveGeneration, controller string
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_resource_leases WHERE session_id=$1),s.snapshot->>'executionGeneration',b.identity->'fence'->>'executionGeneration',b.identity->>'controllerInstanceId' FROM task_sessions s JOIN session_archive_bundles b ON b.session_id=s.id WHERE s.id=$1`, v.SessionID).Scan(&leases, &generation, &archiveGeneration, &controller); err != nil || leases != 0 || generation != "2" || archiveGeneration != "2" || controller != input.Grant.ControllerInstanceID {
					t.Fatal("media cleanup and history handoff were not durable", leases, generation, archiveGeneration, controller, err)
				}
			})
		}
	}
}
