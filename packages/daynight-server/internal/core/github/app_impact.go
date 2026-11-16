package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type AppImpactInput struct {
	AppID   string
	GrantID *string
	Limit   int
	Cursor  string
}
type AppImpactPage struct {
	AppID   string
	GrantID *string
	store.GitHubAppImpact
	Teams      []store.GitHubAppImpactTeam
	NextCursor *string
}
type AppImpactProjectsPage struct {
	Items          []store.GitHubAppImpactProject
	HiddenProjects int64
	NextCursor     *string
}
type impactCursor struct {
	Format        int     `json:"format"`
	Kind          string  `json:"kind"`
	AppID         string  `json:"appId"`
	ActorID       string  `json:"actorId"`
	GrantID       *string `json:"grantId"`
	Version       string  `json:"version"`
	ImpactVersion string  `json:"impactVersion"`
	After         string  `json:"after"`
}

func impactRequest(p model.Principal, in AppImpactInput, kind string) (store.GitHubAppImpactQuery, *impactCursor, error) {
	if err := ValidateAppRead(p, in.AppID); err != nil {
		return store.GitHubAppImpactQuery{}, nil, err
	}
	if in.GrantID != nil {
		id, err := model.CanonicalID(*in.GrantID)
		if err != nil || id != *in.GrantID {
			return store.GitHubAppImpactQuery{}, nil, invalid("Grant ID must be a canonical UUID.")
		}
	}
	if in.Limit == 0 {
		in.Limit = 25
	}
	if in.Limit < 1 || in.Limit > 100 {
		return store.GitHubAppImpactQuery{}, nil, invalid("Limit must be between 1 and 100.")
	}
	q := store.GitHubAppImpactQuery{AppID: in.AppID, ActorID: p.UserID, GrantID: in.GrantID, Limit: in.Limit}
	if in.Cursor == "" {
		return q, nil, nil
	}
	bad := func() (store.GitHubAppImpactQuery, *impactCursor, error) {
		return store.GitHubAppImpactQuery{}, nil, invalid("Cursor is invalid for this list.")
	}
	if len(in.Cursor) > transport.MaxEncodedCursorBytes {
		return bad()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(in.Cursor)
	if err != nil || base64.RawURLEncoding.EncodeToString(raw) != in.Cursor {
		return bad()
	}
	// Reject duplicate and missing fields so every scope component has one meaning.
	d := json.NewDecoder(bytes.NewReader(raw))
	tok, err := d.Token()
	if err != nil || tok != json.Delim('{') {
		return bad()
	}
	fields := map[string]bool{"format": false, "kind": false, "appId": false, "actorId": false, "grantId": false, "version": false, "impactVersion": false, "after": false}
	for d.More() {
		k, err := d.Token()
		if err != nil {
			return bad()
		}
		key, ok := k.(string)
		seen, known := fields[key]
		if !ok || !known || seen {
			return bad()
		}
		fields[key] = true
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return bad()
		}
	}
	if _, err = d.Token(); err != nil || d.Decode(new(any)) != io.EOF {
		return bad()
	}
	for _, seen := range fields {
		if !seen {
			return bad()
		}
	}
	var c impactCursor
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return bad()
	}
	id, err := model.CanonicalID(c.After)
	if err != nil || id != c.After || c.Format != 1 || c.Kind != kind || c.AppID != q.AppID || c.ActorID != q.ActorID || !model.EqualOptional(c.GrantID, q.GrantID) {
		return bad()
	}
	if _, ok := number(c.Version, false); !ok {
		return bad()
	}
	if _, ok := number(c.ImpactVersion, false); !ok {
		return bad()
	}
	q.AfterID = c.After
	return q, &c, nil
}

func impactVersions(summary store.GitHubAppImpact, cursor *impactCursor) error {
	if cursor == nil {
		return nil
	}
	if cursor.Version != strconv.FormatInt(summary.Version, 10) {
		return &model.Fault{Code: "version_conflict", Message: "GitHub App configuration has changed."}
	}
	if cursor.ImpactVersion != strconv.FormatInt(summary.ImpactVersion, 10) {
		return &model.Fault{Code: "impact_changed", Message: "GitHub App impact has changed."}
	}
	return nil
}
func nextImpactCursor(q store.GitHubAppImpactQuery, kind string, impact store.GitHubAppImpact, after string) *string {
	b, _ := json.Marshal(impactCursor{Format: 1, Kind: kind, AppID: q.AppID, ActorID: q.ActorID, GrantID: q.GrantID, Version: strconv.FormatInt(impact.Version, 10), ImpactVersion: strconv.FormatInt(impact.ImpactVersion, 10), After: after})
	s := base64.RawURLEncoding.EncodeToString(b)
	return &s
}

// ReadAppImpact reads counts and a bounded Team page within the DAO snapshot.
func ReadAppImpact(ctx context.Context, dao store.GitHubAppImpactDAO, p model.Principal, in AppImpactInput) (AppImpactPage, error) {
	q, c, err := impactRequest(p, in, "teams")
	if err != nil {
		return AppImpactPage{}, err
	}
	summary, err := dao.Summary(ctx, q)
	if err != nil {
		return AppImpactPage{}, impactReadError(err)
	}
	if err = impactVersions(summary, c); err != nil {
		return AppImpactPage{}, err
	}
	if summary.GrantMissing {
		return AppImpactPage{}, &model.Fault{Code: "not_found", Message: "GitHub App grant was not found.", Cause: model.ErrNotFound}
	}
	page, err := dao.Teams(ctx, q)
	if err != nil {
		return AppImpactPage{}, err
	}
	out := AppImpactPage{AppID: q.AppID, GrantID: q.GrantID, GitHubAppImpact: summary, Teams: page.Items}
	if out.Teams == nil {
		out.Teams = []store.GitHubAppImpactTeam{}
	}
	if page.HasMore && len(page.Items) > 0 {
		out.NextCursor = nextImpactCursor(q, "teams", summary, page.Items[len(page.Items)-1].Team.ID)
	}
	return out, nil
}

// ReadAppImpactProjects rechecks the actor's current project access per page.
func ReadAppImpactProjects(ctx context.Context, dao store.GitHubAppImpactDAO, p model.Principal, in AppImpactInput) (AppImpactProjectsPage, error) {
	q, c, err := impactRequest(p, in, "projects")
	if err != nil {
		return AppImpactProjectsPage{}, err
	}
	summary, err := dao.Summary(ctx, q)
	if err != nil {
		return AppImpactProjectsPage{}, impactReadError(err)
	}
	if err = impactVersions(summary, c); err != nil {
		return AppImpactProjectsPage{}, err
	}
	if summary.GrantMissing {
		return AppImpactProjectsPage{}, &model.Fault{Code: "not_found", Message: "GitHub App grant was not found.", Cause: model.ErrNotFound}
	}
	page, err := dao.Projects(ctx, q)
	if err != nil {
		return AppImpactProjectsPage{}, err
	}
	out := AppImpactProjectsPage{Items: page.Items, HiddenProjects: summary.HiddenProjects}
	if out.Items == nil {
		out.Items = []store.GitHubAppImpactProject{}
	}
	if page.HasMore && len(page.Items) > 0 {
		out.NextCursor = nextImpactCursor(q, "projects", summary, page.Items[len(page.Items)-1].ID)
	}
	return out, nil
}

func impactReadError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "GitHub App or grant was not found.", Cause: err}
	}
	return err
}
