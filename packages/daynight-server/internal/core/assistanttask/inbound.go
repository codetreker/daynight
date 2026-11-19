package assistanttask

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const (
	InboundEventType          = "inbound"
	InboundDaynight           = "daynight"
	InboundExternal           = "external"
	InboundMaxBodyBytes       = protocol.MaxBodyBytes
	InboundMaxIdempotencyKey  = 200
	InboundActorUser          = "user"
	InboundActorBot           = "bot"
	InboundActorSystem        = "system"
	inboundCloudEventsMedia   = protocol.MediaType
	inboundInvalidBodyMessage = "The inbound body is invalid."
)

// InboundActor is the stored actor of a verified Daynight event. A nil actor
// means the actor is unknown, as for events captured before actors existed.
type InboundActor struct {
	Kind          string
	UserID, BotID *string
}

// InboundInput is one accepted inbox request after classification. Body holds
// the exact request bytes; Daynight event facts are decoded from them rather
// than trusted from the caller so the payload always matches the source.
type InboundInput struct {
	InboxID        string
	Classification string
	ReceivedAt     time.Time
	MediaType      string
	IdempotencyKey string
	Body           []byte
	Actor          *InboundActor
}

type inboundActorPayload struct {
	Kind   string  `json:"kind"`
	UserID *string `json:"userId,omitempty"`
	BotID  *string `json:"botId,omitempty"`
}
type inboundDaynightPayload struct {
	InboxID        string               `json:"inboxId"`
	Classification string               `json:"classification"`
	ReceivedAt     string               `json:"receivedAt"`
	MediaType      string               `json:"mediaType"`
	IdempotencyKey string               `json:"idempotencyKey"`
	EventType      string               `json:"eventType"`
	ProjectID      string               `json:"projectId"`
	TaskID         string               `json:"taskId"`
	OccurredAt     string               `json:"occurredAt"`
	Actor          *inboundActorPayload `json:"actor"`
	Data           any                  `json:"data"`
}
type inboundExternalPayload struct {
	InboxID        string  `json:"inboxId"`
	Classification string  `json:"classification"`
	ReceivedAt     string  `json:"receivedAt"`
	MediaType      string  `json:"mediaType"`
	IdempotencyKey *string `json:"idempotencyKey"`
	Body           string  `json:"body"`
	ByteLength     int     `json:"byteLength"`
	SHA256         string  `json:"sha256"`
}

// ValidInboundIdempotencyKey reports whether key is 1-200 visible ASCII bytes.
func ValidInboundIdempotencyKey(key string) bool {
	if len(key) < 1 || len(key) > InboundMaxIdempotencyKey {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7e {
			return false
		}
	}
	return true
}

// inboundMediaType returns the lowercase media type essence for supported
// JSON and UTF-8 text bodies.
func inboundMediaType(raw string) (string, bool, error) {
	essence, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return "", false, invalid("The inbound media type is invalid.")
	}
	charset, hasCharset := params["charset"]
	if hasCharset && !strings.EqualFold(charset, "utf-8") {
		return "", false, invalid("The inbound media type must use UTF-8.")
	}
	if essence == "application/json" || strings.HasSuffix(essence, "+json") {
		return essence, true, nil
	}
	if essence == "text/plain" {
		return essence, false, nil
	}
	return "", false, invalid("The inbound media type is not supported.")
}

// BuildInboundPayload validates an accepted inbox request and returns the
// canonical JSON payload stored on its inbound event.
func BuildInboundPayload(input InboundInput) (json.RawMessage, error) {
	if !strictID(input.InboxID) {
		return nil, invalid("Inbox ID must be a canonical nonzero UUID.")
	}
	if input.ReceivedAt.IsZero() {
		return nil, invalid("The inbound receive time is required.")
	}
	if len(input.Body) > InboundMaxBodyBytes {
		return nil, invalid("The inbound body exceeds 64 KiB.")
	}
	if !utf8.Valid(input.Body) {
		return nil, invalid("The inbound body must be valid UTF-8.")
	}
	// PostgreSQL jsonb cannot store U+0000, so it is a client error here
	// rather than a storage failure at insert time.
	if bytes.IndexByte(input.Body, 0) >= 0 {
		return nil, invalid("The inbound body must not contain NUL characters.")
	}
	mediaType, isJSON, err := inboundMediaType(input.MediaType)
	if err != nil {
		return nil, err
	}
	if isJSON && !json.Valid(input.Body) {
		return nil, invalid(inboundInvalidBodyMessage)
	}
	received := input.ReceivedAt.UTC().Format(time.RFC3339Nano)
	switch input.Classification {
	case InboundDaynight:
		return daynightPayload(input, mediaType, received)
	case InboundExternal:
		return externalPayload(input, mediaType, received)
	default:
		return nil, invalid("Inbound classification must be daynight or external.")
	}
}

