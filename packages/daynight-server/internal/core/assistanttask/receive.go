package assistanttask

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const (
	// InboxPathPrefix is the public receive path before the inbox ID. A
	// Daynight delivery verifies only when its target names this path.
	InboxPathPrefix = "/api/v1/assistant-task-inbox/"
	// InboxDaynightReceiptTTL covers the outbound manual redelivery period.
	InboxDaynightReceiptTTL = 8 * 24 * time.Hour
	// InboxExternalReceiptTTL is how long an external idempotency key holds.
	InboxExternalReceiptTTL = 72 * time.Hour
	// InboundBacklogLimit bounds pending inbound events of one task for its
	// current responsible Bot; it is the cross-instance admission limit.
	InboundBacklogLimit = 500
	// InboundReclaimLimit bounds each reclamation step of one call.
	InboundReclaimLimit = 100
	// InboundReclaimTaskLimit bounds the tasks one cross-task event pull
	// reclaims, so an owner's backlog is cleaned over successive pulls.
	InboundReclaimTaskLimit = 20
	// InboundRetention is how long a settled inbound event is kept.
	InboundRetention = 30 * 24 * time.Hour
	// InboundReactionWindow is how long after an unsuppressed receipt another
	// Bot of the owner is treated as reacting to it, so events it causes about
	// the same project Task are suppressed instead of waking assistants in a
	// loop.
	InboundReactionWindow = 10 * time.Minute
)

// ResponsibleBot returns the Bot that receives inbound events at now: the
// holder of an unexpired claim, or the target of a pending transfer. A task
// without one cannot accept inbound events.
func ResponsibleBot(task model.AssistantTask, now time.Time) (string, bool) {
	switch claimView(task, now).State {
	case "active", "pending":
		return *task.HolderBotID, true
	}
	return "", false
}

// InboxTargetMatches reports whether a stored HTTP destination configuration
// names this inbox: its URL has the given origin and exactly the inbox path.
// Query parameters do not change the target, because the inbox URL itself
// carries no secret.
func InboxTargetMatches(configuration []byte, origin, inboxID string) bool {
	var document struct {
		Kind          string `json:"kind"`
		Configuration struct {
			URL string `json:"url"`
		} `json:"configuration"`
	}
	if json.Unmarshal(configuration, &document) != nil || document.Kind != "http" {
		return false
	}
	target, err := url.Parse(document.Configuration.URL)
	if err != nil || target.User != nil || target.Opaque != "" {
		return false
	}
	return strings.EqualFold(target.Scheme+"://"+target.Host, origin) && target.EscapedPath() == InboxPathPrefix+inboxID
}

// ReclaimInbound deletes, within fixed bounds, expired receipts of the task
// and its inbound events settled before the retention cutoff. The caller holds
// the task lock, so reclamation never races the task's receipt writes.
func ReclaimInbound(ctx context.Context, dao store.AssistantTaskDAO, owner, taskID string, now time.Time) error {
	if _, err := dao.ReclaimInboxReceipts(ctx, owner, taskID, InboundReclaimLimit); err != nil {
		return err
	}
	_, err := dao.ReclaimInboundEvents(ctx, owner, taskID, now.Add(-InboundRetention), InboundReclaimLimit)
	return err
}

// SuppressInbound reports whether a verified Daynight event about the project
// Task subject is a self-loop for target, the task's current responsible Bot.
// It is when the stored actor is a Bot of the task owner that is either target
// itself or, within InboundReactionWindow before now inclusive, was the target
// of an unsuppressed receipt about the same subject. Users, the system,
// unknown actors and Bots of other users are never suppressed.
func SuppressInbound(ctx context.Context, dao store.AssistantTaskDAO, owner, target, subject string, actor *InboundActor, now time.Time) (bool, error) {
	if actor == nil || actor.Kind != InboundActorBot || actor.BotID == nil || actor.UserID == nil || *actor.UserID != owner {
		return false, nil
	}
	if *actor.BotID == target {
		return true, nil
	}
	return dao.ReceivedInbound(ctx, owner, *actor.BotID, subject, now.Add(-InboundReactionWindow))
}
