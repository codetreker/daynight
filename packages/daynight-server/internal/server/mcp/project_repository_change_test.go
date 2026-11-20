package mcp

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type repositoryChangeOperations struct {
	projectOperations
	preview func(context.Context, model.Principal, string, string, string) (coreproject.RepositoryPreview, error)
	write   func(context.Context, model.Principal, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
	get     func(context.Context, model.Principal, string) (model.Project, error)
}

func (o repositoryChangeOperations) RepositoryPreview(ctx context.Context, p model.Principal, id, url, expected string) (coreproject.RepositoryPreview, error) {
	return o.preview(ctx, p, id, url, expected)
}
func (o repositoryChangeOperations) SetRepository(ctx context.Context, p model.Principal, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	return o.write(ctx, p, id, input)
}
func (o repositoryChangeOperations) Get(ctx context.Context, p model.Principal, id string) (model.Project, error) {
	return o.get(ctx, p, id)
}

func TestRepositoryChangeMCPProtocol(t *testing.T) {
	for _, scenario := range []string{"success", "wrong project", "wrong candidate", "stale repository", "stale ownership", "unknown classification without choice", "unknown classification with choice", "unknown commit"} {
		t.Run(scenario, func(t *testing.T) {
			f := newEntryFixture(t)
			const oldURL = "https://github.com/acme/repo.git"
			const newURL = "git@github.com:acme/repo.git"
			const repoVersion int64 = 9007199254740993
			const ownershipVersion int64 = 9223372036854775807
			target := int64(9007199254740995)
			previewCalls, writeCalls, readCalls := 0, 0, 0
			classification := "same_repository"
			if scenario == "unknown classification without choice" || scenario == "unknown classification with choice" {
				classification = "unverified"
			}
			ops := repositoryChangeOperations{
				preview: func(ctx context.Context, p model.Principal, id, address, expected string) (coreproject.RepositoryPreview, error) {
					previewCalls++
					if ctx.Err() != nil || p.UserID != "alice" || expected != "alice" || id != testProjectID || address != newURL {
						t.Errorf("preview arguments: %+v %q %q %q", p, id, address, expected)
					}
					return coreproject.RepositoryPreview{ProjectID: id, ProjectName: "Project", CurrentRepoURL: oldURL, RepoURL: address, RepositoryVersion: repoVersion, OwnershipVersion: ownershipVersion, Classification: classification, TargetGitHubRepositoryID: &target, BindingsInvalidated: classification == "unverified"}, nil
				},
				write: func(ctx context.Context, p model.Principal, id string, in coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
					writeCalls++
					if ctx.Err() != nil || p.UserID != "alice" || in.ExpectedUserID != "alice" {
						t.Errorf("wrong actor: %+v %+v", p, in)
					}
					if scenario == "wrong project" {
						return coreproject.RepositoryReceipt{}, &model.Fault{Code: "not_found", Message: "Project not found"}
					}
					if id != testProjectID || in.RepoURL != newURL || in.Classification != classification || in.TargetGitHubRepositoryID == nil {
						t.Fatalf("write arguments: %q %+v", id, in)
					}
					if in.RepositoryVersion != repoVersion || in.OwnershipVersion != ownershipVersion || *in.TargetGitHubRepositoryID != target {
						return coreproject.RepositoryReceipt{}, &model.Fault{Code: "version_conflict", Message: "Preview changed"}
					}
					if classification == "unverified" && !in.TreatUnverifiedAsSwitch {
						return coreproject.RepositoryReceipt{}, &model.Fault{Code: "invalid_input", Message: "Explicit choice required"}
					}
					if scenario == "unknown commit" {
						return coreproject.RepositoryReceipt{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost confirmation")}
					}
					return coreproject.RepositoryReceipt{ProjectID: id, RepoURL: in.RepoURL, RepositoryVersion: repoVersion + 1, Changed: true, BindingsInvalidated: classification == "unverified"}, nil
				},
				get: func(ctx context.Context, p model.Principal, id string) (model.Project, error) {
					readCalls++
					project := sampleProject(id)
					project.RepoURL = newURL
					return project, nil
				},
			}
			if err := RegisterProjectTools(f.entry, ops, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			preview := object(t, invitationCall(t, client, "project_preview_repository", map[string]any{"projectId": testProjectID, "repoUrl": newURL}, false)["data"])
			if preview["projectId"] != testProjectID || preview["projectName"] != "Project" || preview["currentRepoUrl"] != oldURL || preview["repoUrl"] != newURL || preview["repositoryVersion"] != "9007199254740993" || preview["ownershipVersion"] != "9223372036854775807" || preview["targetGitHubRepositoryId"] != "9007199254740995" || preview["classification"] != classification {
				t.Fatalf("inexact preview: %+v", preview)
			}
			args := map[string]any{"projectId": preview["projectId"], "repoUrl": preview["repoUrl"], "repositoryVersion": preview["repositoryVersion"], "ownershipVersion": preview["ownershipVersion"], "classification": preview["classification"], "targetGitHubRepositoryId": preview["targetGitHubRepositoryId"], "confirm": true}
			switch scenario {
			case "wrong project":
				args["projectId"] = testTargetID
			case "wrong candidate":
				args["targetGitHubRepositoryId"] = "4"
			case "stale repository":
				args["repositoryVersion"] = "2"
			case "stale ownership":
				args["ownershipVersion"] = "2"
			case "unknown classification with choice":
				args["treatUnverifiedAsSwitch"] = true
			}
			wantError := scenario != "success" && scenario != "unknown classification with choice"
			out := invitationCall(t, client, "project_set_repository", args, wantError)
			if wantError {
				err := object(t, out["error"])
				if scenario == "unknown commit" {
					if err["writeOutcome"] != "unknown" || err["phase"] != "commit" || object(t, err["refs"])["projectId"] != testProjectID {
						t.Fatalf("unknown result: %+v", out)
					}
					read := object(t, invitationCall(t, client, "project_show", map[string]any{"projectId": testProjectID}, false)["data"])
					if read["repoUrl"] != newURL {
						t.Fatalf("readback: %+v", read)
					}
				} else {
					want := "version_conflict"
					if scenario == "wrong project" {
						want = "not_found"
					}
					if scenario == "unknown classification without choice" {
						want = "invalid_input"
					}
					if err["code"] != want {
						t.Fatalf("failure: %+v", out)
					}
				}
			} else {
				data, meta := object(t, out["data"]), object(t, out["meta"])
				if data["projectId"] != testProjectID || data["repoUrl"] != newURL || data["repositoryVersion"] != "9007199254740994" || data["changed"] != true || data["bindingsInvalidated"] != (classification == "unverified") || meta["writeOutcome"] != "confirmed" || object(t, meta["refs"])["projectId"] != testProjectID {
					t.Fatalf("receipt: %+v", out)
				}
			}
			wantReads := 0
			if scenario == "unknown commit" {
				wantReads = 1
			}
			wantWrites := 1
			if scenario == "unknown classification without choice" {
				wantWrites = 0
			}
			if previewCalls != 1 || writeCalls != wantWrites || readCalls != wantReads {
				t.Fatalf("calls preview=%d write=%d read=%d", previewCalls, writeCalls, readCalls)
			}
		})
	}
}

func TestRepositoryChangeMCPRejectsMalformedConfirmation(t *testing.T) {
	for _, change := range []struct {
		name, field string
		value       any
	}{
		{"missing confirmation", "confirm", nil}, {"false confirmation", "confirm", false},
		{"missing target", "targetGitHubRepositoryId", nil}, {"numeric version", "repositoryVersion", 1},
		{"zero version", "repositoryVersion", "0"}, {"overflow version", "ownershipVersion", "9223372036854775808"},
		{"noncanonical target", "targetGitHubRepositoryId", "01"}, {"unknown field", "extra", true},
	} {
		t.Run(change.name, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := RegisterProjectTools(f.entry, repositoryChangeOperations{}, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			args := map[string]any{"projectId": testProjectID, "repoUrl": "git@github.com:acme/repo.git", "repositoryVersion": "1", "ownershipVersion": "1", "classification": "same_repository", "targetGitHubRepositoryId": nil, "confirm": true}
			if change.value == nil {
				delete(args, change.field)
			} else {
				args[change.field] = change.value
			}
			out := invitationCall(t, client, "project_set_repository", args, true)
			if object(t, out["error"])["code"] != "invalid_input" {
				t.Fatalf("invalid input: %+v", out)
			}
		})
	}
}

func TestRepositoryChangeMCPDiscovery(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterProjectTools(f.entry, repositoryChangeOperations{}, nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	listing, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, tool := range listing.Tools {
		if tool.Name == "project_preview_repository" || tool.Name == "project_set_repository" {
			if tool.Annotations == nil || tool.Annotations.DestructiveHint == nil {
				t.Fatalf("missing annotations: %+v", tool)
			}
			if tool.Name == "project_preview_repository" && (!tool.Annotations.ReadOnlyHint || *tool.Annotations.DestructiveHint) {
				t.Fatalf("preview annotations: %+v", tool.Annotations)
			}
			if tool.Name == "project_set_repository" && (tool.Annotations.ReadOnlyHint || !*tool.Annotations.DestructiveHint) {
				t.Fatalf("write annotations: %+v", tool.Annotations)
			}
			found[tool.Name] = true
		}
	}
	if len(found) != 2 {
		t.Fatalf("missing repository tools: %+v", found)
	}
}

func TestRepositoryChangeMCPUsesLargeBudget(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"project_preview_repository", map[string]any{"projectId": testProjectID, "repoUrl": "https://example.com/new"}},
		{"project_set_repository", map[string]any{"projectId": testProjectID, "repoUrl": "https://example.com/new", "repositoryVersion": "1", "ownershipVersion": "1", "classification": "same_repository", "targetGitHubRepositoryId": nil, "confirm": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := RegisterProjectTools(f.entry, repositoryChangeOperations{}, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			release, err := f.entry.budget.Acquire(t.Context(), BudgetLarge)
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			out := invitationCall(t, client, tc.name, tc.args, true)
			if object(t, out["error"])["code"] != "resource_busy" {
				t.Fatalf("admission: %+v", out)
			}
		})
	}
}
