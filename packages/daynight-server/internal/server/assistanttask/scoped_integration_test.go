package assistanttask

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

type scopedTransaction struct{ dao *scopedDAO }
type scopedTransactionScope struct{ dao *scopedDAO }

func (s scopedTransactionScope) AssistantTaskDAO() store.AssistantTaskDAO { return s.dao }
func (s scopedTransaction) WriteAssistantTask(_ context.Context, call func(store.AssistantTaskScope) error) (store.Completion, error) {
	err := call(scopedTransactionScope{s.dao})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type scopedDAO struct {
	store.AssistantTaskDAO
	t              *testing.T
	initial, final model.CredentialAuthorization
	missing        bool
	reads, writes  int
}

func (d *scopedDAO) Credential(_ context.Context, p model.Principal) error {
	if p != testPrincipal {
		d.t.Fatal("credential identity changed")
	}
	return nil
}
func (d *scopedDAO) CredentialAuthorization(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	if p != testPrincipal {
		d.t.Fatal("policy identity changed")
	}
	d.reads++
	if d.reads == 1 {
		return d.initial, nil
	}
	return d.final, nil
}
func (d *scopedDAO) Task(_ context.Context, owner, id string, _ bool) (model.AssistantTask, error) {
	if owner != testPrincipal.UserID || id != testTask {
		d.t.Fatal("wrong task identity")
	}
	if d.missing {
		return model.AssistantTask{}, model.ErrNotFound
	}
	return model.AssistantTask{ID: id, OwnerUserID: owner, State: "active", Version: 1}, nil
}
func (d *scopedDAO) ClaimOperation(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
	return model.AssistantTaskClaimOperation{}, model.ErrNotFound
}
func (d *scopedDAO) CurrentInbox(context.Context, string, string) (model.AssistantTaskInbox, error) {
	return model.AssistantTaskInbox{}, model.ErrNotFound
}
func (d *scopedDAO) Now(context.Context) (time.Time, error) { return time.Unix(1, 0).UTC(), nil }
func (d *scopedDAO) InsertInbox(_ context.Context, v model.AssistantTaskInbox) (bool, error) {
	if v.TokenDigest == nil || v.TaskID != testTask {
		d.t.Fatal("invalid inbox")
	}
	d.writes++
	return true, nil
}
func (d *scopedDAO) SaveTask(_ context.Context, task model.AssistantTask, condition store.AssistantTaskCondition) (bool, error) {
	if task.ID != testTask || task.Version != 2 || condition.Version != 1 {
		d.t.Fatal("invalid task update")
	}
	d.writes++
	return true, nil
}
func (d *scopedDAO) InsertClaimOperation(_ context.Context, receipt model.AssistantTaskClaimOperation) error {
	if receipt.OperationID != testOperation || receipt.Kind != "inbox_enable" {
		d.t.Fatal("invalid receipt")
	}
	d.writes++
	return nil
}
func testScopedPolicy(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: testPrincipal, Profile: model.ScopedPATProfile, Policy: &p}
}
func TestScopedHandlerServiceCoreDeletionAndVisibility(t *testing.T) {
	observed := testScopedPolicy(t, "assistant-task:read", "assistant-task:write")
	for _, tc := range []struct {
		method, body string
		missing      bool
	}{
		{"PATCH", `{"ifVersion":"1","state":"deleted"}`, false}, {"DELETE", `{"ifVersion":"1"}`, false}, {"PATCH", `{"ifVersion":"1","state":"deleted"}`, true},
	} {
		t.Run(tc.method+tc.body+map[bool]string{true: "missing", false: "visible"}[tc.missing], func(t *testing.T) {
			d := &scopedDAO{t: t, initial: observed, final: observed, missing: tc.missing}
			h := scopedHandlerWithOperations(t, func(context.Context, model.Principal) (model.CredentialAuthorization, error) { return observed, nil }, service.New(scopedTransaction{d}), nil)
			response := request(h, tc.method, taskPath, tc.body, false)
			if tc.missing {
				assertError(t, response, http.StatusNotFound, "not_found")
				if response.Header().Get("Daynight-Scope-Status") != "" || d.reads != 0 {
					t.Fatalf("header=%v reads=%d", response.Header(), d.reads)
				}
			} else {
				assertError(t, response, http.StatusForbidden, "forbidden")
				if response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || d.reads != 1 {
					t.Fatalf("header=%v reads=%d", response.Header(), d.reads)
				}
			}
			if d.writes != 0 {
				t.Fatalf("writes=%d", d.writes)
			}
		})
	}
}
func TestScopedHandlerServiceCoreInboxSecretAdmission(t *testing.T) {
	read := testScopedPolicy(t, "assistant-task:read")
	full := testScopedPolicy(t, "assistant-task:inbox", "assistant-task:read")
	for _, tc := range []struct {
		name           string
		initial, final model.CredentialAuthorization
		allowed        bool
		writes         int
	}{
		{"missing inbox", read, read, false, 0}, {"authorized", full, full, true, 3}, {"revoked before completion", full, read, false, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &scopedDAO{t: t, initial: tc.initial, final: tc.final}
			h := scopedHandlerWithOperations(t, func(context.Context, model.Principal) (model.CredentialAuthorization, error) { return full, nil }, service.New(scopedTransaction{d}), nil)
			response := request(h, "POST", inboxPath+"/enable", `{"operationId":"`+testOperation+`","ifVersion":"1"}`, false)
			if tc.allowed {
				var value struct {
					Token *string `json:"token"`
				}
				if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &value) != nil || value.Token == nil || !strings.HasPrefix(*value.Token, "dnib_") {
					t.Fatalf("status=%d body=%s", response.Code, response.Body)
				}
			} else {
				assertError(t, response, http.StatusForbidden, "forbidden")
				if strings.Contains(response.Body.String(), "dnib_") || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
					t.Fatalf("header=%v body=%s", response.Header(), response.Body)
				}
			}
			if d.writes != tc.writes {
				t.Fatalf("candidate writes=%d", d.writes)
			}
		})
	}
}
