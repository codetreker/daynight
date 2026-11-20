package usage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type SummaryItem struct {
	TaskID  string             `json:"taskId"`
	Summary model.UsageSummary `json:"summary"`
}
type Summaries struct {
	Items      []SummaryItem `json:"items"`
	ObservedAt time.Time     `json:"observedAt"`
	ETag       string        `json:"etag"`
}

func emptySummary() model.UsageSummary {
	m := map[string]model.UsageMetricSummary{}
	for _, k := range []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"} {
		m[k] = model.UsageMetricSummary{ContributingRecords: "0", UnknownRecords: "0"}
	}
	return model.UsageSummary{Metrics: m, MeasurementRecords: "0"}
}
func authToken(p model.Principal, a model.ProjectAccess) (string, error) {
	grant := ""
	if a.DirectGrant != nil {
		grant = strconv.FormatInt(a.DirectGrant.Version, 10)
	}
	return core.Hash([]any{p.UserID, p.CredentialID, string(p.Kind), a.ProjectID, string(a.Role), a.TeamRole, a.Ownership.TeamID, strconv.FormatInt(a.Ownership.Version, 10), grant})
}
func authorizeProject(ctx context.Context, scope store.UsageScope, p model.Principal, project string) (string, error) {
	now, err := scope.UsageDAO().Now(ctx)
	if err != nil {
		return "", err
	}
	if err = scope.SessionDAO().ReadCredential(ctx, p, now); err != nil {
		return "", err
	}
	a, err := scope.UsageDAO().ProjectAccess(ctx, p.UserID, project, false)
	if err != nil {
		return "", core.Fault("resource_unavailable")
	}
	epoch, err := scope.UsageDAO().PermissionEpoch(ctx, p.UserID, project)
	if err != nil {
		return "", err
	}
	token, err := authToken(p, a)
	if err != nil {
		return "", err
	}
	return core.Hash([]any{token, epoch})
}
func validateTasks(ids []string) error {
	if len(ids) < 1 || len(ids) > 100 {
		return core.Fault("invalid_batch")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !core.UUID(id) || seen[id] {
			return core.Fault("invalid_batch")
		}
		seen[id] = true
	}
	return nil
}
func hashSummary(r model.UsageSummary, permission string) (model.UsageSummary, error) {
	observed := r.ObservedAt
	r.ObservedAt = time.Time{}
	r.ETag = ""
	h, err := core.Hash([]any{r, permission})
	r.ObservedAt = observed
	r.ETag = h
	return r, err
}
func summaries(ctx context.Context, scope store.UsageScope, filter store.UsageFilter, ids []string, permission string, now time.Time) ([]SummaryItem, error) {
	dao := scope.UsageDAO()
	filter.ObservedAt = now
	metrics, err := dao.TaskMetrics(ctx, filter)
	if err != nil {
		return nil, err
	}
	executions, err := dao.Executions(ctx, filter)
	if err != nil {
		return nil, err
	}
	byTask := map[string][]store.UsageExecution{}
	for _, e := range executions {
		byTask[core.Value(e.TaskID)] = append(byTask[core.Value(e.TaskID)], e)
	}
	out := make([]SummaryItem, 0, len(ids))
	for _, id := range ids {
		r, ok := metrics[id]
		if !ok {
			r = emptySummary()
		}
		r = core.Coverage(r, byTask[id], now)
		r, err = hashSummary(r, permission)
		if err != nil {
			return nil, err
		}
		out = append(out, SummaryItem{id, r})
	}
	return out, nil
}
func (s *Service) TaskSummaries(ctx context.Context, p model.Principal, project string, ids []string) (Summaries, error) {
	var out Summaries
	if err := validateTasks(ids); err != nil {
		return out, err
	}
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		permission, err := authorizeProject(ctx, scope, p, project)
		if err != nil {
			return err
		}
		dao := scope.UsageDAO()
		members, err := dao.Tasks(ctx, project, ids)
		if err != nil {
			return err
		}
		if len(members) != len(ids) {
			return core.Fault("resource_unavailable")
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		out.Items, err = summaries(ctx, scope, store.UsageFilter{ProjectID: project, TaskIDs: ids}, ids, permission, now)
		if err != nil {
			return err
		}
		out.ObservedAt = now
		hashes := [][2]string{}
		for _, item := range out.Items {
			hashes = append(hashes, [2]string{item.TaskID, item.Summary.ETag})
		}
		out.ETag, err = core.Hash([]any{hashes, permission})
		return err
	})
	return out, err
}
func (s *Service) TestSummary(ctx context.Context, p model.Principal, id string) (model.UsageSummary, error) {
	var out model.UsageSummary
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		session, err := dao.Session(ctx, id)
		if err != nil {
			return err
		}
		if session.Scope != "test" {
			return core.Fault("resource_unavailable")
		}
		permission, err := readPermission(ctx, scope, p, session, false)
		if err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		filter := store.UsageFilter{SessionID: id, ObservedAt: now}
		out, err = dao.Metrics(ctx, filter)
		if err != nil {
			return err
		}
		executions, err := dao.Executions(ctx, filter)
		if err != nil {
			return err
		}
		out = core.Coverage(out, executions, now)
		out, err = hashSummary(out, permission)
		return err
	})
	return out, err
}

