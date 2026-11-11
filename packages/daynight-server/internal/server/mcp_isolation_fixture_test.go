package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func assertMCPUnstartedObservation(t *testing.T, item map[string]any) {
	t.Helper()
	observation, ok := item["session"].(map[string]any)
	if !ok || observation["observation"] != "observed" || observation["registration"] != "not_applicable" || observation["reason"] != "not_started" {
		t.Fatalf("unstarted Task observation: %#v", item)
	}
	send, ok := observation["send"].(map[string]any)
	if !ok || send["allowed"] != false || send["reason"] != "not_started" {
		t.Fatalf("unstarted Task send eligibility: %#v", observation)
	}
}

func mcpIsolationTaskRead(t *testing.T, tx *httpTestStore, p model.Principal, project model.Project, target model.Task, name, view string) {
	want := map[string]int{"snapshot": 1, "access": 1, "priority": 1}
	if name == "task_list" {
		want["fence"] = 1
	}
	if view == "full" {
		want["task"] = 1
	}
	if name == "task_graph" {
		delete(want, "priority")
		delete(want, "fence")
		delete(want, "task")
		want["project"] = 1
		want["presence"] = 1
		want["nodes"] = 1
		want["clock"] = 1
	}
	if name != "task_ready" {
		want["snapshot"] = 2
		want["access"] = 2
		want["credential"] = 2
		want["sources"] = 2
		want["clock"]++
	}
	counts := newHTTPCallPlan(t, want)
	scope := newHTTPTestSnapshot(t)
	if name != "task_ready" {
		scope.Credentials = &taskHTTPCredentialReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation credential"), CredentialFn: func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
			counts.Called("credential")
			mcpAttachmentCheck(t, actor, p)
			return store.ThreadCredential{}, nil
		}}
		scope.Sessions = &taskHTTPSessionReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP observation sources"), TaskSessionSourcesFn: func(ctx context.Context, pid string, ids []string) ([]store.TaskSessionSource, error) {
			counts.Called("sources")
			mcpAttachmentCheck(t, pid, project.ID)
			mcpAttachmentCheck(t, ids, []string{target.ID})
			return []store.TaskSessionSource{{ProjectID: project.ID, TaskID: target.ID, TaskVersion: target.Version, TaskStatus: target.Status}}, nil
		}}
	}
	scope.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project.ID)
		return projectHTTPAccess(p, project), nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		counts.Called("project")
		mcpAttachmentCheck(t, id, project.ID)
		return project, nil
	}}
	reader := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "MCP isolation Task")}
	reader.TaskListFenceFn = func(ctx context.Context, id string) (store.TaskListFence, error) {
		counts.Called("fence")
		mcpAttachmentCheck(t, id, project.ID)
		return store.TaskListFence{Count: "1", VersionSum: "1"}, nil
	}
	reader.TaskPriorityListFn = func(ctx context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		counts.Called("priority")
		mcpAttachmentCheck(t, id, project.ID)
		expected := store.TaskPriorityQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Limit: 50, ExcludeTerminal: true}
		if name == "task_ready" {
			status, ready := model.TaskTodo, true
			expected = store.TaskPriorityQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll}, Status: &status, Ready: &ready, Limit: 5}
		}
		mcpAttachmentCheck(t, q, expected)
		summary := mcpCloneFixture(target)
		summary.Description = ""
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: summary}}}, nil
	}
	reader.TaskBodiesFn = func(ctx context.Context, pid string, ids []string) ([]model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, pid, project.ID)
		mcpAttachmentCheck(t, ids, []string{target.ID})
		return []model.Task{mcpCloneFixture(target)}, nil
	}
	reader.TaskFn = func(ctx context.Context, pid, id string) (model.Task, error) {
		counts.Called("task")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return mcpCloneFixture(target), nil
	}
	reader.TaskPresenceFn = func(ctx context.Context, pid, id string) (store.TaskPresence, error) {
		counts.Called("presence")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		return store.TaskPresence{Found: true}, nil
	}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	reader.TaskGraphTasksFn = func(ctx context.Context, pid, id string, q store.TaskGraphSelection, n int) ([]model.GraphTask, error) {
		counts.Called("nodes")
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		mcpAttachmentCheck(t, q, selection)
		mcpAttachmentCheck(t, n, 160)
		return []model.GraphTask{{ID: target.ID, Version: target.Version, TitlePreview: target.Title, Status: target.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: target.CreatedAt, UpdatedAt: target.UpdatedAt}}, nil
	}
	scope.Tasks = reader
	scope.ObservedAtCall = func(context.Context) (time.Time, error) { counts.Called("clock"); return target.UpdatedAt, nil }
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		counts.Called("snapshot")
		return fn(scope)
	}
}

