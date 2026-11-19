package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type projectGoalLifecycleStore struct{ appLifecycleTestStore }

func (s projectGoalLifecycleStore) WriteProject(ctx context.Context, id string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.f.writeCalls++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > projectLifecycleTimeout {
		s.f.t.Fatal("missing lifecycle deadline")
	}
	if err := op(projectGoalTransferScope{appLifecycleScope: appLifecycleScope{f: s.f}}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return s.f.completion, nil
}
func (s projectGoalLifecycleStore) WriteProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionScope) error) (store.Completion, error) {
	s.f.writeCalls++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > projectLifecycleTimeout {
		s.f.t.Fatal("missing lifecycle deadline")
	}
	if err := op(appLifecycleDeletionScope{appLifecycleScope{f: s.f}}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return s.f.completion, nil
}

type projectGoalTransferScope struct {
	appLifecycleScope
	store.ProjectWriteScope
}

func (s projectGoalTransferScope) ProjectDAO() store.ProjectWriteDAO {
	return s.appLifecycleScope.ProjectDAO()
}
func (s projectGoalTransferScope) ProjectGoalDependencyDAO() store.ProjectGoalDependencyDAO {
	return s.appLifecycleScope.ProjectGoalDependencyDAO()
}
func (s projectGoalTransferScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return s.appLifecycleScope.EligibilityDAO()
}

func TestProjectLifecycleCoordinatesGoalRemoval(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, operation := range []string{"transfer", "delete"} {
			for _, scenario := range []string{"confirmed", "unconfirmed", "empty", "failure", "unknown", "active claim", "same Team"} {
				if scenario == "active claim" && operation != "delete" || scenario == "same Team" && operation != "transfer" {
					continue
				}
				t.Run(operation+"/"+scenario+map[bool]string{true: "/App", false: "/base"}[app], func(t *testing.T) {
					appService, f := newAppLifecycleTest(t, "")
					f.goalFound = scenario != "empty"
					if scenario == "failure" {
						f.goalRemoveErr = f.cause
					}
					if scenario == "unknown" {
						f.completion.Outcome = store.TransactionUnknown
					}
					if scenario == "active claim" {
						f.mode = "active claim"
					}
					if scenario == "same Team" {
						f.sameTeam = true
					}
					base := NewProjects(projectGoalLifecycleStore{appLifecycleTestStore{f: f}})
					confirmed := scenario == "confirmed" || scenario == "failure" || scenario == "unknown" || scenario == "active claim"
					var err error
					success := false
					if operation == "delete" {
						var result DeletionReceipt
						if app {
							result, err = appService.DeleteWithInput(t.Context(), f.principal, f.project.ID, core.DeletionInput{ConfirmGoalDependencyRemoval: confirmed})
						} else {
							result, err = base.DeleteWithInput(t.Context(), f.principal, f.project.ID, core.DeletionInput{ConfirmGoalDependencyRemoval: confirmed})
						}
						success = result.Deleted
					} else {
						target := "ef000000-0000-4000-8000-000000000002"
						if f.sameTeam {
							target = f.project.Ownership.TeamID
						}
						input := core.TransferInput{Ownership: f.project.Ownership, TargetTeam: core.TeamVersion{ID: target, Version: 1}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: confirmed}
						var result core.TransferReceipt
						if app {
							result, err = appService.Transfer(t.Context(), f.principal, f.project.ID, input)
						} else {
							result, err = base.Transfer(t.Context(), f.principal, f.project.ID, input)
						}
						success = result.ProjectID != ""
					}
					wantCalls := []string{}
					if !app && operation == "transfer" {
						wantCalls = append(wantCalls, "lock")
					}
					switch scenario {
					case "active claim":
						var fault *model.Fault
						if !errors.As(err, &fault) || fault.Code != "active_worker_claims" {
							t.Fatalf("active claim lost: %v", err)
						}
					case "same Team":
						if err != nil || !success {
							t.Fatalf("no-op failed: %v", err)
						}
					case "unconfirmed":
						wantCalls = append(wantCalls, "probe")
						var fault *model.Fault
						if !errors.As(err, &fault) || fault.Code != "invalid_input" {
							t.Fatalf("unconfirmed cleanup: %v", err)
						}
					case "empty":
						wantCalls = append(wantCalls, "probe")
						if err != nil || !success {
							t.Fatalf("empty failed %v", err)
						}
					default:
						wantCalls = append(wantCalls, "remove")
						if scenario == "confirmed" {
							if err != nil || !success {
								t.Fatalf("confirmed failed %v", err)
							}
						} else {
							if err == nil || success {
								t.Fatalf("unconfirmed result success=%v error=%v", success, err)
							}
							if scenario == "failure" && !errors.Is(err, f.cause) {
								t.Fatalf("lost cause %v", err)
							}
						}
					}
					if !reflect.DeepEqual(append([]string{}, f.goalCalls...), wantCalls) {
						t.Fatalf("goal calls %v want %v", f.goalCalls, wantCalls)
					}
					if (scenario == "unconfirmed" || scenario == "failure" || scenario == "active claim") && len(f.retirementCalls) != 0 {
						t.Fatalf("refusal caused App effects %v", f.retirementCalls)
					}
					if f.writeCalls != 1 {
						t.Fatalf("writes=%d", f.writeCalls)
					}
				})
			}
		}
	}
}