func daynightPayload(input InboundInput, mediaType, received string) (json.RawMessage, error) {
	if mediaType != inboundCloudEventsMedia {
		return nil, invalid("A Daynight inbound event must be a CloudEvent.")
	}
	id, fact, err := protocol.Decode(input.Body)
	if err != nil {
		return nil, invalid(inboundInvalidBodyMessage)
	}
	if input.IdempotencyKey != id {
		return nil, invalid("A Daynight inbound idempotency key must be its event ID.")
	}
	actor, err := inboundActor(input.Actor)
	if err != nil {
		return nil, err
	}
	// Decode already proved the envelope shape and data object, so neither
	// step below can fail.
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	_ = json.Unmarshal(input.Body, &envelope)
	decoder := json.NewDecoder(bytes.NewReader(envelope.Data))
	decoder.UseNumber()
	var data any
	_ = decoder.Decode(&data)
	return encodeInbound(inboundDaynightPayload{InboxID: input.InboxID, Classification: InboundDaynight, ReceivedAt: received, MediaType: mediaType, IdempotencyKey: id, EventType: fact.Type, ProjectID: fact.ProjectID, TaskID: fact.TaskID, OccurredAt: fact.OccurredAt.UTC().Format(time.RFC3339Nano), Actor: actor, Data: data})
}

func externalPayload(input InboundInput, mediaType, received string) (json.RawMessage, error) {
	if input.Actor != nil {
		return nil, invalid("External inbound events have no actor.")
	}
	var key *string
	if input.IdempotencyKey != "" {
		if !ValidInboundIdempotencyKey(input.IdempotencyKey) {
			return nil, invalid("The idempotency key must be 1-200 visible ASCII characters.")
		}
		key = ptr(input.IdempotencyKey)
	}
	sum := sha256.Sum256(input.Body)
	return encodeInbound(inboundExternalPayload{InboxID: input.InboxID, Classification: InboundExternal, ReceivedAt: received, MediaType: mediaType, IdempotencyKey: key, Body: string(input.Body), ByteLength: len(input.Body), SHA256: hex.EncodeToString(sum[:])})
}

// encodeInbound produces canonical payload bytes without HTML escaping, so
// '<', '>' and '&' keep their source size. JSON string escaping still expands
// a body byte to at most six bytes (control characters become \u00XX), so a
// payload is bounded by six times the 64 KiB body plus fixed fields.
func encodeInbound(value any) (json.RawMessage, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func inboundActor(actor *InboundActor) (*inboundActorPayload, error) {
	if actor == nil {
		return nil, nil
	}
	validUser := actor.UserID != nil && strictID(*actor.UserID)
	validBot := actor.BotID != nil && strictID(*actor.BotID)
	switch {
	case actor.Kind == InboundActorUser && validUser && actor.BotID == nil,
		actor.Kind == InboundActorBot && validUser && validBot,
		actor.Kind == InboundActorSystem && actor.UserID == nil && actor.BotID == nil:
		return &inboundActorPayload{Kind: actor.Kind, UserID: actor.UserID, BotID: actor.BotID}, nil
	default:
		return nil, invalid("The inbound event actor is invalid.")
	}
}

// AddInboundEvent writes the server-generated inbound event for the current
// responsible Bot. The caller supplies a random event ID and stores it in the
// receipt, so a reused idempotency key after receipt expiry gets a new event.
func (m *Module) AddInboundEvent(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, id, targetBotID string, input InboundInput) (model.AssistantTaskEvent, error) {
	if !strictID(id) || !strictID(targetBotID) {
		return model.AssistantTaskEvent{}, invalid("Event and target Bot identities are required.")
	}
	payload, err := BuildInboundPayload(input)
	if err != nil {
		return model.AssistantTaskEvent{}, err
	}
	attention, err := eventAttention(InboundEventType)
	if err != nil {
		return model.AssistantTaskEvent{}, err
	}
	return insertSystemEvent(ctx, dao, task, id, targetBotID, InboundEventType, attention, payload, input.ReceivedAt.UTC())
}