func mcpIsolationSource(t *testing.T, tx *httpTestStore, p model.Principal, item model.Attachment, n int) {
	counts := newHTTPCallPlan(t, map[string]int{"source snapshot": n, "source access": n, "source presence": n, "source metadata": n})
	scope := newHTTPTestSnapshot(t)
	scope.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("source access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, item.ProjectID)
		return model.ProjectAccess{ProjectID: item.ProjectID, UserID: p.UserID, Role: model.ProjectAdmin}, nil
	}}
	scope.Tasks = &mcpAttachmentTaskReader{t: t, PresenceCall: func(ctx context.Context, pid, id string) (store.TaskPresence, error) {
		counts.Called("source presence")
		mcpAttachmentCheck(t, []string{pid, id}, []string{item.ProjectID, item.TaskID})
		return store.TaskPresence{Found: true}, nil
	}}
	scope.Attachments = &mcpAttachmentDAO{t: t, AttachmentCall: func(ctx context.Context, pid, id, path string) (model.Attachment, error) {
		counts.Called("source metadata")
		mcpAttachmentCheck(t, []string{pid, id, path}, []string{item.ProjectID, item.TaskID, item.Path})
		return item, nil
	}}
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		counts.Called("source snapshot")
		return fn(scope)
	}
}
func mcpIsolationAuthorize(t *testing.T, p model.Principal, project, task string, n int) *mcpTransferDAO {
	counts := newHTTPCallPlan(t, map[string]int{"authority": n})
	return &mcpTransferDAO{t: t, AuthorizeCall: func(ctx context.Context, actual model.Principal, kind, id, pid, tid string) error {
		counts.Called("authority")
		mcpAttachmentCheck(t, actual, p)
		mcpAttachmentCheck(t, []string{kind, id, pid, tid}, []string{"pat", p.CredentialID, project, task})
		return nil
	}}
}
func mcpIsolationPut(t *testing.T, dao *mcpTransferDAO, before, after model.PrivateTransfer) {
	counts := newHTTPCallPlan(t, map[string]int{"put": 1})
	dao.PutCall = func(ctx context.Context, input model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
		counts.Called("put")
		mcpAttachmentCheck(t, version, before.Version)
		mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.Direction, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.State}, []string{after.ID, after.UserID, after.AuthorityKind, after.AuthorityID, after.Direction, after.ProjectID, after.TaskID, after.Path, after.ContentType, after.State})
		mcpAttachmentCheck(t, []int64{input.ReservedBytes, input.OutstandingBytes, input.Version}, []int64{after.ReservedBytes, after.OutstandingBytes, before.Version})
		var got, want any
		if json.Unmarshal(input.Data, &got) != nil || json.Unmarshal(after.Data, &want) != nil {
			unexpectedHTTPCall(t, "private snapshot data JSON")
		}
		mcpAttachmentCheck(t, got, want)
		mcpAttachmentCheck(t, input.Binding, after.Binding)
		if input.UpdatedAt.IsZero() || input.UpdatedAt.Location() != time.UTC || input.ExpiresAt.Before(input.UpdatedAt) || input.HardExpiresAt != after.HardExpiresAt {
			unexpectedHTTPCall(t, "private snapshot time fields")
		}
		return mcpCloneFixture(after), nil
	}
}
func mcpIsolationRenew(t *testing.T, p model.Principal, before, after model.PrivateTransfer) *mcpTransferDAO {
	dao := mcpTransferRead(t, p, 1, 0, mcpTransferRow(before), mcpTransferRow(before))
	mcpIsolationPut(t, dao, before, after)
	return dao
}
func mcpIsolationDownloadRows(p model.Principal, item model.Attachment, id string, now time.Time) (model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer, model.PrivateTransfer) {
	initial := model.PrivateTransfer{ID: id, UserID: p.UserID, AuthorityKind: "pat", AuthorityID: p.CredentialID, Direction: "download", ProjectID: item.ProjectID, TaskID: item.TaskID, Path: item.Path, Binding: json.RawMessage(`{}`), Data: json.RawMessage(`{}`), State: "preparing", Version: 1, CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(24 * time.Hour)}
	acquired := initial
	acquired.Version = 2
	reserved := acquired
	reserved.Version = 3
	reserved.ReservedBytes = 13
	reserved.OutstandingBytes = 13
	materialized := reserved
	materialized.Version = 4
	materialized.OutstandingBytes = 0
	digest := sha256.Sum256([]byte("first content"))
	data, _ := json.Marshal(struct {
		Attachment model.Attachment `json:"attachment"`
		ObjectID   string           `json:"objectId"`
		TotalBytes int64            `json:"totalBytes"`
		SHA256     string           `json:"sha256"`
		Text       bool             `json:"text"`
	}{item, id, 13, hex.EncodeToString(digest[:]), true})
	readable := materialized
	readable.Version = 5
	readable.State = "readable"
	readable.Data = data
	return initial, acquired, reserved, materialized, readable
}
func mcpIsolationDownloadOpen(t *testing.T, tx *httpTestStore, p model.Principal, item model.Attachment, id string, now time.Time) model.PrivateTransfer {
	mcpIsolationSource(t, tx, p, item, 2)
	initial, acquired, reserved, materialized, readable := mcpIsolationDownloadRows(p, item, id, now)
	creation := mcpTransferMissing(t, id)
	c := newHTTPCallPlan(t, map[string]int{"insert": 1, "ledger": 1, "active": 1, "authorize": 1})
	creation.AuthorizeCall = func(ctx context.Context, actual model.Principal, kind, cid, pid, tid string) error {
		c.Called("authorize")
		mcpAttachmentCheck(t, actual, p)
		mcpAttachmentCheck(t, []string{kind, cid, pid, tid}, []string{"pat", p.CredentialID, item.ProjectID, item.TaskID})
		return nil
	}
	creation.InsertCall = func(ctx context.Context, input model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
		c.Called("insert")
		mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.Direction, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.State}, []string{id, p.UserID, "pat", p.CredentialID, "download", item.ProjectID, item.TaskID, item.Path, "", "preparing"})
		mcpAttachmentCheck(t, []int64{input.ReservedBytes, input.OutstandingBytes}, []int64{0, 0})
		mcpAttachmentCheck(t, input.Binding, json.RawMessage(`{}`))
		return mcpCloneFixture(initial), true, nil
	}
	creation.LockLedgerCall = func(context.Context) error { c.Called("ledger"); return nil }
	creation.CountActiveCall = func(ctx context.Context, owner string) (int, error) {
		c.Called("active")
		mcpAttachmentCheck(t, owner, p.UserID)
		return 1, nil
	}
	reservation := mcpTransferRead(t, p, 1, 0, mcpTransferRow(acquired), mcpTransferRow(acquired))
	rc := newHTTPCallPlan(t, map[string]int{"ledger": 2, "outstanding": 1, "reserved": 1, "add": 1})
	reservation.LockLedgerCall = func(context.Context) error { rc.Called("ledger"); return nil }
	reservation.OutstandingTotalCall = func(context.Context) (int64, error) { rc.Called("outstanding"); return 0, nil }
	reservation.ReservedTotalCall = func(context.Context) (int64, error) { rc.Called("reserved"); return 0, nil }
	reservation.AddReservationCall = func(ctx context.Context, got string, n int64) (model.PrivateTransfer, error) {
		rc.Called("add")
		mcpAttachmentCheck(t, got, id)
		mcpAttachmentCheck(t, n, int64(13))
		return mcpCloneFixture(reserved), nil
	}
	publication := mcpTransferRead(t, p, 1, 0, mcpTransferRow(reserved), mcpTransferRow(reserved), mcpTransferRow(materialized))
	pc := newHTTPCallPlan(t, map[string]int{"ledger": 1, "consume": 1})
	publication.LockLedgerCall = func(context.Context) error { pc.Called("ledger"); return nil }
	publication.SubtractOutstandingCall = func(ctx context.Context, got string, n int64) (model.PrivateTransfer, error) {
		pc.Called("consume")
		mcpAttachmentCheck(t, got, id)
		mcpAttachmentCheck(t, n, int64(13))
		return mcpCloneFixture(materialized), nil
	}
	mcpIsolationPut(t, publication, materialized, readable)
	mcpTransferPlan(t, tx, mcpTransferMissing(t, id), mcpIsolationAuthorize(t, p, item.ProjectID, item.TaskID, 1), creation, mcpIsolationRenew(t, p, initial, acquired), mcpIsolationAuthorize(t, p, item.ProjectID, item.TaskID, 1), reservation, publication)
	return readable
}
func mcpIsolationDownloadChunk(t *testing.T, tx *httpTestStore, p model.Principal, readable model.PrivateTransfer) model.PrivateTransfer {
	acquired := readable
	acquired.Version++
	touched := acquired
	touched.Version++
	mcpTransferPlan(t, tx, mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable)), mcpIsolationRenew(t, p, readable, acquired), mcpTransferRead(t, p, 1, 0, mcpTransferRow(acquired)), mcpIsolationRenew(t, p, acquired, touched))
	return touched
}
func mcpIsolationDownloadClose(t *testing.T, tx *httpTestStore, p model.Principal, readable model.PrivateTransfer) {
	pending := readable
	pending.Version++
	pending.State = "cleanup_pending"
	previous := "readable"
	pending.CleanupFromState = &previous
	dao := mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable), mcpTransferRow(readable))
	mcpIsolationPut(t, dao, readable, pending)
	mcpTransferPlan(t, tx, mcpTransferRead(t, p, 1, 0, mcpTransferRow(readable)), dao)
}

