package webhook

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/jackc/pgx/v5/pgxpool"
)

type replayOwnerReadDatabase struct {
	*postgres.Store
	operationID string
	observed    chan struct{}
	resume      chan struct{}
	paused      atomic.Bool
}

type replayOwnerReadScope struct {
	store.WebhookWriteScope
	database *replayOwnerReadDatabase
}

type replayOwnerReadDAO struct {
	store.WebhookWriteDAO
	database *replayOwnerReadDatabase
}

func (d *replayOwnerReadDatabase) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, operationID string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	return d.Store.WriteWebhook(ctx, owner, operationID, func(scope store.WebhookWriteScope) error {
		if operationID == d.operationID {
			return callback(replayOwnerReadScope{WebhookWriteScope: scope, database: d})
		}
		return callback(scope)
	})
}

func (s replayOwnerReadScope) WebhookDAO() store.WebhookWriteDAO {
	return replayOwnerReadDAO{WebhookWriteDAO: s.WebhookWriteScope.WebhookDAO(), database: s.database}
}

func (d replayOwnerReadDAO) OwnerAccess(ctx context.Context, owner webhookmodel.Owner, userID string) (webhookmodel.OwnerAccess, error) {
	access, err := d.WebhookWriteDAO.OwnerAccess(ctx, owner, userID)
	if err == nil && access.CanManage && d.database.paused.CompareAndSwap(false, true) {
		close(d.database.observed)
		select {
		case <-d.database.resume:
		case <-ctx.Done():
			return webhookmodel.OwnerAccess{}, ctx.Err()
		}
	}
	return access, err
}

func contextRequest(h *integrationHarness, ctx context.Context, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", h.Origin)
	request.Header.Set("X-Request-ID", "replay-race")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, request)
	return response
}

func TestReplayCurrentViewUsesOneAuthorizationSnapshot(t *testing.T) {
	for _, remove := range []bool{false, true} {
		name := "demoted actor gets redacted current view"
		if remove {
			name = "removed actor gets no historical result"
		}
		t.Run(name, func(t *testing.T) {
			h := newIntegrationHarness(t)
			ctx := context.Background()
			teams := teamservice.NewTeams(h.Database)
			var bobVersion int64
			if err := h.Database.Pool.QueryRow(ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, h.team.ID, h.bob.UserID).Scan(&bobVersion); err != nil {
				t.Fatal(err)
			}
			if _, err := teams.SetMemberRole(ctx, h.alice, h.team.ID, h.bob.UserID, teamcore.ChangeTeamMember{Version: bobVersion, Role: model.ProjectAdmin, ExpectedUserID: h.alice.UserID}); err != nil {
				t.Fatal(err)
			}
			base := "/api/v1/teams/" + h.team.ID + "/webhooks"
			original := body(t, createBody(h, h.alice))
			created := decoded[mutationResponse](t, h.call("POST", base, original, h.aliceCookie), 201)
			endpoint := decodeEndpoint(t, created.Endpoint)
			database := &replayOwnerReadDatabase{Store: h.Database, operationID: created.Operation.OperationID, observed: make(chan struct{}), resume: make(chan struct{})}
			h.mount(t, database, h.keyring, true)
			requestContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			finished := make(chan *httptest.ResponseRecorder, 1)
			go func() { finished <- contextRequest(h, requestContext, "POST", base, original, h.aliceCookie) }()
			select {
			case <-database.observed:
			case <-requestContext.Done():
				t.Fatal("replay did not reach the old RC management observation")
			}
			var aliceVersion int64
			if err := h.Database.Pool.QueryRow(ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, h.team.ID, h.alice.UserID).Scan(&aliceVersion); err != nil {
				t.Fatal(err)
			}
			change := teamcore.ChangeTeamMember{Version: aliceVersion, Role: model.ProjectMemberRole, ExpectedUserID: h.bob.UserID}
			if remove {
				if _, err := teams.RemoveMember(ctx, h.bob, h.team.ID, h.alice.UserID, change); err != nil {
					t.Fatal(err)
				}
			} else if _, err := teams.SetMemberRole(ctx, h.bob, h.team.ID, h.alice.UserID, change); err != nil {
				t.Fatal(err)
			}
			const unseenURL = "https://receiver.example/secret-after-demotion?token=never-authorized"
			update := h.newOperation(h.bob)
			update["ifVersion"] = endpoint.ConfigVersion
			update["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": unseenURL}}
			changed := decoded[mutationResponse](t, h.call("PATCH", base+"/"+endpoint.ID, body(t, update), h.bobCookie), 200)
			if decodeEndpoint(t, changed.Endpoint).Destination.URL == nil || *decodeEndpoint(t, changed.Endpoint).Destination.URL != unseenURL {
				t.Fatal("second administrator did not commit the unseen URL")
			}
			close(database.resume)
			var response *httptest.ResponseRecorder
			select {
			case response = <-finished:
			case <-requestContext.Done():
				t.Fatal("replay did not finish after the concurrent authority change")
			}
			if remove {
				refusal := decoded[api.ErrorResponse](t, response, 403)
				if refusal.Error.Code != "forbidden" || refusal.Error.RequestID != "replay-race" {
					t.Fatal("access loss did not return its current correlated refusal")
				}
				for _, private := range []string{"operationId", "endpointId", "destination", created.Operation.OperationID, "never-authorized"} {
					if strings.Contains(response.Body.String(), private) {
						t.Fatal("current access refusal serialized a historical result or configuration")
					}
				}
			} else {
				replayed := decoded[mutationResponse](t, response, 200)
				current := decodeEndpoint(t, replayed.Endpoint)
				if replayed.Operation.OperationID != created.Operation.OperationID || replayed.Operation.RequestSHA256 != created.Operation.RequestSHA256 || replayed.Operation.IssuedAt != created.Operation.IssuedAt || replayed.Operation.ConfigVersionAfter != "1" {
					t.Fatal("fresh current-view reading changed the original matched receipt")
				}
				if current.ConfigVersion != "2" || current.Destination.URL != nil || current.Capabilities.Manage || current.Capabilities.ReadSecret || strings.Contains(response.Body.String(), "never-authorized") {
					t.Fatal("replay combined stale management rights with a newly committed secret URL")
				}
			}
		})
	}
}

func TestReplayCurrentSnapshotRunsAfterSinglePoolConnectionIsReleased(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/me/webhooks"
	original := body(t, createBody(h, h.alice))
	created := decoded[mutationResponse](t, h.call("POST", base, original, h.aliceCookie), 201)
	configuration := h.Database.Pool.Config().Copy()
	configuration.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), configuration)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h.mount(t, &postgres.Store{Pool: pool}, h.keyring, true)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	response := contextRequest(h, ctx, "POST", base, original, h.aliceCookie)
	replayed := decoded[mutationResponse](t, response, 200)
	if ctx.Err() != nil || replayed.Operation.OperationID != created.Operation.OperationID || decodeEndpoint(t, replayed.Endpoint).ID != created.Operation.EndpointID {
		t.Fatal("replay attempted a second pool acquisition while its RC operation transaction remained open")
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatal("replay retained its operation or view connection")
	}
}
