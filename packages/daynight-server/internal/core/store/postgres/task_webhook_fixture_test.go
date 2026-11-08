package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

type taskWebhookFixture struct {
	db                  *Store
	project, task, user string
	owner               wm.Owner
	endpoint            wm.Endpoint
	subscription        wm.Subscription
	bindings            []wm.Binding
	receipt             wm.Operation
}

func taskWebhookStore(t *testing.T) taskWebhookFixture {
	t.Helper()
	f := taskWebhookFixture{db: isolatedStore(t), project: uuid.NewString(), task: uuid.NewString(), user: uuid.NewString()}
	team := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, f.user)
	mustQueryExec(t, f.db, `INSERT INTO teams(id,name) VALUES($1,'capture')`, team)
	mustQueryExec(t, f.db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, f.user)
	mustQueryExec(t, f.db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'capture','https://example.test/repo')`, f.project)
	mustQueryExec(t, f.db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, f.project, team)
	completion, err := f.db.WriteProject(t.Context(), f.project, func(sc store.ProjectWriteScope) error {
		_, err := sc.TaskDAO().CreateTask(t.Context(), f.task, store.TaskWrite{Title: "source", Status: model.TaskTodo})
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("source fixture: %v %v", completion, err)
	}
	_, endpoint, key, receipt := webhookStoredFixture(t)
	f.owner = wm.Owner{Kind: "personal", ID: f.user}
	endpoint.Owner, receipt.Owner, receipt.ActorID = f.owner, f.owner, f.user
	endpoint.DestinationConfiguration = []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/old"}}`)
	f.endpoint = endpoint
	f.receipt = receipt
	now := endpoint.CreatedAt
	f.subscription = wm.Subscription{ID: uuid.NewString(), EndpointID: endpoint.ID, ProjectID: f.project, Owner: f.owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	completion, err = f.db.WriteWebhook(t.Context(), f.owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		dao := sc.WebhookWriter()
		if err := dao.PutEndpoint(t.Context(), endpoint); err != nil {
			return err
		}
		if err := dao.PutSigningKey(t.Context(), key); err != nil {
			return err
		}
		if err := dao.PutOperation(t.Context(), receipt); err != nil {
			return err
		}
		if err := dao.PutSubscription(t.Context(), f.subscription); err != nil {
			return err
		}
		for _, kind := range []string{protocol.Created, protocol.StatusChanged, protocol.Paused, protocol.StepUpdated, protocol.ThreadPosted, protocol.Deleted} {
			binding := wm.Binding{ID: uuid.NewString(), SubscriptionID: f.subscription.ID, EventType: kind, CreatedAt: now}
			if err := dao.PutBinding(t.Context(), binding); err != nil {
				return err
			}
			f.bindings = append(f.bindings, binding)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("capture fixture: %v %v", completion, err)
	}
	return f
}

func taskWebhookFixtureTuple(subscription wm.Subscription, binding wm.Binding) [5]string {
	return [5]string{subscription.ID, binding.ID, subscription.ProjectID, binding.EventType, strconv.FormatInt(subscription.AuthorizationEpoch, 10)}
}

func taskWebhookPrepared(fact protocol.Fact, audience []store.WebhookAudience) (store.WebhookCapturedEvent, []store.WebhookCapturedDelivery, error) {
	eventID := uuid.NewString()
	body, err := protocol.Render(eventID, fact)
	if err != nil {
		return store.WebhookCapturedEvent{}, nil, err
	}
	factBytes, err := json.Marshal(fact)
	if err != nil {
		return store.WebhookCapturedEvent{}, nil, err
	}
	factHash, bodyHash := sha256.Sum256(factBytes), sha256.Sum256(body)
	version := fact.TaskVersion
	event := store.WebhookCapturedEvent{ID: eventID, EventType: fact.Type, WireVersion: 1, SchemaVersion: 1, Source: "urn:daynight:project:" + fact.ProjectID, Subject: "tasks/" + fact.TaskID, ProjectID: fact.ProjectID, TaskID: fact.TaskID, TaskVersion: &version, OccurredAt: fact.OccurredAt, RecordedAt: fact.OccurredAt, FactCodecVersion: 1, FactBytes: factBytes, FactSHA256: factHash[:]}
	if fact.Type == protocol.ThreadPosted {
		event.TaskVersion = nil
		event.MessageID = &fact.MessageID
		event.Subject += "/thread/" + fact.MessageID
	}
	if fact.Type == protocol.StepUpdated {
		stepID, err := strconv.ParseInt(fact.StepID, 16, 64)
		if err != nil {
			return event, nil, err
		}
		event.StepID = &stepID
		event.Subject += "/steps"
	}
	if fact.Type == protocol.Deleted {
		event.TaskDeletedAt = fact.DeletedAt
	}
	var deliveries []store.WebhookCapturedDelivery
	for _, row := range audience {
		if row.EventType != fact.Type {
			continue
		}
		index := -1
		for i := range deliveries {
			if deliveries[i].EndpointID == row.Endpoint.ID {
				index = i
				break
			}
		}
		if index < 0 {
			schedule := make([]time.Time, 10)
			for i := range schedule {
				schedule[i] = fact.OccurredAt.Add(time.Duration(i) * time.Minute)
			}
			adapter, err := strconv.ParseInt(row.Endpoint.AdapterVersion, 10, 64)
			if err != nil {
				return event, nil, err
			}
			deliveries = append(deliveries, store.WebhookCapturedDelivery{ID: uuid.NewString(), EndpointID: row.Endpoint.ID, Owner: row.Endpoint.Owner, PolicyVersion: 1, DestinationRevision: row.Endpoint.DestinationRevision, AdapterVersion: adapter, DestinationKind: row.Endpoint.DestinationKind, DestinationOrigin: row.Endpoint.Origin, RenderVersion: 1, ConfigurationSchemaVersion: row.ConfigurationSchemaVersion, DestinationConfiguration: bytes.Clone(row.Endpoint.DestinationConfiguration), RequestMethod: "POST", RequestMediaType: protocol.MediaType, DeterministicHeadersJSON: []byte(`[]`), Body: bytes.Clone(body), BodySHA256: bytes.Clone(bodyHash[:]), AutomaticScheduleAt: schedule, AutomaticExpiresAt: fact.OccurredAt.Add(72 * time.Hour), PayloadExpiresAt: fact.OccurredAt.Add(168 * time.Hour), LastActivityAt: fact.OccurredAt, MetadataExpiresAt: fact.OccurredAt.Add(30 * 24 * time.Hour)})
			index = len(deliveries) - 1
		}
		deliveries[index].Matches = append(deliveries[index].Matches, store.WebhookCapturedMatch{SubscriptionID: row.SubscriptionID, BindingID: row.BindingID, ProjectID: row.ProjectID, EventType: row.EventType, AuthorizationEpoch: row.AuthorizationEpoch})
	}
	for i := range deliveries {
		tuples := make([][5]string, len(deliveries[i].Matches))
		for j, m := range deliveries[i].Matches {
			tuples[j] = [5]string{m.SubscriptionID, m.BindingID, m.ProjectID, m.EventType, strconv.FormatInt(m.AuthorizationEpoch, 10)}
		}
		proof, err := json.Marshal(tuples)
		if err != nil {
			return event, nil, err
		}
		hash := sha256.Sum256(proof)
		deliveries[i].OriginalMatchSHA256 = bytes.Clone(hash[:])
	}
	return event, deliveries, nil
}

func taskWebhookInsertMessage(ctx context.Context, sc store.ThreadScope, f taskWebhookFixture, body string, reply *string) (model.ThreadMessage, error) {
	if _, err := sc.TaskDAO().LockTaskPresence(ctx, f.project, f.task); err != nil {
		return model.ThreadMessage{}, err
	}
	head, err := sc.ThreadDAO().LockHead(ctx, f.task)
	if err != nil {
		return model.ThreadMessage{}, err
	}
	message, err := sc.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: f.task, Author: model.ThreadAuthor{UserID: f.user}, Body: body, ReplyTo: reply})
	if err != nil {
		return message, err
	}
	if err = sc.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
		return message, err
	}
	return message, sc.ThreadDAO().AdvanceHead(ctx, f.task, message.Position())
}

func taskWebhookSaveThread(ctx context.Context, sc store.ThreadScope, f taskWebhookFixture, message model.ThreadMessage) error {
	audience, err := sc.CaptureDAO().FreezeAudience(ctx, f.project, []string{protocol.ThreadPosted})
	if err != nil {
		return err
	}
	event, deliveries, err := taskWebhookPrepared(protocol.Fact{Type: protocol.ThreadPosted, ProjectID: f.project, TaskID: f.task, MessageID: message.ID, CreatedAt: &message.CreatedAt, OccurredAt: message.CreatedAt, ReplyTo: message.ReplyTo}, audience)
	if err != nil {
		return err
	}
	return sc.CaptureDAO().SaveCapture(ctx, event, deliveries)
}

func taskWebhookWait(t *testing.T, ctx context.Context, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
