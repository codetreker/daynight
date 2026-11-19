package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type transferConfirmationOperations struct {
	projectOperations
	get     func(context.Context, model.Principal, string) (model.Project, error)
	preview func(context.Context, model.Principal, string, string) (coreproject.TransferPreview, error)
	write   func(context.Context, model.Principal, string, coreproject.TransferInput) (coreproject.TransferReceipt, error)
}

func (o transferConfirmationOperations) Get(ctx context.Context, p model.Principal, id string) (model.Project, error) {
	return o.get(ctx, p, id)
}
func (o transferConfirmationOperations) TransferPreview(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
	return o.preview(ctx, p, id, target)
}
func (o transferConfirmationOperations) Transfer(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	return o.write(ctx, p, id, input)
}

func TestProjectTransferPreviewProtocol(t *testing.T) {
	for _, tc := range []struct {
		name       string
		target     string
		previewErr error
		getErr     error
		code       string
	}{
		{name: "different owner", target: testTargetID},
		{name: "same owner", target: testTeamID},
		{name: "invalid destination", target: "https://another.test/teams/" + testTargetID, code: "invalid_input"},
		{name: "not authorized", target: testTargetID, previewErr: &model.Fault{Code: "forbidden", Message: "Owner Team administrator access is required."}, code: "forbidden"},
		{name: "project read fails", target: testTargetID, getErr: model.ErrNotFound, code: "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			previews, reads := 0, 0
			project := sampleProject(testProjectID)
			operations := transferConfirmationOperations{
				preview: func(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
					previews++
					if ctx.Err() != nil || p.UserID != "alice" || id != testProjectID || target != tc.target {
						t.Errorf("preview arguments: %+v %q %q", p, id, target)
					}
					return coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID, Kind: "ordinary", Name: ptr("Source")}, TargetTeam: model.TeamRef{ID: target, Kind: "ordinary", Name: ptr("Target")}, Ownership: project.Ownership, TargetTeamVersion: 9223372036854775807}, tc.previewErr
				},
				get: func(ctx context.Context, p model.Principal, id string) (model.Project, error) {
					reads++
					if ctx.Err() != nil || p.UserID != "alice" || id != testProjectID {
						t.Errorf("Project read arguments: %+v %q", p, id)
					}
					return project, tc.getErr
				},
			}
			if err := RegisterProjectTools(f.entry, operations, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			out := invitationCall(t, client, "project_transfer_preview", map[string]any{"projectId": testProjectID, "toTeam": tc.target}, tc.code != "")
			if tc.code != "" {
				if object(t, out["error"])["code"] != tc.code {
					t.Fatalf("preview error: %+v", out)
				}
			} else {
				data := object(t, out["data"])
				removal := object(t, data["goalDependencyRemoval"])
				if data["projectId"] != testProjectID || data["projectName"] != project.Name || object(t, data["sourceTeam"])["id"] != testTeamID || object(t, data["targetTeam"])["id"] != tc.target || object(t, data["targetTeam"])["version"] != "9223372036854775807" || object(t, data["ownership"])["version"] != "9007199254740994" || removal["ownershipWillChange"] != (tc.target != testTeamID) || removal["onOwnershipChange"] != true || removal["permanent"] != true {
					t.Fatalf("incomplete or inexact preview: %+v", data)
				}
				for _, fact := range []string{"either endpoint", "internal", "incoming and outgoing", "Other Projects", "does not restore", "Unchanged ownership preserves"} {
					if !strings.Contains(removal["scope"].(string), fact) {
						t.Errorf("cleanup scope omits %q: %+v", fact, removal)
					}
				}
			}
			wantPreviews, wantReads := 1, 1
			if tc.name == "invalid destination" {
				wantPreviews, wantReads = 0, 0
			} else if tc.previewErr != nil {
				wantReads = 0
			}
			if previews != wantPreviews || reads != wantReads {
				t.Fatalf("preview calls=%d reads=%d; want %d/%d", previews, reads, wantPreviews, wantReads)
			}
		})
	}
}