func mcpIsolationInline(t *testing.T, tx *httpTestStore, p model.Principal, item model.Attachment, created bool) {
	mcpAttachmentRead(t, tx, p, item.ProjectID, item.TaskID, &mcpAttachmentDAO{t: t})
	calls := newHTTPCallPlan(t, map[string]int{"conflict": 1, "metadata": 1})
	dao := &mcpAttachmentDAO{t: t, ConflictCall: func(ctx context.Context, pid, tid string, q store.AttachmentConflictQuery) (bool, error) {
		calls.Called("conflict")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{item.ProjectID, item.TaskID})
		mcpAttachmentCheck(t, q, store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: item.Path + "/"})
		return false, nil
	}, PutCall: func(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
		calls.Called("metadata")
		mcpAttachmentCheck(t, []string{input.ProjectID, input.TaskID, input.Path, input.ContentType}, []string{item.ProjectID, item.TaskID, item.Path, item.ContentType})
		mcpAttachmentCheck(t, input.SizeBytes, item.SizeBytes)
		return item, created, nil
	}}
	mcpAttachmentMutation(t, tx, p, item.ProjectID, item.TaskID, dao, false)
}

type mcpIsolationRevocationDAO struct {
	httpRejectedIdentityDAO
	session model.Principal
	tokenID string
	calls   *httpCallPlan
}

