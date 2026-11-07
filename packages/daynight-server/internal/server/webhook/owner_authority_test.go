package webhook

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

type countedConfigurationDatabase struct {
	*postgres.Store
	locks atomic.Int32
}

type countedConfigurationScope struct {
	store.WebhookWriteScope
	locks *atomic.Int32
}

type countedConfigurationDAO struct {
	store.WebhookWriteDAO
	locks *atomic.Int32
}

func (d *countedConfigurationDatabase) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, operationID string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	return d.Store.WriteWebhook(ctx, owner, operationID, func(scope store.WebhookWriteScope) error {
		return callback(countedConfigurationScope{WebhookWriteScope: scope, locks: &d.locks})
	})
}

func (s countedConfigurationScope) WebhookDAO() store.WebhookWriteDAO {
	return countedConfigurationDAO{WebhookWriteDAO: s.WebhookWriteScope.WebhookDAO(), locks: s.locks}
}

func (d countedConfigurationDAO) LockConfiguration(ctx context.Context, lock store.WebhookConfigurationLock) error {
	d.locks.Add(1)
	return d.WebhookWriteDAO.LockConfiguration(ctx, lock)
}

func TestMemberNewWritesRefuseBeforeSelectedProjectLocks(t *testing.T) {
	h := newIntegrationHarness(t)
	ctx := context.Background()
	foreign, err := projectservice.NewProjects(h.Database).Create(ctx, h.charlie, projectcore.CreateProject{Name: "Foreign private project", RepoURL: "https://github.com/example/foreign", ExpectedUserID: h.charlie.UserID})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/teams/" + h.team.ID + "/webhooks"
	originalBody := body(t, createBody(h, h.alice))
	created := decoded[mutationResponse](t, h.call("POST", base, originalBody, h.aliceCookie), 201)
	endpoint := decodeEndpoint(t, created.Endpoint)
	database := &countedConfigurationDatabase{Store: h.Database}
	h.mount(t, database, h.keyring, true)
	for _, target := range []struct{ name, id string }{{"present foreign project", foreign.ID}, {"missing project", uuid.NewString()}} {
		for _, method := range []string{"POST", "PATCH"} {
			t.Run(target.name+" "+method, func(t *testing.T) {
				database.locks.Store(0)
				input := createBody(h, h.bob)
				path := base
				if method == "PATCH" {
					input = h.newOperation(h.bob)
					input["ifVersion"] = endpoint.ConfigVersion
					path += "/" + endpoint.ID
				}
				input["subscriptions"] = []any{map[string]any{"id": nil, "projectId": target.id, "eventTypes": []string{"task.paused"}}}
				errorStatus(t, h.call(method, path, body(t, input), h.bobCookie), 403, "forbidden")
				if database.locks.Load() != 0 {
					t.Fatal("ordinary member reached selected project configuration locks")
				}
			})
		}
	}
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil || endpoints != 1 || operations != 1 {
		t.Fatal("member refusals applied configuration or receipts")
	}
	unchanged := decoded[endpointResponse](t, h.call("GET", base+"/"+endpoint.ID, "", h.aliceCookie), 200)
	if unchanged.ConfigVersion != endpoint.ConfigVersion || len(unchanged.Subscriptions) != 1 || unchanged.Subscriptions[0].ID != endpoint.Subscriptions[0].ID {
		t.Fatal("member refusals changed existing configuration")
	}
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, h.team.ID, h.charlie.UserID); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := h.Database.Pool.QueryRow(ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, h.team.ID, h.alice.UserID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := teamservice.NewTeams(h.Database).SetMemberRole(ctx, h.alice, h.team.ID, h.alice.UserID, teamcore.ChangeTeamMember{Version: version, Role: model.ProjectMemberRole, ExpectedUserID: h.alice.UserID}); err != nil {
		t.Fatal(err)
	}
	database.locks.Store(0)
	replayed := decoded[mutationResponse](t, h.call("POST", base, originalBody, h.aliceCookie), 200)
	if replayed.Operation.OperationID != created.Operation.OperationID || decodeEndpoint(t, replayed.Endpoint).Destination.URL != nil || database.locks.Load() != 0 {
		t.Fatal("demoted actor receipt replay lost its read-only recovery boundary")
	}
}
