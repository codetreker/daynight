package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type HistoryDirectoryRequest struct {
	Kind, Target, Cursor string
	Limit                int
}

type HistoryDirectoryPage struct {
	Version      int       `json:"version"`
	GraphVersion string    `json:"graphVersion"`
	Items        any       `json:"items"`
	NextCursor   *string   `json:"nextCursor"`
	ObservedAt   time.Time `json:"observedAt"`
}

type HistoryDirectoryGroup struct {
	ID          string     `json:"groupId"`
	Kind        string     `json:"kind"`
	MemberCount int        `json:"memberCount"`
	EndedAt     *time.Time `json:"scopeEndedAt"`
	TimeState   string     `json:"timeState"`
}

type HistoryDirectoryMember struct {
	TaskID    string     `json:"taskId"`
	Title     string     `json:"title"`
	Status    string     `json:"status"`
	EndedAt   *time.Time `json:"endedAt"`
	TimeState string     `json:"timeState"`
}

type HistoryDirectorySession struct {
	TaskID               string     `json:"taskId"`
	SessionID            string     `json:"sessionId"`
	ClaimID              string     `json:"claimId"`
	ExecutionGeneration  string     `json:"executionGeneration"`
	AgentControlMode     string     `json:"agentControlMode"`
	ContentKind          string     `json:"contentKind"`
	CreatedAt            time.Time  `json:"createdAt"`
	EndedAt              *string    `json:"endedAt"`
	CurrentBinding       bool       `json:"currentBinding"`
	ArchiveState         string     `json:"archiveState"`
	Completeness         *string    `json:"completeness"`
	ExpiresAt            *time.Time `json:"expiresAt"`
	ExpiredAt            *time.Time `json:"expiredAt"`
	RetentionReason      string     `json:"reason"`
	RetentionState       string     `json:"retentionState"`
	ScopeEndedAt         *time.Time `json:"scopeEndedAt"`
	FirstArchivedAt      *time.Time `json:"firstArchivedAt"`
	LegacyGraceStartedAt *time.Time `json:"legacyGraceStartedAt"`
}

type historyDirectoryCursor struct {
	Version                                int
	Project, User, Kind, Target, Fence, ID string
	At                                     *time.Time
}

func ValidateHistoryDirectoryRequest(project string, q HistoryDirectoryRequest) error {
	if _, err := model.CanonicalID(project); err != nil {
		return err
	}
	if q.Limit < 1 || q.Limit > 200 || len(q.Cursor) > 4096 {
		return fault("invalid_input", "Invalid history directory page.")
	}
	switch q.Kind {
	case "groups":
		if q.Target != "" {
			return fault("invalid_input", "Groups do not accept a target.")
		}
	case "members", "sessions":
		if _, err := model.CanonicalID(q.Target); err != nil {
			return err
		}
	default:
		return fault("invalid_input", "Unknown history directory view.")
	}
	return nil
}

// ReadHistoryDirectory uses one authorized snapshot for graph, original Session
// identities and retention facts. A cursor cannot continue across changed facts.
func ReadHistoryDirectory(ctx context.Context, scope store.HistoryDirectoryScope, project, user string, q HistoryDirectoryRequest) (HistoryDirectoryPage, error) {
	out := HistoryDirectoryPage{Version: 1}
	if err := ValidateHistoryDirectoryRequest(project, q); err != nil {
		return out, err
	}
	position := historyDirectoryCursor{Version: 1, Project: project, User: user, Kind: q.Kind, Target: q.Target}
	if q.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		if err != nil || json.Unmarshal(raw, &position) != nil || position.Version != 1 || position.Project != project || position.User != user || position.Kind != q.Kind || position.Target != q.Target || position.Fence == "" {
			return out, fault("invalid_cursor", "Invalid history directory cursor.")
		}
		if _, err := model.CanonicalID(position.ID); err != nil {
			return out, fault("invalid_cursor", "Invalid history directory position.")
		}
		if q.Kind == "sessions" && position.At == nil {
			return out, fault("invalid_cursor", "Missing Session history timestamp.")
		}
	}
	dao := scope.HistoryDirectoryDAO()
	fence, err := dao.Fence(ctx, project)
	if err != nil {
		return out, err
	}
	if q.Cursor != "" && position.Fence != fence {
		return out, fault("reset_required", "The history directory changed; restart from its first page.")
	}
	position.Fence = fence
	out.GraphVersion = fence
	out.ObservedAt, err = scope.ObservedAt(ctx)
	if err != nil {
		return out, err
	}
	next := func(id string, at *time.Time) {
		position.ID, position.At = id, at
		raw, _ := json.Marshal(position)
		token := base64.RawURLEncoding.EncodeToString(raw)
		out.NextCursor = &token
	}
	switch q.Kind {
	case "groups":
		var after *store.HistoryGroupPosition
		if q.Cursor != "" {
			after = &store.HistoryGroupPosition{ID: position.ID, EndedAt: position.At}
		}
		rows, err := dao.Groups(ctx, project, after, q.Limit+1)
		if err != nil {
			return out, err
		}
		items := []HistoryDirectoryGroup{}
		for i, row := range rows {
			if i == q.Limit {
				last := rows[i-1]
				next(last.ID, last.EndedAt)
				break
			}
			kind := "task"
			if row.MemberCount > 1 {
				kind = "chain"
			}
			items = append(items, HistoryDirectoryGroup{ID: row.ID, Kind: kind, MemberCount: row.MemberCount, EndedAt: row.EndedAt, TimeState: row.TimeState})
		}
		out.Items = items
	case "members":
		rows, err := dao.Members(ctx, project, q.Target, position.ID, q.Limit+1)
		if err != nil {
			return out, err
		}
		items := []HistoryDirectoryMember{}
		for i, row := range rows {
			if i == q.Limit {
				next(rows[i-1].TaskID, nil)
				break
			}
			ended, state := historyMemberTime(row.ArchiveRetentionMember)
			items = append(items, HistoryDirectoryMember{TaskID: row.TaskID, Title: row.Title, Status: row.Status, EndedAt: ended, TimeState: state})
		}
		out.Items = items
	case "sessions":
		task, err := scope.TaskDAO().Task(ctx, project, q.Target)
		if err != nil {
			return out, err
		}
		if task.Type != model.TaskTypeTask {
			return out, model.ErrNotFound
		}
		worker, err := taskproperty.Worker(task.Properties)
		if err != nil {
			return out, err
		}
		members, err := dao.RetentionMembers(ctx, project, q.Target)
		if err != nil {
			return out, err
		}
		var after *store.Position
		if q.Cursor != "" {
			after = &store.Position{ID: position.ID, CreatedAt: *position.At}
		}
		rows, err := dao.Sessions(ctx, project, q.Target, after, q.Limit+1)
		if err != nil {
			return out, err
		}
		items := []HistoryDirectorySession{}
		for i, row := range rows {
			if i == q.Limit {
				last := rows[i-1]
				next(last.ID, &last.Created)
				break
			}
			item, err := projectHistorySession(row, members, worker)
			if err != nil {
				return out, err
			}
			item.TaskID = q.Target
			items = append(items, item)
		}
		out.Items = items
	}
	return out, nil
}