func (d *mcpIsolationRevocationDAO) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	d.calls.Called("session lock")
	mcpAttachmentCheck(d.t, p, d.session)
	if now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "revocation time")
	}
	return nil
}
func (d *mcpIsolationRevocationDAO) DeletePAT(ctx context.Context, owner, id string) error {
	d.calls.Called("PAT delete")
	mcpAttachmentCheck(d.t, []string{owner, id}, []string{d.session.UserID, d.tokenID})
	return nil
}
func mcpIsolationRevocation(t *testing.T, tx *httpTestStore, browser model.Principal, tokenID string) {
	before := tx.WriteIdentityCall
	calls := newHTTPCallPlan(t, map[string]int{"identity callback": 2, "session lock": 1, "PAT delete": 1})
	phase := 0
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		calls.Called("identity callback")
		phase++
		if phase == 1 {
			return before(ctx, fn)
		}
		dao := &mcpIsolationRevocationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, session: browser, tokenID: tokenID, calls: calls}
		return mcpBotResult(fn(httpAuthenticationScope{t: t, dao: dao}))
	}
}
func mcpIsolationRevokedAuthentication(t *testing.T, tx *httpTestStore, revokedToken, otherToken string, other model.Principal) {
	revokedHash, otherHash := secret.Hash(revokedToken), secret.Hash(otherToken)
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		dao := &mcpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		dao.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
			dao.calls++
			if dao.calls != 1 || kind != model.PATCredential || now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "revoked MCP authentication")
			}
			if bytes.Equal(hash, revokedHash) {
				return model.Principal{}, model.ErrNotFound
			}
			if bytes.Equal(hash, otherHash) {
				return other, nil
			}
			unexpectedHTTPCall(t, "undeclared MCP credential")
			panic("unreachable")
		}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			unexpectedHTTPCall(t, "MCP authentication count")
		}
		return mcpBotResult(err)
	}
}
