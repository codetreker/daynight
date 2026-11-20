package assistanttask

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
	"github.com/google/uuid"
)

const (
	// InboxBodyLimit is the largest accepted inbox request body.
	InboxBodyLimit = 64 << 10
	// inboxRatePerMinute is the initial per-inbox request rate of one server
	// instance. The pending-event backlog limit inside the receive transaction
	// is the cross-instance bound.
	inboxRatePerMinute = 120
	// inboxBucketSweep is the bucket count above which idle, refilled buckets
	// are dropped, so unknown inbox IDs cannot grow the limiter without bound.
	inboxBucketSweep = 10000
	// inboxRetryAfter is the delay advertised for backlog and availability
	// refusals, whose recovery time the server cannot predict.
	inboxRetryAfter = "60"
)

type inboxReceiver interface {
	Receive(context.Context, service.ReceiveInput) (service.ReceiveResult, error)
}

// RegisterInboxRoute registers the public inbox receive route. It sits outside
// authentication: the inbox token or a verified Daynight delivery is the only
// credential, and the route never reads cookies.
func RegisterInboxRoute(mux *http.ServeMux, inbox inboxReceiver, logger *slog.Logger) {
	r := &inboxRoute{inbox: inbox, logger: logger, limiter: newInboxLimiter(time.Now)}
	mux.HandleFunc(core.InboxPathPrefix+"{inboxId}", r.serve)
}

type inboxRoute struct {
	inbox   inboxReceiver
	logger  *slog.Logger
	limiter *inboxLimiter
}

// serve logs one line per request with only the server-generated request ID,
// inbox ID, classification, status and body size; the token, the URL query, the
// body and any sender-supplied request ID never reach logs. The request logging
// middleware replaces a sender's X-Request-ID on this route.
func (h *inboxRoute) serve(w http.ResponseWriter, r *http.Request) {
	outcome := inboxOutcome{}
	status := h.receive(w, r, &outcome)
	attributes := []any{"type", "operation", "component", "assistant_task_inbox", "status", status, "bytes", outcome.bytes, "request_id", httpx.RequestID(r.Context())}
	if outcome.inboxID != "" {
		attributes = append(attributes, "inbox_id", outcome.inboxID)
	}
	if outcome.classification != "" {
		attributes = append(attributes, "classification", outcome.classification)
	}
	h.logger.InfoContext(r.Context(), "assistant task inbox request", attributes...)
}

type inboxOutcome struct {
	inboxID, classification string
	bytes                   int
}

func (h *inboxRoute) receive(w http.ResponseWriter, r *http.Request, outcome *inboxOutcome) int {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		return h.refuse(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Only POST is supported.", "")
	}
	id := r.PathValue("inboxId")
	if parsed, err := uuid.Parse(id); err != nil || parsed.String() != id || parsed == uuid.Nil {
		return h.refuse(w, r, http.StatusNotFound, "not_found", "The assistant task inbox does not exist.", "")
	}
	outcome.inboxID = id
	token, problem := requestInboxToken(r)
	if problem != "" {
		return h.refuse(w, r, http.StatusBadRequest, "invalid_input", problem, "")
	}
	webhookID, webhookOK := idempotencyHeader(r, "Webhook-Id")
	idempotencyKey, keyOK := idempotencyHeader(r, "Idempotency-Key")
	if !webhookOK || !keyOK {
		return h.refuse(w, r, http.StatusBadRequest, "invalid_input", "Provide Webhook-Id and Idempotency-Key at most once each, with a non-empty value.", "")
	}
	if r.ContentLength > InboxBodyLimit {
		return h.refuse(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", "The request body exceeds 64 KiB.", "")
	}
	mediaType, text, ok := inboxMediaType(r.Header.Values("Content-Type"))
	if !ok {
		return h.refuse(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "The media type must be application/json, a +json type or UTF-8 text/plain.", "")
	}
	if wait, ok := h.limiter.take(id); !ok {
		return h.refuse(w, r, http.StatusTooManyRequests, "rate_limited", "The inbox request rate limit was exceeded.", strconv.Itoa(wait))
	}
	body, err := httpx.ReadBody(w, r, InboxBodyLimit, transport.JSONBodyReadTimeout)
	if err != nil {
		httpx.WriteBodyError(w, r, h.logger, "assistant_task_inbox", "body", err)
		var bodyErr *httpx.BodyReadError
		if errors.As(err, &bodyErr) {
			return bodyErr.Status
		}
		return http.StatusBadRequest
	}
	outcome.bytes = len(body)
	if message := inboxBodyProblem(body, text); message != "" {
		return h.refuse(w, r, http.StatusBadRequest, "invalid_input", message, "")
	}
	result, err := h.inbox.Receive(r.Context(), service.ReceiveInput{
		InboxID: id, Token: token, MediaType: mediaType,
		WebhookID: webhookID, IdempotencyKey: idempotencyKey,
		Body: body,
	})
	if err != nil {
		return h.failure(w, r, err)
	}
	outcome.classification = result.Classification
	httpx.WriteJSON(w, r, h.logger, http.StatusAccepted, api.AssistantTaskInboxReceipt{EventID: result.EventID, Classification: result.Classification, Duplicate: result.Duplicate, Suppressed: result.Suppressed})
	return http.StatusAccepted
}

func (h *inboxRoute) refuse(w http.ResponseWriter, r *http.Request, status int, code, message, retryAfter string) int {
	httpx.CloseUnreadBody(w, r)
	if retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	httpx.WriteJSON(w, r, h.logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
	return status
}

// failure maps receive results to the inbox status table. Anything else is an
// internal failure reported without its cause.
func (h *inboxRoute) failure(w http.ResponseWriter, r *http.Request, err error) int {
	var completion *service.WriteError
	if errors.As(err, &completion) && completion.Outcome == store.TransactionUnknown {
		httpx.LogFailure(h.logger, r.Context(), "assistant_task_inbox", "completion", err)
		return h.refuse(w, r, http.StatusServiceUnavailable, "write_outcome_unknown", "The receive result is unknown; retry with the same idempotency identity.", inboxRetryAfter)
	}
	if fault, ok := httpx.KnownFault(err); ok && completion == nil {
		statuses := map[string]int{
			"invalid_input": http.StatusBadRequest, "unauthenticated": http.StatusUnauthorized,
			"not_found": http.StatusNotFound, "operation_conflict": http.StatusConflict,
			"inbox_gone": http.StatusGone, "rate_limited": http.StatusTooManyRequests,
			"service_unavailable": http.StatusServiceUnavailable,
		}
		if status, mapped := statuses[fault.Code]; mapped {
			retryAfter := ""
			if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
				retryAfter = inboxRetryAfter
			}
			return h.refuse(w, r, status, fault.Code, fault.Message, retryAfter)
		}
	}
	httpx.LogFailure(h.logger, r.Context(), "assistant_task_inbox", "receive", err)
	return h.refuse(w, r, http.StatusInternalServerError, "internal_error", "internal server error", "")
}

// requestInboxToken returns the token from exactly one of the Bearer header and the
// token query parameter, or nil when the request carries none. A refusal
// returns its client-facing reason.
func requestInboxToken(r *http.Request) (*string, string) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, "The request query is malformed."
	}
	headers := r.Header.Values("Authorization")
	queried := query["token"]
	if len(headers) > 1 || len(queried) > 1 || len(headers) == 1 && len(queried) == 1 {
		return nil, "Provide the inbox token at most once, in the Authorization header or the token query parameter."
	}
	var token string
	switch {
	case len(headers) == 1:
		scheme, value, found := strings.Cut(headers[0], " ")
		if !found || !strings.EqualFold(scheme, "Bearer") {
			return nil, "The Authorization header must use the Bearer scheme."
		}
		token = value
	case len(queried) == 1:
		token = queried[0]
	default:
		return nil, ""
	}
	if token == "" {
		return nil, "The inbox token form is invalid."
	}
	return &token, ""
}