type PageRequest struct {
	Kind, StateID, Model, Provider, Role, Cursor string
	Limit                                        int
}
type RecordsPage struct {
	Items         []model.UsageRecord `json:"items"`
	NextCursor    *string             `json:"nextCursor"`
	ObservedAt    time.Time           `json:"observedAt"`
	SnapshotToken string              `json:"snapshotToken"`
}
type cursor struct {
	Binding   string    `json:"binding"`
	Revision  string    `json:"revision"`
	LastTime  time.Time `json:"lastTime"`
	LastID    string    `json:"lastId"`
	ExpiresAt string    `json:"expiresAt"`
}

func (s *Service) encodeCursor(c cursor) (string, error) {
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func cursorAlphabet(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func cursorHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (s *Service) decodeCursor(token string, now time.Time, detail bool) (cursor, error) {
	var c cursor
	invalid := func() (cursor, error) { return cursor{}, core.Fault("invalid_cursor") }
	if len(token) > 4096 {
		return invalid()
	}
	// Signed cursors from the previous release cannot continue on this server.
	// Detect their shape without trusting or decoding either part.
	if left, right, ok := strings.Cut(token, "."); ok {
		if len(right) == 43 && cursorAlphabet(left) && cursorAlphabet(right) {
			return c, core.Fault("reset_required")
		}
		return invalid()
	}
	if !cursorAlphabet(token) {
		return invalid()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return invalid()
	}
	seen := map[string]bool{}
	for decoder.More() {
		keyToken, e := decoder.Token()
		key, ok := keyToken.(string)
		if e != nil || !ok || seen[key] {
			return invalid()
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(value, []byte("null")) {
			return invalid()
		}
		var target any
		switch key {
		case "binding":
			target = &c.Binding
		case "revision":
			target = &c.Revision
		case "lastTime":
			target = &c.LastTime
		case "lastId":
			target = &c.LastID
		case "expiresAt":
			target = &c.ExpiresAt
		default:
			return invalid()
		}
		if json.Unmarshal(value, target) != nil {
			return invalid()
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || len(seen) != 5 {
		return invalid()
	}
	if _, err = decoder.Token(); err != io.EOF {
		return invalid()
	}
	if !cursorHash(c.Binding) || !cursorHash(c.Revision) || !core.UUID(c.LastID) || detail && c.LastTime.IsZero() {
		return invalid()
	}
	expires, err := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	if err != nil || expires.IsZero() {
		return invalid()
	}
	if !now.Before(expires) {
		return c, core.Fault("cursor_expired")
	}
	return c, nil
}
func (s *Service) Records(ctx context.Context, p model.Principal, project, task, sessionID string, input PageRequest) (RecordsPage, error) {
	out := RecordsPage{Items: []model.UsageRecord{}}
	if input.Limit < 1 || input.Limit > 100 || input.Kind != "" && input.Kind != "measurement" && input.Kind != "execution_state" || input.StateID != "" && !core.UUID(input.StateID) || input.Model != "" && !core.Text(input.Model, 128) || input.Provider != "" && input.Provider != "copilot" && input.Provider != "claude" && input.Provider != "codex" || input.Role != "" && input.Role != "counted" && input.Role != "included" && input.Role != "unattributed" {
		return out, core.Fault("invalid_filter")
	}
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		var permission string
		var err error
		filter := store.UsageFilter{ProjectID: project, SessionID: sessionID, Kind: input.Kind, StateID: input.StateID, Model: input.Model, Provider: input.Provider, Role: input.Role, Limit: input.Limit + 1}
		if sessionID != "" {
			session, e := dao.Session(ctx, sessionID)
			if e != nil {
				return e
			}
			if session.Scope != "test" {
				return core.Fault("resource_unavailable")
			}
			permission, err = readPermission(ctx, scope, p, session, false)
		} else {
			permission, err = authorizeProject(ctx, scope, p, project)
			if err != nil {
				return err
			}
			members, e := dao.Tasks(ctx, project, []string{task})
			if e != nil {
				return e
			}
			if len(members) != 1 {
				return core.Fault("resource_unavailable")
			}
			filter.TaskIDs = []string{task}
		}
		if err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		out.ObservedAt = now
		binding, err := core.Hash([]any{p.UserID, project, task, sessionID, input.Kind, input.StateID, input.Model, input.Provider, input.Role, permission})
		if err != nil {
			return err
		}
		revision, err := dao.Revision(ctx, filter)
		if err != nil {
			return err
		}
		type stateView struct {
			State   string
			Reasons []string
		}
		stateViews := map[string]stateView{}
		if input.Kind != "measurement" {
			filter.ObservedAt = now
			executions, e := dao.Executions(ctx, filter)
			if e != nil {
				return e
			}
			for _, execution := range executions {
				if execution.State != nil {
					r := execution.State
					state, reasons := core.Effective(*r, core.EffectiveFacts{Expired: r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt), Revoked: r.GrantRevokedAt != nil || !execution.ParentValid || !execution.Allowed, Stopped: execution.Stopped, Known: execution.Known, GapReasons: execution.GapReasons})
					stateViews[r.ID] = stateView{state, reasons}
				}
			}
			revision.Hash, err = core.Hash([]any{revision.Hash, stateViews})
			if err != nil {
				return err
			}
		}
		out.SnapshotToken = revision.Hash
		expiry := now.Add(15 * time.Minute).Format(time.RFC3339Nano)
		if input.Cursor != "" {
			c, e := s.decodeCursor(input.Cursor, now, true)
			if e != nil {
				return e
			}
			if c.Binding != binding || c.Revision != revision.Hash {
				return core.Fault("reset_required")
			}
			filter.AfterTime = &c.LastTime
			filter.AfterID = c.LastID
			expiry = c.ExpiresAt
		}
		items, err := dao.Records(ctx, filter)
		if err != nil {
			return err
		}
		if len(items) > input.Limit {
			last := items[input.Limit-1]
			next, e := s.encodeCursor(cursor{binding, revision.Hash, last.CreatedAt, last.ID, expiry})
			if e != nil {
				return e
			}
			out.NextCursor = &next
			items = items[:input.Limit]
		}
		// Projection never contains grant material; effective state comes from
		// the same snapshot used for authorization and revision.
		if input.Kind != "measurement" {
			for i := range items {
				if view, ok := stateViews[items[i].ID]; ok {
					items[i].EffectiveCollectionState = &view.State
					items[i].ReasonCodes = view.Reasons
				}
			}
		}
		out.Items = items
		return nil
	})
	return out, err
}
