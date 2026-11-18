package usage

import (
	"context"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type MemberCounts struct {
	Total          string `json:"total"`
	WithKnownUsage string `json:"withKnownUsage"`
	Complete       string `json:"complete"`
	Collecting     string `json:"collecting"`
	Partial        string `json:"partial"`
	Unsupported    string `json:"unsupported"`
	Unavailable    string `json:"unavailable"`
	NoData         string `json:"noData"`
	Restricted     string `json:"restricted"`
}
type MissingMember struct {
	TaskID       string   `json:"taskId"`
	Title        string   `json:"title"`
	Completeness string   `json:"completeness"`
	ReasonCodes  []string `json:"reasonCodes"`
	SummaryURL   string   `json:"summaryUrl"`
}
type Aggregate struct {
	Scope              string             `json:"scope"`
	ScopeID            string             `json:"scopeId"`
	MembershipRevision string             `json:"membershipRevision"`
	MembershipPolicy   string             `json:"membershipPolicy"`
	Summary            model.UsageSummary `json:"summary"`
	Members            MemberCounts       `json:"members"`
	MissingMembers     []MissingMember    `json:"missingMembers"`
	NextMembersCursor  *string            `json:"nextMembersCursor"`
	ObservedAt         time.Time          `json:"observedAt"`
}

func (s *Service) Aggregate(ctx context.Context, p model.Principal, project, kind, id, token string) (Aggregate, error) {
	out := Aggregate{Scope: kind, ScopeID: id, MembershipPolicy: "current_members_excludes_deleted", MissingMembers: []MissingMember{}}
	if kind != "chain" && kind != "goal" {
		return out, core.Fault("resource_unavailable")
	}
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		present, err := scope.UsageDAO().ProjectPresent(ctx, project)
		if err != nil {
			return err
		}
		if !present {
			return core.Fault("resource_unavailable")
		}
		permission, err := authorizeProject(ctx, scope, p, project)
		if err != nil {
			return core.Fault("aggregate_scope_restricted")
		}
		dao := scope.UsageDAO()
		members, err := dao.Members(ctx, project, kind, id, 10001)
		if err != nil {
			return err
		}
		if len(members) > 10000 {
			return core.Fault("aggregate_scope_too_large")
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		out.ObservedAt = now
		out.MembershipRevision, err = core.Hash(members)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(members))
		for _, m := range members {
			ids = append(ids, m.ID)
		}
		filter := store.UsageFilter{ProjectID: project, TaskIDs: ids}
		items, err := summaries(ctx, scope, filter, ids, permission, now)
		if err != nil {
			return err
		}
		metrics, err := dao.Metrics(ctx, filter)
		if err != nil {
			return err
		}
		executions, err := dao.Executions(ctx, filter)
		if err != nil {
			return err
		}
		out.Summary = core.Coverage(metrics, executions, now)
		counts := map[string]int{}
		known := 0
		hashes := []string{}
		for _, item := range items {
			r := item.Summary
			counts[r.Completeness]++
			hashes = append(hashes, r.ETag)
			out.Summary.ReasonCodes = core.MergeReasons(out.Summary.ReasonCodes, r.ReasonCodes...)
			for _, m := range r.Metrics {
				if m.Known != nil {
					known++
					break
				}
			}
		}
		count := func(k string) string { return strconv.Itoa(counts[k]) }
		out.Members = MemberCounts{Total: strconv.Itoa(len(members)), WithKnownUsage: strconv.Itoa(known), Complete: count("complete"), Collecting: count("collecting"), Partial: count("partial"), Unsupported: count("unsupported"), Unavailable: count("unavailable"), NoData: count("no_data"), Restricted: "0"}
		n := len(members)
		switch {
		case counts["collecting"] > 0:
			out.Summary.Completeness = "collecting"
		case n > 0 && counts["complete"] == n:
			out.Summary.Completeness = "complete"
		case known > 0 || counts["partial"] > 0 || n > 0 && counts["unsupported"] != n && counts["unavailable"] != n && counts["no_data"] != n:
			out.Summary.Completeness = "partial"
		case counts["unavailable"] > 0:
			out.Summary.Completeness = "unavailable"
		case n > 0 && counts["unsupported"] == n:
			out.Summary.Completeness = "unsupported"
		default:
			out.Summary.Completeness = "no_data"
		}
		out.Summary, err = hashSummary(out.Summary, permission+out.MembershipRevision)
		if err != nil {
			return err
		}
		binding, err := core.Hash([]any{p.UserID, project, kind, id, permission})
		if err != nil {
			return err
		}
		revision, err := core.Hash([]any{out.MembershipRevision, hashes})
		if err != nil {
			return err
		}
		after := ""
		expiry := now.Add(15 * time.Minute).Format(time.RFC3339Nano)
		if token != "" {
			c, e := s.decodeCursor(token, now)
			if e != nil {
				return e
			}
			if c.Binding != binding || c.Revision != revision {
				return core.Fault("reset_required")
			}
			after = c.LastID
			expiry = c.ExpiresAt
		}
		for i, item := range items {
			if item.TaskID <= after || item.Summary.Completeness == "complete" {
				continue
			}
			if len(out.MissingMembers) == 100 {
				last := out.MissingMembers[99]
				next, e := s.encodeCursor(cursor{Binding: binding, Revision: revision, LastID: last.TaskID, ExpiresAt: expiry})
				if e != nil {
					return e
				}
				out.NextMembersCursor = &next
				break
			}
			out.MissingMembers = append(out.MissingMembers, MissingMember{TaskID: item.TaskID, Title: members[i].Title, Completeness: item.Summary.Completeness, ReasonCodes: item.Summary.ReasonCodes, SummaryURL: "/api/projects/" + project + "/tasks/" + item.TaskID + "/usage/v1/summary"})
		}
		return nil
	})
	return out, err
}