// The controlled host displays the actual protocol preview and supplies a
// separate user reply. The stateless server cannot obtain that reply itself.
func TestProjectTransferConfirmedHostProtocol(t *testing.T) {
	for _, protocol := range []string{"2026-07-28", "2025-11-25"} {
		for _, decision := range []string{"no answer", "refuse", "agree", "ownership changed", "target changed", "unknown"} {
			t.Run(protocol+"/"+decision, func(t *testing.T) {
				f := newEntryFixture(t)
				project := sampleProject(testProjectID)
				const targetVersion int64 = 9007199254740993
				previews, writes, reads, shown := 0, 0, 0, 0
				operations := transferConfirmationOperations{
					get: func(context.Context, model.Principal, string) (model.Project, error) { reads++; return project, nil },
					preview: func(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
						previews++
						if ctx.Err() != nil || p.UserID != "alice" || id != project.ID || target != testTargetID {
							t.Errorf("preview arguments: %+v %q %q", p, id, target)
						}
						value := coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, TargetTeam: model.TeamRef{ID: testTargetID}, Ownership: project.Ownership, TargetTeamVersion: targetVersion}
						if previews > 1 && decision == "ownership changed" {
							value.Ownership.Version++
						}
						if previews > 1 && decision == "target changed" {
							value.TargetTeamVersion++
						}
						return value, nil
					},
					write: func(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
						writes++
						if shown != 1 || ctx.Err() != nil || p.UserID != "alice" || id != project.ID || input.ExpectedUserID != "alice" || !input.ConfirmGoalDependencyRemoval || input.Ownership.TeamID != testTeamID || input.Ownership.Version != project.Ownership.Version || input.TargetTeam.ID != testTargetID || input.TargetTeam.Version != targetVersion {
							t.Errorf("confirmed write arguments were refreshed or changed: %+v", input)
						}
						switch decision {
						case "ownership changed", "target changed":
							return coreproject.TransferReceipt{}, &model.Fault{Code: "version_conflict", Message: "Preview has changed."}
						case "unknown":
							return coreproject.TransferReceipt{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("commit response lost")}
						}
						return coreproject.TransferReceipt{ProjectID: id, Changed: true, SourceTeam: model.TeamRef{ID: testTeamID}, OwnerTeam: model.TeamRef{ID: testTargetID}, Ownership: model.ProjectOwnership{TeamID: testTargetID, Version: input.Ownership.Version + 1}}, nil
					},
				}
				if err := RegisterProjectTools(f.entry, operations, nil, "https://daynight.test"); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, protocol, "alice")
				out := invitationCall(t, client, "project_transfer_preview", map[string]any{"projectId": project.ID, "toTeam": "https://daynight.test/teams/" + testTargetID}, false)
				preview := object(t, out["data"])
				if preview["projectId"] != project.ID || preview["projectName"] != project.Name || object(t, preview["targetTeam"])["id"] != testTargetID || object(t, preview["goalDependencyRemoval"])["permanent"] != true {
					t.Fatalf("host cannot display required confirmation: %+v", preview)
				}
				shown++
				if decision == "no answer" || decision == "refuse" {
					if writes != 0 || previews != 1 || reads != 1 || shown != 1 {
						t.Fatalf("unconfirmed host wrote: writes=%d previews=%d reads=%d shown=%d", writes, previews, reads, shown)
					}
					return
				}
				args := map[string]any{"projectId": preview["projectId"], "toTeam": object(t, preview["targetTeam"])["id"], "ifVersion": object(t, preview["ownership"])["version"], "ifTargetVersion": object(t, preview["targetTeam"])["version"], "confirm": true, "confirmGoalDependencyRemoval": true}
				out = invitationCall(t, client, "project_transfer", args, decision != "agree")
				if decision == "agree" {
					if object(t, out["data"])["changed"] != true {
						t.Fatalf("transfer receipt: %+v", out)
					}
				} else {
					failure := object(t, out["error"])
					if decision == "unknown" {
						if failure["writeOutcome"] != "unknown" || failure["phase"] != "commit" || object(t, failure["refs"])["projectId"] != project.ID {
							t.Fatalf("unknown result lost: %+v", out)
						}
					} else if failure["code"] != "version_conflict" {
						t.Fatalf("stale preview accepted: %+v", out)
					}
				}
				if writes != 1 || previews != 2 || reads != 1 {
					t.Fatalf("transfer or preview replayed: writes=%d previews=%d reads=%d", writes, previews, reads)
				}
			})
		}
	}
}

