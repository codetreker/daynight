package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type teamItemReader struct{ tx pgx.Tx }

func (s *Store) ReadTeamItem(ctx context.Context, operation func(store.TeamItemReader) error) error {
	return ReadOnlySnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(&teamItemReader{tx: tx}) })
}

func (r *teamItemReader) Metadata(ctx context.Context, p model.Principal, target model.TeamItemTarget) (model.TeamItemMetadata, error) {
	switch target.Kind {
	case "team":
		return r.teamMetadata(ctx, p, target.TeamID)
	case "member":
		return r.memberMetadata(ctx, p, target.TeamID, target.UserID)
	case "project":
		return r.projectMetadata(ctx, p, target.TeamID, target.ProjectID)
	default:
		return model.TeamItemMetadata{}, fmt.Errorf("invalid Team item kind %q", target.Kind)
	}
}

func utcMember(m *model.TeamMember) { m.CreatedAt = m.CreatedAt.UTC(); m.UpdatedAt = m.UpdatedAt.UTC() }
func (r *teamItemReader) teamMetadata(ctx context.Context, p model.Principal, id string) (model.TeamItemMetadata, error) {
	t := model.Team{}
	var owner *string
	var null, present bool
	var size int64
	err := r.tx.QueryRow(ctx, `SELECT t.id::text,t.personal_user_id::text,t.version,t.created_at,t.updated_at,
 m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at,
 f.content IS NULL,coalesce(octet_length(f.content),0),f.object_id IS NOT NULL
 FROM teams t JOIN team_members m ON m.team_id=t.id
 LEFT JOIN team_item_fields f ON f.kind='team' AND f.object_id=t.id AND f.field='name'
 WHERE t.id=$1 AND m.user_id=$2`, id, p.UserID).Scan(
		&t.ID, &owner, &t.Version, &t.CreatedAt, &t.UpdatedAt, &t.Membership.TeamID, &t.Membership.UserID, &t.Membership.Role, &t.Membership.Version, &t.Membership.CreatedAt, &t.Membership.UpdatedAt, &null, &size, &present)
	if err != nil {
		return model.TeamItemMetadata{}, pg.QueryError("read Team item metadata", err)
	}
	if !present {
		return model.TeamItemMetadata{}, fmt.Errorf("Team name projection is missing")
	}
	t.Kind = "ordinary"
	if owner != nil {
		t.Kind = "personal"
		if *owner != p.UserID || !null || t.Membership.Role != model.ProjectAdmin {
			return model.TeamItemMetadata{}, fmt.Errorf("invalid Personal Team membership")
		}
	}
	if owner == nil && null {
		return model.TeamItemMetadata{}, fmt.Errorf("ordinary Team is missing its name")
	}
	t.CreatedAt = t.CreatedAt.UTC()
	t.UpdatedAt = t.UpdatedAt.UTC()
	utcMember(&t.Membership)
	return model.TeamItemMetadata{Team: &t, Fields: []model.TeamItemField{{Name: "name", IsNull: null, SizeBytes: size}}, ModifiedAt: []time.Time{t.UpdatedAt, t.Membership.UpdatedAt}}, nil
}

func (r *teamItemReader) memberMetadata(ctx context.Context, p model.Principal, teamID, userID string) (model.TeamItemMetadata, error) {
	m := model.TeamMember{}
	var changed time.Time
	var names [3]bool
	var sizes [3]int64
	var present bool
	err := r.tx.QueryRow(ctx, `SELECT m.team_id::text,m.user_id::text,m.role,m.version,m.created_at,m.updated_at,u.updated_at,
 n.content IS NULL,coalesce(octet_length(n.content),0),e.content IS NULL,coalesce(octet_length(e.content),0),
 a.content IS NULL,coalesce(octet_length(a.content),0),n.object_id IS NOT NULL AND e.object_id IS NOT NULL AND a.object_id IS NOT NULL
 FROM teams t JOIN team_members actor ON actor.team_id=t.id AND actor.user_id=$1
 JOIN team_members m ON m.team_id=t.id JOIN users u ON u.id=m.user_id
 LEFT JOIN team_item_fields n ON n.kind='member' AND n.object_id=u.id AND n.field='profile.name'
 LEFT JOIN team_item_fields e ON e.kind='member' AND e.object_id=u.id AND e.field='profile.email'
 LEFT JOIN team_item_fields a ON a.kind='member' AND a.object_id=u.id AND a.field='profile.avatarUrl'
 WHERE t.id=$2 AND m.user_id=$3`, p.UserID, teamID, userID).Scan(
		&m.TeamID, &m.UserID, &m.Role, &m.Version, &m.CreatedAt, &m.UpdatedAt, &changed, &names[0], &sizes[0], &names[1], &sizes[1], &names[2], &sizes[2], &present)
	if err != nil {
		return model.TeamItemMetadata{}, pg.QueryError("read member item metadata", err)
	}
	if !present {
		return model.TeamItemMetadata{}, fmt.Errorf("member profile projection is missing")
	}
	utcMember(&m)
	fields := make([]model.TeamItemField, 3)
	for i, name := range []string{"profile.name", "profile.email", "profile.avatarUrl"} {
		fields[i] = model.TeamItemField{Name: name, IsNull: names[i], SizeBytes: sizes[i]}
	}
	return model.TeamItemMetadata{Member: &m, Fields: fields, ModifiedAt: []time.Time{m.UpdatedAt, changed.UTC()}}, nil
}

