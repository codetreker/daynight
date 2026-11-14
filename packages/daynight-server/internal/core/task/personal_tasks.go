package task

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type personalTaskCursor struct {
	Version  int                        `json:"version"`
	Kind     string                     `json:"kind"`
	Actor    string                     `json:"actor"`
	Revision string                     `json:"revision"`
	Position store.PersonalTaskPosition `json:"position"`
}

type PersonalTaskSelection struct {
	Query store.PersonalTaskQuery
	actor string
	prior *personalTaskCursor
}

// SelectPersonalTasks binds the fixed personal inventory to the authenticated actor.
func SelectPersonalTasks(actorID string, limit int, cursor *string) (PersonalTaskSelection, error) {
	actor, err := model.CanonicalID(actorID)
	if err != nil {
		return PersonalTaskSelection{}, err
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return PersonalTaskSelection{}, invalidInput("Personal task limit must be between 1 and 100.")
	}
	selection := PersonalTaskSelection{actor: actor, Query: store.PersonalTaskQuery{Limit: limit}}
	if cursor == nil {
		return selection, nil
	}
	invalid := func() (PersonalTaskSelection, error) {
		return PersonalTaskSelection{}, invalidInput("Cursor is invalid for this personal task inventory.")
	}
	if len(*cursor) > transport.MaxEncodedCursorBytes {
		return invalid()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(*cursor)
	if err != nil {
		return invalid()
	}
	var c personalTaskCursor
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF {
		return invalid()
	}
	encoded, err := json.Marshal(c)
	if err != nil || !bytes.Equal(raw, encoded) || c.Version != 1 || c.Kind != "personal-in-progress-tasks" || c.Actor != actor || !validPersonalRevision(c.Revision) || !validPersonalPosition(c.Position) {
		return invalid()
	}
	selection.Query.After = &c.Position
	selection.prior = &c
	return selection, nil
}

func validPersonalRevision(s string) bool {
	if len(s) != 64 || strings.ToLower(s) != s {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
func validPersonalPosition(p store.PersonalTaskPosition) bool {
	for _, id := range []string{p.OwnerTeamID, p.ProjectID, p.TaskID} {
		canonical, err := model.CanonicalID(id)
		if err != nil || canonical != id {
			return false
		}
	}
	if p.ProjectName == "" || (p.OwnerTeamKind != "personal" && p.OwnerTeamKind != "ordinary") {
		return false
	}
	if p.OwnerTeamKind == "personal" && p.OwnerTeamName != nil || p.OwnerTeamKind == "ordinary" && (p.OwnerTeamName == nil || *p.OwnerTeamName == "") {
		return false
	}
	return p.StartedAt == nil || !p.StartedAt.IsZero() && p.StartedAt.Location().String() == "UTC" && p.StartedAt.Nanosecond()%1000 == 0
}

// PersonalTaskRevision hashes the complete project facts in project ID order.
func PersonalTaskRevision(facts []store.PersonalTaskProject) (string, error) {
	canonical := append([]store.PersonalTaskProject{}, facts...)
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].ID < canonical[j].ID })
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func (s PersonalTaskSelection) CheckRevision(revision string) error {
	if s.prior != nil && s.prior.Revision != revision {
		return &model.Fault{Code: "reset_required", Message: "Tasks changed during this personal inventory; restart the inventory."}
	}
	return nil
}
func (s PersonalTaskSelection) CursorAfter(revision string, position store.PersonalTaskPosition) (string, error) {
	if !validPersonalRevision(revision) || !validPersonalPosition(position) {
		return "", fmt.Errorf("invalid personal task cursor position or revision")
	}
	raw, err := json.Marshal(personalTaskCursor{Version: 1, Kind: "personal-in-progress-tasks", Actor: s.actor, Revision: revision, Position: position})
	if err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	if len(token) > transport.MaxEncodedCursorBytes {
		return "", fmt.Errorf("personal task cursor exceeds transport limit")
	}
	return token, nil
}

// PersonalTaskPaused decodes only the optional paused property, preserving the
// storage contract's failure on malformed values.
func PersonalTaskPaused(raw *string) (bool, error) {
	if raw == nil {
		return false, nil
	}
	var value *bool
	if err := json.Unmarshal([]byte(*raw), &value); err != nil {
		return false, err
	}
	if value == nil {
		return false, fmt.Errorf("invalid paused property")
	}
	return *value, nil
}

// PersonalTaskWorker exposes only the current claim's display identity.
type PersonalTaskWorker struct {
	WorkerID string
	Machine  model.WorkerMachine
}

func ActivePersonalTaskWorker(claim *model.WorkerClaim) *PersonalTaskWorker {
	if claim == nil || claim.State != model.WorkerActive {
		return nil
	}
	return &PersonalTaskWorker{WorkerID: claim.WorkerID, Machine: claim.Machine}
}