func TestProjectTransferConfirmationInputs(t *testing.T) {
	for _, change := range []struct {
		name  string
		field string
		value any
	}{
		{name: "missing ownership version", field: "ifVersion"},
		{name: "missing target version", field: "ifTargetVersion"},
		{name: "false cleanup confirmation", field: "confirmGoalDependencyRemoval", value: false},
		{name: "false operation confirmation", field: "confirm", value: false},
		{name: "missing operation confirmation", field: "confirm"},
		{name: "null target version", field: "ifTargetVersion", value: (*string)(nil)},
		{name: "numeric target version", field: "ifTargetVersion", value: 1},
		{name: "target version zero", field: "ifTargetVersion", value: "0"},
		{name: "target version overflow", field: "ifTargetVersion", value: "9223372036854775808"},
	} {
		t.Run(change.name, func(t *testing.T) {
			f := newEntryFixture(t)
			// Every method remains unconfigured: malformed input must fail before
			// any preview, Project read or business write can be invoked.
			if err := RegisterProjectTools(f.entry, transferConfirmationOperations{}, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			args := map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "ifVersion": "1", "ifTargetVersion": "1", "confirm": true, "confirmGoalDependencyRemoval": true}
			if change.value == nil {
				delete(args, change.field)
			} else {
				args[change.field] = change.value
			}
			out := invitationCall(t, client, "project_transfer", args, true)
			if object(t, out["error"])["code"] != "invalid_input" {
				t.Fatalf("invalid confirmation: %+v", out)
			}
		})
	}
}

