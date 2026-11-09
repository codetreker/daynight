package webhook

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func mgmtInstallEndpointList(f *mgmtFixture, endpoints []wm.Endpoint) {
	for _, d := range []*mgmtWebhookDAO{f.preDAO, f.postDAO} {
		d.EndpointsFn = func(_ context.Context, o wm.Owner) ([]wm.Endpoint, error) {
			if o != f.owner {
				f.t.Errorf("list owner=%v", o)
			}
			return append([]wm.Endpoint(nil), endpoints...), nil
		}
		d.SubscriptionsFn = func(context.Context, string) ([]wm.Subscription, error) { return nil, nil }
		d.SigningKeysFn = func(context.Context, string) ([]wm.SigningKey, error) { return nil, nil }
		d.LatestAttemptFn = func(context.Context, string) (*store.WebhookAttempt, error) { return nil, nil }
	}
}
func TestManagementListCursorIsScopedToActorFiltersAndDisclosure(t *testing.T) {
	for _, kind := range []string{"valid", "actor", "filter", "enabled", "disclosure", "invalid encoding"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			second := f.endpoint
			second.ID = "44444444-4444-4444-8444-444444444444"
			second.CreatedAt = f.endpoint.CreatedAt.Add(time.Second)
			mgmtInstallEndpointList(f, []wm.Endpoint{second, f.endpoint})
			first, err := f.service.List(f.ctx, f.principal, f.owner, ListQuery{Limit: 1})
			if err != nil {
				t.Fatal(err)
			}
			page := first.(map[string]any)
			if len(page["items"].([]any)) != 1 || page["nextCursor"] == nil {
				t.Fatalf("first page=%#v", page)
			}
			raw := page["nextCursor"].(string)
			q := ListQuery{Limit: 1, Cursor: &raw}
			switch kind {
			case "actor", "disclosure":
				b, e := base64.RawURLEncoding.DecodeString(raw)
				if e != nil {
					t.Fatal(e)
				}
				var c cursor
				if e = json.Unmarshal(b, &c); e != nil {
					t.Fatal(e)
				}
				if kind == "actor" {
					c.User = "88888888-8888-4888-8888-888888888888"
				} else {
					c.View = "false"
				}
				b, e = json.Marshal(c)
				if e != nil {
					t.Fatal(e)
				}
				raw = base64.RawURLEncoding.EncodeToString(b)
			case "filter":
				q.Query = "changed"
			case "enabled":
				q.Enabled = mgmtPtr(true)
			case "invalid encoding":
				raw = "%%%"
			}
			next, err := f.service.List(f.ctx, f.principal, f.owner, q)
			if kind != "valid" {
				mgmtWantFault(t, err, "invalid_input")
				return
			}
			p := next.(map[string]any)
			items := p["items"].([]any)
			if len(items) != 1 || items[0].(map[string]any)["id"] != second.ID || p["nextCursor"] != nil {
				t.Fatalf("continuation=%#v", p)
			}
		})
	}
}

func TestManagementListSearchDoesNotDiscloseMemberTargetPath(t *testing.T) {
	f := newMgmtFixture(t)
	f.team("shared", model.ProjectMemberRole)
	mgmtInstallEndpointList(f, []wm.Endpoint{f.endpoint})
	result, err := f.service.List(f.ctx, f.principal, f.owner, ListQuery{Query: "private"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.(map[string]any)["items"].([]any)) != 0 {
		t.Fatalf("hidden target matched=%#v", result)
	}
}

func TestManagementOperationReadsCurrentAuthority(t *testing.T) {
	for _, kind := range []string{"admin", "own receipt after demotion", "other receipt after demotion", "missing receipt", "credential revoked"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			f.team("shared", model.ProjectAdmin)
			m := f.mutation("endpoint.update")
			op := f.respondMutation(m, f.endpoint, "unchanged", []wm.SigningKey{f.key})
			f.preDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			switch kind {
			case "own receipt after demotion", "other receipt after demotion":
				f.preTeam.TeamFn = func(context.Context, string, string) (model.Team, error) {
					return model.Team{TeamRef: model.TeamRef{Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
				}
				if kind == "other receipt after demotion" {
					op.ActorID = "88888888-8888-4888-8888-888888888888"
				}
			case "missing receipt":
				f.preDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) {
					return wm.Operation{}, model.ErrNotFound
				}
			case "credential revoked":
				f.preCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}
			}
			value, err := f.service.Operation(f.ctx, f.principal, f.owner, op.ID)
			switch kind {
			case "other receipt after demotion":
				mgmtWantFault(t, err, "forbidden")
			case "missing receipt":
				mgmtWantFault(t, err, "not_found")
			case "credential revoked":
				mgmtWantFault(t, err, "unauthenticated")
			default:
				if err != nil || value.(map[string]any)["operationId"] != op.ID {
					t.Fatalf("operation=%#v %v", value, err)
				}
			}
		})
	}
}

func TestManagementReadPropagatesStorageErrors(t *testing.T) {
	cause := errors.New("endpoint reader failed")
	for _, phase := range []string{"credential", "endpoint", "signing keys", "clock", "subscriptions", "list", "latest attempt"} {
		t.Run(phase, func(t *testing.T) {
			f := newMgmtFixture(t)
			switch phase {
			case "credential":
				f.preCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, cause
				}
			case "endpoint":
				f.preDAO.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, cause }
			case "signing keys":
				f.preDAO.SigningKeysFn = func(context.Context, string) ([]wm.SigningKey, error) { return nil, cause }
			case "clock":
				f.pre.ObservedAtFn = func(context.Context) (time.Time, error) { return time.Time{}, cause }
			case "subscriptions":
				f.preDAO.SubscriptionsFn = func(context.Context, string) ([]wm.Subscription, error) { return nil, cause }
			case "list", "latest attempt":
				mgmtInstallEndpointList(f, []wm.Endpoint{f.endpoint})
				if phase == "list" {
					f.preDAO.EndpointsFn = func(context.Context, wm.Owner) ([]wm.Endpoint, error) { return nil, cause }
				} else {
					f.preDAO.LatestAttemptFn = func(context.Context, string) (*store.WebhookAttempt, error) { return nil, cause }
				}
			}
			var err error
			if phase == "list" || phase == "latest attempt" {
				_, err = f.service.List(f.ctx, f.principal, f.owner, ListQuery{})
			} else {
				_, err = f.service.Get(f.ctx, f.principal, f.owner, f.endpoint.ID)
			}
			if !errors.Is(err, cause) {
				t.Fatalf("lost %s cause=%v", phase, err)
			}
		})
	}
}

func TestManagementReceiptPresenceAndCollectionDecideReplay(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(map[bool]string{false: "collector removed expired receipt", true: "retained receipt"}[exists], func(t *testing.T) {
			f := newMgmtFixture(t)
			m := f.mutation("endpoint.update")
			m.IssuedAt = f.now.Add(-29 * 24 * time.Hour).Format(time.RFC3339Nano)
			op := f.respondMutation(m, f.endpoint, "unchanged", []wm.SigningKey{f.key})
			op.RecordedAt = f.now.Add(-29 * 24 * time.Hour)
			op.ExpiresAt = op.RecordedAt.Add(30 * 24 * time.Hour)
			if exists {
				f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
				f.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			}
			f.recordWrites()
			got, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if exists {
				if err != nil || !got.Replay {
					t.Fatalf("retained replay=%#v %v", got, err)
				}
			} else {
				mgmtWantFault(t, err, "operation_expired")
			}
			f.noEffects()
		})
	}
}