func (r *teamItemReader) projectMetadata(ctx context.Context, p model.Principal, teamID, id string) (model.TeamItemMetadata, error) {
	project := model.Project{}
	var nameSize, repoSize int64
	var present bool
	err := r.tx.QueryRow(ctx, `SELECT p.id::text,p.created_at,p.updated_at,p.settings_version,p.execution_warning_minutes,
 o.team_id::text,o.version,o.updated_at,coalesce(octet_length(n.content),0),coalesce(octet_length(r.content),0),
 n.object_id IS NOT NULL AND r.object_id IS NOT NULL
 FROM projects p JOIN project_ownership o ON o.project_id=p.id
 JOIN teams t ON t.id=o.team_id JOIN team_members actor ON actor.team_id=t.id AND actor.user_id=$1
 LEFT JOIN team_item_fields n ON n.kind='project' AND n.object_id=p.id AND n.field='name'
 LEFT JOIN team_item_fields r ON r.kind='project' AND r.object_id=p.id AND r.field='repoUrl'
 WHERE p.id=$2 AND t.id=$3 AND p.deleted_at IS NULL`, p.UserID, id, teamID).Scan(
		&project.ID, &project.CreatedAt, &project.UpdatedAt, &project.Settings.Version, &project.Settings.ExecutionWarningMinutes,
		&project.Ownership.TeamID, &project.Ownership.Version, &project.Ownership.UpdatedAt, &nameSize, &repoSize, &present)
	if err != nil {
		return model.TeamItemMetadata{}, pg.QueryError("read Project item metadata", err)
	}
	if !present {
		return model.TeamItemMetadata{}, fmt.Errorf("Project field projection is missing")
	}
	project.CreatedAt = project.CreatedAt.UTC()
	project.UpdatedAt = project.UpdatedAt.UTC()
	project.Ownership.UpdatedAt = project.Ownership.UpdatedAt.UTC()
	return model.TeamItemMetadata{Project: &project, Fields: []model.TeamItemField{{Name: "name", SizeBytes: nameSize}, {Name: "repoUrl", SizeBytes: repoSize}}, ModifiedAt: []time.Time{project.UpdatedAt, project.Ownership.UpdatedAt}}, nil
}

func (r *teamItemReader) FieldBytes(ctx context.Context, target model.TeamItemTarget, field string, offset int64, length int) ([]byte, error) {
	var id string
	valid := false
	switch target.Kind {
	case "team":
		id, valid = target.TeamID, field == "name"
	case "member":
		id = target.UserID
		valid = field == "profile.name" || field == "profile.email" || field == "profile.avatarUrl"
	case "project":
		id = target.ProjectID
		valid = field == "name" || field == "repoUrl"
	}
	if !valid || offset < 0 || offset > 1<<30 || length < 1 || length > 512<<10 {
		return nil, fmt.Errorf("invalid bounded item field read")
	}
	var data []byte
	err := r.tx.QueryRow(ctx, `SELECT substring(content FROM $4::integer FOR $5::integer) FROM team_item_fields WHERE kind=$1 AND object_id=$2 AND field=$3`, target.Kind, id, field, offset+1, length).Scan(&data)
	if err != nil {
		return nil, pg.QueryError("read item field bytes", err)
	}
	return data, nil
}