func historyMemberTime(m store.ArchiveRetentionMember) (*time.Time, string) {
	var at *time.Time
	switch m.Status {
	case "done":
		at = m.CompletedAt
	case "cancelled":
		at = m.CancelledAt
	default:
		return nil, "unfinished"
	}
	if at == nil {
		return nil, "unknown"
	}
	return at, "ended"
}

func projectHistorySession(row store.HistoryDirectorySession, members []store.ArchiveRetentionMember, worker *model.WorkerClaim) (HistoryDirectorySession, error) {
	out := HistoryDirectorySession{SessionID: row.ID, ClaimID: row.Claim, ExecutionGeneration: row.ExecutionGeneration, EndedAt: row.EndedAt, AgentControlMode: row.Backend, ContentKind: "native_timeline", CreatedAt: row.Created.UTC(), ArchiveState: "pending", Completeness: row.Completeness, RetentionReason: "archive_unavailable", RetentionState: "unknown"}
	generation, err := strconv.ParseInt(row.ExecutionGeneration, 10, 64)
	if err != nil || generation <= 0 || strconv.FormatInt(generation, 10) != row.ExecutionGeneration {
		return out, fault("source_corrupt", "The Session directory has an invalid execution generation.")
	}
	out.CurrentBinding = worker != nil && worker.ClaimID == row.Claim && string(worker.AgentControlMode) == row.Backend
	if row.Backend == "herdr" {
		out.ContentKind, out.RetentionReason = "terminal_recording", "not_applicable"
	}
	storedState := "unavailable"
	if row.State != nil {
		storedState = *row.State
	}
	if storedState == "ready" || storedState == "failed" {
		out.ArchiveState = storedState
	}
	if storedState == "ready" && row.Completeness != nil && *row.Completeness == "partial" {
		out.ArchiveState = "partial"
	}
	if row.Backend == "web" {
		retention := store.ArchiveRetention{SessionID: row.ID}
		if row.Retention != nil {
			retention = *row.Retention
		}
		calculated, err := CalculateArchiveRetention(store.ArchiveRetentionFacts{Archive: retention, State: storedState, Members: members})
		if err != nil {
			return out, err
		}
		out.ExpiresAt, out.ExpiredAt, out.RetentionReason = calculated.ExpiresAt, calculated.ExpiredAt, calculated.Reason
		out.FirstArchivedAt = calculated.FirstSucceededAt
		if calculated.GraceUntil != nil {
			at := calculated.GraceUntil.Add(-ArchiveRetentionPeriod)
			out.LegacyGraceStartedAt = &at
		}
		known := len(members) > 0
		var latest time.Time
		for _, member := range members {
			at, state := historyMemberTime(member)
			if state != "ended" {
				known = false
			}
			if at != nil && at.After(latest) {
				latest = *at
			}
		}
		if known {
			out.ScopeEndedAt = &latest
		}
		switch {
		case calculated.ExpiredAt != nil:
			out.ArchiveState, out.RetentionState, out.RetentionReason = "expired", "expired", "history_expired"
		case calculated.Reason == "chain_unfinished":
			out.RetentionState = "waiting"
		case calculated.ExpiresAt != nil:
			out.RetentionState = "scheduled"
		}
	}
	return out, nil
}