func TestProjectTransferPreviewToolMetadata(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterProjectTools(f.entry, transferConfirmationOperations{}, nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	listing, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listing.Tools {
		if tool.Name == "project_transfer_preview" {
			if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint {
				t.Fatalf("unsafe preview annotations: %+v", tool.Annotations)
			}
			for _, fact := range []string{"explicit confirmation", "No answer or refusal", "permanent"} {
				if !strings.Contains(tool.Description, fact) {
					t.Fatalf("preview discovery omits %q: %s", fact, tool.Description)
				}
			}
			return
		}
	}
	t.Fatal("project_transfer_preview missing from discovery")
}

type transferConfirmationDependencies struct {
	lock, inspect, remove func()
	hasEdges              bool
}

func (d transferConfirmationDependencies) LockTeam(context.Context) error { d.lock(); return nil }
func (d transferConfirmationDependencies) HasProjectEdges(context.Context) (bool, error) {
	d.inspect()
	return d.hasEdges, nil
}
func (d transferConfirmationDependencies) RemoveProjectEdges(context.Context) error {
	d.remove()
	return nil
}

func TestProjectTransferProtocolUsesAtomicGoalCleanup(t *testing.T) {
	for _, tc := range []struct {
		name       string
		confirmed  bool
		hasEdges   bool
		sameOwner  bool
		wantError  bool
		stale      string
		wantRemove int
		wantProbe  int
	}{
		{name: "confirmed cleanup", confirmed: true, hasEdges: true, wantRemove: 1},
		{name: "legacy request with edges", hasEdges: true, wantError: true, wantProbe: 1},
		{name: "legacy request without edges", wantProbe: 1},
		{name: "same owner preserves edges", confirmed: true, hasEdges: true, sameOwner: true},
		{name: "stale ownership rejected before cleanup", confirmed: true, hasEdges: true, stale: "ownership", wantError: true},
		{name: "stale target rejected before cleanup", confirmed: true, hasEdges: true, stale: "target", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			tx := newHTTPTestStore(t)
			project := sampleProject(testProjectID)
			target := testTargetID
			if tc.sameOwner {
				target = testTeamID
			}
			actor := model.Principal{Kind: model.PATCredential, UserID: "alice", CredentialID: "credential-alice"}
			previewReads := mcpOrgCount(t, 1)
			teamReads := mcpOrgCount(t, 1)
			roleReads := mcpOrgCount(t, 1)
			mcpOrgRead(t, tx, 1, mcpOrgProjectReader{
				ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
					previewReads()
					projectHTTPCheck(t, p, actor)
					projectHTTPCheck(t, id, project.ID)
					return projectHTTPAccess(actor, project), nil
				},
				TransferTeamCall: func(ctx context.Context, id string) (store.TransferTeam, error) {
					teamReads()
					projectHTTPCheck(t, id, target)
					return store.TransferTeam{Ref: model.TeamRef{ID: target}, Version: 7}, nil
				},
				TransferRoleCall: func(ctx context.Context, user, id, team string) (*model.ProjectRole, error) {
					roleReads()
					projectHTTPCheck(t, []string{user, id, team}, []string{actor.UserID, project.ID, target})
					return nil, nil
				},
			}, nil)
			ownershipReads, teamLocks := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
			wantAccesses := 2
			if tc.stale != "" {
				wantAccesses = 1
			}
			accesses := mcpOrgCount(t, wantAccesses)
			moves := 0
			writer := mcpOrgProjectWriter{
				LockTransferOwnershipCall: func(context.Context) (model.ProjectOwnership, error) { ownershipReads(); return project.Ownership, nil },
				LockTransferTeamsCall: func(ctx context.Context, source, dest string) (store.TransferTeam, store.TransferTeam, error) {
					teamLocks()
					projectHTTPCheck(t, []string{source, dest}, []string{testTeamID, target})
					return store.TransferTeam{Ref: model.TeamRef{ID: testTeamID}, Version: 1}, store.TransferTeam{Ref: model.TeamRef{ID: target}, Version: 7}, nil
				},
				ProjectAccessCall: func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
					accesses()
					projectHTTPCheck(t, p, actor)
					return projectHTTPAccess(actor, project), nil
				},
				MoveOwnershipCall: func(ctx context.Context, dest string) (model.ProjectOwnership, error) {
					moves++
					projectHTTPCheck(t, dest, target)
					return model.ProjectOwnership{TeamID: target, Version: project.Ownership.Version + 1}, nil
				},
			}
			var eligibility store.WebhookEligibilityDAO
			if !tc.wantError {
				eligibility = mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{ProjectID: project.ID})
			}
			mcpOrgWriteProject(t, tx, project.ID, writer, eligibility, transferConfirmationDependencies{lock: mcpOrgCount(t, 1), inspect: mcpOrgCount(t, tc.wantProbe), remove: mcpOrgCount(t, tc.wantRemove), hasEdges: tc.hasEdges})
			if err := RegisterProjectTools(f.entry, projectservice.NewProjects(tx), nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			args := map[string]any{"projectId": project.ID, "toTeam": target, "confirm": true}
			if tc.confirmed {
				args["confirmGoalDependencyRemoval"] = true
				args["ifVersion"] = Decimal(project.Ownership.Version)
				args["ifTargetVersion"] = "7"
			}
			if tc.stale == "ownership" {
				args["ifVersion"] = Decimal(project.Ownership.Version - 1)
			}
			if tc.stale == "target" {
				args["ifTargetVersion"] = "6"
			}
			out := invitationCall(t, client, "project_transfer", args, tc.wantError)
			if tc.wantError {
				wantCode := "invalid_input"
				if tc.stale != "" {
					wantCode = "version_conflict"
				}
				if object(t, out["error"])["code"] != wantCode {
					t.Fatalf("legacy cleanup confirmation: %+v", out)
				}
			} else if object(t, out["data"])["changed"] != !tc.sameOwner {
				t.Fatalf("ownership receipt: %+v", out)
			}
			wantMoves := 1
			if tc.sameOwner || tc.stale != "" {
				wantMoves = 0
			}
			if moves != wantMoves {
				t.Fatalf("ownership mutations=%d; want %d", moves, wantMoves)
			}
		})
	}
}

func TestProjectTransferPreviewRequiresOwnerTeamAdmin(t *testing.T) {
	f := newEntryFixture(t)
	tx := newHTTPTestStore(t)
	project := sampleProject(testProjectID)
	accesses := mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		accesses()
		projectHTTPCheck(t, p.UserID, "alice")
		projectHTTPCheck(t, id, project.ID)
		access := projectHTTPAccess(p, project)
		access.TeamRole = nil
		access.CanTransfer = false
		return access, nil
	}}, nil)
	if err := RegisterProjectTools(f.entry, projectservice.NewProjects(tx), nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	out := invitationCall(t, client, "project_transfer_preview", map[string]any{"projectId": project.ID, "toTeam": testTargetID}, true)
	if object(t, out["error"])["code"] != "forbidden" || out["data"] != nil {
		t.Fatalf("Project grant bypassed owner Team permission: %+v", out)
	}
}