// idempotencyHeader returns the header value, or "" when the header is absent.
// An explicitly empty or repeated header is refused rather than read as absent:
// absence writes a new event per request, so a sender that meant to supply a
// key would otherwise duplicate events on retry.
func idempotencyHeader(r *http.Request, name string) (string, bool) {
	values := r.Header.Values(name)
	switch {
	case len(values) == 0:
		return "", true
	case len(values) == 1 && values[0] != "":
		return values[0], true
	}
	return "", false
}

// inboxMediaType accepts application/json, any +json type and text/plain,
// each only in UTF-8. It returns the media type without parameters.
func inboxMediaType(values []string) (string, bool, bool) {
	if len(values) != 1 {
		return "", false, false
	}
	essence, params, err := mime.ParseMediaType(values[0])
	if err != nil {
		return "", false, false
	}
	if charset, present := params["charset"]; present && !strings.EqualFold(charset, "utf-8") {
		return "", false, false
	}
	text := essence == "text/plain"
	if !text && essence != "application/json" && !strings.HasSuffix(essence, "+json") {
		return "", false, false
	}
	return essence, text, true
}

// inboxBodyProblem rejects NUL bytes, which a stored JSON payload cannot
// represent, invalid UTF-8 and invalid JSON.
func inboxBodyProblem(body []byte, text bool) string {
	switch {
	case bytes.IndexByte(body, 0) >= 0:
		return "The request body must not contain NUL bytes."
	case !utf8.Valid(body):
		return "The request body must be valid UTF-8."
	case !text && !json.Valid(body):
		return "The request body must be valid JSON."
	}
	return ""
}

// inboxLimiter is a per-inbox token bucket local to this server instance.
type inboxLimiter struct {
	mu        sync.Mutex
	now       func() time.Time
	buckets   map[string]*inboxBucket
	nextSweep time.Time
}

type inboxBucket struct {
	tokens float64
	at     time.Time
}

func newInboxLimiter(now func() time.Time) *inboxLimiter {
	return &inboxLimiter{now: now, buckets: map[string]*inboxBucket{}}
}

// take consumes one request for the inbox. A refusal reports the whole
// seconds until the next request is admitted.
func (l *inboxLimiter) take(id string) (int, bool) {
	const capacity = float64(inboxRatePerMinute)
	const perSecond = capacity / 60
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.buckets) >= inboxBucketSweep && !now.Before(l.nextSweep) {
		for key, bucket := range l.buckets {
			if bucket.tokens+now.Sub(bucket.at).Seconds()*perSecond >= capacity {
				delete(l.buckets, key)
			}
		}
		l.nextSweep = now.Add(time.Second)
	}
	bucket, ok := l.buckets[id]
	if !ok {
		bucket = &inboxBucket{tokens: capacity, at: now}
		l.buckets[id] = bucket
	}
	if elapsed := now.Sub(bucket.at).Seconds(); elapsed > 0 {
		bucket.tokens = math.Min(capacity, bucket.tokens+elapsed*perSecond)
		bucket.at = now
	}
	if bucket.tokens < 1 {
		return max(1, int(math.Ceil((1-bucket.tokens)/perSecond))), false
	}
	bucket.tokens--
	return 0, true
}
